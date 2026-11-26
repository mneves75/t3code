import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { InferenceServerId } from "./inference.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const TrainingDatasetId = TrimmedNonEmptyString.pipe(Schema.brand("TrainingDatasetId"));
export type TrainingDatasetId = typeof TrainingDatasetId.Type;

export const TrainingJobId = TrimmedNonEmptyString.pipe(Schema.brand("TrainingJobId"));
export type TrainingJobId = typeof TrainingJobId.Type;

export const TrainingArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("TrainingArtifactId"));
export type TrainingArtifactId = typeof TrainingArtifactId.Type;

export const TrainingEvalRunId = TrimmedNonEmptyString.pipe(Schema.brand("TrainingEvalRunId"));
export type TrainingEvalRunId = typeof TrainingEvalRunId.Type;

export const TrainingObjective = Schema.Literals(["sft", "dpo"]);
export type TrainingObjective = typeof TrainingObjective.Type;

export const TrainingFineTuneType = Schema.Literals(["lora", "dora", "full"]);
export type TrainingFineTuneType = typeof TrainingFineTuneType.Type;

export const TrainingOptimizer = Schema.Literals(["adam", "adamw", "muon", "sgd", "adafactor"]);
export type TrainingOptimizer = typeof TrainingOptimizer.Type;

export const TrainingJobStatus = Schema.Literals([
  "queued",
  "draining_inference",
  "preparing_dataset",
  "training",
  "fusing",
  "completed",
  "failed",
  "cancelled",
]);
export type TrainingJobStatus = typeof TrainingJobStatus.Type;

export const TrainingJobErrorCategory = Schema.Literals([
  "invalid_config",
  "insufficient_disk",
  "inference_drain_timeout",
  "dataset_invalid",
  "trainer_spawn_failed",
  "trainer_oom",
  "trainer_exited_nonzero",
  "fuse_failed",
  "server_restarted",
  "cancelled",
]);
export type TrainingJobErrorCategory = typeof TrainingJobErrorCategory.Type;

export const TrainerBackendId = Schema.Literals(["mlx-lora", "mlx-dpo", "external"]);
export type TrainerBackendId = typeof TrainerBackendId.Type;

export const TrainingEvalSuite = Schema.Literals(["heldout_perplexity", "local_coding"]);
export type TrainingEvalSuite = typeof TrainingEvalSuite.Type;

export const TrainingEvalStatus = Schema.Literals(["running", "completed", "failed", "cancelled"]);
export type TrainingEvalStatus = typeof TrainingEvalStatus.Type;

export const TrainingDatasetSplit = Schema.Struct({
  validRatio: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0.4 })),
  testRatio: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0.3 })),
  seed: NonNegativeInt,
});
export type TrainingDatasetSplit = typeof TrainingDatasetSplit.Type;

export const TrainingDatasetDpoSources = Schema.Struct({
  fromForks: Schema.Boolean,
  fromRollbacks: Schema.Boolean,
  fromRetryAttempts: Schema.Boolean,
});
export type TrainingDatasetDpoSources = typeof TrainingDatasetDpoSources.Type;

