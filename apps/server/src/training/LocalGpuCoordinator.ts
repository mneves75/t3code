import type { InferenceServerId, InferenceServerSnapshot, TrainingJobId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as InferenceAdmission from "../inference/InferenceAdmission.ts";
import * as InferenceServerRegistry from "../inference/InferenceServerRegistry.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingStore from "./TrainingStore.ts";

export class LocalGpuLeaseError extends Schema.TaggedError<LocalGpuLeaseError>()(
  "LocalGpuLeaseError",
  {
    code: Schema.Literals(["inference_drain_timeout", "adapter_server_stop_failed"]),
    jobId: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Local GPU lease failed for '${this.jobId}' (${this.code}): ${this.reason}`;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

function isLoopbackInferenceUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function selectLocalInferenceServerIds(
  snapshots: ReadonlyArray<InferenceServerSnapshot>,
): ReadonlyArray<InferenceServerId> {
  return snapshots
    .filter((snapshot) => snapshot.enabled && isLoopbackInferenceUrl(snapshot.baseUrl))
    .map((snapshot) => snapshot.id);
}

export interface AcquireGpuLeaseInput {
  readonly jobId: TrainingJobId;
  readonly reason: string;
  readonly pauseLocalInference: boolean;
  readonly drainTimeout: Duration.Duration;
  readonly onDraining?: () => Effect.Effect<void>;
}

export class LocalGpuCoordinator extends Context.Service<
  LocalGpuCoordinator,
  {
    readonly activeLeaseJobId: SubscriptionRef.SubscriptionRef<TrainingJobId | null>;
    readonly currentLease: Effect.Effect<TrainingJobId | null>;
    readonly acquireLease: (
      input: AcquireGpuLeaseInput,
    ) => Effect.Effect<void, LocalGpuLeaseError, Scope.Scope>;
  }
>()("t3/training/LocalGpuCoordinator") {}

const make = Effect.gen(function* () {
  const inferenceAdmission = yield* InferenceAdmission.InferenceAdmission;
  const inferenceRegistry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const adapterServer = yield* TrainingAdapterServer.TrainingAdapterServer;
  const store = yield* TrainingStore.TrainingStore;

  const semaphore = yield* Semaphore.make(1);
  const activeLeaseJobId = yield* SubscriptionRef.make<TrainingJobId | null>(null);

  const acquireLease = Effect.fn("LocalGpuCoordinator.acquireLease")(function* (
    input: AcquireGpuLeaseInput,
  ): Effect.fn.Return<void, LocalGpuLeaseError, Scope.Scope> {
    yield* Effect.acquireRelease(semaphore.take(1), () => semaphore.release(1));

    yield* Effect.acquireRelease(SubscriptionRef.set(activeLeaseJobId, input.jobId), () =>
      SubscriptionRef.set(activeLeaseJobId, null),
    );

    if (!input.pauseLocalInference) {
      return;
    }

    if (input.onDraining !== undefined) {
      yield* input.onDraining();
    }

    const snapshots = yield* inferenceRegistry.current;
    const localServerIds = selectLocalInferenceServerIds(snapshots);

    if (localServerIds.length > 0) {
      yield* inferenceAdmission
        .acquireExclusivePause({
          reason: input.reason,
          serverIds: localServerIds,
          drainTimeout: input.drainTimeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LocalGpuLeaseError({
                code: "inference_drain_timeout",
                jobId: input.jobId,
                reason: `Timed out waiting for local inference server(s) to drain within ${Duration.toSeconds(input.drainTimeout)}s.`,
                cause,
              }),
          ),
        );
    }

    const stoppedServers = yield* adapterServer.stopAllManaged;
    yield* Effect.forEach(
      stoppedServers,
      (server) =>
        store.updateArtifact(server.artifactId, { servingPort: null }).pipe(Effect.ignore),
      { discard: true },
    );
  });

  return LocalGpuCoordinator.of({
    activeLeaseJobId,
    currentLease: SubscriptionRef.get(activeLeaseJobId),
    acquireLease,
  });
});

export const layer = Layer.effect(LocalGpuCoordinator, make);
