// @effect-diagnostics nodeBuiltinImport:off -- realpath containment, statfs roots, bounded log slices, and adapter provenance SHA-256
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  TRAINING_LOG_MAX_BYTES,
  TrainingArtifactId,
  TrainingDatasetId,
  TrainingEvalRunId,
  TrainingJobId,
  TrainingOperationError,
  type TrainingArtifact,
  type TrainingCancelJobInput,
  type TrainingCapabilitiesResult,
  type TrainingConvertDpoDatasetToSftInput,
  type TrainingCreateDatasetInput,
  type TrainingDatasetPreview,
  type TrainingDatasetSummary,
  type TrainingDeleteDatasetInput,
  type TrainingDeleteDatasetResult,
  type TrainingEvalComparison,
  type TrainingFuseArtifactInput,
  type TrainingGetDatasetInput,
  type TrainingGetDatasetResult,
  type TrainingGetEvalInput,
  type TrainingGetEvalResult,
  type TrainingGetJobInput,
  type TrainingGetJobLogsInput,
  type TrainingGetJobLogsResult,
  type TrainingGetJobResult,
  type TrainingJobSnapshot,
  type TrainingJobStreamEvent,
  type TrainingListArtifactsResult,
  type TrainingListCuratedThreadsInput,
  type TrainingListCuratedThreadsResult,
  type TrainingListDatasetsResult,
  type TrainingListEvalsInput,
  type TrainingListEvalsResult,
  type TrainingListJobsResult,
  type TrainingMetricTick,
  type TrainingPreviewDatasetInput,
  type TrainingRegisterArtifactInInferenceInput,
  type TrainingRegisterArtifactInInferenceResult,
  type TrainingRunEvalInput,
  type TrainingServeArtifactInput,
  type TrainingServeArtifactResult,
  type TrainingSetCuratedThreadInput,
  type TrainingSetCuratedThreadResult,
  type TrainingStartJobInput,
  type TrainingStopServedArtifactInput,
  type TrainingStorageRootInfo,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DatasetExtractor from "./DatasetExtractor.ts";
import * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
import { getFreeDiskBytes, scanCachedHfModels } from "./MlxLoraTrainer.ts";
import * as TrainerAdapter from "./TrainerAdapter.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingEvalRunner from "./TrainingEvalRunner.ts";
import * as TrainingStore from "./TrainingStore.ts";

const MAX_RECENT_METRICS = 500;
const MAX_RECENT_METRICS_JOBS = 50;
const METRIC_BROADCAST_MIN_INTERVAL_MS = 500;
const EVENT_PUBSUB_CAPACITY = 256;
const FORBIDDEN_ROOTS = new Set(["/", "/etc", "/usr", "/bin", "/sbin", "/System", "/Library"]);

function resolvePathForContainment(target: string): string {
  const resolved = NodePath.resolve(target);
  try {
    return NodeFS.realpathSync(resolved);
  } catch {
    const parent = NodePath.dirname(resolved);
    if (parent === resolved) return resolved;
    return NodePath.join(resolvePathForContainment(parent), NodePath.basename(resolved));
  }
}

function pathsOverlap(a: string, b: string): boolean {
  const normA = resolvePathForContainment(a);
  const normB = resolvePathForContainment(b);
  return (
    normA === normB ||
    normA.startsWith(`${normB}${NodePath.sep}`) ||
    normB.startsWith(`${normA}${NodePath.sep}`)
  );
}

export function isPathContainedWithin(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = resolvePathForContainment(rootDir);
  const resolvedTarget = resolvePathForContainment(targetPath);
  return resolvedTarget.startsWith(`${resolvedRoot}${NodePath.sep}`);
}