export const TrainingDatasetFilter = Schema.Struct({
  /** Explicit thread allow-list (e.g. from "Add to training dataset" curation). */
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  /** Additional threads excluded even if matched by project/tag filters. */
  excludeThreadIds: Schema.optional(Schema.Array(ThreadId)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  providerInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  /** Filter by model slug substring or exact ID (e.g. "claude-opus", "qwen3"). */
  modelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Only include threads with `settledAt != null` or `settledOverride === "settled"`. */
  settledOnly: Schema.Boolean,
  /** Exclude archived threads unless explicitly opted in. */
  includeArchived: Schema.Boolean,
  /** Exclude subagent / delegated child threads by default. */
  includeSubagents: Schema.Boolean,
  createdAfter: Schema.optional(IsoDateTime),
  createdBefore: Schema.optional(IsoDateTime),
  /** Minimum completed user->assistant turns in a thread. */
  minCompletedRuns: PositiveInt,
  /** Whether to include tool calls + tool results (`command_execution`, `file_change`, `dynamic_tool`, `file_search`). */
  includeToolCalls: Schema.Boolean,
  /** Whether to fold `reasoning` items into `<think>...</think>` blocks in assistant turns. */
  includeReasoning: Schema.Boolean,
  /** Whether to include checkpoint file summaries as structured tool context. */
  includeCheckpointDiffs: Schema.Boolean,
  /** Max characters per single tool output before deterministic head+tail clipping. */
  maxToolOutputChars: PositiveInt,
  /** Train / valid / test deterministic hash split ratios (sum = 1.0). */
  split: TrainingDatasetSplit,
  /** DPO-specific extraction toggles (ignored when objective === "sft"). */
  dpoSources: Schema.optional(TrainingDatasetDpoSources),
});
export type TrainingDatasetFilter = typeof TrainingDatasetFilter.Type;

export const RedactionRuleCategory = Schema.Literals([
  "api_key_provider",
  "jwt_bearer",
  "pem_private_key",
  "aws_gcp_cloud",
  "env_assignment",
  "url_credentials",
  "home_path_username",
  "email_address",
  "high_entropy_secret",
]);
export type RedactionRuleCategory = typeof RedactionRuleCategory.Type;

export const RedactionOptions = Schema.Struct({
  /** Always-on categories cannot be disabled: api_key_provider, jwt_bearer, pem_private_key, aws_gcp_cloud, url_credentials. */
  redactEnvAssignments: Schema.Boolean,
  redactHomePaths: Schema.Boolean,
  redactEmails: Schema.Boolean,
  redactHighEntropy: Schema.Boolean,
  /** Optional user-supplied literal strings (e.g. internal company/client names) to scrub. */
  customLiteralTerms: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type RedactionOptions = typeof RedactionOptions.Type;

export const RedactionAuditSourceKind = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_input",
  "tool_output",
  "diff",
]);
export type RedactionAuditSourceKind = typeof RedactionAuditSourceKind.Type;

/** Never contains raw secret values—only surrounding context and the replacement placeholder. */
export const RedactionAuditFinding = Schema.Struct({
  category: RedactionRuleCategory,
  ruleId: TrimmedNonEmptyString,
  threadId: ThreadId,
  sourceKind: RedactionAuditSourceKind,
  /** Masked preview with <=24 chars before/after and `[REDACTED:<CATEGORY>]`. */
  redactedSnippet: TrimmedNonEmptyString,
  /** Short non-reversible fingerprint (first 8 hex chars of SHA-256) to correlate duplicates. */
  matchDigestPrefix: TrimmedNonEmptyString,
});
export type RedactionAuditFinding = typeof RedactionAuditFinding.Type;

export const RedactionAuditReport = Schema.Struct({
  redactorVersion: TrimmedNonEmptyString,
  totalRedactions: NonNegativeInt,
  countsByCategory: Schema.Record(RedactionRuleCategory, NonNegativeInt),
  affectedThreadCount: NonNegativeInt,
  /** Capped at 100 representative findings for UI audit without flooding WS. */
  sampleFindings: Schema.Array(RedactionAuditFinding),
  findingsTruncated: Schema.Boolean,
});
export type RedactionAuditReport = typeof RedactionAuditReport.Type;

/** Canonical SFT ChatML tool call (compatible with `mlx_lm.tuner.datasets.ChatDataset` + OpenAI tool calls). */
export const TrainingToolCall = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: TrimmedNonEmptyString,
    arguments: Schema.String,
  }),
});
export type TrainingToolCall = typeof TrainingToolCall.Type;

export const TrainingChatMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.NullOr(Schema.String),
  tool_calls: Schema.optional(Schema.Array(TrainingToolCall)),
  tool_call_id: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
});
export type TrainingChatMessage = typeof TrainingChatMessage.Type;

export const TrainingSftRecord = Schema.Struct({
  messages: Schema.Array(TrainingChatMessage),
  tools: Schema.optional(Schema.Array(Schema.Json)),
});
export type TrainingSftRecord = typeof TrainingSftRecord.Type;

