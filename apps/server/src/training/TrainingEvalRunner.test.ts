// @effect-diagnostics nodeBuiltinImport:off -- temp eval fixture directory in live test
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  TrainingArtifactId,
  TrainingDatasetId,
  TrainingEvalRunId,
  TrainingJobId,
  type TrainingArtifact,
  type TrainingDatasetSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { runMigrations } from "../persistence/Migrations.ts";
import * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
import { REDACTOR_VERSION } from "./SecretRedactor.ts";
import * as TrainerAdapter from "./TrainerAdapter.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingEvalRunner from "./TrainingEvalRunner.ts";
import * as TrainingStore from "./TrainingStore.ts";

const makeDataset = (storagePath: string): TrainingDatasetSummary => ({
  id: TrainingDatasetId.make("ds-eval-1"),
  name: "Eval DS",
  objective: "sft",
  filter: {
    settledOnly: false,
    includeArchived: false,
    includeSubagents: false,
    minCompletedRuns: 1,
    includeToolCalls: true,
    includeReasoning: false,
    includeCheckpointDiffs: false,
    maxToolOutputChars: 2000,
    split: { validRatio: 0.1, testRatio: 0.1, seed: 1 },
  },
  redactionOptions: {
    redactEnvAssignments: true,
    redactHomePaths: true,
    redactEmails: true,
    redactHighEntropy: true,
  },
  redactionAudit: {
    redactorVersion: REDACTOR_VERSION,
    totalRedactions: 0,
    countsByCategory: {
      api_key_provider: 0,
      jwt_bearer: 0,
      pem_private_key: 0,
      aws_gcp_cloud: 0,
      env_assignment: 0,
      url_credentials: 0,
      home_path_username: 0,
      email_address: 0,
      high_entropy_secret: 0,
    },
    affectedThreadCount: 0,
    sampleFindings: [],
    findingsTruncated: false,
  },
  storagePath,
  provenanceHash: "a".repeat(64),
  sourceThreadIds: [],
  trainCount: 8,
  validCount: 1,
  testCount: 1,
  estimatedTokens: 1000,
  sizeBytes: 1000,
  createdAt: "2026-11-24T20:00:00.000Z",
});

const makeArtifact = (datasetId: TrainingDatasetId): TrainingArtifact => ({
  id: TrainingArtifactId.make("art-eval-1"),
  jobId: TrainingJobId.make("job-eval-1"),
  datasetId,
  baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
  fineTuneType: "lora",
  adapterPath: "/tmp/adapters",
  fusedModelPath: null,
  ggufPath: null,
  provenanceHash: "b".repeat(64),
  sourceThreadIds: [],
  registeredInferenceServerId: null,
  servingPort: null,
  createdAt: "2026-11-24T20:05:00.000Z",
});

