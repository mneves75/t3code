// @effect-diagnostics nodeBuiltinImport:off -- verifies files materialized on disk in live test
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  TRAINING_LOG_MAX_BYTES,
  ThreadId,
  TrainingJobId,
  type RedactionOptions,
  type TrainingDatasetFilter,
  type TrainingJobConfig,
  type TrainingMetricTick,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as InferenceAdmission from "../inference/InferenceAdmission.ts";
import * as InferenceServerRegistry from "../inference/InferenceServerRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DatasetExtractor from "./DatasetExtractor.ts";
import * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
import * as SecretRedactor from "./SecretRedactor.ts";
import * as TrainerAdapter from "./TrainerAdapter.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingEvalRunner from "./TrainingEvalRunner.ts";
import * as TrainingService from "./TrainingService.ts";
import * as TrainingStore from "./TrainingStore.ts";

const DEFAULT_FILTER: TrainingDatasetFilter = {
  settledOnly: false,
  includeArchived: false,
  includeSubagents: false,
  minCompletedRuns: 1,
  includeToolCalls: true,
  includeReasoning: false,
  includeCheckpointDiffs: false,
  maxToolOutputChars: 2000,
  split: { validRatio: 0, testRatio: 0, seed: 42 },
};

const DEFAULT_REDACTION: RedactionOptions = {
  redactEnvAssignments: true,
  redactHomePaths: true,
  redactEmails: true,
  redactHighEntropy: true,
};