export const TrainingDpoRecord = Schema.Struct({
  prompt: Schema.Array(TrainingChatMessage),
  chosen: Schema.Array(TrainingChatMessage),
  rejected: Schema.Array(TrainingChatMessage),
  metadata: Schema.Struct({
    source: Schema.Literals(["fork", "rollback", "retry_attempt"]),
    sourceThreadId: ThreadId,
    chosenThreadId: ThreadId,
    rejectedThreadId: ThreadId,
    divergenceRunOrdinal: NonNegativeInt,
    confidence: Schema.Literals(["high", "medium"]),
  }),
});
export type TrainingDpoRecord = typeof TrainingDpoRecord.Type;

export const TrainingDatasetPreview = Schema.Struct({
  objective: TrainingObjective,
  matchedThreadCount: NonNegativeInt,
  skippedThreadCount: NonNegativeInt,
  totalExamples: NonNegativeInt,
  trainExamples: NonNegativeInt,
  validExamples: NonNegativeInt,
  testExamples: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
  redactionAudit: RedactionAuditReport,
  /** Up to 10 already-redacted sample records for visual inspection before commit. */
  sampleSftRecords: Schema.optional(Schema.Array(TrainingSftRecord)),
  sampleDpoRecords: Schema.optional(Schema.Array(TrainingDpoRecord)),
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type TrainingDatasetPreview = typeof TrainingDatasetPreview.Type;

export const TrainingDatasetSummary = Schema.Struct({
  id: TrainingDatasetId,
  name: TrimmedNonEmptyString,
  objective: TrainingObjective,
  filter: TrainingDatasetFilter,
  redactionOptions: RedactionOptions,
  redactionAudit: RedactionAuditReport,
  storagePath: TrimmedNonEmptyString,
  provenanceHash: TrimmedNonEmptyString,
  sourceThreadIds: Schema.Array(ThreadId),
  trainCount: NonNegativeInt,
  validCount: NonNegativeInt,
  testCount: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
  sizeBytes: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type TrainingDatasetSummary = typeof TrainingDatasetSummary.Type;

export const TrainingCuratedThread = Schema.Struct({
  bucketName: TrimmedNonEmptyString,
  threadId: ThreadId,
  addedAt: IsoDateTime,
  note: Schema.NullOr(TrimmedNonEmptyString),
});
export type TrainingCuratedThread = typeof TrainingCuratedThread.Type;

const TrainingLoraNumLayers = Schema.Int.check(
  Schema.makeFilter((value: number) => value === -1 || (value >= 1 && value <= 128), {
    expected: "-1 or an integer between 1 and 128",
  }),
);

export const TrainingLoraParams = Schema.Struct({
  rank: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  scale: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  dropout: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0.5 })),
  numLayers: TrainingLoraNumLayers,
});
export type TrainingLoraParams = typeof TrainingLoraParams.Type;

/** Prevents leading `-` so CLI flag injection into `mlx_lm.lora --model` is impossible at the boundary. */
const TrainingBaseModelRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value: string) => !value.startsWith("-"), {
    expected: "a model slug or directory path not starting with '-'",
  }),
);

export const TrainingJobConfig = Schema.Struct({
  name: TrimmedNonEmptyString,
  backend: TrainerBackendId,
  datasetId: TrainingDatasetId,
  /** HuggingFace repo slug (org/model) or validated local model directory path. */
  baseModel: TrainingBaseModelRef,
  fineTuneType: TrainingFineTuneType,
  optimizer: TrainingOptimizer,
  iters: PositiveInt,
  batchSize: PositiveInt,
  gradAccumulationSteps: PositiveInt,
  learningRate: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  maxSeqLength: PositiveInt,
  maskPrompt: Schema.Boolean,
  gradCheckpoint: Schema.Boolean,
  stepsPerReport: PositiveInt,
  stepsPerEval: PositiveInt,
  saveEvery: PositiveInt,
  valBatches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  seed: NonNegativeInt,
  lora: Schema.optional(TrainingLoraParams),
  /** Optional explicit storage root override (validated against allowed roots / mounted external SSD). */
  outputBaseDir: Schema.optional(TrimmedNonEmptyString),
  /** Automatically run `mlx_lm.fuse` after training succeeds. */
  autoFuse: Schema.Boolean,
  /** Automatically run `mlx_lm.lora --test` if dataset has a test split. */
  runTestEval: Schema.Boolean,
  /** Must be explicitly opted in; defaults to false. */
  trustRemoteCode: Schema.Boolean,
  /** Pause/drain local InferenceGateway servers before training (default true on Apple Silicon). */
  pauseLocalInference: Schema.Boolean,
  inferenceDrainTimeoutSec: PositiveInt,
});
export type TrainingJobConfig = typeof TrainingJobConfig.Type;

