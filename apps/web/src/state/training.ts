import {
  type EnvironmentId,
  type ThreadId,
  type TrainingArtifact,
  type TrainingCapabilitiesResult,
  type TrainingDatasetSummary,
  type TrainingEvalComparison,
  type TrainingJobId,
  type TrainingJobSnapshot,
  type TrainingJobStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  environmentSessionGenerationAtom,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  EMPTY_TRAINING_LIVE_STATE,
  applyTrainingStreamEvent,
  mergeTrainingEvalRuns,
  type TrainingLiveState,
} from "../components/settings/TrainingSettings.logic";
import { connectionAtomRuntime } from "../connection/runtime";

function settled<A, E>(result: AtomCommandResult<A, E>): Effect.Effect<A, E> {
  return result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause);
}

const EMPTY_THREAD_ID_SET: ReadonlySet<ThreadId> = new Set();

function sameThreadIdSet(a: ReadonlySet<ThreadId>, b: ReadonlySet<ThreadId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

const subscribeTrainingStream = (): Stream.Stream<
  TrainingJobStreamEvent,
  unknown,
  EnvironmentSupervisor.EnvironmentSupervisor
> => subscribe(WS_METHODS.trainingSubscribe, {});

export const trainingStreamAtom = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "web-training-stream",
  subscribe: () =>
    subscribeTrainingStream().pipe(
      Stream.scan(() => EMPTY_TRAINING_LIVE_STATE, applyTrainingStreamEvent),
    ),
});

export const trainingLiveStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TrainingLiveState =>
    AsyncResult.getOrElse(
      get(trainingStreamAtom({ environmentId, input: {} })),
      () => EMPTY_TRAINING_LIVE_STATE,
    ),
  ).pipe(Atom.withLabel(`web-training-live-state:${environmentId}`)),
);

const trainingJobsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<TrainingJobSnapshot> => get(trainingLiveStateAtom(environmentId)).jobs,
  ).pipe(Atom.withLabel(`web-training-jobs:${environmentId}`)),
);

const trainingDatasetsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<TrainingDatasetSummary> =>
      get(trainingLiveStateAtom(environmentId)).datasets,
  ).pipe(Atom.withLabel(`web-training-datasets:${environmentId}`)),
);

const activeGpuLeaseJobIdAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): TrainingJobId | null => get(trainingLiveStateAtom(environmentId)).activeGpuLeaseJobId,
  ).pipe(Atom.withLabel(`web-training-active-gpu-lease:${environmentId}`)),
);

export const activeGpuLeaseJobAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TrainingJobSnapshot | null => {
    const state = get(trainingLiveStateAtom(environmentId));
    if (state.activeGpuLeaseJobId === null) return null;
    return state.jobs.find((job) => job.id === state.activeGpuLeaseJobId) ?? null;
  }).pipe(Atom.withLabel(`web-training-active-gpu-lease-job:${environmentId}`)),
);

const trainingListCuratedThreads = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:list-curated-threads",
  tag: WS_METHODS.trainingListCuratedThreads,
});

const trainingGetCapabilities = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:get-capabilities",
  tag: WS_METHODS.trainingGetCapabilities,
});

const trainingListDatasets = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:list-datasets",
  tag: WS_METHODS.trainingListDatasets,
});

const trainingGetDataset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:get-dataset",
  tag: WS_METHODS.trainingGetDataset,
});

export const trainingPreviewDataset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:preview-dataset",
  tag: WS_METHODS.trainingPreviewDataset,
});

const trainingListJobs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:list-jobs",
  tag: WS_METHODS.trainingListJobs,
});

const trainingGetJob = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:get-job",
  tag: WS_METHODS.trainingGetJob,
});

export const trainingGetJobLogs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:get-job-logs",
  tag: WS_METHODS.trainingGetJobLogs,
});

const trainingGetEval = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:get-eval",
  tag: WS_METHODS.trainingGetEval,
});

const trainingListArtifacts = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:list-artifacts",
  tag: WS_METHODS.trainingListArtifacts,
});

const trainingListEvals = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:list-evals",
  tag: WS_METHODS.trainingListEvals,
});

export const trainingCapabilitiesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    return Effect.promise(() =>
      runAtomCommand(
        get.registry,
        trainingGetCapabilities,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
    ).pipe(Effect.flatMap(settled));
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`web-training-capabilities:${environmentId}`)),
);

export const trainingCapabilitiesValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TrainingCapabilitiesResult | null =>
    AsyncResult.getOrElse(get(trainingCapabilitiesAtom(environmentId)), () => null),
  ).pipe(Atom.withLabel(`web-training-capabilities-value:${environmentId}`)),
);

const trainingCuratedThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    return Effect.promise(() =>
      runAtomCommand(
        get.registry,
        trainingListCuratedThreads,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
    ).pipe(Effect.flatMap(settled));
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`web-training-curated-threads:${environmentId}`)),
);

export const curatedThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlySet<ThreadId> => {
    const result = get(trainingCuratedThreadsAtom(environmentId));
    const list = AsyncResult.getOrElse(result, () => null);
    if (list === null || list.threads.length === 0) return EMPTY_THREAD_ID_SET;
    return new Set(list.threads.map((entry) => entry.threadId));
  }).pipe(
    Atom.withEquality(sameThreadIdSet),
    Atom.withLabel(`web-training-curated-thread-ids:${environmentId}`),
  ),
);

const completedTrainingJobIdsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): string =>
    get(trainingJobsAtom(environmentId))
      .filter((job) => job.status === "completed")
      .map((job) => job.id)
      .join(","),
  ).pipe(Atom.withLabel(`web-training-completed-job-ids:${environmentId}`)),
);

