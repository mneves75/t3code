import {
  type RedactionOptions,
  type RedactionRuleCategory,
  type TrainerBackendCapabilities,
  type TrainerBackendId,
  type TrainingArtifact,
  type TrainingCapabilitiesResult,
  type TrainingDatasetFilter,
  type TrainingDatasetId,
  type TrainingDatasetSummary,
  type TrainingEvalComparison,
  type TrainingEvalStatus,
  type TrainingFineTuneType,
  type TrainingJobConfig,
  type TrainingJobId,
  type TrainingJobSnapshot,
  type TrainingJobStatus,
  type TrainingJobStreamEvent,
  type TrainingMetricTick,
  type TrainingOptimizer,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

export const TRAINING_RECENT_METRICS_CAP = 500;

export interface TrainingLiveState {
  readonly loaded: boolean;
  readonly jobs: ReadonlyArray<TrainingJobSnapshot>;
  readonly datasets: ReadonlyArray<TrainingDatasetSummary>;
  readonly evalRuns: ReadonlyArray<TrainingEvalComparison>;
  readonly activeGpuLeaseJobId: TrainingJobId | null;
}

export const EMPTY_TRAINING_LIVE_STATE: TrainingLiveState = {
  loaded: false,
  jobs: [],
  datasets: [],
  evalRuns: [],
  activeGpuLeaseJobId: null,
};

function capRecentMetrics(
  metrics: ReadonlyArray<TrainingMetricTick>,
): ReadonlyArray<TrainingMetricTick> {
  return metrics.length <= TRAINING_RECENT_METRICS_CAP
    ? metrics
    : metrics.slice(metrics.length - TRAINING_RECENT_METRICS_CAP);
}

function capJobMetrics(job: TrainingJobSnapshot): TrainingJobSnapshot {
  const recentMetrics = capRecentMetrics(job.recentMetrics);
  return recentMetrics === job.recentMetrics ? job : { ...job, recentMetrics };
}

function isTerminalEvalStatus(status: TrainingEvalStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function mergeTrainingEvalRuns(
  persisted: ReadonlyArray<TrainingEvalComparison>,
  live: ReadonlyArray<TrainingEvalComparison>,
): ReadonlyArray<TrainingEvalComparison> {
  if (live.length === 0) return persisted;
  const byId = new Map<TrainingEvalComparison["id"], TrainingEvalComparison>();
  for (const run of persisted) {
    byId.set(run.id, run);
  }
  for (const run of live) {
    const existing = byId.get(run.id);
    if (
      existing === undefined ||
      isTerminalEvalStatus(run.status) ||
      !isTerminalEvalStatus(existing.status)
    ) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function applyTrainingStreamEvent(
  state: TrainingLiveState,
  event: TrainingJobStreamEvent,
): TrainingLiveState {
  switch (event.type) {
    case "snapshot":
      return {
        loaded: true,
        jobs: event.jobs.map(capJobMetrics),
        datasets: event.datasets,
        evalRuns: [],
        activeGpuLeaseJobId: event.activeGpuLeaseJobId,
      };

    case "job_updated": {
      const nextJob = capJobMetrics(event.job);
      const index = state.jobs.findIndex((job) => job.id === nextJob.id);
      const jobs =
        index === -1
          ? [nextJob, ...state.jobs]
          : state.jobs.map((job, at) => (at === index ? nextJob : job));
      return { ...state, loaded: true, jobs };
    }

    case "metric_tick": {
      const index = state.jobs.findIndex((job) => job.id === event.jobId);
      if (index === -1) return state;
      const jobs = state.jobs.map((job, at) => {
        if (at !== index) return job;
        return {
          ...job,
          latestMetric: event.tick,
          recentMetrics: capRecentMetrics([...job.recentMetrics, event.tick]),
        };
      });
      return { ...state, loaded: true, jobs };
    }

    case "dataset_changed": {
      if (event.dataset === null) {
        return {
          ...state,
          loaded: true,
          datasets: state.datasets.filter((dataset) => dataset.id !== event.datasetId),
        };
      }
      const nextDataset = event.dataset;
      const index = state.datasets.findIndex((dataset) => dataset.id === nextDataset.id);
      const datasets =
        index === -1
          ? [nextDataset, ...state.datasets]
          : state.datasets.map((dataset, at) => (at === index ? nextDataset : dataset));
      return { ...state, loaded: true, datasets };
    }

    case "gpu_lease_changed":
      return {
        ...state,
        loaded: true,
        activeGpuLeaseJobId: event.activeGpuLeaseJobId,
      };

    case "eval_updated": {
      const nextEval = event.evalRun;
      const index = state.evalRuns.findIndex((run) => run.id === nextEval.id);
      const evalRuns =
        index === -1
          ? [nextEval, ...state.evalRuns]
          : state.evalRuns.map((run, at) => (at === index ? nextEval : run));
      return { ...state, loaded: true, evalRuns };
    }
  }
}

export type TrainingPresetId = "quick_smoke" | "balanced_lora" | "deep_lora";

export interface TrainingPreset {
  readonly id: TrainingPresetId;
  readonly label: string;
  readonly description: string;
  readonly fineTuneType: TrainingFineTuneType;
  readonly optimizer: TrainingOptimizer;
  readonly iters: number;
  readonly batchSize: number;
  readonly gradAccumulationSteps: number;
  readonly learningRate: number;
  readonly maxSeqLength: number;
  readonly maskPrompt: boolean;
  readonly gradCheckpoint: boolean;
  readonly stepsPerReport: number;
  readonly stepsPerEval: number;
  readonly saveEvery: number;
  readonly valBatches: number;
  readonly lora: {
    readonly rank: number;
    readonly scale: number;
    readonly dropout: number;
    readonly numLayers: number;
  };
}

export const TRAINING_PRESETS: ReadonlyArray<TrainingPreset> = [
  {
    id: "quick_smoke",
    label: msg("Quick Smoke"),
    description: msg("100 iterations, fast sanity check on formatting and loss descent."),
    fineTuneType: "lora",
    optimizer: "adamw",
    iters: 100,
    batchSize: 2,
    gradAccumulationSteps: 2,
    learningRate: 1e-4,
    maxSeqLength: 2048,
    maskPrompt: true,
    gradCheckpoint: true,
    stepsPerReport: 10,
    stepsPerEval: 50,
    saveEvery: 50,
    valBatches: 10,
    lora: { rank: 8, scale: 20, dropout: 0, numLayers: 8 },
  },
  {
    id: "balanced_lora",
    label: msg("Balanced LoRA"),
    description: msg("600 iterations, strong coding style and tool-call adaptation."),
    fineTuneType: "lora",
    optimizer: "adamw",
    iters: 600,
    batchSize: 2,
    gradAccumulationSteps: 4,
    learningRate: 1e-4,
    maxSeqLength: 4096,
    maskPrompt: true,
    gradCheckpoint: true,
    stepsPerReport: 10,
    stepsPerEval: 100,
    saveEvery: 100,
    valBatches: 25,
    lora: { rank: 16, scale: 20, dropout: 0.05, numLayers: 16 },
  },
  {
    id: "deep_lora",
    label: msg("Deep LoRA"),
    description: msg("1500 iterations across all layers for larger curated datasets."),
    fineTuneType: "lora",
    optimizer: "adamw",
    iters: 1500,
    batchSize: 2,
    gradAccumulationSteps: 4,
    learningRate: 5e-5,
    maxSeqLength: 4096,
    maskPrompt: true,
    gradCheckpoint: true,
    stepsPerReport: 25,
    stepsPerEval: 150,
    saveEvery: 250,
    valBatches: 25,
    lora: { rank: 32, scale: 20, dropout: 0.05, numLayers: -1 },
  },
];

function getTrainingPreset(id: TrainingPresetId): TrainingPreset {
  return TRAINING_PRESETS.find((preset) => preset.id === id) ?? TRAINING_PRESETS[1]!;
}

export const REDACTION_CATEGORY_LABELS: Readonly<Record<RedactionRuleCategory, string>> = {
  api_key_provider: msg("Provider API keys"),
  jwt_bearer: msg("JWT & bearer tokens"),
  pem_private_key: msg("PEM private keys"),
  aws_gcp_cloud: msg("Cloud credentials"),
  env_assignment: msg("Env secret assignments"),
  url_credentials: msg("URL credentials"),
  home_path_username: msg("Home paths & usernames"),
  email_address: msg("Email addresses"),
  high_entropy_secret: msg("High-entropy secrets"),
};

export const TRAINING_JOB_STATUS_LABELS: Readonly<Record<TrainingJobStatus, string>> = {
  queued: msg("Queued", { $context: "training job status" }),
  draining_inference: msg("Draining inference"),
  preparing_dataset: msg("Preparing dataset"),
  training: msg("Training", { $context: "training job status" }),
  fusing: msg("Fusing"),
  completed: msg("Completed"),
  failed: msg("Failed"),
  cancelled: msg("Cancelled"),
};

export const TRAINING_EVAL_STATUS_LABELS: Readonly<Record<TrainingEvalStatus, string>> = {
  running: msg("Running", { $context: "training eval status" }),
  completed: msg("Completed"),
  failed: msg("Failed"),
  cancelled: msg("Cancelled"),
};

export type TrainingBadgeVariant =
  | "default"
  | "secondary"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "outline";

export function trainingEvalStatusBadgeVariant(status: TrainingEvalStatus): TrainingBadgeVariant {
  switch (status) {
    case "running":
      return "info";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "secondary";
  }
}

export function trainingJobStatusBadgeVariant(status: TrainingJobStatus): TrainingBadgeVariant {
  switch (status) {
    case "queued":
      return "outline";
    case "draining_inference":
    case "preparing_dataset":
      return "warning";
    case "training":
    case "fusing":
      return "info";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "secondary";
  }
}

export function isTrainingJobActive(status: TrainingJobStatus): boolean {
  return (
    status === "queued" ||
    status === "draining_inference" ||
    status === "preparing_dataset" ||
    status === "training" ||
    status === "fusing"
  );
}

export function trainingJobProgressPercent(job: TrainingJobSnapshot): number {
  if (job.status === "completed") return 100;
  const metric = job.latestMetric;
  if (!metric || metric.totalIters <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((metric.iter / metric.totalIters) * 100)));
}

export function formatTrainingEta(etaSec: number | undefined | null): string {
  if (etaSec === undefined || etaSec === null || !Number.isFinite(etaSec) || etaSec < 0) {
    return "--";
  }
  const totalSeconds = Math.round(etaSec);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatTrainingLoss(loss: number | undefined | null): string {
  if (loss === undefined || loss === null || !Number.isFinite(loss)) return "--";
  return loss.toFixed(3);
}

export function formatTrainingThroughput(tokSec: number | undefined | null): string {
  if (tokSec === undefined || tokSec === null || !Number.isFinite(tokSec)) return "--";
  if (tokSec >= 100) {
    return `${Math.round(tokSec).toLocaleString("en-US")} tok/s`;
  }
  return `${tokSec.toFixed(1)} tok/s`;
}

export function formatTrainingMemoryGb(gb: number | undefined | null): string {
  if (gb === undefined || gb === null || !Number.isFinite(gb)) return "--";
  return `${gb.toFixed(1)} GB`;
}

export function formatTrainingTokenCount(tokens: number | undefined | null): string {
  if (tokens === undefined || tokens === null || !Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

export function formatTrainingBytesGb(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return "--";
  }
  const gib = bytes / 1_073_741_824;
  if (gib >= 100) return `${Math.round(gib)} GB`;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  const mib = bytes / 1_048_576;
  return `${Math.round(mib)} MB`;
}

export function parseCsvTerms(raw: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function createDefaultDatasetFilter(): TrainingDatasetFilter {
  return {
    settledOnly: false,
    includeArchived: false,
    includeSubagents: false,
    minCompletedRuns: 1,
    includeToolCalls: true,
    includeReasoning: true,
    includeCheckpointDiffs: false,
    maxToolOutputChars: 8_000,
    split: {
      validRatio: 0.1,
      testRatio: 0.1,
      seed: 42,
    },
    dpoSources: {
      fromForks: true,
      fromRollbacks: true,
      fromRetryAttempts: true,
    },
  };
}

export function createDefaultRedactionOptions(): RedactionOptions {
  return {
    redactEnvAssignments: true,
    redactHomePaths: true,
    redactEmails: true,
    redactHighEntropy: true,
  };
}

export interface TrainingJobLaunchDraft {
  readonly name: string;
  readonly backend: TrainerBackendId;
  readonly datasetId: TrainingDatasetId | "";
  readonly baseModel: string;
  readonly fineTuneType: TrainingFineTuneType;
  readonly optimizer: TrainingOptimizer;
  readonly iters: number;
  readonly batchSize: number;
  readonly gradAccumulationSteps: number;
  readonly learningRate: number;
  readonly maxSeqLength: number;
  readonly maskPrompt: boolean;
  readonly gradCheckpoint: boolean;
  readonly stepsPerReport: number;
  readonly stepsPerEval: number;
  readonly saveEvery: number;
  readonly valBatches: number;
  readonly seed: number;
  readonly loraRank: number;
  readonly loraScale: number;
  readonly loraDropout: number;
  readonly loraNumLayers: number;
  readonly outputBaseDir: string;
  readonly autoFuse: boolean;
  readonly runTestEval: boolean;
  readonly trustRemoteCode: boolean;
  readonly pauseLocalInference: boolean;
  readonly inferenceDrainTimeoutSec: number;
}

export function createJobLaunchDraft(input: {
  readonly presetId?: TrainingPresetId;
  readonly datasetId?: TrainingDatasetId | "";
  readonly baseModel?: string;
  readonly outputBaseDir?: string;
}): TrainingJobLaunchDraft {
  const preset = getTrainingPreset(input.presetId ?? "balanced_lora");
  return {
    name: "",
    backend: "mlx-lora",
    datasetId: input.datasetId ?? "",
    baseModel: input.baseModel ?? "",
    fineTuneType: preset.fineTuneType,
    optimizer: preset.optimizer,
    iters: preset.iters,
    batchSize: preset.batchSize,
    gradAccumulationSteps: preset.gradAccumulationSteps,
    learningRate: preset.learningRate,
    maxSeqLength: preset.maxSeqLength,
    maskPrompt: preset.maskPrompt,
    gradCheckpoint: preset.gradCheckpoint,
    stepsPerReport: preset.stepsPerReport,
    stepsPerEval: preset.stepsPerEval,
    saveEvery: preset.saveEvery,
    valBatches: preset.valBatches,
    seed: 42,
    loraRank: preset.lora.rank,
    loraScale: preset.lora.scale,
    loraDropout: preset.lora.dropout,
    loraNumLayers: preset.lora.numLayers,
    outputBaseDir: input.outputBaseDir ?? "",
    autoFuse: false,
    runTestEval: true,
    trustRemoteCode: false,
    pauseLocalInference: true,
    inferenceDrainTimeoutSec: 60,
  };
}

export function applyPresetToJobDraft(
  draft: TrainingJobLaunchDraft,
  presetId: TrainingPresetId,
): TrainingJobLaunchDraft {
  const preset = getTrainingPreset(presetId);
  return {
    ...draft,
    fineTuneType: preset.fineTuneType,
    optimizer: preset.optimizer,
    iters: preset.iters,
    batchSize: preset.batchSize,
    gradAccumulationSteps: preset.gradAccumulationSteps,
    learningRate: preset.learningRate,
    maxSeqLength: preset.maxSeqLength,
    maskPrompt: preset.maskPrompt,
    gradCheckpoint: preset.gradCheckpoint,
    stepsPerReport: preset.stepsPerReport,
    stepsPerEval: preset.stepsPerEval,
    saveEvery: preset.saveEvery,
    valBatches: preset.valBatches,
    loraRank: preset.lora.rank,
    loraScale: preset.lora.scale,
    loraDropout: preset.lora.dropout,
    loraNumLayers: preset.lora.numLayers,
  };
}

export function isValidBaseModelRef(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (trimmed.startsWith("-")) return false;
  if (/[\0\r\n]/.test(trimmed)) return false;
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) return true;
  if (trimmed.startsWith("/") || trimmed.startsWith("~/")) return true;
  return false;
}

export interface TrainingJobPreflightResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly dpoIncompatibleWithBackend: boolean;
}

function validateDatasetForLaunch(
  draft: TrainingJobLaunchDraft,
  dataset: TrainingDatasetSummary | null,
  backend: TrainerBackendCapabilities | null,
  resolve: MessageResolver,
  errors: string[],
  warnings: string[],
): boolean {
  if (dataset === null) {
    errors.push(resolve(msg("Select a dataset before starting training.")));
    return false;
  }
  if (dataset.trainCount < draft.batchSize) {
    errors.push(
      resolve(
        msg(
          "Dataset has {trainCount} training examples, which is fewer than batch size {batchSize}.",
          { trainCount: dataset.trainCount, batchSize: draft.batchSize },
        ),
      ),
    );
  }
  if (dataset.validCount > 0 && dataset.validCount < draft.batchSize) {
    warnings.push(
      resolve(
        msg(
          "Validation split has {validCount} examples (below batch size {batchSize}); validation will be skipped automatically.",
          { validCount: dataset.validCount, batchSize: draft.batchSize },
        ),
      ),
    );
  }
  const dpoIncompatible =
    dataset.objective === "dpo" &&
    (backend === null
      ? draft.backend === "mlx-lora"
      : !backend.supportedObjectives.includes("dpo"));
  if (dpoIncompatible) {
    errors.push(
      resolve(
        msg(
          "The selected mlx-lora backend supports SFT datasets only. Create an SFT dataset from the chosen completions or export the DPO JSONL.",
        ),
      ),
    );
  }
  return dpoIncompatible;
}

function validateHyperparameters(
  draft: TrainingJobLaunchDraft,
  resolve: MessageResolver,
  errors: string[],
): void {
  if (!Number.isInteger(draft.iters) || draft.iters < 1) {
    errors.push(resolve(msg("Iterations must be a positive integer.")));
  }
  if (!Number.isInteger(draft.batchSize) || draft.batchSize < 1) {
    errors.push(resolve(msg("Batch size must be at least 1.")));
  }
  if (!Number.isInteger(draft.gradAccumulationSteps) || draft.gradAccumulationSteps < 1) {
    errors.push(resolve(msg("Gradient accumulation steps must be at least 1.")));
  }
  if (!Number.isFinite(draft.learningRate) || draft.learningRate <= 0) {
    errors.push(resolve(msg("Learning rate must be greater than 0.")));
  }
  if (!Number.isInteger(draft.maxSeqLength) || draft.maxSeqLength < 64) {
    errors.push(resolve(msg("Max sequence length must be at least 64.")));
  }
  if (draft.fineTuneType === "full") return;

  if (!Number.isInteger(draft.loraRank) || draft.loraRank < 1 || draft.loraRank > 256) {
    errors.push(resolve(msg("LoRA rank must be between 1 and 256.")));
  }
  if (!Number.isFinite(draft.loraScale) || draft.loraScale <= 0) {
    errors.push(resolve(msg("LoRA scale must be greater than 0.")));
  }
  if (!Number.isFinite(draft.loraDropout) || draft.loraDropout < 0 || draft.loraDropout > 0.5) {
    errors.push(resolve(msg("LoRA dropout must be between 0 and 0.5.")));
  }
  if (
    !Number.isInteger(draft.loraNumLayers) ||
    (draft.loraNumLayers !== -1 && (draft.loraNumLayers < 1 || draft.loraNumLayers > 128))
  ) {
    errors.push(resolve(msg("LoRA layers must be -1 (all layers) or between 1 and 128.")));
  }
}

function checkStorageHeadroom(
  draft: TrainingJobLaunchDraft,
  availableStorageFreeBytes: number | null | undefined,
  resolve: MessageResolver,
  warnings: string[],
): void {
  if (availableStorageFreeBytes === undefined || availableStorageFreeBytes === null) return;
  const requiredGiB = draft.fineTuneType === "full" || draft.autoFuse ? 20 : 5;
  if (availableStorageFreeBytes < requiredGiB * 1_073_741_824) {
    warnings.push(
      resolve(
        msg("Target storage has {free} free; at least {required} GB is recommended for this run.", {
          free: formatTrainingBytesGb(availableStorageFreeBytes),
          required: requiredGiB,
        }),
      ),
    );
  }
}

export function validateTrainingJobLaunch(
  input: {
    readonly draft: TrainingJobLaunchDraft;
    readonly dataset: TrainingDatasetSummary | null;
    readonly backend: TrainerBackendCapabilities | null;
    readonly availableStorageFreeBytes?: number | null;
  },
  resolve: MessageResolver = m,
): TrainingJobPreflightResult {
  const { draft, dataset, backend, availableStorageFreeBytes } = input;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (draft.name.trim().length === 0) {
    errors.push(resolve(msg("Enter a name for this training job.")));
  }
  if (backend !== null && !backend.available) {
    errors.push(
      backend.unavailableReason ??
        resolve(msg("The selected training backend is not available on this host.")),
    );
  }

  const dpoIncompatibleWithBackend = validateDatasetForLaunch(
    draft,
    dataset,
    backend,
    resolve,
    errors,
    warnings,
  );

  const trimmedModel = draft.baseModel.trim();
  if (trimmedModel.length === 0) {
    errors.push(resolve(msg("Choose or enter a base model.")));
  } else if (trimmedModel.startsWith("-")) {
    errors.push(resolve(msg("Base model cannot start with '-'.")));
  } else if (!isValidBaseModelRef(trimmedModel)) {
    errors.push(
      resolve(msg("Base model must be a HuggingFace repo slug (org/model) or a local model path.")),
    );
  }

  validateHyperparameters(draft, resolve, errors);
  checkStorageHeadroom(draft, availableStorageFreeBytes, resolve, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    dpoIncompatibleWithBackend,
  };
}

export function buildJobConfigFromDraft(
  draft: TrainingJobLaunchDraft,
  datasetId: TrainingDatasetId,
): TrainingJobConfig {
  const outputBaseDir = draft.outputBaseDir.trim();
  return {
    name: draft.name.trim(),
    backend: draft.backend,
    datasetId,
    baseModel: draft.baseModel.trim(),
    fineTuneType: draft.fineTuneType,
    optimizer: draft.optimizer,
    iters: Math.max(1, Math.round(draft.iters)),
    batchSize: Math.max(1, Math.round(draft.batchSize)),
    gradAccumulationSteps: Math.max(1, Math.round(draft.gradAccumulationSteps)),
    learningRate: draft.learningRate,
    maxSeqLength: Math.max(64, Math.round(draft.maxSeqLength)),
    maskPrompt: draft.maskPrompt,
    gradCheckpoint: draft.gradCheckpoint,
    stepsPerReport: Math.max(1, Math.round(draft.stepsPerReport)),
    stepsPerEval: Math.max(1, Math.round(draft.stepsPerEval)),
    saveEvery: Math.max(1, Math.round(draft.saveEvery)),
    valBatches: Math.max(-1, Math.round(draft.valBatches)),
    seed: Math.max(0, Math.round(draft.seed)),
    ...(draft.fineTuneType === "full"
      ? {}
      : {
          lora: {
            rank: Math.round(draft.loraRank),
            scale: draft.loraScale,
            dropout: draft.loraDropout,
            numLayers: Math.round(draft.loraNumLayers),
          },
        }),
    ...(outputBaseDir.length > 0 ? { outputBaseDir } : {}),
    autoFuse: draft.autoFuse,
    runTestEval: draft.runTestEval,
    trustRemoteCode: draft.trustRemoteCode,
    pauseLocalInference: draft.pauseLocalInference,
    inferenceDrainTimeoutSec: Math.max(1, Math.round(draft.inferenceDrainTimeoutSec)),
  };
}

const GGUF_FAMILY_PATTERN = /(?:^|\/|-)(?:llama|mistral|mixtral)(?:[-_.\d]|$)/i;

export function artifactSupportsGgufExport(
  artifact: TrainingArtifact,
  capabilities: TrainingCapabilitiesResult | null,
): boolean {
  const cached = capabilities?.cachedModels.find(
    (model) => model.id === artifact.baseModel || model.path === artifact.baseModel,
  );
  if (cached !== undefined) {
    return cached.supportsGgufExport;
  }
  const mlxBackend = capabilities?.backends.find((backend) => backend.id === "mlx-lora");
  if (mlxBackend && !mlxBackend.supportsGgufExport) {
    return false;
  }
  return GGUF_FAMILY_PATTERN.test(artifact.baseModel);
}