export const TrainingMetricTick = Schema.Struct({
  iter: NonNegativeInt,
  totalIters: PositiveInt,
  trainLoss: Schema.optional(Schema.Number),
  valLoss: Schema.optional(Schema.Number),
  learningRate: Schema.optional(Schema.Number),
  tokSec: Schema.optional(Schema.Number),
  itSec: Schema.optional(Schema.Number),
  trainedTokens: Schema.optional(NonNegativeInt),
  peakMemGb: Schema.optional(Schema.Number),
  etaSec: Schema.optional(NonNegativeInt),
  recordedAt: IsoDateTime,
});
export type TrainingMetricTick = typeof TrainingMetricTick.Type;

export const TrainingArtifact = Schema.Struct({
  id: TrainingArtifactId,
  jobId: TrainingJobId,
  datasetId: TrainingDatasetId,
  baseModel: TrimmedNonEmptyString,
  fineTuneType: TrainingFineTuneType,
  adapterPath: TrimmedNonEmptyString,
  fusedModelPath: Schema.NullOr(TrimmedNonEmptyString),
  ggufPath: Schema.NullOr(TrimmedNonEmptyString),
  /** SHA-256 of dataset manifest + training config + adapter safetensors checksum. */
  provenanceHash: TrimmedNonEmptyString,
  sourceThreadIds: Schema.Array(ThreadId),
  testLoss: Schema.optional(Schema.Number),
  testPerplexity: Schema.optional(Schema.Number),
  /** Linked InferenceServerId if currently registered in Settings -> Inference. */
  registeredInferenceServerId: Schema.NullOr(InferenceServerId),
  /** Managed mlx_lm.server port if currently served by T3. */
  servingPort: Schema.NullOr(PositiveInt),
  createdAt: IsoDateTime,
});
export type TrainingArtifact = typeof TrainingArtifact.Type;