export const trainingArtifactsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    // A job completes after its artifact is stored, so refetch when one does.
    get(completedTrainingJobIdsAtom(environmentId));
    return Effect.promise(() =>
      runAtomCommand(
        get.registry,
        trainingListArtifacts,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
    ).pipe(Effect.flatMap(settled));
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`web-training-artifacts:${environmentId}`)),
);

export const trainingArtifactsValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<TrainingArtifact> =>
      AsyncResult.getOrElse(get(trainingArtifactsAtom(environmentId)), () => null)?.artifacts ?? [],
  ).pipe(Atom.withLabel(`web-training-artifacts-value:${environmentId}`)),
);

export const trainingEvalsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    return Effect.promise(() =>
      runAtomCommand(
        get.registry,
        trainingListEvals,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
    ).pipe(Effect.flatMap(settled));
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`web-training-evals:${environmentId}`)),
);

export const trainingEvalsValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<TrainingEvalComparison> => {
    const persisted =
      AsyncResult.getOrElse(get(trainingEvalsAtom(environmentId)), () => null)?.evalRuns ?? [];
    const live = get(trainingLiveStateAtom(environmentId)).evalRuns;
    return mergeTrainingEvalRuns(persisted, live);
  }).pipe(Atom.withLabel(`web-training-evals-value:${environmentId}`)),
);

function refreshArtifactQueries(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  return Effect.sync(() => {
    registry.refresh(trainingArtifactsAtom(environmentId));
    registry.refresh(trainingCapabilitiesAtom(environmentId));
  });
}

const setCuratedThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:set-curated-thread",
  tag: WS_METHODS.trainingSetCuratedThread,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => {
      registry.refresh(trainingCuratedThreadsAtom(environmentId));
    }),
});

export const trainingCreateDataset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:create-dataset",
  tag: WS_METHODS.trainingCreateDataset,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => {
      registry.refresh(trainingCapabilitiesAtom(environmentId));
    }),
});

export const trainingConvertDpoDatasetToSft = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:convert-dpo-dataset-to-sft",
  tag: WS_METHODS.trainingConvertDpoDatasetToSft,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => {
      registry.refresh(trainingCapabilitiesAtom(environmentId));
    }),
});

export const trainingDeleteDataset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:delete-dataset",
  tag: WS_METHODS.trainingDeleteDataset,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => {
      registry.refresh(trainingCapabilitiesAtom(environmentId));
    }),
});

export const trainingStartJob = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:start-job",
  tag: WS_METHODS.trainingStartJob,
  onSuccess: ({ environmentId }, registry) => refreshArtifactQueries(registry, environmentId),
});

export const trainingCancelJob = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:cancel-job",
  tag: WS_METHODS.trainingCancelJob,
  onSuccess: ({ environmentId }, registry) => refreshArtifactQueries(registry, environmentId),
});

export const trainingFuseArtifact = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:fuse-artifact",
  tag: WS_METHODS.trainingFuseArtifact,
  onSuccess: ({ environmentId }, registry) => refreshArtifactQueries(registry, environmentId),
});

export const trainingServeArtifact = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:serve-artifact",
  tag: WS_METHODS.trainingServeArtifact,
  onSuccess: ({ environmentId }, registry) => refreshArtifactQueries(registry, environmentId),
});

export const trainingStopServedArtifact = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:stop-served-artifact",
  tag: WS_METHODS.trainingStopServedArtifact,
  onSuccess: ({ environmentId }, registry) => refreshArtifactQueries(registry, environmentId),
});

export const trainingRegisterArtifactInInference = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "training:register-artifact-in-inference",
    tag: WS_METHODS.trainingRegisterArtifactInInference,
    onSuccess: ({ environmentId }, registry) => refreshArtifactQueries(registry, environmentId),
  },
);

export const trainingRunEval = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "training:run-eval",
  tag: WS_METHODS.trainingRunEval,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => {
      registry.refresh(trainingEvalsAtom(environmentId));
      registry.refresh(trainingArtifactsAtom(environmentId));
    }),
});

export const trainingEnvironment = {
  stream: trainingStreamAtom,
  liveStateAtom: trainingLiveStateAtom,
  jobsAtom: trainingJobsAtom,
  datasetsAtom: trainingDatasetsAtom,
  activeGpuLeaseJobIdAtom,
  activeGpuLeaseJobAtom,
  capabilitiesAtom: trainingCapabilitiesAtom,
  capabilitiesValueAtom: trainingCapabilitiesValueAtom,
  curatedThreadsAtom: trainingCuratedThreadsAtom,
  curatedThreadIdsAtom,
  artifactsAtom: trainingArtifactsAtom,
  artifactsValueAtom: trainingArtifactsValueAtom,
  evalsAtom: trainingEvalsAtom,
  evalsValueAtom: trainingEvalsValueAtom,
  listCuratedThreads: trainingListCuratedThreads,
  setCuratedThread,
  getCapabilities: trainingGetCapabilities,
  listDatasets: trainingListDatasets,
  getDataset: trainingGetDataset,
  previewDataset: trainingPreviewDataset,
  createDataset: trainingCreateDataset,
  convertDpoDatasetToSft: trainingConvertDpoDatasetToSft,
  deleteDataset: trainingDeleteDataset,
  listJobs: trainingListJobs,
  getJob: trainingGetJob,
  getJobLogs: trainingGetJobLogs,
  startJob: trainingStartJob,
  cancelJob: trainingCancelJob,
  fuseArtifact: trainingFuseArtifact,
  serveArtifact: trainingServeArtifact,
  stopServedArtifact: trainingStopServedArtifact,
  registerArtifactInInference: trainingRegisterArtifactInInference,
  runEval: trainingRunEval,
  getEval: trainingGetEval,
  listArtifacts: trainingListArtifacts,
  listEvals: trainingListEvals,
} as const;