function isPathEqualOrContainedWithin(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = resolvePathForContainment(rootDir);
  const resolvedTarget = resolvePathForContainment(targetPath);
  return (
    resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${NodePath.sep}`)
  );
}

export function validateSafeStorageDir(
  candidate: string,
  protectedPaths: ReadonlyArray<string>,
  allowedRoots?: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly reason: string } {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return { ok: false, reason: "Storage directory path must be a non-empty valid path." };
  }
  const resolved = resolvePathForContainment(trimmed);
  if (FORBIDDEN_ROOTS.has(resolved)) {
    return { ok: false, reason: `Storage directory '${resolved}' is a protected system path.` };
  }
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(resolved, protectedPath)) {
      return {
        ok: false,
        reason: "Storage directory must not overlap T3 state database, secrets, or worktrees.",
      };
    }
  }
  if (allowedRoots !== undefined) {
    const allowed = allowedRoots.some((root) => isPathEqualOrContainedWithin(root, resolved));
    if (!allowed) {
      return {
        ok: false,
        reason:
          "Storage directory override must stay within an allowed training storage root (default T3 training directory, configured storageDir, T3_TRAINING_DIR, or a mounted external volume).",
      };
    }
  }
  return { ok: true, resolvedPath: resolved };
}

async function computeAdapterProvenanceHash(input: {
  readonly datasetProvenanceHash: string;
  readonly config: TrainingStartJobInput["config"];
  readonly adapterPath: string;
}): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(input.datasetProvenanceHash);
  hash.update("\n");
  hash.update(JSON.stringify(input.config));
  try {
    const entries = (await NodeFSP.readdir(input.adapterPath)).toSorted();
    for (const entry of entries) {
      if (!entry.endsWith(".safetensors") && entry !== "adapter_config.json") continue;
      const fullPath = NodePath.join(input.adapterPath, entry);
      const bytes = await NodeFSP.readFile(fullPath);
      hash.update(entry);
      hash.update(bytes);
    }
  } catch {
    // Adapter directory may be virtual in unit tests
  }
  return hash.digest("hex");
}

async function discoverStorageRoots(
  defaultTrainingDir: string,
  activeStorageDir: string,
  platform: string,
): Promise<ReadonlyArray<TrainingStorageRootInfo>> {
  const roots: Array<TrainingStorageRootInfo> = [];
  const seen = new Set<string>();

  const addRoot = async (dirPath: string, label: string, isExternal: boolean) => {
    const resolved = resolvePathForContainment(dirPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      let probe = resolved;
      while (!NodeFS.existsSync(probe)) {
        const parent = NodePath.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      const stats = await NodeFSP.statfs(probe);
      const bsize = Number(stats.bsize);
      roots.push({
        path: resolved,
        label,
        freeBytes: Math.max(0, Math.floor(Number(stats.bavail) * bsize)),
        totalBytes: Math.max(0, Math.floor(Number(stats.blocks) * bsize)),
        isExternal,
      });
    } catch {
      // Skip inaccessible mount
    }
  };

  await addRoot(defaultTrainingDir, "Default T3 Storage", false);
  if (
    resolvePathForContainment(activeStorageDir) !== resolvePathForContainment(defaultTrainingDir)
  ) {
    await addRoot(
      activeStorageDir,
      "Active Training Storage",
      activeStorageDir.startsWith("/Volumes/"),
    );
  }

  if (platform === "darwin") {
    try {
      const volumes = await NodeFSP.readdir("/Volumes");
      for (const vol of volumes.toSorted()) {
        if (vol === "Macintosh HD" || vol.startsWith(".")) continue;
        const volPath = NodePath.join("/Volumes", vol);
        try {
          const stat = await NodeFSP.lstat(volPath);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          await addRoot(NodePath.join(volPath, "t3-training"), `External: ${vol}`, true);
        } catch {
          continue;
        }
      }
    } catch {
      // Ignore if /Volumes is unreadable
    }
  }

  return roots;
}

interface ActiveJobRuntime {
  readonly cancel: () => Effect.Effect<void>;
  readonly fiber: Fiber.Fiber<void, never>;
}

export class TrainingService extends Context.Service<
  TrainingService,
  {
    readonly listCuratedThreads: (
      input: TrainingListCuratedThreadsInput,
    ) => Effect.Effect<TrainingListCuratedThreadsResult, TrainingOperationError>;
    readonly setCuratedThread: (
      input: TrainingSetCuratedThreadInput,
    ) => Effect.Effect<TrainingSetCuratedThreadResult, TrainingOperationError>;
    readonly getCapabilities: Effect.Effect<TrainingCapabilitiesResult, TrainingOperationError>;
    readonly listDatasets: Effect.Effect<TrainingListDatasetsResult, TrainingOperationError>;
    readonly getDataset: (
      input: TrainingGetDatasetInput,
    ) => Effect.Effect<TrainingGetDatasetResult, TrainingOperationError>;
    readonly previewDataset: (
      input: TrainingPreviewDatasetInput,
    ) => Effect.Effect<TrainingDatasetPreview, TrainingOperationError>;
    readonly createDataset: (
      input: TrainingCreateDatasetInput,
    ) => Effect.Effect<TrainingDatasetSummary, TrainingOperationError>;
    readonly convertDpoDatasetToSft: (
      input: TrainingConvertDpoDatasetToSftInput,
    ) => Effect.Effect<TrainingDatasetSummary, TrainingOperationError>;
    readonly deleteDataset: (
      input: TrainingDeleteDatasetInput,
    ) => Effect.Effect<TrainingDeleteDatasetResult, TrainingOperationError>;
    readonly listJobs: Effect.Effect<TrainingListJobsResult, TrainingOperationError>;
    readonly getJob: (
      input: TrainingGetJobInput,
    ) => Effect.Effect<TrainingGetJobResult, TrainingOperationError>;
    readonly getJobLogs: (
      input: TrainingGetJobLogsInput,
    ) => Effect.Effect<TrainingGetJobLogsResult, TrainingOperationError>;
    readonly subscribe: Stream.Stream<TrainingJobStreamEvent, TrainingOperationError>;
    readonly startJob: (
      input: TrainingStartJobInput,
    ) => Effect.Effect<TrainingJobSnapshot, TrainingOperationError>;
    readonly cancelJob: (
      input: TrainingCancelJobInput,
    ) => Effect.Effect<TrainingJobSnapshot, TrainingOperationError>;
    readonly fuseArtifact: (
      input: TrainingFuseArtifactInput,
    ) => Effect.Effect<TrainingArtifact, TrainingOperationError>;
    readonly serveArtifact: (
      input: TrainingServeArtifactInput,
    ) => Effect.Effect<TrainingServeArtifactResult, TrainingOperationError>;
    readonly stopServedArtifact: (
      input: TrainingStopServedArtifactInput,
    ) => Effect.Effect<TrainingArtifact, TrainingOperationError>;
    readonly registerArtifactInInference: (
      input: TrainingRegisterArtifactInInferenceInput,
    ) => Effect.Effect<TrainingRegisterArtifactInInferenceResult, TrainingOperationError>;
    readonly runEval: (
      input: TrainingRunEvalInput,
    ) => Effect.Effect<TrainingEvalComparison, TrainingOperationError>;
    readonly getEval: (
      input: TrainingGetEvalInput,
    ) => Effect.Effect<TrainingGetEvalResult, TrainingOperationError>;
    readonly listArtifacts: Effect.Effect<TrainingListArtifactsResult, TrainingOperationError>;
    readonly listEvals: (
      input: TrainingListEvalsInput,
    ) => Effect.Effect<TrainingListEvalsResult, TrainingOperationError>;
  }
>()("t3/training/TrainingService") {}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const store = yield* TrainingStore.TrainingStore;
  const extractor = yield* DatasetExtractor.DatasetExtractor;
  const gpuCoordinator = yield* LocalGpuCoordinator.LocalGpuCoordinator;
  const trainerRegistry = yield* TrainerAdapter.TrainerRegistry;
  const adapterServer = yield* TrainingAdapterServer.TrainingAdapterServer;
  const evalRunner = yield* TrainingEvalRunner.TrainingEvalRunner;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serviceScope = yield* Scope.make();

  // Startup crash-recovery reconciler: mark stale running/queued jobs failed and clear stale ports
  yield* store.reconcileStaleJobsOnStartup.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to reconcile stale training jobs on startup.", { cause }),
    ),
  );

  // Bounded sliding PubSub ensures slow WS subscribers never accumulate unbounded memory
  const eventPubSub = yield* PubSub.sliding<TrainingJobStreamEvent>(EVENT_PUBSUB_CAPACITY);
  const recentMetricsRef = yield* Ref.make(new Map<TrainingJobId, Array<TrainingMetricTick>>());
  const activeJobsRef = yield* Ref.make(new Map<TrainingJobId, ActiveJobRuntime>());

  const emitEvent = (event: TrainingJobStreamEvent) =>
    PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const hostEnv = yield* HostProcess.Environment;

  // Mirror GPU lease changes onto the training stream
  yield* Stream.runForEach(SubscriptionRef.changes(gpuCoordinator.activeLeaseJobId), (leaseJobId) =>
    emitEvent({ type: "gpu_lease_changed", activeGpuLeaseJobId: leaseJobId }),
  ).pipe(Effect.forkIn(serviceScope));

  yield* Effect.addFinalizer(() =>
    Ref.get(activeJobsRef).pipe(
      Effect.flatMap((running) =>
        Effect.forEach([...running.values()], (rt) => rt.cancel().pipe(Effect.ignore), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
      Effect.andThen(Scope.close(serviceScope, Exit.void)),
    ),
  );

  const protectedPaths: ReadonlyArray<string> = [
    serverConfig.dbPath,
    serverConfig.secretsDir,
    serverConfig.worktreesDir,
  ];

  const defaultTrainingDir = NodePath.join(serverConfig.stateDir, "training");

  const discoverExternalVolumeRoots = (): Promise<ReadonlyArray<string>> => {
    if (platform !== "darwin") return Promise.resolve([]);
    return NodeFSP.readdir("/Volumes")
      .then(async (volumes) => {
        const roots: Array<string> = [];
        for (const vol of volumes.toSorted()) {
          if (vol === "Macintosh HD" || vol.startsWith(".")) continue;
          const volPath = NodePath.join("/Volumes", vol);
          try {
            const stat = await NodeFSP.lstat(volPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
            roots.push(volPath);
          } catch {
            continue;
          }
        }
        return roots;
      })
      .catch(() => []);
  };

  const resolveAllowedStorageRoots = Effect.fn("TrainingService.resolveAllowedStorageRoots")(
    function* (envDir: string | undefined, configuredDir: string | undefined) {
      const roots: Array<string> = [defaultTrainingDir];
      if (envDir && envDir.length > 0 && validateSafeStorageDir(envDir, protectedPaths).ok) {
        roots.push(envDir);
      }
      if (
        configuredDir &&
        configuredDir.length > 0 &&
        validateSafeStorageDir(configuredDir, protectedPaths).ok
      ) {
        roots.push(configuredDir);
      }
      const externalVolumes = yield* Effect.promise(() => discoverExternalVolumeRoots());
      roots.push(...externalVolumes);
      return roots;
    },
  );

  const resolveActiveStorageDir = Effect.fn("TrainingService.resolveActiveStorageDir")(function* (
    explicitOverride?: string,
  ): Effect.fn.Return<string, TrainingOperationError> {
    const envDir = hostEnv.T3_TRAINING_DIR?.trim();
    const configuredDir = yield* settings.getSettings.pipe(
      Effect.map((current) => current.training.storageDir?.trim() || undefined),
      Effect.orElseSucceed(() => undefined),
    );
    const hasOverride = explicitOverride !== undefined && explicitOverride.trim().length > 0;
    const chosen = hasOverride
      ? explicitOverride.trim()
      : envDir && envDir.length > 0
        ? envDir
        : configuredDir && configuredDir.length > 0
          ? configuredDir
          : defaultTrainingDir;

    const allowedRoots = hasOverride
      ? yield* resolveAllowedStorageRoots(envDir, configuredDir)
      : undefined;
    const checked = validateSafeStorageDir(chosen, protectedPaths, allowedRoots);
    if (!checked.ok) {
      return yield* new TrainingOperationError({
        code: "invalid_request",
        operation: "resolveStorageDir",
        reason: checked.reason,
      });
    }
    return checked.resolvedPath;
  });

  const hydrateJobSnapshot = (job: TrainingJobSnapshot): Effect.Effect<TrainingJobSnapshot> =>
    Ref.get(recentMetricsRef).pipe(
      Effect.map((cache) => {
        const recent = cache.get(job.id);
        if (recent === undefined || recent.length === 0) return job;
        return {
          ...job,
          recentMetrics: [...recent],
          latestMetric: recent.at(-1) ?? job.latestMetric,
        };
      }),
    );

  const recordMetricTick = (jobId: TrainingJobId, tick: TrainingMetricTick) =>
    Ref.update(recentMetricsRef, (cache) => {
      const next = new Map(cache);
      const list = [...(next.get(jobId) ?? []), tick];
      if (list.length > MAX_RECENT_METRICS) {
        list.splice(0, list.length - MAX_RECENT_METRICS);
      }
      next.delete(jobId);
      next.set(jobId, list);
      while (next.size > MAX_RECENT_METRICS_JOBS) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return next;
    });

  const mapStoreErr =
    (operation: string, resourceId?: string) =>
    <A, R>(
      effect: Effect.Effect<A, TrainingStore.TrainingStoreError, R>,
    ): Effect.Effect<A, TrainingOperationError, R> =>
      Effect.mapError(
        effect,
        (cause) =>
          new TrainingOperationError({
            code: "storage_failed",
            operation,
            ...(resourceId === undefined ? {} : { resourceId }),
            reason: cause.message,
            cause,
          }),
      );

  const publishUpdatedJob = Effect.fn("TrainingService.publishUpdatedJob")(function* (
    jobId: TrainingJobId,
  ) {
    const loaded = yield* store.getJob(jobId).pipe(Effect.orElseSucceed(() => null));
    if (loaded === null) return;
    const hydrated = yield* hydrateJobSnapshot(loaded);
    yield* emitEvent({ type: "job_updated", job: hydrated });
  });

  const listJobs = Effect.gen(function* () {
    const [jobs, activeGpuLeaseJobId] = yield* Effect.all([
      store.listJobs.pipe(mapStoreErr("listJobs")),
      gpuCoordinator.currentLease,
    ]);
    const hydrated = yield* Effect.forEach(jobs, hydrateJobSnapshot);
    return { jobs: hydrated, activeGpuLeaseJobId };
  }).pipe(Effect.withSpan("TrainingService.listJobs"));

  const listDatasets = store.listDatasets.pipe(
    mapStoreErr("listDatasets"),
    Effect.map((datasets) => ({ datasets })),
    Effect.withSpan("TrainingService.listDatasets"),
  );

  const runJobInBackground = Effect.fn("TrainingService.runJobInBackground")(function* (input: {
    readonly jobId: TrainingJobId;
    readonly config: TrainingStartJobInput["config"];
    readonly dataset: TrainingDatasetSummary;
    readonly adapter: TrainerAdapter.TrainerAdapter;
    readonly jobDir: string;
    readonly cancelHandleRef: Ref.Ref<Effect.Effect<void> | null>;
    readonly cancelledFlagRef: Ref.Ref<boolean>;
  }): Effect.fn.Return<void, never> {
    const logFilePath = NodePath.join(input.jobDir, "run.log");
    const metricsFilePath = NodePath.join(input.jobDir, "metrics.jsonl");

    const failJob = Effect.fn("TrainingService.failJob")(function* (
      errorCategory: NonNullable<TrainingJobSnapshot["errorCategory"]>,
      statusMessage: string,
    ) {
      const completedAt = yield* nowIso;
      const isCancelled = errorCategory === "cancelled";
      yield* store
        .updateJob(input.jobId, {
          status: isCancelled ? "cancelled" : "failed",
          statusMessage,
          errorCategory,
          pid: null,
          completedAt,
        })
        .pipe(Effect.ignore);
      yield* publishUpdatedJob(input.jobId);
    });

    const execution = Effect.scoped(
      Effect.gen(function* () {
        if (yield* Ref.get(input.cancelledFlagRef)) {
          yield* failJob("cancelled", "Training job was cancelled while queued.");
          return;
        }

        yield* gpuCoordinator
          .acquireLease({
            jobId: input.jobId,
            reason: `training:${input.jobId}`,
            pauseLocalInference: input.config.pauseLocalInference,
            drainTimeout: Duration.seconds(input.config.inferenceDrainTimeoutSec),
            onDraining: () =>
              store
                .updateJob(input.jobId, {
                  status: "draining_inference",
                  statusMessage:
                    "Pausing local inference servers and waiting for active requests to drain.",
                })
                .pipe(Effect.ignore, Effect.andThen(publishUpdatedJob(input.jobId))),
          })
          .pipe(
            Effect.catchTags({
              LocalGpuLeaseError: (err) =>
                failJob(
                  err.code === "inference_drain_timeout"
                    ? "inference_drain_timeout"
                    : "trainer_spawn_failed",
                  err.reason,
                ).pipe(Effect.andThen(Effect.fail(err))),
            }),
          );

        if (yield* Ref.get(input.cancelledFlagRef)) {
          yield* failJob("cancelled", "Training job was cancelled before training started.");
          return;
        }

        const startedAt = yield* nowIso;
        yield* store
          .updateJob(input.jobId, {
            status: "preparing_dataset",
            statusMessage: "Validating dataset and preparing training config.",
            startedAt,
          })
          .pipe(Effect.ignore);
        yield* publishUpdatedJob(input.jobId);

        const runHandle = yield* input.adapter.startTraining({
          jobId: input.jobId,
          config: input.config,
          datasetDir: input.dataset.storagePath,
          jobDir: input.jobDir,
          logFilePath,
          metricsFilePath,
        });

        yield* Ref.set(input.cancelHandleRef, runHandle.cancel);
        yield* Effect.addFinalizer(() => Ref.set(input.cancelHandleRef, null));

        yield* store
          .updateJob(input.jobId, {
            status: "training",
            statusMessage: `Training ${input.config.baseModel} (${input.config.fineTuneType}).`,
            pid: runHandle.pid,
          })
          .pipe(Effect.ignore);
        yield* publishUpdatedJob(input.jobId);

        const lastBroadcastRef = yield* Ref.make(0);
        const truncationCountRef = yield* Ref.make(0);

        const metricsFiber = yield* Stream.runForEach(runHandle.metrics, (tick) =>
          Effect.gen(function* () {
            yield* recordMetricTick(input.jobId, tick);
            const nowMs = yield* Clock.currentTimeMillis;
            const prevMs = yield* Ref.get(lastBroadcastRef);
            const isBoundary =
              tick.valLoss !== undefined ||
              tick.iter >= tick.totalIters ||
              nowMs - prevMs >= METRIC_BROADCAST_MIN_INTERVAL_MS;
            if (isBoundary) {
              yield* Ref.set(lastBroadcastRef, nowMs);
              yield* store.updateJob(input.jobId, { latestMetric: tick }).pipe(Effect.ignore);
              yield* emitEvent({ type: "metric_tick", jobId: input.jobId, tick });
            }
          }),
        ).pipe(Effect.ignore, Effect.forkChild);

        const warningsFiber = yield* Stream.runForEach(runHandle.warnings, () =>
          Ref.updateAndGet(truncationCountRef, (n) => n + 1).pipe(
            Effect.flatMap((count) =>
              store.updateJob(input.jobId, { truncationWarningsCount: count }).pipe(Effect.ignore),
            ),
          ),
        ).pipe(Effect.ignore, Effect.forkChild);

        const completion = yield* runHandle.completion;
        yield* Fiber.join(metricsFiber);
        yield* Fiber.join(warningsFiber);
        // Training subprocess has exited; clear its cancel handle so cancelJob interrupts autoFuse.
        yield* Ref.set(input.cancelHandleRef, null);

        if (yield* Ref.get(input.cancelledFlagRef)) {
          yield* failJob("cancelled", "Training job was cancelled before fusing.");
          return;
        }

        let fusedModelPath: string | null = null;
        let ggufPath: string | null = null;

        if (input.config.autoFuse) {
          yield* store
            .updateJob(input.jobId, {
              status: "fusing",
              statusMessage: "Fusing adapter weights into standalone model.",
              pid: null,
            })
            .pipe(Effect.ignore);
          yield* publishUpdatedJob(input.jobId);

          const fused = yield* input.adapter.fuse({
            baseModel: input.config.baseModel,
            adapterPath: completion.adapterPath,
            savePath: NodePath.join(input.jobDir, "fused"),
            exportGguf: false,
            trustRemoteCode: input.config.trustRemoteCode,
            logFilePath,
          });
          fusedModelPath = fused.fusedModelPath;
          ggufPath = fused.ggufPath;
        }

        const completedAt = yield* nowIso;
        const provenanceHash = yield* Effect.promise(() =>
          computeAdapterProvenanceHash({
            datasetProvenanceHash: input.dataset.provenanceHash,
            config: input.config,
            adapterPath: completion.adapterPath,
          }),
        );

        const artifact: TrainingArtifact = {
          id: TrainingArtifactId.make(
            `art_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
          ),
          jobId: input.jobId,
          datasetId: input.dataset.id,
          baseModel: input.config.baseModel,
          fineTuneType: input.config.fineTuneType,
          adapterPath: completion.adapterPath,
          fusedModelPath,
          ggufPath,
          provenanceHash,
          sourceThreadIds: input.dataset.sourceThreadIds,
          ...(completion.testLoss === undefined ? {} : { testLoss: completion.testLoss }),
          ...(completion.testPerplexity === undefined
            ? {}
            : { testPerplexity: completion.testPerplexity }),
          registeredInferenceServerId: null,
          servingPort: null,
          createdAt: completedAt,
        };

        yield* store.upsertArtifact(artifact).pipe(Effect.ignore);
        yield* store
          .updateJob(input.jobId, {
            status: "completed",
            statusMessage: "Fine-tuning completed.",
            pid: null,
            completedAt,
          })
          .pipe(Effect.ignore);
        yield* publishUpdatedJob(input.jobId);
      }),
    );

    yield* execution.pipe(
      Effect.catchTags({
        TrainerExecutionError: (err) => failJob(err.category, err.reason),
        LocalGpuLeaseError: () => Effect.void,
      }),
      Effect.ensuring(
        Ref.update(activeJobsRef, (map) => {
          const next = new Map(map);
          next.delete(input.jobId);
          return next;
        }),
      ),
    );
  });

  return TrainingService.of({
    listCuratedThreads: Effect.fn("TrainingService.listCuratedThreads")(function* (input) {
      const threads = yield* store
        .listCuratedThreads(input.bucketName)
        .pipe(mapStoreErr("listCuratedThreads"));
      return { threads };
    }),

    setCuratedThread: Effect.fn("TrainingService.setCuratedThread")(function* (input) {
      const result = yield* store
        .setCuratedThread(input)
        .pipe(mapStoreErr("setCuratedThread", input.threadId));
      return {
        threadId: input.threadId,
        curated: result.curated,
        bucketName: result.bucketName,
      };
    }),

    getCapabilities: Effect.gen(function* () {
      const activeStorageDir = yield* resolveActiveStorageDir();
      const [backends, activeGpuLeaseJobId, activeStorageFreeBytes, storageRoots] =
        yield* Effect.all([
          trainerRegistry.probeAll,
          gpuCoordinator.currentLease,
          Effect.promise(() => getFreeDiskBytes(activeStorageDir).catch(() => 0)),
          Effect.promise(() =>
            discoverStorageRoots(defaultTrainingDir, activeStorageDir, platform),
          ),
        ]);

      return {
        backends,
        hostMemoryBytes: NodeOS.totalmem(),
        isAppleSilicon: platform === "darwin" && architecture === "arm64",
        activeStorageDir,
        activeStorageFreeBytes: Math.max(0, Math.floor(activeStorageFreeBytes)),
        storageRoots,
        cachedModels: scanCachedHfModels(),
        activeGpuLeaseJobId,
      };
    }).pipe(Effect.withSpan("TrainingService.getCapabilities")),

    listDatasets,

    getDataset: Effect.fn("TrainingService.getDataset")(function* (input) {
      const dataset = yield* store
        .getDataset(input.datasetId)
        .pipe(mapStoreErr("getDataset", input.datasetId));
      return { dataset };
    }),

    previewDataset: Effect.fn("TrainingService.previewDataset")(function* (input) {
      return yield* extractor.preview(input).pipe(
        Effect.mapError(
          (cause) =>
            new TrainingOperationError({
              code: "dataset_extraction_failed",
              operation: "previewDataset",
              reason: cause.reason,
              cause,
            }),
        ),
      );
    }),

    createDataset: Effect.fn("TrainingService.createDataset")(function* (input) {
      const storageRoot = yield* resolveActiveStorageDir(input.outputBaseDir);
      const datasetId = TrainingDatasetId.make(
        `ds_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      );
      const outputDir = NodePath.join(storageRoot, "datasets", datasetId);

      const summary = yield* extractor
        .materialize({
          datasetId,
          name: input.name,
          objective: input.objective,
          filter: input.filter,
          redactionOptions: input.redactionOptions,
          outputDir,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TrainingOperationError({
                code: "dataset_extraction_failed",
                operation: "createDataset",
                resourceId: datasetId,
                reason: cause.reason,
                cause,
              }),
          ),
        );

      yield* store.insertDataset(summary).pipe(mapStoreErr("createDataset", datasetId));
      yield* emitEvent({ type: "dataset_changed", datasetId, dataset: summary });
      return summary;
    }),

    convertDpoDatasetToSft: Effect.fn("TrainingService.convertDpoDatasetToSft")(function* (input) {
      const source = yield* store
        .getDataset(input.datasetId)
        .pipe(mapStoreErr("convertDpoDatasetToSft", input.datasetId));
      if (source === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "convertDpoDatasetToSft",
          resourceId: input.datasetId,
          reason: "Source DPO dataset was not found.",
        });
      }
      if (source.objective !== "dpo") {
        return yield* new TrainingOperationError({
          code: "invalid_request",
          operation: "convertDpoDatasetToSft",
          resourceId: input.datasetId,
          reason: "Only DPO datasets can be converted to SFT chosen completions.",
        });
      }

      const storageRoot = yield* resolveActiveStorageDir();
      const targetDatasetId = TrainingDatasetId.make(
        `ds_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      );
      const outputDir = NodePath.join(storageRoot, "datasets", targetDatasetId);
      const summary = yield* extractor
        .materializeSftFromDpo({
          sourceDataset: source,
          targetDatasetId,
          targetName: input.name?.trim() || `${source.name} (SFT chosen)`,
          outputDir,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TrainingOperationError({
                code: "dataset_extraction_failed",
                operation: "convertDpoDatasetToSft",
                resourceId: targetDatasetId,
                reason: cause.reason,
                cause,
              }),
          ),
        );

      yield* store
        .insertDataset(summary)
        .pipe(mapStoreErr("convertDpoDatasetToSft", targetDatasetId));
      yield* emitEvent({ type: "dataset_changed", datasetId: targetDatasetId, dataset: summary });
      return summary;
    }),

    deleteDataset: Effect.fn("TrainingService.deleteDataset")(function* (input) {
      const dataset = yield* store
        .getDataset(input.datasetId)
        .pipe(mapStoreErr("deleteDataset", input.datasetId));
      if (dataset === null) {
        return { datasetId: input.datasetId, deleted: false };
      }

      const envDir = hostEnv.T3_TRAINING_DIR?.trim();
      const configuredDir = yield* settings.getSettings.pipe(
        Effect.map((current) => current.training.storageDir?.trim() || undefined),
        Effect.orElseSucceed(() => undefined),
      );
      const allowedRoots = yield* resolveAllowedStorageRoots(envDir, configuredDir);
      const isContained = allowedRoots.some((root) =>
        isPathContainedWithin(root, dataset.storagePath),
      );
      const pathExists = yield* Effect.tryPromise({
        try: () =>
          NodeFSP.access(dataset.storagePath).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ),
        catch: (cause) =>
          new TrainingOperationError({
            code: "storage_failed",
            operation: "deleteDataset",
            resourceId: input.datasetId,
            reason: `Could not inspect dataset files before deletion: ${String(cause)}`,
            cause,
          }),
      });
      if (pathExists && !isContained) {
        return yield* new TrainingOperationError({
          code: "storage_failed",
          operation: "deleteDataset",
          resourceId: input.datasetId,
          reason:
            "Dataset files lie outside the active training storage root; restore the previous storage root or remove the files before deleting this dataset.",
        });
      }
      if (pathExists) {
        yield* Effect.tryPromise({
          try: () => NodeFSP.rm(dataset.storagePath, { recursive: true, force: true }),
          catch: (cause) =>
            new TrainingOperationError({
              code: "storage_failed",
              operation: "deleteDataset",
              resourceId: input.datasetId,
              reason: `Could not delete dataset files: ${String(cause)}`,
              cause,
            }),
        });
      }

      const deleted = yield* store
        .softDeleteDataset(input.datasetId)
        .pipe(mapStoreErr("deleteDataset", input.datasetId));

      yield* emitEvent({
        type: "dataset_changed",
        datasetId: input.datasetId,
        dataset: null,
      });
      return { datasetId: input.datasetId, deleted };
    }),

    listJobs,

    getJob: Effect.fn("TrainingService.getJob")(function* (input) {
      const loaded = yield* store.getJob(input.jobId).pipe(mapStoreErr("getJob", input.jobId));
      return {
        job: loaded === null ? null : yield* hydrateJobSnapshot(loaded),
      };
    }),

    getJobLogs: Effect.fn("TrainingService.getJobLogs")(function* (input) {
      const job = yield* store.getJob(input.jobId).pipe(mapStoreErr("getJobLogs", input.jobId));
      if (job === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "getJobLogs",
          resourceId: input.jobId,
          reason: "Training job was not found.",
        });
      }

      const logPath = NodePath.join(job.jobDir, "run.log");
      if (!NodeFS.existsSync(logPath)) {
        return {
          jobId: input.jobId,
          content: "",
          totalBytes: 0,
          offsetBytes: 0,
          truncated: false,
        };
      }

      const readResult = yield* Effect.tryPromise({
        try: async () => {
          const stat = await NodeFSP.stat(logPath);
          const totalBytes = stat.size;
          const maxBytes = Math.min(
            input.tailBytes ?? TRAINING_LOG_MAX_BYTES,
            TRAINING_LOG_MAX_BYTES,
          );
          let offsetBytes: number;
          let lengthToRead: number;
          if (input.offsetBytes !== undefined) {
            offsetBytes = Math.min(input.offsetBytes, totalBytes);
            lengthToRead = Math.min(maxBytes, Math.max(0, totalBytes - offsetBytes));
          } else {
            lengthToRead = Math.min(maxBytes, totalBytes);
            offsetBytes = Math.max(0, totalBytes - lengthToRead);
          }
          if (lengthToRead === 0) {
            return {
              content: "",
              totalBytes,
              offsetBytes,
              truncated: offsetBytes > 0,
            };
          }
          const handle = await NodeFSP.open(logPath, "r");
          try {
            const buffer = Buffer.alloc(lengthToRead);
            const { bytesRead } = await handle.read(buffer, 0, lengthToRead, offsetBytes);
            return {
              content: buffer.subarray(0, bytesRead).toString("utf8"),
              totalBytes,
              offsetBytes,
              truncated: offsetBytes > 0 || offsetBytes + bytesRead < totalBytes,
            };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new TrainingOperationError({
            code: "storage_failed",
            operation: "getJobLogs",
            resourceId: input.jobId,
            reason: "Failed to read training job log file.",
            cause,
          }),
      });

      return {
        jobId: input.jobId,
        ...readResult,
      };
    }),

    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(eventPubSub);
        const [{ jobs, activeGpuLeaseJobId }, { datasets }] = yield* Effect.all([
          listJobs,
          listDatasets,
        ]);
        const initial: TrainingJobStreamEvent = {
          type: "snapshot",
          jobs,
          datasets,
          activeGpuLeaseJobId,
        };
        return Stream.concat(Stream.succeed(initial), Stream.fromSubscription(subscription));
      }),
    ),

    startJob: Effect.fn("TrainingService.startJob")(function* (input) {
      const dataset = yield* store
        .getDataset(input.config.datasetId)
        .pipe(mapStoreErr("startJob", input.config.datasetId));
      if (dataset === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "startJob",
          resourceId: input.config.datasetId,
          reason: "Training dataset was not found.",
        });
      }

      const adapter = trainerRegistry.get(input.config.backend);
      if (adapter === undefined) {
        return yield* new TrainingOperationError({
          code: "backend_unavailable",
          operation: "startJob",
          reason: `Unknown trainer backend '${input.config.backend}'.`,
        });
      }

      const capabilities = yield* adapter.probeCapabilities;
      if (!capabilities.available) {
        return yield* new TrainingOperationError({
          code: "backend_unavailable",
          operation: "startJob",
          reason:
            capabilities.unavailableReason ??
            `Trainer backend '${input.config.backend}' is unavailable on this host.`,
        });
      }

      if (!capabilities.supportedObjectives.includes(dataset.objective)) {
        return yield* new TrainingOperationError({
          code: "invalid_request",
          operation: "startJob",
          resourceId: dataset.id,
          reason: `Backend '${input.config.backend}' supports [${capabilities.supportedObjectives.join(", ")}] only, not '${dataset.objective}'. Convert the DPO dataset's chosen completions to SFT first.`,
        });
      }

      if (dataset.trainCount < input.config.batchSize) {
        return yield* new TrainingOperationError({
          code: "invalid_request",
          operation: "startJob",
          resourceId: dataset.id,
          reason: `Dataset has ${dataset.trainCount} train example(s), fewer than batchSize (${input.config.batchSize}).`,
        });
      }

      const storageRoot = yield* resolveActiveStorageDir(input.config.outputBaseDir);
      const jobId = TrainingJobId.make(
        `job_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      );
      const jobDir = NodePath.join(storageRoot, "jobs", jobId);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(jobDir, { recursive: true }),
        catch: (cause) =>
          new TrainingOperationError({
            code: "storage_failed",
            operation: "startJob",
            resourceId: jobId,
            reason: "Failed to create training job directory.",
            cause,
          }),
      });

      const createdAt = yield* nowIso;
      const snapshot: TrainingJobSnapshot = {
        id: jobId,
        config: input.config,
        status: "queued",
        statusMessage: "Queued waiting for local GPU coordinator.",
        latestMetric: null,
        recentMetrics: [],
        truncationWarningsCount: 0,
        artifact: null,
        jobDir,
        createdAt,
        startedAt: null,
        completedAt: null,
      };

      yield* store.insertJob(snapshot).pipe(mapStoreErr("startJob", jobId));
      yield* emitEvent({ type: "job_updated", job: snapshot });

      const cancelHandleRef = yield* Ref.make<Effect.Effect<void> | null>(null);
      const cancelledFlagRef = yield* Ref.make(false);

      const fiber = yield* runJobInBackground({
        jobId,
        config: input.config,
        dataset,
        adapter,
        jobDir,
        cancelHandleRef,
        cancelledFlagRef,
      }).pipe(Effect.forkIn(serviceScope));

      const cancel = Effect.fn("TrainingService.cancelActiveJob")(function* () {
        yield* Ref.set(cancelledFlagRef, true);
        const handleCancel = yield* Ref.get(cancelHandleRef);
        if (handleCancel !== null) {
          yield* handleCancel;
        } else {
          yield* Fiber.interrupt(fiber);
        }
      });

      yield* Ref.update(activeJobsRef, (map) => new Map(map).set(jobId, { cancel, fiber }));
      return snapshot;
    }),

    cancelJob: Effect.fn("TrainingService.cancelJob")(function* (input) {
      const existing = yield* store.getJob(input.jobId).pipe(mapStoreErr("cancelJob", input.jobId));
      if (existing === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "cancelJob",
          resourceId: input.jobId,
          reason: "Training job was not found.",
        });
      }

      const active = (yield* Ref.get(activeJobsRef)).get(input.jobId);
      if (active !== undefined) {
        yield* active.cancel();
      }

      if (
        existing.status !== "completed" &&
        existing.status !== "failed" &&
        existing.status !== "cancelled"
      ) {
        const completedAt = yield* nowIso;
        yield* store
          .updateJob(input.jobId, {
            status: "cancelled",
            statusMessage: "Cancelled by user.",
            errorCategory: "cancelled",
            pid: null,
            completedAt,
          })
          .pipe(mapStoreErr("cancelJob", input.jobId));
      }

      const updated = yield* store.getJob(input.jobId).pipe(mapStoreErr("cancelJob", input.jobId));
      const hydrated = yield* hydrateJobSnapshot(updated ?? existing);
      yield* emitEvent({ type: "job_updated", job: hydrated });
      return hydrated;
    }),

    fuseArtifact: Effect.fn("TrainingService.fuseArtifact")(function* (input) {
      const artifact = yield* store
        .getArtifact(input.artifactId)
        .pipe(mapStoreErr("fuseArtifact", input.artifactId));
      if (artifact === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "fuseArtifact",
          resourceId: input.artifactId,
          reason: "Training artifact was not found.",
        });
      }
      const job = yield* store
        .getJob(artifact.jobId)
        .pipe(mapStoreErr("fuseArtifact", artifact.jobId));
      const adapter = trainerRegistry.get(job?.config.backend ?? "mlx-lora");
      if (adapter === undefined) {
        return yield* new TrainingOperationError({
          code: "backend_unavailable",
          operation: "fuseArtifact",
          resourceId: input.artifactId,
          reason: "Trainer backend for artifact is unavailable.",
        });
      }

      const savePath = NodePath.join(
        job?.jobDir ?? NodePath.dirname(artifact.adapterPath),
        "fused",
      );
      const logFilePath = NodePath.join(
        job?.jobDir ?? NodePath.dirname(artifact.adapterPath),
        "fuse.log",
      );

      const fused = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* gpuCoordinator
            .acquireLease({
              jobId: artifact.jobId,
              reason: `fuse:${artifact.id}`,
              pauseLocalInference: job?.config.pauseLocalInference ?? true,
              drainTimeout: Duration.seconds(job?.config.inferenceDrainTimeoutSec ?? 60),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TrainingOperationError({
                    code: "inference_drain_timeout",
                    operation: "fuseArtifact",
                    resourceId: input.artifactId,
                    reason: cause.reason,
                    cause,
                  }),
              ),
            );
          return yield* adapter
            .fuse({
              baseModel: artifact.baseModel,
              adapterPath: artifact.adapterPath,
              savePath,
              exportGguf: input.exportGguf ?? false,
              ...(input.ggufFilename === undefined ? {} : { ggufFilename: input.ggufFilename }),
              ...(input.dequantize === undefined ? {} : { dequantize: input.dequantize }),
              trustRemoteCode: input.trustRemoteCode ?? job?.config.trustRemoteCode ?? false,
              logFilePath,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TrainingOperationError({
                    code:
                      cause.category === "insufficient_disk"
                        ? "insufficient_disk"
                        : cause.category === "invalid_config"
                          ? "invalid_request"
                          : "execution_failed",
                    operation: "fuseArtifact",
                    resourceId: input.artifactId,
                    reason: cause.reason,
                    cause,
                  }),
              ),
            );
        }),
      );

      const updated = yield* store
        .updateArtifact(artifact.id, {
          fusedModelPath: fused.fusedModelPath,
          ggufPath: fused.ggufPath,
        })
        .pipe(mapStoreErr("fuseArtifact", artifact.id));
      yield* publishUpdatedJob(artifact.jobId);
      return (
        updated ?? { ...artifact, fusedModelPath: fused.fusedModelPath, ggufPath: fused.ggufPath }
      );
    }),

    serveArtifact: Effect.fn("TrainingService.serveArtifact")(function* (input) {
      const artifact = yield* store
        .getArtifact(input.artifactId)
        .pipe(mapStoreErr("serveArtifact", input.artifactId));
      if (artifact === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "serveArtifact",
          resourceId: input.artifactId,
          reason: "Training artifact was not found.",
        });
      }

      const mode = input.mode ?? (artifact.fusedModelPath !== null ? "fused" : "adapter");
      const started = yield* adapterServer
        .start({
          artifact,
          mode,
          autoRegisterInInference: input.autoRegisterInInference ?? true,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TrainingOperationError({
                code: "execution_failed",
                operation: "serveArtifact",
                resourceId: input.artifactId,
                reason: cause.reason,
                cause,
              }),
          ),
        );

      const updated = yield* store
        .updateArtifact(artifact.id, {
          servingPort: started.port,
          registeredInferenceServerId: started.registeredServerId,
        })
        .pipe(mapStoreErr("serveArtifact", artifact.id));
      yield* publishUpdatedJob(artifact.jobId);

      return {
        artifact: updated ?? {
          ...artifact,
          servingPort: started.port,
          registeredInferenceServerId: started.registeredServerId,
        },
        port: started.port,
        baseUrl: started.baseUrl,
        registeredInferenceServerId: started.registeredServerId,
      };
    }),

    stopServedArtifact: Effect.fn("TrainingService.stopServedArtifact")(function* (input) {
      const artifact = yield* store
        .getArtifact(input.artifactId)
        .pipe(mapStoreErr("stopServedArtifact", input.artifactId));
      if (artifact === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "stopServedArtifact",
          resourceId: input.artifactId,
          reason: "Training artifact was not found.",
        });
      }

      const removeInferenceServer = input.removeInferenceServer ?? false;
      yield* adapterServer
        .stop({
          artifactId: artifact.id,
          removeInferenceServer,
          registeredServerId: artifact.registeredInferenceServerId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TrainingOperationError({
                code: "execution_failed",
                operation: "stopServedArtifact",
                resourceId: input.artifactId,
                reason: cause.reason,
                cause,
              }),
          ),
        );

      const updated = yield* store
        .updateArtifact(artifact.id, {
          servingPort: null,
          ...(removeInferenceServer ? { registeredInferenceServerId: null } : {}),
        })
        .pipe(mapStoreErr("stopServedArtifact", artifact.id));
      yield* publishUpdatedJob(artifact.jobId);
      return updated ?? { ...artifact, servingPort: null };
    }),

    registerArtifactInInference: Effect.fn("TrainingService.registerArtifactInInference")(
      function* (input) {
        const artifact = yield* store
          .getArtifact(input.artifactId)
          .pipe(mapStoreErr("registerArtifactInInference", input.artifactId));
        if (artifact === null) {
          return yield* new TrainingOperationError({
            code: "not_found",
            operation: "registerArtifactInInference",
            resourceId: input.artifactId,
            reason: "Training artifact was not found.",
          });
        }

        const active = yield* adapterServer.getActive(artifact.id);
        let baseUrl: string;
        let servingPort = artifact.servingPort;
        if (active !== null) {
          baseUrl = active.baseUrl;
          servingPort = active.port;
        } else if (artifact.servingPort !== null) {
          baseUrl = `http://127.0.0.1:${artifact.servingPort}/v1`;
        } else {
          const started = yield* adapterServer
            .start({
              artifact,
              mode: artifact.fusedModelPath !== null ? "fused" : "adapter",
              autoRegisterInInference: false,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TrainingOperationError({
                    code: "execution_failed",
                    operation: "registerArtifactInInference",
                    resourceId: input.artifactId,
                    reason: cause.reason,
                    cause,
                  }),
              ),
            );
          baseUrl = started.baseUrl;
          servingPort = started.port;
        }

        const reg = yield* adapterServer
          .registerInInference({
            artifact,
            baseUrl,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TrainingOperationError({
                  code: cause.reason.includes("already exists") ? "conflict" : "execution_failed",
                  operation: "registerArtifactInInference",
                  resourceId: input.artifactId,
                  reason: cause.reason,
                  cause,
                }),
            ),
          );

        const updated = yield* store
          .updateArtifact(artifact.id, {
            registeredInferenceServerId: reg.serverId,
            servingPort,
          })
          .pipe(mapStoreErr("registerArtifactInInference", artifact.id));
        yield* publishUpdatedJob(artifact.jobId);

        return {
          artifact: updated ?? {
            ...artifact,
            registeredInferenceServerId: reg.serverId,
            servingPort,
          },
          serverId: reg.serverId,
          baseUrl: reg.baseUrl,
        };
      },
    ),

    runEval: Effect.fn("TrainingService.runEval")(function* (input) {
      const artifact = yield* store
        .getArtifact(input.artifactId)
        .pipe(mapStoreErr("runEval", input.artifactId));
      if (artifact === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "runEval",
          resourceId: input.artifactId,
          reason: "Training artifact was not found.",
        });
      }

      const dataset = yield* store
        .getDataset(artifact.datasetId)
        .pipe(mapStoreErr("runEval", artifact.datasetId));
      if (dataset === null) {
        return yield* new TrainingOperationError({
          code: "not_found",
          operation: "runEval",
          resourceId: artifact.datasetId,
          reason: "Source dataset for artifact was not found.",
        });
      }

      const job = yield* store.getJob(artifact.jobId).pipe(mapStoreErr("runEval", artifact.jobId));
      const evalRunId = TrainingEvalRunId.make(
        `eval_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      );
      const reportDir = NodePath.join(
        job?.jobDir ?? NodePath.dirname(artifact.adapterPath),
        "evals",
        evalRunId,
      );
      const reportPath = NodePath.join(reportDir, "comparison.json");
      const createdAt = yield* nowIso;
      const initial: TrainingEvalComparison = {
        id: evalRunId,
        artifactId: artifact.id,
        suite: input.suite,
        status: "running",
        baseSummary: null,
        tunedSummary: null,
        reportPath,
        createdAt,
        completedAt: null,
      };

      yield* store.insertEvalRun(initial).pipe(mapStoreErr("runEval", evalRunId));
      yield* emitEvent({ type: "eval_updated", evalRun: initial });

      yield* evalRunner
        .runComparison({
          evalRunId,
          jobId: artifact.jobId,
          artifact,
          dataset,
          suite: input.suite,
          reportDir,
          ...(input.samples === undefined ? {} : { samples: input.samples }),
          pauseLocalInference: job?.config.pauseLocalInference ?? true,
          drainTimeoutSec: job?.config.inferenceDrainTimeoutSec ?? 60,
          initialRecord: initial,
        })
        .pipe(
          Effect.tap((completed) => emitEvent({ type: "eval_updated", evalRun: completed })),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Background training eval failed.", { evalRunId, cause });
              const persisted = yield* store
                .getEvalRun(evalRunId)
                .pipe(Effect.orElseSucceed(() => null));
              const completedAt = persisted?.completedAt ?? (yield* nowIso);
              yield* emitEvent({
                type: "eval_updated",
                evalRun: persisted ?? { ...initial, status: "failed", completedAt },
              });
            }),
          ),
          Effect.onInterrupt(() =>
            nowIso.pipe(
              Effect.flatMap((completedAt) =>
                store.updateEvalRun(evalRunId, { status: "cancelled", completedAt }).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    emitEvent({
                      type: "eval_updated",
                      evalRun: { ...initial, status: "cancelled", completedAt },
                    }),
                  ),
                ),
              ),
              Effect.ignore,
            ),
          ),
          Effect.forkIn(serviceScope),
        );

      return initial;
    }),

    getEval: Effect.fn("TrainingService.getEval")(function* (input) {
      const evalRun = yield* store
        .getEvalRun(input.evalRunId)
        .pipe(mapStoreErr("getEval", input.evalRunId));
      return { evalRun };
    }),

    listArtifacts: store.listArtifacts.pipe(
      mapStoreErr("listArtifacts"),
      Effect.map((artifacts) => ({ artifacts })),
      Effect.withSpan("TrainingService.listArtifacts"),
    ),

    listEvals: Effect.fn("TrainingService.listEvals")(function* (input) {
      const evalRuns = yield* store
        .listEvalRuns(input.artifactId)
        .pipe(mapStoreErr("listEvals", input.artifactId));
      return { evalRuns };
    }),
  });
});

export const layer = Layer.effect(TrainingService, make);