export const TrainingJobSnapshot = Schema.Struct({
  id: TrainingJobId,
  config: TrainingJobConfig,
  status: TrainingJobStatus,
  statusMessage: Schema.optional(TrimmedNonEmptyString),
  errorCategory: Schema.optional(TrainingJobErrorCategory),
  latestMetric: Schema.NullOr(TrainingMetricTick),
  /** Bounded rolling series (max 500 points) for live loss chart without WS bloat. */
  recentMetrics: Schema.Array(TrainingMetricTick),
  truncationWarningsCount: NonNegativeInt,
  artifact: Schema.NullOr(TrainingArtifact),
  jobDir: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type TrainingJobSnapshot = typeof TrainingJobSnapshot.Type;

export const TrainingEvalModelSummary = Schema.Struct({
  model: TrimmedNonEmptyString,
  passRate: Schema.optional(Schema.Number),
  passedCases: Schema.optional(NonNegativeInt),
  totalCases: Schema.optional(NonNegativeInt),
  testLoss: Schema.optional(Schema.Number),
  testPerplexity: Schema.optional(Schema.Number),
});
export type TrainingEvalModelSummary = typeof TrainingEvalModelSummary.Type;

export const TrainingEvalComparison = Schema.Struct({
  id: TrainingEvalRunId,
  artifactId: TrainingArtifactId,
  suite: TrainingEvalSuite,
  status: TrainingEvalStatus,
  baseSummary: Schema.NullOr(TrainingEvalModelSummary),
  tunedSummary: Schema.NullOr(TrainingEvalModelSummary),
  reportPath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type TrainingEvalComparison = typeof TrainingEvalComparison.Type;

export const TrainerBackendCapabilities = Schema.Struct({
  id: TrainerBackendId,
  available: Schema.Boolean,
  binaryPath: Schema.NullOr(TrimmedNonEmptyString),
  version: Schema.NullOr(TrimmedNonEmptyString),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  supportedObjectives: Schema.Array(TrainingObjective),
  supportedFineTuneTypes: Schema.Array(TrainingFineTuneType),
  supportsFuse: Schema.Boolean,
  supportsGgufExport: Schema.Boolean,
  supportsAdapterServing: Schema.Boolean,
});
export type TrainerBackendCapabilities = typeof TrainerBackendCapabilities.Type;

export const TrainingStorageRootInfo = Schema.Struct({
  path: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  freeBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
  isExternal: Schema.Boolean,
});
export type TrainingStorageRootInfo = typeof TrainingStorageRootInfo.Type;

export const TrainingCachedModelInfo = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  modelType: Schema.NullOr(TrimmedNonEmptyString),
  supportsGgufExport: Schema.Boolean,
  sizeBytes: Schema.optional(NonNegativeInt),
});
export type TrainingCachedModelInfo = typeof TrainingCachedModelInfo.Type;

export const TrainingCapabilitiesResult = Schema.Struct({
  backends: Schema.Array(TrainerBackendCapabilities),
  hostMemoryBytes: NonNegativeInt,
  isAppleSilicon: Schema.Boolean,
  activeStorageDir: TrimmedNonEmptyString,
  activeStorageFreeBytes: NonNegativeInt,
  storageRoots: Schema.Array(TrainingStorageRootInfo),
  cachedModels: Schema.Array(TrainingCachedModelInfo),
  activeGpuLeaseJobId: Schema.NullOr(TrainingJobId),
});
export type TrainingCapabilitiesResult = typeof TrainingCapabilitiesResult.Type;

export const TrainingJobStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    jobs: Schema.Array(TrainingJobSnapshot),
    datasets: Schema.Array(TrainingDatasetSummary),
    activeGpuLeaseJobId: Schema.NullOr(TrainingJobId),
  }),
  Schema.Struct({
    type: Schema.Literal("job_updated"),
    job: TrainingJobSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("metric_tick"),
    jobId: TrainingJobId,
    tick: TrainingMetricTick,
  }),
  Schema.Struct({
    type: Schema.Literal("dataset_changed"),
    dataset: Schema.NullOr(TrainingDatasetSummary),
    datasetId: TrainingDatasetId,
  }),
  Schema.Struct({
    type: Schema.Literal("gpu_lease_changed"),
    activeGpuLeaseJobId: Schema.NullOr(TrainingJobId),
  }),
  Schema.Struct({
    type: Schema.Literal("eval_updated"),
    evalRun: TrainingEvalComparison,
  }),
]);
export type TrainingJobStreamEvent = typeof TrainingJobStreamEvent.Type;

// RPC Input & Output Schemas

export const TRAINING_LOG_MAX_BYTES = 65_536;

export const TrainingListCuratedThreadsInput = Schema.Struct({
  bucketName: Schema.optional(TrimmedNonEmptyString),
});
export type TrainingListCuratedThreadsInput = typeof TrainingListCuratedThreadsInput.Type;

export const TrainingListCuratedThreadsResult = Schema.Struct({
  threads: Schema.Array(TrainingCuratedThread),
});
export type TrainingListCuratedThreadsResult = typeof TrainingListCuratedThreadsResult.Type;

