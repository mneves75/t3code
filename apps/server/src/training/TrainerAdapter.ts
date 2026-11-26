import type {
  TrainerBackendCapabilities,
  TrainerBackendId,
  TrainingJobConfig,
  TrainingJobErrorCategory,
  TrainingJobId,
  TrainingMetricTick,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export class TrainerExecutionError extends Schema.TaggedError<TrainerExecutionError>()(
  "TrainerExecutionError",
  {
    category: Schema.Literals([
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
    ]),
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation} failed (${this.category}): ${this.reason}`;
  }
}

export type TrainerErrorCategory = TrainingJobErrorCategory;

export interface TrainerWarning {
  readonly kind: "sequence_truncated";
  readonly maxLen: number;
  readonly observedLen: number;
}

export interface TrainerCompletionResult {
  readonly adapterPath: string;
  readonly testLoss?: number;
  readonly testPerplexity?: number;
}

export interface TrainerRunHandle {
  readonly pid: number | null;
  readonly metrics: Stream.Stream<TrainingMetricTick, TrainerExecutionError>;
  readonly warnings: Stream.Stream<TrainerWarning>;
  readonly completion: Effect.Effect<TrainerCompletionResult, TrainerExecutionError>;
  readonly cancel: Effect.Effect<void>;
}

export interface TrainerStartInput {
  readonly jobId: TrainingJobId;
  readonly config: TrainingJobConfig;
  readonly datasetDir: string;
  readonly jobDir: string;
  readonly logFilePath: string;
  readonly metricsFilePath: string;
}

export interface TrainerFuseInput {
  readonly baseModel: string;
  readonly adapterPath: string;
  readonly savePath: string;
  readonly exportGguf: boolean;
  readonly ggufFilename?: string;
  readonly dequantize?: boolean;
  readonly trustRemoteCode: boolean;
  readonly logFilePath: string;
}

export interface TrainerTestEvalInput {
  readonly baseModel: string;
  readonly datasetDir: string;
  readonly adapterPath: string | null;
  readonly maxSeqLength?: number;
  readonly batchSize?: number;
  readonly trustRemoteCode?: boolean;
  readonly logFilePath: string;
}

export interface TrainerTestEvalResult {
  readonly testLoss: number;
  readonly testPerplexity: number;
}

export interface TrainerAdapter {
  readonly id: TrainerBackendId;
  readonly probeCapabilities: Effect.Effect<TrainerBackendCapabilities>;
  readonly startTraining: (
    input: TrainerStartInput,
  ) => Effect.Effect<TrainerRunHandle, TrainerExecutionError, Scope.Scope>;
  readonly fuse: (
    input: TrainerFuseInput,
  ) => Effect.Effect<
    { readonly fusedModelPath: string; readonly ggufPath: string | null },
    TrainerExecutionError
  >;
  readonly runTestEval?: (
    input: TrainerTestEvalInput,
  ) => Effect.Effect<TrainerTestEvalResult, TrainerExecutionError>;
}

export const UNAVAILABLE_MLX_DPO_CAPABILITIES: TrainerBackendCapabilities = {
  id: "mlx-dpo",
  available: false,
  binaryPath: null,
  version: null,
  unavailableReason:
    "Native MLX DPO training is not bundled yet; convert a DPO dataset's chosen completions to SFT or export DPO JSONL.",
  supportedObjectives: ["dpo"],
  supportedFineTuneTypes: ["lora", "dora"],
  supportsFuse: false,
  supportsGgufExport: false,
  supportsAdapterServing: false,
};

export const UNAVAILABLE_EXTERNAL_CAPABILITIES: TrainerBackendCapabilities = {
  id: "external",
  available: false,
  binaryPath: null,
  version: null,
  unavailableReason: "No external trainer adapter is configured on this host.",
  supportedObjectives: ["sft", "dpo"],
  supportedFineTuneTypes: ["lora", "dora", "full"],
  supportsFuse: false,
  supportsGgufExport: false,
  supportsAdapterServing: false,
};

export function makeUnavailableAdapter(capabilities: TrainerBackendCapabilities): TrainerAdapter {
  const unavailable = (operation: string) =>
    Effect.fail(
      new TrainerExecutionError({
        category: "invalid_config",
        operation,
        reason:
          capabilities.unavailableReason ?? `Trainer backend '${capabilities.id}' is unavailable.`,
      }),
    );

  return {
    id: capabilities.id,
    probeCapabilities: Effect.succeed(capabilities),
    startTraining: () => unavailable("startTraining"),
    fuse: () => unavailable("fuse"),
  };
}

export class TrainerRegistry extends Context.Service<
  TrainerRegistry,
  {
    readonly get: (id: TrainerBackendId) => TrainerAdapter | undefined;
    readonly list: ReadonlyArray<TrainerAdapter>;
    readonly probeAll: Effect.Effect<ReadonlyArray<TrainerBackendCapabilities>>;
  }
>()("t3/training/TrainerAdapter/TrainerRegistry") {}

export function makeTrainerRegistry(
  adapters: ReadonlyArray<TrainerAdapter>,
): TrainerRegistry["Service"] {
  const byId = new Map<TrainerBackendId, TrainerAdapter>();
  for (const adapter of adapters) {
    byId.set(adapter.id, adapter);
  }
  return TrainerRegistry.of({
    get: (id) => byId.get(id),
    list: [...byId.values()],
    probeAll: Effect.forEach([...byId.values()], (adapter) => adapter.probeCapabilities, {
      concurrency: "unbounded",
    }),
  });
}