describe("TrainingService", () => {
  it("validates storage directory containment and rejects protected overlaps", () => {
    const checkRoot = TrainingService.validateSafeStorageDir("/", []);
    expect(checkRoot.ok).toBe(false);

    const checkOverlap = TrainingService.validateSafeStorageDir("/tmp/t3/state/secrets/sub", [
      "/tmp/t3/state/secrets",
    ]);
    expect(checkOverlap.ok).toBe(false);

    const sshDir = NodePath.join(NodeOS.homedir(), ".ssh");
    const checkOutsideAllowed = TrainingService.validateSafeStorageDir(
      sshDir,
      [],
      ["/tmp/t3-training-allowed"],
    );
    expect(checkOutsideAllowed.ok).toBe(false);

    const checkInsideAllowed = TrainingService.validateSafeStorageDir(
      "/tmp/t3-training-allowed/sub",
      [],
      ["/tmp/t3-training-allowed"],
    );
    expect(checkInsideAllowed.ok).toBe(true);

    expect(
      TrainingService.isPathContainedWithin(
        "/tmp/training-root",
        "/tmp/training-root/datasets/ds1",
      ),
    ).toBe(true);
    expect(
      TrainingService.isPathContainedWithin(
        "/tmp/training-root",
        "/tmp/training-root/../etc/passwd",
      ),
    ).toBe(false);
  });

  it.live(
    "orchestrates curation, dataset creation, queued training job completion, bounded logs, and deletion containment",
    () =>
      Effect.gen(function* () {
        const jobFinishedDeferred = yield* Deferred.make<void>();
        const fakeAdapter: TrainerAdapter.TrainerAdapter = {
          id: "mlx-lora",
          probeCapabilities: Effect.succeed({
            id: "mlx-lora",
            available: true,
            binaryPath: "/usr/local/bin/mlx_lm.lora",
            version: "0.32.2",
            supportedObjectives: ["sft"],
            supportedFineTuneTypes: ["lora", "dora", "full"],
            supportsFuse: true,
            supportsGgufExport: true,
            supportsAdapterServing: true,
          }),
          startTraining: (input) =>
            Effect.gen(function* () {
              const tick: TrainingMetricTick = {
                iter: 10,
                totalIters: input.config.iters,
                trainLoss: 1.5,
                tokSec: 1200,
                trainedTokens: 4000,
                recordedAt: "2026-11-24T21:00:00.000Z",
              };
              const adapterPath = NodePath.join(input.jobDir, "adapters");
              yield* Effect.promise(async () => {
                await NodeFSP.mkdir(adapterPath, { recursive: true });
                await NodeFSP.writeFile(input.logFilePath, "line 1\n".repeat(15_000), "utf8");
              });
              const q = yield* Queue.unbounded<TrainingMetricTick | null>();
              yield* Queue.offer(q, tick);
              yield* Queue.offer(q, null);
              return {
                pid: 4242,
                metrics: Stream.fromQueue(q).pipe(
                  Stream.takeWhile((item): item is TrainingMetricTick => item !== null),
                ),
                warnings: Stream.empty,
                completion: Effect.succeed({
                  adapterPath,
                  testLoss: 1.25,
                  testPerplexity: 3.49,
                }).pipe(Effect.tap(() => Deferred.succeed(jobFinishedDeferred, undefined))),
                cancel: Effect.void,
              };
            }),
          fuse: (input) =>
            Effect.succeed({
              fusedModelPath: input.savePath,
              ggufPath: null,
            }),
        };

        const baseInfra = Layer.mergeAll(
          NodeServices.layer,
          NodeSqliteClient.layer({ filename: ":memory:" }),
          ServerSettings.layerTest(),
        );
        const configLayer = ServerConfig.layerTest("/tmp", { prefix: "t3-train-svc-" }).pipe(
          Layer.provideMerge(baseInfra),
        );
        const inferenceMocks = Layer.mergeAll(
          Layer.succeed(
            InferenceServerRegistry.InferenceServerRegistry,
            InferenceServerRegistry.InferenceServerRegistry.of({
              current: Effect.succeed([]),
              streamChanges: Stream.empty,
              refresh: () => Effect.succeed([]),
              publishGatewayQueue: () => Effect.void,
            }),
          ),
          Layer.succeed(
            InferenceAdmission.InferenceAdmission,
            InferenceAdmission.InferenceAdmission.of({
              admit: () => Effect.void,
              acquireExclusivePause: () => Effect.void,
            }),
          ),
        );

        const trainingDeps = Layer.mergeAll(
          TrainingStore.layer,
          DatasetExtractor.layer.pipe(Layer.provideMerge(SecretRedactor.layer)),
          Layer.succeed(
            TrainerAdapter.TrainerRegistry,
            TrainerAdapter.makeTrainerRegistry([fakeAdapter]),
          ),
          TrainingAdapterServer.layer,
        ).pipe(Layer.provideMerge(inferenceMocks), Layer.provideMerge(configLayer));

        const coordinatorAndEval = Layer.mergeAll(
          LocalGpuCoordinator.layer,
          TrainingEvalRunner.layer.pipe(Layer.provide(LocalGpuCoordinator.layer)),
        ).pipe(Layer.provideMerge(trainingDeps));

        const fullLayer = TrainingService.layer.pipe(Layer.provideMerge(coordinatorAndEval));

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* runMigrations();
            const sql = yield* SqlClient.SqlClient;
            const service = yield* TrainingService.TrainingService;

            // Seed one durable thread
            const tid = ThreadId.make("thread-svc-1");
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
              ) VALUES (
                ${tid}, 'proj-1', 'Svc Thread', 'codex', 'full-access', 'default',
                NULL, '2026-11-24T18:00:00.000Z', '2026-11-24T18:05:00.000Z', NULL, NULL,
                ${JSON.stringify({ providerInstanceId: "codex", lineage: { relationshipToParent: "root" } })}
              )
            `;
            yield* sql`
              INSERT INTO orchestration_v2_projection_runs (
                run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
              ) VALUES (
                'run-svc-1', ${tid}, 1, 'codex', 'pt-1', 'completed',
                '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'
              )
            `;
            yield* sql`
              INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
                parent_item_id, ordinal, type, status, updated_at, payload_json
              ) VALUES
                ('ti-1', ${tid}, 'run-svc-1', 'n1', 'pt-1', 't1', NULL, 1, 'user_message', 'completed', '2026-11-24T18:01:00.000Z', ${JSON.stringify({ messageId: "m1", text: "Write hello world" })}),
                ('ti-2', ${tid}, 'run-svc-1', 'n1', 'pt-1', 't1', NULL, 2, 'assistant_message', 'completed', '2026-11-24T18:02:00.000Z', ${JSON.stringify({ messageId: "m2", text: "print('hello world')", streaming: false })})
            `;

            const curatedRes = yield* service.setCuratedThread({
              threadId: tid,
              curated: true,
              note: "clean example",
            });
            expect(curatedRes.curated).toBe(true);
            expect((yield* service.listCuratedThreads({})).threads).toHaveLength(1);

            const caps = yield* service.getCapabilities;
            expect(caps.backends[0]?.id).toBe("mlx-lora");
            expect(caps.backends[0]?.available).toBe(true);

            const dataset = yield* service.createDataset({
              name: "Svc Dataset",
              objective: "sft",
              filter: DEFAULT_FILTER,
              redactionOptions: DEFAULT_REDACTION,
            });
            expect(dataset.trainCount).toBe(1);
            expect(NodeFS.existsSync(NodePath.join(dataset.storagePath, "train.jsonl"))).toBe(true);

            // Subscribe and start job
            const jobConfig: TrainingJobConfig = {
              name: "Smoke Job",
              backend: "mlx-lora",
              datasetId: dataset.id,
              baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
              fineTuneType: "lora",
              optimizer: "adamw",
              iters: 10,
              batchSize: 1,
              gradAccumulationSteps: 1,
              learningRate: 1e-5,
              maxSeqLength: 2048,
              maskPrompt: true,
              gradCheckpoint: true,
              stepsPerReport: 5,
              stepsPerEval: 10,
              saveEvery: 10,
              valBatches: 0,
              seed: 42,
              autoFuse: false,
              runTestEval: false,
              trustRemoteCode: false,
              pauseLocalInference: true,
              inferenceDrainTimeoutSec: 30,
            };

            const job = yield* service.startJob({ config: jobConfig });
            expect(job.status).toBe("queued");

            yield* Deferred.await(jobFinishedDeferred);

            // Wait for background fiber to persist completion by collecting from subscribe snapshot/updates
            const finalEvent = yield* service.subscribe.pipe(
              Stream.filter(
                (event) =>
                  (event.type === "snapshot" &&
                    event.jobs.some((j) => j.id === job.id && j.status === "completed")) ||
                  (event.type === "job_updated" &&
                    event.job.id === job.id &&
                    event.job.status === "completed"),
              ),
              Stream.take(1),
              Stream.runCollect,
            );
            expect([...finalEvent]).toHaveLength(1);

            const loaded = yield* service.getJob({ jobId: job.id });
            expect(loaded.job?.status).toBe("completed");
            expect(loaded.job?.artifact?.testLoss).toBe(1.25);

            // Bounded logs <= 64 KB
            const logs = yield* service.getJobLogs({ jobId: job.id });
            expect(Buffer.byteLength(logs.content, "utf8")).toBeLessThanOrEqual(
              TRAINING_LOG_MAX_BYTES,
            );
            expect(logs.truncated).toBe(true);

            // Delete dataset cleans up files safely
            const delRes = yield* service.deleteDataset({ datasetId: dataset.id });
            expect(delRes.deleted).toBe(true);
            expect(NodeFS.existsSync(dataset.storagePath)).toBe(false);

            // SEC-02: outputBaseDir outside allowed roots (e.g. ~/.ssh) is rejected
            const badOutputExit = yield* Effect.exit(
              service.createDataset({
                name: "Blocked Dataset",
                objective: "sft",
                filter: DEFAULT_FILTER,
                redactionOptions: DEFAULT_REDACTION,
                outputBaseDir: NodePath.join(NodeOS.homedir(), ".ssh"),
              }),
            );
            expect(Exit.isFailure(badOutputExit)).toBe(true);

            // Missing job returns not_found error on cancel
            const missingExit = yield* Effect.exit(
              service.cancelJob({ jobId: TrainingJobId.make("job-missing") }),
            );
            expect(Exit.isFailure(missingExit)).toBe(true);
          }).pipe(Effect.provide(fullLayer)),
        );
      }),
  );

  it.live("runs runEval asynchronously and emits running + completed eval_updated events", () =>
    Effect.gen(function* () {
      const evalGate = yield* Deferred.make<void>();
      const baseInfra = Layer.mergeAll(
        NodeServices.layer,
        NodeSqliteClient.layer({ filename: ":memory:" }),
        ServerSettings.layerTest(),
      );
      const configLayer = ServerConfig.layerTest("/tmp", { prefix: "t3-train-eval-async-" }).pipe(
        Layer.provideMerge(baseInfra),
      );
      const inferenceMocks = Layer.mergeAll(
        Layer.succeed(
          InferenceServerRegistry.InferenceServerRegistry,
          InferenceServerRegistry.InferenceServerRegistry.of({
            current: Effect.succeed([]),
            streamChanges: Stream.empty,
            refresh: () => Effect.succeed([]),
            publishGatewayQueue: () => Effect.void,
          }),
        ),
        Layer.succeed(
          InferenceAdmission.InferenceAdmission,
          InferenceAdmission.InferenceAdmission.of({
            admit: () => Effect.void,
            acquireExclusivePause: () => Effect.void,
          }),
        ),
      );
      const fakeAdapter: TrainerAdapter.TrainerAdapter = {
        id: "mlx-lora",
        probeCapabilities: Effect.succeed({
          id: "mlx-lora",
          available: true,
          binaryPath: "/usr/local/bin/mlx_lm.lora",
          version: "0.32.2",
          supportedObjectives: ["sft"],
          supportedFineTuneTypes: ["lora", "dora", "full"],
          supportsFuse: true,
          supportsGgufExport: false,
          supportsAdapterServing: true,
        }),
        startTraining: () => Effect.die("unused"),
        fuse: () => Effect.die("unused"),
        runTestEval: (input) =>
          Deferred.await(evalGate).pipe(
            Effect.as(
              input.adapterPath === null
                ? { testLoss: 2.2, testPerplexity: 9.03 }
                : { testLoss: 1.4, testPerplexity: 4.06 },
            ),
          ),
      };

      const trainingDeps = Layer.mergeAll(
        TrainingStore.layer,
        DatasetExtractor.layer.pipe(Layer.provideMerge(SecretRedactor.layer)),
        Layer.succeed(
          TrainerAdapter.TrainerRegistry,
          TrainerAdapter.makeTrainerRegistry([fakeAdapter]),
        ),
        TrainingAdapterServer.layer,
      ).pipe(Layer.provideMerge(inferenceMocks), Layer.provideMerge(configLayer));

      const coordinatorAndEval = Layer.mergeAll(
        LocalGpuCoordinator.layer,
        TrainingEvalRunner.layer.pipe(Layer.provide(LocalGpuCoordinator.layer)),
      ).pipe(Layer.provideMerge(trainingDeps));

      const fullLayer = TrainingService.layer.pipe(Layer.provideMerge(coordinatorAndEval));

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const store = yield* TrainingStore.TrainingStore;
          const service = yield* TrainingService.TrainingService;
          const cfg = yield* ServerConfig.ServerConfig;

          const dsDir = NodePath.join(cfg.stateDir, "training", "datasets", "ds-async");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(dsDir, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(dsDir, "test.jsonl"), '{"messages":[]}\n');
          });
          const dataset = {
            id: "ds-async" as never,
            name: "Async Eval DS",
            objective: "sft" as const,
            filter: DEFAULT_FILTER,
            redactionOptions: DEFAULT_REDACTION,
            redactionAudit: SecretRedactor.createRedactionAuditCollector().toReport(),
            storagePath: dsDir,
            provenanceHash: "a".repeat(64),
            sourceThreadIds: [],
            trainCount: 2,
            validCount: 1,
            testCount: 1,
            estimatedTokens: 100,
            sizeBytes: 100,
            createdAt: "2026-11-24T20:00:00.000Z",
          };
          yield* store.insertDataset(dataset);
          const jobDir = NodePath.join(cfg.stateDir, "training", "jobs", "job-async");
          yield* store.insertJob({
            id: TrainingJobId.make("job-async"),
            config: {
              name: "Job Async",
              backend: "mlx-lora",
              datasetId: dataset.id,
              baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
              fineTuneType: "lora",
              optimizer: "adamw",
              iters: 10,
              batchSize: 1,
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
              runTestEval: false,
              trustRemoteCode: false,
              pauseLocalInference: false,
              inferenceDrainTimeoutSec: 30,
            },
            status: "completed",
            latestMetric: null,
            recentMetrics: [],
            truncationWarningsCount: 0,
            artifact: null,
            jobDir,
            createdAt: "2026-11-24T20:00:00.000Z",
            startedAt: "2026-11-24T20:01:00.000Z",
            completedAt: "2026-11-24T20:02:00.000Z",
          });
          yield* store.upsertArtifact({
            id: "art-async" as never,
            jobId: TrainingJobId.make("job-async"),
            datasetId: dataset.id,
            baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
            fineTuneType: "lora",
            adapterPath: NodePath.join(jobDir, "adapters"),
            fusedModelPath: null,
            ggufPath: null,
            provenanceHash: "b".repeat(64),
            sourceThreadIds: [],
            registeredInferenceServerId: null,
            servingPort: null,
            createdAt: "2026-11-24T20:02:00.000Z",
          });

          // Subscribe before starting eval so we observe eval_updated events
          const completedWaiter = yield* service.subscribe.pipe(
            Stream.filter(
              (event) => event.type === "eval_updated" && event.evalRun.status === "completed",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );

          // RPC returns immediately with status "running" while evalGate is still locked
          const started = yield* service.runEval({
            artifactId: "art-async" as never,
            suite: "heldout_perplexity",
          });
          expect(started.status).toBe("running");

          yield* Deferred.succeed(evalGate, undefined);
          const events = [...(yield* Fiber.join(completedWaiter))];
          expect(events).toHaveLength(1);
          const stored = yield* service.getEval({ evalRunId: started.id });
          expect(stored.evalRun?.status).toBe("completed");
          expect(stored.evalRun?.tunedSummary?.testLoss).toBe(1.4);

          // T3-02: deleteDataset refuses to tombstone row if storagePath exists outside active allowedRoots
          const externalDir = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-outside-root-ds-")),
          );
          try {
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(externalDir, "train.jsonl"), '{"messages":[]}\n'),
            );
            yield* store.insertDataset({
              ...dataset,
              id: "ds-outside-root" as never,
              name: "Outside Root DS",
              storagePath: externalDir,
            });
            const blockedDelete = yield* Effect.exit(
              service.deleteDataset({ datasetId: "ds-outside-root" as never }),
            );
            expect(Exit.isFailure(blockedDelete)).toBe(true);
            const stillPresent = yield* store.getDataset("ds-outside-root" as never);
            expect(stillPresent).not.toBeNull();
            expect(NodeFS.existsSync(externalDir)).toBe(true);
          } finally {
            yield* Effect.promise(() => NodeFSP.rm(externalDir, { recursive: true, force: true }));
          }
        }).pipe(Effect.provide(fullLayer)),
      );
    }),
  );
});
