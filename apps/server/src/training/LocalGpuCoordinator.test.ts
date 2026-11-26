import { describe, expect, it } from "@effect/vitest";
import {
  InferenceServerId,
  ThreadId,
  TrainingArtifactId,
  TrainingJobId,
  type InferenceServerSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as InferenceAdmission from "../inference/InferenceAdmission.ts";
import * as InferenceServerRegistry from "../inference/InferenceServerRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingStore from "./TrainingStore.ts";
import { sampleDataset, sampleJob } from "./TrainingStore.testFixtures.ts";

const storeLayer = TrainingStore.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const makeSnapshot = (id: string, baseUrl: string, enabled = true): InferenceServerSnapshot => ({
  id: InferenceServerId.make(id),
  displayName: id,
  baseUrl,
  enabled,
  status: "ready",
  checkedAt: "2026-11-24T20:00:00.000Z",
  models: [],
});

describe("LocalGpuCoordinator", () => {
  it("selects only enabled loopback inference servers", () => {
    const selected = LocalGpuCoordinator.selectLocalInferenceServerIds([
      makeSnapshot("local_mlx", "http://127.0.0.1:8080/v1", true),
      makeSnapshot("local_ollama", "http://localhost:11434/v1", true),
      makeSnapshot("local_disabled", "http://127.0.0.1:1234/v1", false),
      makeSnapshot("remote_gpu", "http://192.168.1.50:8000/v1", true),
    ]);
    expect(selected).toEqual([
      InferenceServerId.make("local_mlx"),
      InferenceServerId.make("local_ollama"),
    ]);
  });

  it.effect(
    "serializes concurrent GPU leases via Semaphore(1), pauses local inference, stops managed adapter servers, clears their serving port, and releases on scope close",
    () =>
      Effect.gen(function* () {
        const pausedLog: Array<ReadonlyArray<InferenceServerId>> = [];
        const releasedLog: Array<string> = [];
        const events: Array<string> = [];

        const releaseFirst = yield* Deferred.make<void>();
        const firstEntered = yield* Deferred.make<void>();

        const testLayer = LocalGpuCoordinator.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(
              InferenceServerRegistry.InferenceServerRegistry,
              InferenceServerRegistry.InferenceServerRegistry.of({
                current: Effect.succeed([
                  makeSnapshot("mlx_local", "http://127.0.0.1:8080/v1", true),
                  makeSnapshot("remote_box", "http://10.0.0.5:8080/v1", true),
                ]),
                streamChanges: Stream.empty,
                refresh: () => Effect.succeed([]),
                publishGatewayQueue: () => Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(
              InferenceAdmission.InferenceAdmission,
              InferenceAdmission.InferenceAdmission.of({
                admit: () => Effect.void,
                acquireExclusivePause: (input) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      pausedLog.push(input.serverIds);
                    }),
                    () =>
                      Effect.sync(() => {
                        releasedLog.push(input.reason);
                      }),
                  ),
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(
              TrainingAdapterServer.TrainingAdapterServer,
              TrainingAdapterServer.TrainingAdapterServer.of({
                start: () => Effect.die("unused"),
                stop: () => Effect.void,
                registerInInference: () => Effect.die("unused"),
                getActive: () => Effect.succeed(null),
                listActive: Effect.succeed([]),
                stopAllManaged: Effect.succeed([
                  {
                    artifactId: TrainingArtifactId.make("art-active"),
                    model: "org/model",
                    adapterPath: "/tmp/adapter",
                    mode: "adapter",
                    registeredServerId: null,
                  },
                ]),
                startTemporary: () => Effect.die("unused"),
              }),
            ),
          ),
          Layer.provideMerge(storeLayer),
        );

        yield* Effect.gen(function* () {
          yield* runMigrations();
          const store = yield* TrainingStore.TrainingStore;
          const dataset = sampleDataset("ds-1");
          const servedJob = sampleJob("job-served", "ds-1", "completed");
          const artifactId = TrainingArtifactId.make("art-active");
          yield* store.insertDataset(dataset);
          yield* store.insertJob(servedJob);
          yield* store.upsertArtifact({
            id: artifactId,
            jobId: servedJob.id,
            datasetId: dataset.id,
            baseModel: servedJob.config.baseModel,
            fineTuneType: "lora",
            adapterPath: "/tmp/adapter",
            fusedModelPath: null,
            ggufPath: null,
            provenanceHash: "b".repeat(64),
            sourceThreadIds: [ThreadId.make("thread-1")],
            registeredInferenceServerId: null,
            servingPort: 18081,
            createdAt: "2026-11-24T20:10:00.000Z",
          });

          const coordinator = yield* LocalGpuCoordinator.LocalGpuCoordinator;
          const job1 = TrainingJobId.make("job-1");
          const job2 = TrainingJobId.make("job-2");

          const fiber1 = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                yield* coordinator.acquireLease({
                  jobId: job1,
                  reason: "training:job-1",
                  pauseLocalInference: true,
                  drainTimeout: Duration.seconds(30),
                  onDraining: () => Effect.sync(() => void events.push("drain-1")),
                });
                events.push("acquired-1");
                expect(yield* coordinator.currentLease).toBe(job1);
                yield* Deferred.succeed(firstEntered, undefined);
                yield* Deferred.await(releaseFirst);
                events.push("releasing-1");
              }),
            ),
          );

          yield* Deferred.await(firstEntered);

          const fiber2 = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                yield* coordinator.acquireLease({
                  jobId: job2,
                  reason: "training:job-2",
                  pauseLocalInference: true,
                  drainTimeout: Duration.seconds(30),
                });
                events.push("acquired-2");
                expect(yield* coordinator.currentLease).toBe(job2);
              }),
            ),
          );

          // Job 2 must wait until job 1 releases the semaphore
          yield* Effect.yieldNow;
          expect(events).toEqual(["drain-1", "acquired-1"]);

          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(fiber1);
          yield* Fiber.join(fiber2);

          expect(events).toEqual(["drain-1", "acquired-1", "releasing-1", "acquired-2"]);
          expect(yield* coordinator.currentLease).toBeNull();
          expect(pausedLog).toEqual([
            [InferenceServerId.make("mlx_local")],
            [InferenceServerId.make("mlx_local")],
          ]);
          expect(releasedLog).toEqual(["training:job-1", "training:job-2"]);
          expect((yield* store.getArtifact(artifactId))?.servingPort).toBeNull();
        }).pipe(Effect.provide(testLayer));
      }),
  );

  it.effect(
    "surfaces inference_drain_timeout and clears activeLeaseJobId when drain times out",
    () =>
      Effect.gen(function* () {
        const testLayer = LocalGpuCoordinator.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(
              InferenceServerRegistry.InferenceServerRegistry,
              InferenceServerRegistry.InferenceServerRegistry.of({
                current: Effect.succeed([
                  makeSnapshot("mlx_local", "http://127.0.0.1:8080/v1", true),
                ]),
                streamChanges: Stream.empty,
                refresh: () => Effect.succeed([]),
                publishGatewayQueue: () => Effect.void,
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(
              InferenceAdmission.InferenceAdmission,
              InferenceAdmission.InferenceAdmission.of({
                admit: () => Effect.void,
                acquireExclusivePause: (input) =>
                  Effect.fail(
                    new InferenceAdmission.InferenceDrainTimeoutError({
                      message: "busy",
                      serverIds: [...input.serverIds],
                    }),
                  ),
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(
              TrainingAdapterServer.TrainingAdapterServer,
              TrainingAdapterServer.TrainingAdapterServer.of({
                start: () => Effect.die("unused"),
                stop: () => Effect.void,
                registerInInference: () => Effect.die("unused"),
                getActive: () => Effect.succeed(null),
                listActive: Effect.succeed([]),
                stopAllManaged: Effect.succeed([]),
                startTemporary: () => Effect.die("unused"),
              }),
            ),
          ),
          Layer.provideMerge(storeLayer),
        );

        yield* Effect.gen(function* () {
          const coordinator = yield* LocalGpuCoordinator.LocalGpuCoordinator;
          const scope = yield* Scope.make();
          const exit = yield* Effect.exit(
            coordinator
              .acquireLease({
                jobId: TrainingJobId.make("job-timeout"),
                reason: "training:job-timeout",
                pauseLocalInference: true,
                drainTimeout: Duration.seconds(5),
              })
              .pipe(Scope.provide(scope)),
          );
          yield* Scope.close(scope, Exit.void);

          expect(Exit.isFailure(exit)).toBe(true);
          expect(String(exit)).toContain("inference_drain_timeout");
          expect(yield* coordinator.currentLease).toBeNull();
        }).pipe(Effect.provide(testLayer));
      }),
  );
});
