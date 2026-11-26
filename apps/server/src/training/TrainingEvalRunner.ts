// @effect-diagnostics nodeBuiltinImport:off -- invokes evals/local-coding subprocess and writes comparison report
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type TrainingArtifact,
  type TrainingDatasetSummary,
  type TrainingEvalComparison,
  type TrainingEvalModelSummary,
  TrainingEvalRunId,
  type TrainingEvalSuite,
  type TrainingJobId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
import { buildSanitizedChildEnv, terminateProcessGroup } from "./MlxLoraTrainer.ts";
import * as TrainerAdapter from "./TrainerAdapter.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingStore from "./TrainingStore.ts";

export class TrainingEvalError extends Schema.TaggedError<TrainingEvalError>()(
  "TrainingEvalError",
  {
    operation: Schema.String,
    evalRunId: Schema.optional(Schema.String),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Training eval (${this.operation}) failed: ${this.reason}`;
  }
}

export interface LocalCodingEvalRequest {
  readonly baseUrl: string;
  readonly model: string;
  readonly outDir: string;
  readonly samples: number;
}

export interface LocalCodingEvalResult {
  readonly passRate: number;
  readonly passedCases: number;
  readonly totalCases: number;
}

function parseLocalCodingSummaryJson(raw: string): LocalCodingEvalResult {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const readNum = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const totalCases =
    readNum(parsed.totalCases) ??
    readNum(parsed.totalSamples) ??
    readNum(parsed.cases) ??
    readNum(parsed.total) ??
    0;
  const passedCases =
    readNum(parsed.passedCases) ?? readNum(parsed.passedSamples) ?? readNum(parsed.passed) ?? 0;
  const explicitPassRate = readNum(parsed.passRate) ?? readNum(parsed.pass_rate);
  const passRate =
    explicitPassRate !== undefined
      ? explicitPassRate
      : totalCases > 0
        ? Number((passedCases / totalCases).toFixed(4))
        : 0;

  return {
    passRate,
    passedCases,
    totalCases,
  };
}

function resolveEvalScriptPath(): string | null {
  const candidates = [
    NodePath.resolve(import.meta.dirname, "../../../../evals/local-coding/run.ts"),
    NodePath.resolve(process.cwd(), "evals/local-coding/run.ts"),
  ];
  for (const candidate of candidates) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

// mlx_lm.server applies its --adapter-path only to requests naming this id; any other id,
// the base model's included, reloads that model without the adapter.
const MLX_SERVER_DEFAULT_MODEL = "default_model";

const encodePrettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const defaultRunLocalCoding = Effect.fn("TrainingEvalRunner.runLocalCoding")(function* (
  request: LocalCodingEvalRequest,
): Effect.fn.Return<LocalCodingEvalResult, TrainingEvalError> {
  const scriptPath = resolveEvalScriptPath();
  if (scriptPath === null) {
    return yield* new TrainingEvalError({
      operation: "runLocalCoding",
      reason: "evals/local-coding/run.ts was not found in this workspace.",
    });
  }
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(request.outDir, { recursive: true }),
    catch: (cause) =>
      new TrainingEvalError({
        operation: "runLocalCoding",
        reason: "Failed to create local coding eval output directory.",
        cause,
      }),
  });
  const argv = [
    scriptPath,
    "--out",
    request.outDir,
    "--model",
    request.model,
    "--base-url",
    request.baseUrl,
    "--harness",
    "openai",
    "--samples",
    String(request.samples),
  ];

  yield* Effect.suspend(() => {
    let childPid: number | null = null;
    let settled = false;
    return Effect.callback<void, TrainingEvalError>((resume) => {
      const child = NodeChildProcess.spawn(process.execPath, argv, {
        cwd: NodePath.dirname(NodePath.dirname(scriptPath)),
        env: buildSanitizedChildEnv(),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      childPid = child.pid ?? null;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
      });
      child.on("error", (cause) => {
        if (settled) return;
        settled = true;
        resume(
          Effect.fail(
            new TrainingEvalError({
              operation: "runLocalCoding",
              reason: "Local coding eval subprocess failed.",
              cause,
            }),
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resume(Effect.void);
        } else {
          resume(
            Effect.fail(
              new TrainingEvalError({
                operation: "runLocalCoding",
                reason: "Local coding eval subprocess failed.",
                cause: new Error(
                  stderr.trim() || `local-coding eval exited with code ${code ?? -1}`,
                ),
              }),
            ),
          );
        }
      });
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          settled = true;
          const pid = childPid;
          return pid !== null ? Effect.promise(() => terminateProcessGroup(pid)) : Effect.void;
        }),
      ),
    );
  });

  const summaryPath = NodePath.join(request.outDir, "summary.json");
  return yield* Effect.tryPromise({
    try: async () => {
      const raw = await NodeFSP.readFile(summaryPath, "utf8");
      return parseLocalCodingSummaryJson(raw);
    },
    catch: (cause) =>
      new TrainingEvalError({
        operation: "runLocalCoding",
        reason: "Failed to read local coding eval summary.",
        cause,
      }),
  });
});

export interface TrainingEvalRunnerOptions {
  readonly runLocalCoding?: (
    request: LocalCodingEvalRequest,
  ) => Effect.Effect<LocalCodingEvalResult, TrainingEvalError>;
}

export class TrainingEvalRunner extends Context.Service<
  TrainingEvalRunner,
  {
    readonly runComparison: (input: {
      readonly evalRunId: TrainingEvalRunId;
      readonly jobId: TrainingJobId;
      readonly artifact: TrainingArtifact;
      readonly dataset: TrainingDatasetSummary;
      readonly suite: TrainingEvalSuite;
      readonly reportDir: string;
      readonly samples?: number;
      readonly pauseLocalInference?: boolean;
      readonly drainTimeoutSec?: number;
      readonly initialRecord?: TrainingEvalComparison;
    }) => Effect.Effect<TrainingEvalComparison, TrainingEvalError>;
  }
>()("t3/training/TrainingEvalRunner") {}

export const makeWithOptions = Effect.fn("TrainingEvalRunner.make")(function* (
  options: TrainingEvalRunnerOptions = {},
) {
  const store = yield* TrainingStore.TrainingStore;
  const gpuCoordinator = yield* LocalGpuCoordinator.LocalGpuCoordinator;
  const trainerRegistry = yield* TrainerAdapter.TrainerRegistry;
  const adapterServer = yield* TrainingAdapterServer.TrainingAdapterServer;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const runLocalCoding = options.runLocalCoding ?? defaultRunLocalCoding;

  return TrainingEvalRunner.of({
    runComparison: Effect.fn("TrainingEvalRunner.runComparison")(function* (input) {
      const createdAt = input.initialRecord?.createdAt ?? (yield* nowIso);
      const reportPath =
        input.initialRecord?.reportPath ?? NodePath.join(input.reportDir, "comparison.json");
      if (input.initialRecord === undefined) {
        const initial: TrainingEvalComparison = {
          id: input.evalRunId,
          artifactId: input.artifact.id,
          suite: input.suite,
          status: "running",
          baseSummary: null,
          tunedSummary: null,
          reportPath,
          createdAt,
          completedAt: null,
        };

        yield* store.insertEvalRun(initial).pipe(
          Effect.mapError(
            (cause) =>
              new TrainingEvalError({
                operation: "insertEvalRun",
                evalRunId: input.evalRunId,
                reason: "Failed to persist initial eval run record.",
                cause,
              }),
          ),
        );
      }

      const execute = Effect.scoped(
        Effect.gen(function* () {
          yield* gpuCoordinator
            .acquireLease({
              jobId: input.jobId,
              reason: `eval:${input.evalRunId}`,
              pauseLocalInference: input.pauseLocalInference ?? true,
              drainTimeout: Duration.seconds(input.drainTimeoutSec ?? 60),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TrainingEvalError({
                    operation: "acquireGpuLease",
                    evalRunId: input.evalRunId,
                    reason: cause.reason,
                    cause,
                  }),
              ),
            );

          yield* Effect.tryPromise({
            try: () => NodeFSP.mkdir(input.reportDir, { recursive: true }),
            catch: (cause) =>
              new TrainingEvalError({
                operation: "prepareReportDir",
                evalRunId: input.evalRunId,
                reason: "Failed to create eval report directory.",
                cause,
              }),
          });

          let baseSummary: TrainingEvalModelSummary;
          let tunedSummary: TrainingEvalModelSummary;

          if (input.suite === "heldout_perplexity") {
            const testFilePath = NodePath.join(input.dataset.storagePath, "test.jsonl");
            if (!NodeFS.existsSync(testFilePath)) {
              return yield* new TrainingEvalError({
                operation: "heldout_perplexity",
                evalRunId: input.evalRunId,
                reason: "Dataset has no test.jsonl split for held-out perplexity evaluation.",
              });
            }
            const trainer = trainerRegistry.get("mlx-lora");
            if (trainer === undefined || trainer.runTestEval === undefined) {
              return yield* new TrainingEvalError({
                operation: "heldout_perplexity",
                evalRunId: input.evalRunId,
                reason: "mlx-lora trainer backend does not support held-out perplexity eval.",
              });
            }

            const baseRes = yield* trainer
              .runTestEval({
                baseModel: input.artifact.baseModel,
                datasetDir: input.dataset.storagePath,
                adapterPath: null,
                logFilePath: NodePath.join(input.reportDir, "base-test.log"),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new TrainingEvalError({
                      operation: "heldout_perplexity:base",
                      evalRunId: input.evalRunId,
                      reason: cause.reason,
                      cause,
                    }),
                ),
              );

            const tunedRes = yield* trainer
              .runTestEval({
                baseModel: input.artifact.baseModel,
                datasetDir: input.dataset.storagePath,
                adapterPath: input.artifact.adapterPath,
                logFilePath: NodePath.join(input.reportDir, "tuned-test.log"),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new TrainingEvalError({
                      operation: "heldout_perplexity:tuned",
                      evalRunId: input.evalRunId,
                      reason: cause.reason,
                      cause,
                    }),
                ),
              );

            baseSummary = {
              model: input.artifact.baseModel,
              testLoss: baseRes.testLoss,
              testPerplexity: baseRes.testPerplexity,
            };
            tunedSummary = {
              model: `${input.artifact.baseModel} (tuned)`,
              testLoss: tunedRes.testLoss,
              testPerplexity: tunedRes.testPerplexity,
            };
          } else {
            const samples = input.samples ?? 1;

            const baseMetrics = yield* Effect.acquireUseRelease(
              adapterServer
                .startTemporary({
                  model: input.artifact.baseModel,
                  adapterPath: null,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new TrainingEvalError({
                        operation: "local_coding:startBaseServer",
                        evalRunId: input.evalRunId,
                        reason: cause.reason,
                        cause,
                      }),
                  ),
                ),
              (srv) =>
                runLocalCoding({
                  baseUrl: srv.baseUrl,
                  model: MLX_SERVER_DEFAULT_MODEL,
                  outDir: NodePath.join(input.reportDir, "base"),
                  samples,
                }),
              (srv) => srv.stop,
            );

            const tunedModelRef = input.artifact.fusedModelPath ?? input.artifact.baseModel;
            const tunedAdapterPath =
              input.artifact.fusedModelPath !== null ? null : input.artifact.adapterPath;

            const tunedMetrics = yield* Effect.acquireUseRelease(
              adapterServer
                .startTemporary({
                  model: tunedModelRef,
                  adapterPath: tunedAdapterPath,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new TrainingEvalError({
                        operation: "local_coding:startTunedServer",
                        evalRunId: input.evalRunId,
                        reason: cause.reason,
                        cause,
                      }),
                  ),
                ),
              (srv) =>
                runLocalCoding({
                  baseUrl: srv.baseUrl,
                  model: MLX_SERVER_DEFAULT_MODEL,
                  outDir: NodePath.join(input.reportDir, "tuned"),
                  samples,
                }),
              (srv) => srv.stop,
            );

            baseSummary = {
              model: input.artifact.baseModel,
              passRate: baseMetrics.passRate,
              passedCases: baseMetrics.passedCases,
              totalCases: baseMetrics.totalCases,
            };
            tunedSummary = {
              model:
                input.artifact.fusedModelPath !== null
                  ? input.artifact.fusedModelPath
                  : `${input.artifact.baseModel} (adapter)`,
              passRate: tunedMetrics.passRate,
              passedCases: tunedMetrics.passedCases,
              totalCases: tunedMetrics.totalCases,
            };
          }

          const completedAt = yield* nowIso;
          const comparison: TrainingEvalComparison = {
            id: input.evalRunId,
            artifactId: input.artifact.id,
            suite: input.suite,
            status: "completed",
            baseSummary,
            tunedSummary,
            reportPath,
            createdAt,
            completedAt,
          };

          yield* Effect.tryPromise({
            try: () => NodeFSP.writeFile(reportPath, encodePrettyJson(comparison), "utf8"),
            catch: (cause) =>
              new TrainingEvalError({
                operation: "writeComparisonReport",
                evalRunId: input.evalRunId,
                reason: "Failed to write eval comparison report.",
                cause,
              }),
          });

          yield* store
            .updateEvalRun(input.evalRunId, {
              status: "completed",
              baseSummary,
              tunedSummary,
              reportPath,
              completedAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TrainingEvalError({
                    operation: "updateEvalRun",
                    evalRunId: input.evalRunId,
                    reason: "Failed to persist completed eval run.",
                    cause,
                  }),
              ),
            );

          return comparison;
        }),
      );

      return yield* execute.pipe(
        Effect.onError(() =>
          nowIso.pipe(
            Effect.flatMap((completedAt) =>
              store.updateEvalRun(input.evalRunId, {
                status: "failed",
                completedAt,
              }),
            ),
            Effect.ignore,
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(TrainingEvalRunner, makeWithOptions());