export const TrainingSetCuratedThreadInput = Schema.Struct({
  threadId: ThreadId,
  curated: Schema.Boolean,
  bucketName: Schema.optional(TrimmedNonEmptyString),
  note: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TrainingSetCuratedThreadInput = typeof TrainingSetCuratedThreadInput.Type;

export const TrainingSetCuratedThreadResult = Schema.Struct({
  threadId: ThreadId,
  curated: Schema.Boolean,
  bucketName: TrimmedNonEmptyString,
});
export type TrainingSetCuratedThreadResult = typeof TrainingSetCuratedThreadResult.Type;

export const TrainingListDatasetsResult = Schema.Struct({
  datasets: Schema.Array(TrainingDatasetSummary),
});
export type TrainingListDatasetsResult = typeof TrainingListDatasetsResult.Type;

export const TrainingGetDatasetInput = Schema.Struct({
  datasetId: TrainingDatasetId,
});
export type TrainingGetDatasetInput = typeof TrainingGetDatasetInput.Type;

export const TrainingGetDatasetResult = Schema.Struct({
  dataset: Schema.NullOr(TrainingDatasetSummary),
});
export type TrainingGetDatasetResult = typeof TrainingGetDatasetResult.Type;

export const TrainingPreviewDatasetInput = Schema.Struct({
  objective: TrainingObjective,
  filter: TrainingDatasetFilter,
  redactionOptions: RedactionOptions,
});
export type TrainingPreviewDatasetInput = typeof TrainingPreviewDatasetInput.Type;

export const TrainingCreateDatasetInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  objective: TrainingObjective,
  filter: TrainingDatasetFilter,
  redactionOptions: RedactionOptions,
  outputBaseDir: Schema.optional(TrimmedNonEmptyString),
});
export type TrainingCreateDatasetInput = typeof TrainingCreateDatasetInput.Type;

export const TrainingConvertDpoDatasetToSftInput = Schema.Struct({
  datasetId: TrainingDatasetId,
  name: Schema.optional(TrimmedNonEmptyString),
});
export type TrainingConvertDpoDatasetToSftInput = typeof TrainingConvertDpoDatasetToSftInput.Type;

export const TrainingDeleteDatasetInput = Schema.Struct({
  datasetId: TrainingDatasetId,
});
export type TrainingDeleteDatasetInput = typeof TrainingDeleteDatasetInput.Type;

export const TrainingDeleteDatasetResult = Schema.Struct({
  datasetId: TrainingDatasetId,
  deleted: Schema.Boolean,
});
export type TrainingDeleteDatasetResult = typeof TrainingDeleteDatasetResult.Type;

export const TrainingListJobsResult = Schema.Struct({
  jobs: Schema.Array(TrainingJobSnapshot),
  activeGpuLeaseJobId: Schema.NullOr(TrainingJobId),
});
export type TrainingListJobsResult = typeof TrainingListJobsResult.Type;

export const TrainingGetJobInput = Schema.Struct({
  jobId: TrainingJobId,
});
export type TrainingGetJobInput = typeof TrainingGetJobInput.Type;

export const TrainingGetJobResult = Schema.Struct({
  job: Schema.NullOr(TrainingJobSnapshot),
});
export type TrainingGetJobResult = typeof TrainingGetJobResult.Type;

export const TrainingGetJobLogsInput = Schema.Struct({
  jobId: TrainingJobId,
  tailBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: TRAINING_LOG_MAX_BYTES })),
  ),
  offsetBytes: Schema.optional(NonNegativeInt),
});
export type TrainingGetJobLogsInput = typeof TrainingGetJobLogsInput.Type;

