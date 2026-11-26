import { describe, expect, it } from "@effect/vitest";
import {
  InferenceServerId,
  ThreadId,
  TrainingArtifactId,
  TrainingEvalRunId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations.ts";
import * as TrainingStore from "./TrainingStore.ts";
import { sampleDataset, sampleJob } from "./TrainingStore.testFixtures.ts";

const makeTestLayer = () =>
  TrainingStore.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("TrainingStore", () => {
  it.effect("persists curated threads, datasets, jobs, artifacts, and eval runs", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* TrainingStore.TrainingStore;

      const t1 = ThreadId.make("thread-1");
      yield* store.setCuratedThread({ threadId: t1, curated: true, note: "great fix" });
      const curated = yield* store.listCuratedThreads();
      expect(curated).toHaveLength(1);
      expect(curated[0]?.threadId).toBe(t1);
      expect(curated[0]?.note).toBe("great fix");

      yield* store.setCuratedThread({ threadId: t1, curated: false });
      expect(yield* store.listCuratedThreads()).toHaveLength(0);

      const ds = sampleDataset("ds-1");
      yield* store.insertDataset(ds);
      expect(yield* store.getDataset(ds.id)).toEqual(ds);
      expect(yield* store.listDatasets).toHaveLength(1);

      const job = sampleJob("job-1", "ds-1", "completed");
      yield* store.insertJob(job);
      const artifact = {
        id: TrainingArtifactId.make("art-1"),
        jobId: job.id,
        datasetId: ds.id,
        baseModel: job.config.baseModel,
        fineTuneType: "lora" as const,
        adapterPath: "/tmp/training/jobs/job-1/adapters",
        fusedModelPath: null,
        ggufPath: null,
        provenanceHash: "b".repeat(64),
        sourceThreadIds: [t1],
        testLoss: 1.35,
        testPerplexity: 3.86,
        registeredInferenceServerId: InferenceServerId.make("mlx-ft-1"),
        servingPort: 18081,
        createdAt: "2026-11-24T20:10:00.000Z",
      };
      yield* store.upsertArtifact(artifact);

      const loadedJob = yield* store.getJob(job.id);
      expect(loadedJob?.artifact).toEqual(artifact);

      const evalRun = {
        id: TrainingEvalRunId.make("eval-1"),
        artifactId: artifact.id,
        suite: "heldout_perplexity" as const,
        status: "running" as const,
        baseSummary: null,
        tunedSummary: null,
        reportPath: null,
        createdAt: "2026-11-24T20:11:00.000Z",
        completedAt: null,
      };
      yield* store.insertEvalRun(evalRun);
      const updatedEval = yield* store.updateEvalRun(evalRun.id, {
        status: "completed",
        baseSummary: { model: job.config.baseModel, testLoss: 1.8, testPerplexity: 6.05 },
        tunedSummary: {
          model: `${job.config.baseModel}+adapter`,
          testLoss: 1.35,
          testPerplexity: 3.86,
        },
        completedAt: "2026-11-24T20:12:00.000Z",
      });
      expect(updatedEval?.status).toBe("completed");
      expect(updatedEval?.tunedSummary?.testLoss).toBe(1.35);

      expect(yield* store.softDeleteDataset(ds.id)).toBe(true);
      expect(yield* store.getDataset(ds.id)).toBeNull();
      expect(yield* store.listDatasets).toHaveLength(0);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("reconciles stale active jobs, serving ports, and running evals on startup", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* TrainingStore.TrainingStore;

      const ds = sampleDataset("ds-recover");
      yield* store.insertDataset(ds);

      const runningJob = sampleJob("job-running", "ds-recover", "training");
      const queuedJob = sampleJob("job-queued", "ds-recover", "queued");
      const completedJob = sampleJob("job-done", "ds-recover", "completed");
      yield* store.insertJob(runningJob, 12345);
      yield* store.insertJob(queuedJob, null);
      yield* store.insertJob(completedJob, null);

      const art = {
        id: TrainingArtifactId.make("art-done"),
        jobId: completedJob.id,
        datasetId: ds.id,
        baseModel: completedJob.config.baseModel,
        fineTuneType: "lora" as const,
        adapterPath: "/tmp/adapters",
        fusedModelPath: null,
        ggufPath: null,
        provenanceHash: "c".repeat(64),
        sourceThreadIds: [],
        registeredInferenceServerId: null,
        servingPort: 18082,
        createdAt: "2026-11-24T20:10:00.000Z",
      };
      yield* store.upsertArtifact(art);

      const staleEval = {
        id: TrainingEvalRunId.make("eval-stale"),
        artifactId: art.id,
        suite: "local_coding" as const,
        status: "running" as const,
        baseSummary: null,
        tunedSummary: null,
        reportPath: null,
        createdAt: "2026-11-24T20:11:00.000Z",
        completedAt: null,
      };
      yield* store.insertEvalRun(staleEval);

      const result = yield* store.reconcileStaleJobsOnStartup;
      expect(result).toEqual({ reconciledJobCount: 2, clearedServingPorts: 1 });

      const afterRunning = yield* store.getJob(runningJob.id);
      expect(afterRunning?.status).toBe("failed");
      expect(afterRunning?.errorCategory).toBe("server_restarted");
      expect(afterRunning?.completedAt).not.toBeNull();

      const afterQueued = yield* store.getJob(queuedJob.id);
      expect(afterQueued?.status).toBe("failed");
      expect(afterQueued?.errorCategory).toBe("server_restarted");

      const afterDone = yield* store.getJob(completedJob.id);
      expect(afterDone?.status).toBe("completed");
      expect(afterDone?.artifact?.servingPort).toBeNull();

      const afterEval = yield* store.getEvalRun(staleEval.id);
      expect(afterEval?.status).toBe("failed");
      expect(afterEval?.completedAt).not.toBeNull();
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