describe("TrainingEvalRunner", () => {
  it.live(
    "runs heldout_perplexity and local_coding base vs. tuned comparisons and persists reports",
    () =>
      Effect.gen(function* () {
        const tmpRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-eval-runner-")),
        );
        try {
          const dsDir = NodePath.join(tmpRoot, "dataset");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(dsDir, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(dsDir, "test.jsonl"), '{"messages":[]}\n');
          });

          const servedCalls: Array<{
            readonly model: string;
            readonly adapterPath: string | null;
          }> = [];
          let stoppedCount = 0;
          const codingModels: Array<string> = [];

          const fakeAdapter: TrainerAdapter.TrainerAdapter = {
            id: "mlx-lora",
            probeCapabilities: Effect.die("unused"),
            startTraining: () => Effect.die("unused"),
            fuse: () => Effect.die("unused"),
            runTestEval: (input) =>
              Effect.succeed(
                input.adapterPath === null
                  ? { testLoss: 2.1, testPerplexity: 8.17 }
                  : { testLoss: 1.45, testPerplexity: 4.26 },
              ),
          };

          const gpuLayer = Layer.effect(
            LocalGpuCoordinator.LocalGpuCoordinator,
            Effect.gen(function* () {
              const ref = yield* SubscriptionRef.make<TrainingJobId | null>(null);
              return LocalGpuCoordinator.LocalGpuCoordinator.of({
                activeLeaseJobId: ref,
                currentLease: SubscriptionRef.get(ref),
                acquireLease: () => Effect.void,
              });
            }),
          );

          const adapterServerLayer = Layer.succeed(
            TrainingAdapterServer.TrainingAdapterServer,
            TrainingAdapterServer.TrainingAdapterServer.of({
              start: () => Effect.die("unused"),
              stop: () => Effect.void,
              registerInInference: () => Effect.die("unused"),
              getActive: () => Effect.succeed(null),
              listActive: Effect.succeed([]),
              stopAllManaged: Effect.succeed([]),
              startTemporary: (input) =>
                Effect.sync(() => {
                  servedCalls.push(input);
                  const port = input.adapterPath === null ? 19001 : 19002;
                  return {
                    port,
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                    stop: Effect.sync(() => {
                      stoppedCount += 1;
                    }),
                  };
                }),
            }),
          );

          const evalRunnerLayer = Layer.effect(
            TrainingEvalRunner.TrainingEvalRunner,
            TrainingEvalRunner.makeWithOptions({
              runLocalCoding: (req) =>
                Effect.sync(() => {
                  codingModels.push(req.model);
                  return req.baseUrl.includes("19001")
                    ? { passRate: 0.5, passedCases: 6, totalCases: 12 }
                    : { passRate: 0.75, passedCases: 9, totalCases: 12 };
                }),
            }),
          ).pipe(
            Layer.provideMerge(TrainingStore.layer),
            Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
            Layer.provideMerge(gpuLayer),
            Layer.provideMerge(
              Layer.succeed(
                TrainerAdapter.TrainerRegistry,
                TrainerAdapter.makeTrainerRegistry([fakeAdapter]),
              ),
            ),
            Layer.provideMerge(adapterServerLayer),
          );

          yield* Effect.gen(function* () {
            yield* runMigrations();
            const store = yield* TrainingStore.TrainingStore;
            const runner = yield* TrainingEvalRunner.TrainingEvalRunner;

            const dataset = makeDataset(dsDir);
            const artifact = makeArtifact(dataset.id);
            yield* store.insertDataset(dataset);
            yield* store.insertJob({
              id: artifact.jobId,
              config: {
                name: "Job 1",
                backend: "mlx-lora",
                datasetId: dataset.id,
                baseModel: artifact.baseModel,
                fineTuneType: "lora",
                optimizer: "adamw",
                iters: 20,
                batchSize: 2,
                gradAccumulationSteps: 1,
                learningRate: 1e-5,
                maxSeqLength: 2048,
                maskPrompt: true,
                gradCheckpoint: true,
                stepsPerReport: 5,
                stepsPerEval: 10,
                saveEvery: 10,
                valBatches: 1,
                seed: 1,
                autoFuse: false,
                runTestEval: true,
                trustRemoteCode: false,
                pauseLocalInference: true,
                inferenceDrainTimeoutSec: 30,
              },
              status: "completed",
              latestMetric: null,
              recentMetrics: [],
              truncationWarningsCount: 0,
              artifact: null,
              jobDir: tmpRoot,
              createdAt: "2026-11-24T20:00:00.000Z",
              startedAt: "2026-11-24T20:01:00.000Z",
              completedAt: "2026-11-24T20:05:00.000Z",
            });
            yield* store.upsertArtifact(artifact);

            const pplResult = yield* runner.runComparison({
              evalRunId: TrainingEvalRunId.make("eval-ppl"),
              jobId: artifact.jobId,
              artifact,
              dataset,
              suite: "heldout_perplexity",
              reportDir: NodePath.join(tmpRoot, "eval-ppl"),
            });
            expect(pplResult.status).toBe("completed");
            expect(pplResult.baseSummary?.testLoss).toBe(2.1);
            expect(pplResult.tunedSummary?.testLoss).toBe(1.45);
            expect(NodeFS.existsSync(pplResult.reportPath!)).toBe(true);

            const codingResult = yield* runner.runComparison({
              evalRunId: TrainingEvalRunId.make("eval-coding"),
              jobId: artifact.jobId,
              artifact,
              dataset,
              suite: "local_coding",
              reportDir: NodePath.join(tmpRoot, "eval-coding"),
              samples: 1,
            });
            expect(codingResult.status).toBe("completed");
            expect(codingResult.baseSummary?.passRate).toBe(0.5);
            expect(codingResult.tunedSummary?.passRate).toBe(0.75);
            expect(servedCalls).toHaveLength(2);
            // Naming the base id would make mlx_lm.server reload the base without the adapter.
            expect(codingModels).toEqual(["default_model", "default_model"]);
            expect(stoppedCount).toBe(2);

            const saved = yield* store.listEvalRuns(artifact.id);
            expect(saved).toHaveLength(2);
          }).pipe(Effect.provide(evalRunnerLayer));
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
        }
      }),
  );
});