export const TrainingGetJobLogsResult = Schema.Struct({
  jobId: TrainingJobId,
  content: Schema.String,
  totalBytes: NonNegativeInt,
  offsetBytes: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type TrainingGetJobLogsResult = typeof TrainingGetJobLogsResult.Type;

export const TrainingStartJobInput = Schema.Struct({
  config: TrainingJobConfig,
});
export type TrainingStartJobInput = typeof TrainingStartJobInput.Type;

export const TrainingCancelJobInput = Schema.Struct({
  jobId: TrainingJobId,
});
export type TrainingCancelJobInput = typeof TrainingCancelJobInput.Type;

const TrainingGgufFilename = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);

export const TrainingFuseArtifactInput = Schema.Struct({
  artifactId: TrainingArtifactId,
  exportGguf: Schema.optional(Schema.Boolean),
  ggufFilename: Schema.optional(TrainingGgufFilename),
  dequantize: Schema.optional(Schema.Boolean),
  trustRemoteCode: Schema.optional(Schema.Boolean),
});
export type TrainingFuseArtifactInput = typeof TrainingFuseArtifactInput.Type;

export const TrainingServeArtifactInput = Schema.Struct({
  artifactId: TrainingArtifactId,
  mode: Schema.optional(Schema.Literals(["adapter", "fused"])),
  autoRegisterInInference: Schema.optional(Schema.Boolean),
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type TrainingServeArtifactInput = typeof TrainingServeArtifactInput.Type;

export const TrainingServeArtifactResult = Schema.Struct({
  artifact: TrainingArtifact,
  port: PositiveInt,
  baseUrl: TrimmedNonEmptyString,
  registeredInferenceServerId: Schema.NullOr(InferenceServerId),
});
export type TrainingServeArtifactResult = typeof TrainingServeArtifactResult.Type;

export const TrainingStopServedArtifactInput = Schema.Struct({
  artifactId: TrainingArtifactId,
  removeInferenceServer: Schema.optional(Schema.Boolean),
});
export type TrainingStopServedArtifactInput = typeof TrainingStopServedArtifactInput.Type;

export const TrainingRegisterArtifactInInferenceInput = Schema.Struct({
  artifactId: TrainingArtifactId,
  displayName: Schema.optional(TrimmedNonEmptyString),
  serverId: Schema.optional(InferenceServerId),
});
export type TrainingRegisterArtifactInInferenceInput =
  typeof TrainingRegisterArtifactInInferenceInput.Type;

export const TrainingRegisterArtifactInInferenceResult = Schema.Struct({
  artifact: TrainingArtifact,
  serverId: InferenceServerId,
  baseUrl: TrimmedNonEmptyString,
});
export type TrainingRegisterArtifactInInferenceResult =
  typeof TrainingRegisterArtifactInInferenceResult.Type;

export const TrainingRunEvalInput = Schema.Struct({
  artifactId: TrainingArtifactId,
  suite: TrainingEvalSuite,
  samples: Schema.optional(PositiveInt),
});
export type TrainingRunEvalInput = typeof TrainingRunEvalInput.Type;

export const TrainingGetEvalInput = Schema.Struct({
  evalRunId: TrainingEvalRunId,
});
export type TrainingGetEvalInput = typeof TrainingGetEvalInput.Type;

export const TrainingGetEvalResult = Schema.Struct({
  evalRun: Schema.NullOr(TrainingEvalComparison),
});
export type TrainingGetEvalResult = typeof TrainingGetEvalResult.Type;

export const TrainingListArtifactsResult = Schema.Struct({
  artifacts: Schema.Array(TrainingArtifact),
});
export type TrainingListArtifactsResult = typeof TrainingListArtifactsResult.Type;

export const TrainingListEvalsInput = Schema.Struct({
  artifactId: Schema.optional(TrainingArtifactId),
});
export type TrainingListEvalsInput = typeof TrainingListEvalsInput.Type;

export const TrainingListEvalsResult = Schema.Struct({
  evalRuns: Schema.Array(TrainingEvalComparison),
});
export type TrainingListEvalsResult = typeof TrainingListEvalsResult.Type;

// Error Schemas

export const TrainingErrorCode = Schema.Literals([
  "invalid_request",
  "not_found",
  "conflict",
  "backend_unavailable",
  "insufficient_disk",
  "dataset_extraction_failed",
  "inference_drain_timeout",
  "execution_failed",
  "storage_failed",
]);
export type TrainingErrorCode = typeof TrainingErrorCode.Type;

export class TrainingOperationError extends Schema.TaggedError<TrainingOperationError>()(
  "TrainingOperationError",
  {
    code: TrainingErrorCode,
    operation: TrimmedNonEmptyString,
    resourceId: Schema.optional(TrimmedNonEmptyString),
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation} failed (${this.code}): ${this.reason}`;
  }
}
