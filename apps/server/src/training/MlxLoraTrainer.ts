// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off -- spawns detached mlx_lm process groups, streams run.log, and samples RSS/statfs
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  TrainerBackendCapabilities,
  TrainingCachedModelInfo,
  TrainingJobConfig,
  TrainingMetricTick,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as YAML from "yaml";

import * as ServerSettings from "../serverSettings.ts";
import {
  createMlxMetricParserState,
  isMetalOomLine,
  parseMlxLoraLine,
  stripAnsi,
} from "./MlxLoraMetricParser.ts";
import {
  type TrainerAdapter,
  type TrainerCompletionResult,
  TrainerExecutionError,
  type TrainerFuseInput,
  type TrainerRunHandle,
  type TrainerStartInput,
  type TrainerTestEvalInput,
  type TrainerTestEvalResult,
  type TrainerWarning,
  TrainerRegistry,
  UNAVAILABLE_EXTERNAL_CAPABILITIES,
  UNAVAILABLE_MLX_DPO_CAPABILITIES,
  makeTrainerRegistry,
  makeUnavailableAdapter,
} from "./TrainerAdapter.ts";

const HF_REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GGUF_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GGUF_SUPPORTED_MODEL_TYPES: ReadonlySet<string> = new Set(["llama", "mixtral", "mistral"]);
const MIN_FREE_BYTES_LORA = 5 * 1024 * 1024 * 1024;
const MIN_FREE_BYTES_FULL_OR_FUSE = 20 * 1024 * 1024 * 1024;
const MAX_RUN_LOG_BYTES = 50 * 1024 * 1024;
const MAX_LINE_BUFFER_BYTES = 256 * 1024;
const SIGKILL_GRACE_MS = 5_000;
const RSS_SAMPLE_INTERVAL_MS = 2_000;

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

function isPathContainedWithinDir(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = resolvePathForContainment(rootDir);
  const resolvedTarget = resolvePathForContainment(targetPath);
  return resolvedTarget.startsWith(`${resolvedRoot}${NodePath.sep}`);
}

interface BoundedLogWriter {
  readonly write: (chunk: string) => void;
  readonly end: () => Promise<void>;
}

function createBoundedLogWriter(
  filePath: string,
  maxBytes: number,
  label: string,
): BoundedLogWriter {
  const stream = NodeFS.createWriteStream(filePath, { flags: "a" });
  let writtenBytes = 0;
  let ended = false;
  return {
    write(chunk: string) {
      if (ended || writtenBytes >= maxBytes) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (writtenBytes + bytes <= maxBytes) {
        stream.write(chunk);
        writtenBytes += bytes;
      } else {
        const remaining = maxBytes - writtenBytes;
        if (remaining > 0) {
          stream.write(chunk.slice(0, remaining));
          stream.write(`\n[${label} truncated at 50 MB limit]\n`);
        }
        writtenBytes = maxBytes;
      }
    },
    end() {
      ended = true;
      return new Promise((resolve) => {
        if (stream.writableEnded) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      });
    },
  };
}

export function isGgufSupportedModelType(modelType: string | null): boolean {
  return modelType !== null && GGUF_SUPPORTED_MODEL_TYPES.has(modelType.toLowerCase());
}

export function validateBaseModelRef(
  baseModel: string,
):
  | { readonly ok: true; readonly kind: "hf_slug" | "local_dir" }
  | { readonly ok: false; readonly reason: string } {
  const trimmed = baseModel.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
    return {
      ok: false,
      reason: "Base model must be a HuggingFace repo slug or local model directory, not a flag.",
    };
  }
  if (HF_REPO_SLUG_PATTERN.test(trimmed) && !NodePath.isAbsolute(trimmed)) {
    return { ok: true, kind: "hf_slug" };
  }
  const configPath = NodePath.join(trimmed, "config.json");
  if (NodeFS.existsSync(configPath)) {
    return { ok: true, kind: "local_dir" };
  }
  return {
    ok: false,
    reason:
      "Base model must match '<org>/<model>' or point to an existing local directory containing config.json.",
  };
}

function resolveHfHubCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HF_HUB_CACHE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const hfHome = env.HF_HOME?.trim();
  if (hfHome && hfHome.length > 0) return NodePath.join(hfHome, "hub");
  return NodePath.join(NodeOS.homedir(), ".cache", "huggingface", "hub");
}

function readModelTypeFromConfigDir(modelDir: string): string | null {
  const configPath = NodePath.join(modelDir, "config.json");
  try {
    const raw = NodeFS.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as { readonly model_type?: unknown };
    return typeof parsed.model_type === "string" && parsed.model_type.trim().length > 0
      ? parsed.model_type.trim()
      : null;
  } catch {
    return null;
  }
}

function resolveLocalModelConfigDir(
  baseModel: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (NodeFS.existsSync(NodePath.join(baseModel, "config.json"))) {
    return baseModel;
  }
  if (!HF_REPO_SLUG_PATTERN.test(baseModel)) return null;
  const cacheDir = resolveHfHubCacheDir(env);
  const repoDir = NodePath.join(cacheDir, `models--${baseModel.replace(/\//g, "--")}`);
  const snapshotsDir = NodePath.join(repoDir, "snapshots");
  try {
    const snapshots = NodeFS.readdirSync(snapshotsDir);
    for (const snap of snapshots) {
      const candidate = NodePath.join(snapshotsDir, snap);
      if (NodeFS.existsSync(NodePath.join(candidate, "config.json"))) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function scanCachedHfModels(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<TrainingCachedModelInfo> {
  const cacheDir = resolveHfHubCacheDir(env);
  const results: Array<TrainingCachedModelInfo> = [];
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(cacheDir);
  } catch {
    return results;
  }

  for (const entry of entries.toSorted()) {
    if (!entry.startsWith("models--")) continue;
    const parts = entry.slice("models--".length).split("--");
    if (parts.length < 2) continue;
    const modelId = `${parts[0]}/${parts.slice(1).join("--")}`;
    const snapshotsDir = NodePath.join(cacheDir, entry, "snapshots");
    try {
      const snaps = NodeFS.readdirSync(snapshotsDir);
      const snap = snaps.find((candidate) =>
        NodeFS.existsSync(NodePath.join(snapshotsDir, candidate, "config.json")),
      );
      if (snap === undefined) continue;
      const snapPath = NodePath.join(snapshotsDir, snap);
      const modelType = readModelTypeFromConfigDir(snapPath);
      results.push({
        id: modelId,
        path: snapPath,
        modelType,
        supportsGgufExport: isGgufSupportedModelType(modelType),
      });
    } catch {
      continue;
    }
  }

  return results;
}

export function resolveMlxBinary(
  binaryName: "mlx_lm.lora" | "mlx_lm.fuse" | "mlx_lm.server",
  configuredBinDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: Array<string> = [];
  if (configuredBinDir && configuredBinDir.trim().length > 0) {
    candidates.push(NodePath.join(configuredBinDir.trim(), binaryName));
  }
  candidates.push(NodePath.join(NodeOS.homedir(), ".local", "bin", binaryName));
  candidates.push(NodePath.join("/opt/homebrew/bin", binaryName));
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(NodePath.delimiter)) {
    if (dir.trim().length > 0) {
      candidates.push(NodePath.join(dir, binaryName));
    }
  }

  for (const candidate of candidates) {
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function buildMlxLoraConfigYaml(config: TrainingJobConfig): string {
  const doc: Record<string, unknown> = {
    fine_tune_type: config.fineTuneType,
    optimizer: config.optimizer,
    seed: config.seed,
  };
  if (config.fineTuneType !== "full") {
    doc.lora_parameters = {
      rank: config.lora?.rank ?? 8,
      dropout: config.lora?.dropout ?? 0.0,
      scale: config.lora?.scale ?? 20.0,
    };
  }
  return YAML.stringify(doc);
}

export function buildMlxLoraArgv(input: {
  readonly config: TrainingJobConfig;
  readonly configYamlPath: string;
  readonly datasetDir: string;
  readonly adapterDir: string;
  readonly effectiveValBatches: number;
  readonly testCount: number;
}): ReadonlyArray<string> {
  const { config } = input;
  return [
    "--train",
    "--config",
    input.configYamlPath,
    "--model",
    config.baseModel,
    "--data",
    input.datasetDir,
    "--fine-tune-type",
    config.fineTuneType,
    "--optimizer",
    config.optimizer,
    "--num-layers",
    String(config.lora?.numLayers ?? 16),
    "--batch-size",
    String(config.batchSize),
    "--iters",
    String(config.iters),
    "--learning-rate",
    String(config.learningRate),
    "--max-seq-length",
    String(config.maxSeqLength),
    "--grad-accumulation-steps",
    String(config.gradAccumulationSteps),
    "--steps-per-report",
    String(config.stepsPerReport),
    "--steps-per-eval",
    String(config.stepsPerEval),
    "--save-every",
    String(config.saveEvery),
    "--val-batches",
    String(input.effectiveValBatches),
    "--adapter-path",
    input.adapterDir,
    "--seed",
    String(config.seed),
    ...(config.maskPrompt ? ["--mask-prompt"] : []),
    ...(config.gradCheckpoint ? ["--grad-checkpoint"] : []),
    // mlx_lm runs --test after saving the adapter and fails on a split smaller than one batch.
    ...(config.runTestEval && input.testCount >= config.batchSize ? ["--test"] : []),
    ...(config.trustRemoteCode ? ["--trust-remote-code"] : []),
  ];
}

export function buildMlxFuseArgv(input: {
  readonly baseModel: string;
  readonly adapterPath: string;
  readonly savePath: string;
  readonly exportGguf: boolean;
  readonly ggufPath?: string;
  readonly dequantize?: boolean;
  readonly trustRemoteCode: boolean;
}): ReadonlyArray<string> {
  return [
    "--model",
    input.baseModel,
    "--adapter-path",
    input.adapterPath,
    "--save-path",
    input.savePath,
    ...(input.dequantize || input.exportGguf ? ["--dequantize"] : []),
    ...(input.exportGguf ? ["--export-gguf"] : []),
    ...(input.exportGguf && input.ggufPath ? ["--gguf-path", input.ggufPath] : []),
    ...(input.trustRemoteCode ? ["--trust-remote-code"] : []),
  ];
}

function buildMlxTestEvalArgv(input: {
  readonly baseModel: string;
  readonly datasetDir: string;
  readonly adapterPath: string | null;
  readonly maxSeqLength?: number;
  readonly batchSize?: number;
  readonly trustRemoteCode?: boolean;
}): ReadonlyArray<string> {
  return [
    "--model",
    input.baseModel,
    "--data",
    input.datasetDir,
    "--test",
    // mlx_lm defaults --adapter-path to "adapters" unless given "" for base-model eval.
    "--adapter-path",
    input.adapterPath ?? "",
    ...(input.maxSeqLength !== undefined ? ["--max-seq-length", String(input.maxSeqLength)] : []),
    ...(input.batchSize !== undefined ? ["--batch-size", String(input.batchSize)] : []),
    ...(input.trustRemoteCode ? ["--trust-remote-code"] : []),
  ];
}

export function buildSanitizedChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HF_HUB_CACHE",
    "HF_HOME",
    "HF_HUB_OFFLINE",
    "XDG_CACHE_HOME",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.PYTHONUNBUFFERED = "1";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  return env;
}

async function countJsonlLines(filePath: string): Promise<number> {
  try {
    const content = await NodeFSP.readFile(filePath, "utf8");
    let count = 0;
    for (const line of content.split("\n")) {
      if (line.trim().length > 0) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function getFreeDiskBytes(targetDir: string): Promise<number> {
  let probe = targetDir;
  while (!NodeFS.existsSync(probe)) {
    const parent = NodePath.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stats = await NodeFSP.statfs(probe);
  return Number(stats.bavail) * Number(stats.bsize);
}

function sampleProcessRssGb(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "ps",
      ["-o", "rss=", "-p", String(pid)],
      { timeout: 1_500 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const kib = Number.parseInt(stdout.trim(), 10);
        if (!Number.isFinite(kib) || kib <= 0) {
          resolve(undefined);
          return;
        }
        resolve(kib / 1_048_576);
      },
    );
  });
}

export function terminateProcessGroup(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const isAlive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
    };

    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already exited
        }
      }
    };

    if (!isAlive()) {
      resolve();
      return;
    }

    sendSignal("SIGTERM");
    const deadline = Date.now() + SIGKILL_GRACE_MS;
    const poll = setInterval(() => {
      if (!isAlive()) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        sendSignal("SIGKILL");
        resolve();
      }
    }, 100);
    poll.unref();
  });
}

function resolveSiblingPython(binaryPath: string): string | null {
  const dirs = new Set<string>();
  try {
    dirs.add(NodePath.dirname(NodeFS.realpathSync(binaryPath)));
  } catch {
    // Fall back to the declared path directory if realpath fails.
  }
  dirs.add(NodePath.dirname(binaryPath));
  for (const dir of dirs) {
    for (const name of ["python3", "python"]) {
      const candidate = NodePath.join(dir, name);
      try {
        NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function probeMlxVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      binaryPath,
      ["--version"],
      { timeout: 4_000, env: buildSanitizedChildEnv() },
      (error, stdout, stderr) => {
        const combined = `${stdout}\n${stderr}`.trim();
        const match = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(combined);
        if (!error) {
          resolve(match ? match[1]! : combined.split("\n")[0] || null);
          return;
        }
        if (match) {
          resolve(match[1]!);
          return;
        }
        // mlx_lm.lora does not support --version in 0.32.x; read package metadata via sibling python.
        const pythonBin = resolveSiblingPython(binaryPath);
        if (pythonBin === null) {
          resolve(null);
          return;
        }
        NodeChildProcess.execFile(
          pythonBin,
          ["-c", "import importlib.metadata; print(importlib.metadata.version('mlx-lm'))"],
          { timeout: 2_000, env: buildSanitizedChildEnv() },
          (pyError, pyStdout) => {
            if (pyError) {
              resolve(null);
              return;
            }
            const version = pyStdout.trim();
            resolve(version.length > 0 ? version : null);
          },
        );
      },
    );
  });
}

export interface MlxLoraTrainerOptions {
  readonly getBinDir?: () => Effect.Effect<string | undefined>;
  readonly minFreeBytesLora?: number;
  readonly minFreeBytesFullOrFuse?: number;
  readonly spawnProcess?: typeof NodeChildProcess.spawn;
  readonly resolveBinary?: (
    binaryName: "mlx_lm.lora" | "mlx_lm.fuse" | "mlx_lm.server",
    binDir?: string,
  ) => string | null;
}

export class MlxLoraTrainer extends Context.Service<MlxLoraTrainer, TrainerAdapter>()(
  "t3/training/MlxLoraTrainer",
) {}

export const makeMlxLoraTrainer = (options: MlxLoraTrainerOptions = {}): TrainerAdapter => {
  const resolveBin = options.resolveBinary ?? resolveMlxBinary;
  const spawnFn = options.spawnProcess ?? NodeChildProcess.spawn;
  const minLoraBytes = options.minFreeBytesLora ?? MIN_FREE_BYTES_LORA;
  const minFullBytes = options.minFreeBytesFullOrFuse ?? MIN_FREE_BYTES_FULL_OR_FUSE;

  const getConfiguredBinDir = (): Effect.Effect<string | undefined> =>
    options.getBinDir ? options.getBinDir() : Effect.undefined;

  const probeCapabilities: Effect.Effect<TrainerBackendCapabilities> = Effect.gen(function* () {
    const binDir = yield* getConfiguredBinDir();
    const loraBin = resolveBin("mlx_lm.lora", binDir);
    const fuseBin = resolveBin("mlx_lm.fuse", binDir);
    const serverBin = resolveBin("mlx_lm.server", binDir);

    if (loraBin === null) {
      return {
        id: "mlx-lora" as const,
        available: false,
        binaryPath: null,
        version: null,
        unavailableReason:
          "mlx_lm.lora was not found on PATH or in ~/.local/bin. Install mlx-lm (e.g. pipx install mlx-lm).",
        supportedObjectives: ["sft" as const],
        supportedFineTuneTypes: ["lora" as const, "dora" as const, "full" as const],
        supportsFuse: false,
        supportsGgufExport: false,
        supportsAdapterServing: false,
      };
    }

    const version = yield* Effect.promise(() => probeMlxVersion(loraBin));
    return {
      id: "mlx-lora" as const,
      available: true,
      binaryPath: loraBin,
      version,
      supportedObjectives: ["sft" as const],
      supportedFineTuneTypes: ["lora" as const, "dora" as const, "full" as const],
      supportsFuse: fuseBin !== null,
      supportsGgufExport: fuseBin !== null,
      supportsAdapterServing: serverBin !== null,
    };
  }).pipe(Effect.withSpan("MlxLoraTrainer.probeCapabilities"));

  const startTraining = Effect.fn("MlxLoraTrainer.startTraining")(function* (
    input: TrainerStartInput,
  ): Effect.fn.Return<TrainerRunHandle, TrainerExecutionError, never> {
    const binDir = yield* getConfiguredBinDir();
    const loraBin = resolveBin("mlx_lm.lora", binDir);
    if (loraBin === null) {
      return yield* new TrainerExecutionError({
        category: "trainer_spawn_failed",
        operation: "startTraining",
        reason: "mlx_lm.lora binary was not found.",
      });
    }

    const modelValidation = validateBaseModelRef(input.config.baseModel);
    if (!modelValidation.ok) {
      return yield* new TrainerExecutionError({
        category: "invalid_config",
        operation: "startTraining",
        reason: modelValidation.reason,
      });
    }

    const trainPath = NodePath.join(input.datasetDir, "train.jsonl");
    const validPath = NodePath.join(input.datasetDir, "valid.jsonl");
    const testPath = NodePath.join(input.datasetDir, "test.jsonl");

    const trainCount = yield* Effect.promise(() => countJsonlLines(trainPath));
    if (trainCount < input.config.batchSize) {
      return yield* new TrainerExecutionError({
        category: "dataset_invalid",
        operation: "startTraining",
        reason: `Dataset train.jsonl has ${trainCount} example(s), fewer than batchSize (${input.config.batchSize}).`,
      });
    }

    const validCount = yield* Effect.promise(() => countJsonlLines(validPath));
    const testCount = yield* Effect.promise(() => countJsonlLines(testPath));
    const effectiveValBatches = validCount >= input.config.batchSize ? input.config.valBatches : 0;

    const requiredDisk =
      input.config.fineTuneType === "full" || input.config.autoFuse ? minFullBytes : minLoraBytes;
    const freeBytes = yield* Effect.tryPromise({
      try: () => getFreeDiskBytes(input.jobDir),
      catch: (cause) =>
        new TrainerExecutionError({
          category: "insufficient_disk",
          operation: "startTraining",
          reason: "Unable to inspect free disk space for training job directory.",
          cause,
        }),
    });
    if (freeBytes < requiredDisk) {
      const freeGiB = (freeBytes / 1024 ** 3).toFixed(1);
      const reqGiB = (requiredDisk / 1024 ** 3).toFixed(0);
      return yield* new TrainerExecutionError({
        category: "insufficient_disk",
        operation: "startTraining",
        reason: `Free space (${freeGiB} GiB) is below required minimum (${reqGiB} GiB).`,
      });
    }

    const adapterDir = NodePath.join(input.jobDir, "adapters");
    const configYamlPath = NodePath.join(input.jobDir, "config.yaml");
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(adapterDir, { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(input.logFilePath), { recursive: true });
        await NodeFSP.writeFile(configYamlPath, buildMlxLoraConfigYaml(input.config), "utf8");
      },
      catch: (cause) =>
        new TrainerExecutionError({
          category: "trainer_spawn_failed",
          operation: "startTraining",
          reason: "Failed to prepare job directory and config.yaml.",
          cause,
        }),
    });

    const argv = buildMlxLoraArgv({
      config: input.config,
      configYamlPath,
      datasetDir: input.datasetDir,
      adapterDir,
      effectiveValBatches,
      testCount,
    });

    const metricsQueue = yield* Queue.unbounded<TrainingMetricTick | null>();
    const warningsQueue = yield* Queue.unbounded<TrainerWarning | null>();
    const completionDeferred = yield* Deferred.make<
      TrainerCompletionResult,
      TrainerExecutionError
    >();

    let cancelled = false;
    let sawOom = false;
    let testLoss: number | undefined;
    let testPerplexity: number | undefined;
    let latestRssGb: number | undefined;

    const parserState = createMlxMetricParserState(input.config.iters);
    const logWriter = createBoundedLogWriter(input.logFilePath, MAX_RUN_LOG_BYTES, "run.log");
    const metricsWriter = createBoundedLogWriter(
      input.metricsFilePath,
      MAX_RUN_LOG_BYTES,
      "metrics.jsonl",
    );

    const child = spawnFn(loraBin, [...argv], {
      cwd: input.jobDir,
      env: buildSanitizedChildEnv(),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const childPid = child.pid ?? null;

    const rssInterval =
      childPid !== null
        ? setInterval(() => {
            void sampleProcessRssGb(childPid).then((gb) => {
              if (gb !== undefined) {
                latestRssGb = latestRssGb === undefined ? gb : Math.max(latestRssGb, gb);
              }
            });
          }, RSS_SAMPLE_INTERVAL_MS)
        : null;
    rssInterval?.unref();

    const processLine = (rawLine: string, isStderr: boolean) => {
      if (isStderr && isMetalOomLine(rawLine)) {
        sawOom = true;
      }
      const parsed = parseMlxLoraLine(rawLine, parserState, {
        nowMs: Date.now(),
        recordedAt: new Date().toISOString(),
        ...(latestRssGb === undefined ? {} : { sampledPeakMemGb: latestRssGb }),
      });
      if (parsed.kind === "oom") {
        sawOom = true;
      } else if (parsed.kind === "test_summary") {
        testLoss = parsed.testLoss;
        testPerplexity = parsed.testPerplexity;
      } else if (parsed.kind === "sequence_truncated") {
        Queue.offerUnsafe(warningsQueue, {
          kind: "sequence_truncated",
          maxLen: parsed.maxLen,
          observedLen: parsed.observedLen,
        });
      } else if (parsed.kind === "metric") {
        metricsWriter.write(`${JSON.stringify(parsed.tick)}\n`);
        Queue.offerUnsafe(metricsQueue, parsed.tick);
      }
    };

    const attachReader = (readable: NodeJS.ReadableStream | null, isStderr: boolean) => {
      if (readable === null) return;
      let buffer = "";
      let droppingLongLine = false;
      readable.setEncoding("utf8");
      readable.on("data", (chunk: string) => {
        logWriter.write(chunk);
        let remaining = chunk;
        if (droppingLongLine) {
          const nl = remaining.indexOf("\n");
          if (nl === -1) return;
          remaining = remaining.slice(nl + 1);
          droppingLongLine = false;
        }
        buffer += remaining;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line, isStderr);
        }
        if (buffer.length > MAX_LINE_BUFFER_BYTES) {
          processLine(buffer.slice(0, MAX_LINE_BUFFER_BYTES), isStderr);
          buffer = "";
          droppingLongLine = true;
        }
      });
      readable.on("end", () => {
        if (buffer.length > 0 && !droppingLongLine) {
          processLine(buffer, isStderr);
          buffer = "";
        }
      });
    };

    attachReader(child.stdout, false);
    attachReader(child.stderr, true);

    const finishStreams = (): Promise<void> => {
      if (rssInterval !== null) clearInterval(rssInterval);
      Queue.offerUnsafe(metricsQueue, null);
      Queue.offerUnsafe(warningsQueue, null);
      return Promise.all([logWriter.end(), metricsWriter.end()]).then(() => undefined);
    };

    child.on("error", (error) => {
      void finishStreams().then(() => {
        Deferred.doneUnsafe(
          completionDeferred,
          Exit.fail(
            new TrainerExecutionError({
              category: "trainer_spawn_failed",
              operation: "startTraining",
              reason: "Failed to spawn mlx_lm.lora child process.",
              cause: error,
            }),
          ),
        );
      });
    });

    child.on("close", (code, signal) => {
      void finishStreams().then(() => {
        if (cancelled) {
          Deferred.doneUnsafe(
            completionDeferred,
            Exit.fail(
              new TrainerExecutionError({
                category: "cancelled",
                operation: "startTraining",
                reason: "Training job was cancelled.",
              }),
            ),
          );
          return;
        }
        if (code === 0) {
          Deferred.doneUnsafe(
            completionDeferred,
            Exit.succeed({
              adapterPath: adapterDir,
              ...(testLoss === undefined ? {} : { testLoss }),
              ...(testPerplexity === undefined ? {} : { testPerplexity }),
            }),
          );
          return;
        }
        if (sawOom) {
          Deferred.doneUnsafe(
            completionDeferred,
            Exit.fail(
              new TrainerExecutionError({
                category: "trainer_oom",
                operation: "startTraining",
                reason:
                  "Metal ran out of unified memory. Try enabling gradCheckpoint, reducing batchSize, or lowering maxSeqLength.",
              }),
            ),
          );
          return;
        }
        Deferred.doneUnsafe(
          completionDeferred,
          Exit.fail(
            new TrainerExecutionError({
              category: "trainer_exited_nonzero",
              operation: "startTraining",
              reason:
                signal !== null
                  ? `mlx_lm.lora terminated by signal ${signal}.`
                  : `mlx_lm.lora exited with code ${code ?? -1}.`,
            }),
          ),
        );
      });
    });

    const cancel = Effect.suspend(() => {
      cancelled = true;
      if (childPid === null) return Effect.void;
      return Effect.promise(() => terminateProcessGroup(childPid));
    });

    const metrics = Stream.fromQueue(metricsQueue).pipe(
      Stream.takeWhile((item): item is TrainingMetricTick => item !== null),
    );
    const warnings = Stream.fromQueue(warningsQueue).pipe(
      Stream.takeWhile((item): item is TrainerWarning => item !== null),
    );

    return {
      pid: childPid,
      metrics,
      warnings,
      completion: Deferred.await(completionDeferred),
      cancel,
    };
  });

  const fuse = Effect.fn("MlxLoraTrainer.fuse")(function* (input: TrainerFuseInput) {
    const binDir = yield* getConfiguredBinDir();
    const fuseBin = resolveBin("mlx_lm.fuse", binDir);
    if (fuseBin === null) {
      return yield* new TrainerExecutionError({
        category: "fuse_failed",
        operation: "fuse",
        reason: "mlx_lm.fuse binary was not found.",
      });
    }

    const modelValidation = validateBaseModelRef(input.baseModel);
    if (!modelValidation.ok) {
      return yield* new TrainerExecutionError({
        category: "invalid_config",
        operation: "fuse",
        reason: modelValidation.reason,
      });
    }

    if (input.exportGguf) {
      const configDir = resolveLocalModelConfigDir(input.baseModel);
      const modelType = configDir === null ? null : readModelTypeFromConfigDir(configDir);
      if (modelType !== null && !isGgufSupportedModelType(modelType)) {
        return yield* new TrainerExecutionError({
          category: "invalid_config",
          operation: "fuse",
          reason: `GGUF export is only supported by mlx_lm.fuse for llama, mixtral, and mistral architectures (detected '${modelType}'). Fuse as MLX safetensors instead.`,
        });
      }
    }

    const freeBytes = yield* Effect.tryPromise({
      try: () => getFreeDiskBytes(input.savePath),
      catch: (cause) =>
        new TrainerExecutionError({
          category: "insufficient_disk",
          operation: "fuse",
          reason: "Unable to inspect free disk space for fuse output directory.",
          cause,
        }),
    });
    if (freeBytes < minFullBytes) {
      return yield* new TrainerExecutionError({
        category: "insufficient_disk",
        operation: "fuse",
        reason: `Fusing requires at least ${(minFullBytes / 1024 ** 3).toFixed(0)} GiB free disk space.`,
      });
    }

    const ggufFilename = input.ggufFilename?.trim() || "ggml-model-f16.gguf";
    let ggufPath: string | null = null;
    if (input.exportGguf) {
      if (!GGUF_FILENAME_PATTERN.test(ggufFilename)) {
        return yield* new TrainerExecutionError({
          category: "invalid_config",
          operation: "fuse",
          reason:
            "GGUF filename must be a plain filename without path separators or traversal segments.",
        });
      }
      const candidatePath = NodePath.join(input.savePath, ggufFilename);
      if (!isPathContainedWithinDir(input.savePath, candidatePath)) {
        return yield* new TrainerExecutionError({
          category: "invalid_config",
          operation: "fuse",
          reason: "GGUF output path must stay contained within the fuse output directory.",
        });
      }
      ggufPath = candidatePath;
    }
    const argv = buildMlxFuseArgv({
      baseModel: input.baseModel,
      adapterPath: input.adapterPath,
      savePath: input.savePath,
      exportGguf: input.exportGguf,
      ...(ggufPath === null ? {} : { ggufPath }),
      ...(input.dequantize === undefined ? {} : { dequantize: input.dequantize }),
      trustRemoteCode: input.trustRemoteCode,
    });

    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(input.savePath, { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(input.logFilePath), { recursive: true });
      },
      catch: (cause) =>
        new TrainerExecutionError({
          category: "fuse_failed",
          operation: "fuse",
          reason: "Failed to prepare fuse output and log directories.",
          cause,
        }),
    });

    yield* Effect.suspend(() => {
      let childPid: number | null = null;
      let settled = false;
      const logWriter = createBoundedLogWriter(input.logFilePath, MAX_RUN_LOG_BYTES, "fuse.log");
      return Effect.callback<void, TrainerExecutionError>((resume) => {
        const child = spawnFn(fuseBin, [...argv], {
          env: buildSanitizedChildEnv(),
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        childPid = child.pid ?? null;
        let lastErrLine = "";
        child.stdout?.on("data", (chunk: Buffer) => logWriter.write(chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          logWriter.write(text);
          const clean = stripAnsi(text).slice(0, 4096);
          if (clean.length > 0) lastErrLine = clean;
        });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          void logWriter.end().then(() =>
            resume(
              Effect.fail(
                new TrainerExecutionError({
                  category: "fuse_failed",
                  operation: "fuse",
                  reason: "mlx_lm.fuse failed while merging adapter weights.",
                  cause: err,
                }),
              ),
            ),
          );
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          void logWriter.end().then(() => {
            if (code === 0) {
              resume(Effect.void);
            } else {
              resume(
                Effect.fail(
                  new TrainerExecutionError({
                    category: "fuse_failed",
                    operation: "fuse",
                    reason: "mlx_lm.fuse failed while merging adapter weights.",
                    cause: new Error(lastErrLine || `mlx_lm.fuse exited with code ${code ?? -1}`),
                  }),
                ),
              );
            }
          });
        });
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            settled = true;
            const pid = childPid;
            return Effect.promise(() =>
              Promise.all([
                pid !== null ? terminateProcessGroup(pid) : Promise.resolve(),
                logWriter.end(),
              ]).then(() => undefined),
            );
          }),
        ),
      );
    });

    return {
      fusedModelPath: input.savePath,
      ggufPath,
    };
  });

  const runTestEval = Effect.fn("MlxLoraTrainer.runTestEval")(function* (
    input: TrainerTestEvalInput,
  ): Effect.fn.Return<TrainerTestEvalResult, TrainerExecutionError> {
    const binDir = yield* getConfiguredBinDir();
    const loraBin = resolveBin("mlx_lm.lora", binDir);
    if (loraBin === null) {
      return yield* new TrainerExecutionError({
        category: "trainer_spawn_failed",
        operation: "runTestEval",
        reason: "mlx_lm.lora binary was not found.",
      });
    }

    // mlx_lm refuses a split smaller than one batch; its default batch is 4.
    const testCount = yield* Effect.promise(() =>
      countJsonlLines(NodePath.join(input.datasetDir, "test.jsonl")),
    );
    const argv = buildMlxTestEvalArgv({
      ...input,
      batchSize: Math.max(1, Math.min(input.batchSize ?? 4, testCount)),
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const recordedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(NodePath.dirname(input.logFilePath), { recursive: true }),
      catch: (cause) =>
        new TrainerExecutionError({
          category: "trainer_exited_nonzero",
          operation: "runTestEval",
          reason: "Failed to prepare test evaluation log directory.",
          cause,
        }),
    });

    const parsed = yield* Effect.suspend(() => {
      let childPid: number | null = null;
      let settled = false;
      const logWriter = createBoundedLogWriter(input.logFilePath, MAX_RUN_LOG_BYTES, "eval.log");
      return Effect.callback<TrainerTestEvalResult, TrainerExecutionError>((resume) => {
        const state = createMlxMetricParserState(1);
        let found: TrainerTestEvalResult | null = null;
        const child = spawnFn(loraBin, [...argv], {
          env: buildSanitizedChildEnv(),
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        childPid = child.pid ?? null;

        const attachEvalReader = (readable: NodeJS.ReadableStream | null) => {
          if (readable === null) return;
          let buffer = "";
          let droppingLongLine = false;
          readable.setEncoding("utf8");
          readable.on("data", (chunk: string) => {
            logWriter.write(chunk);
            let remaining = chunk;
            if (droppingLongLine) {
              const nl = remaining.indexOf("\n");
              if (nl === -1) return;
              remaining = remaining.slice(nl + 1);
              droppingLongLine = false;
            }
            buffer += remaining;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const res = parseMlxLoraLine(line, state, { nowMs, recordedAt });
              if (res.kind === "test_summary") {
                found = { testLoss: res.testLoss, testPerplexity: res.testPerplexity };
              }
            }
            if (buffer.length > MAX_LINE_BUFFER_BYTES) {
              const res = parseMlxLoraLine(buffer.slice(0, MAX_LINE_BUFFER_BYTES), state, {
                nowMs,
                recordedAt,
              });
              if (res.kind === "test_summary") {
                found = { testLoss: res.testLoss, testPerplexity: res.testPerplexity };
              }
              buffer = "";
              droppingLongLine = true;
            }
          });
          readable.on("end", () => {
            if (buffer.length > 0 && !droppingLongLine) {
              const res = parseMlxLoraLine(buffer, state, { nowMs, recordedAt });
              if (res.kind === "test_summary") {
                found = { testLoss: res.testLoss, testPerplexity: res.testPerplexity };
              }
              buffer = "";
            }
          });
        };

        attachEvalReader(child.stdout);
        attachEvalReader(child.stderr);

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          void logWriter.end().then(() =>
            resume(
              Effect.fail(
                new TrainerExecutionError({
                  category: "trainer_exited_nonzero",
                  operation: "runTestEval",
                  reason: "mlx_lm.lora --test evaluation failed.",
                  cause: err,
                }),
              ),
            ),
          );
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          void logWriter.end().then(() => {
            if (code !== 0) {
              resume(
                Effect.fail(
                  new TrainerExecutionError({
                    category: "trainer_exited_nonzero",
                    operation: "runTestEval",
                    reason: "mlx_lm.lora --test evaluation failed.",
                    cause: new Error(`mlx_lm.lora --test exited with code ${code ?? -1}`),
                  }),
                ),
              );
              return;
            }
            if (found === null) {
              resume(
                Effect.fail(
                  new TrainerExecutionError({
                    category: "trainer_exited_nonzero",
                    operation: "runTestEval",
                    reason: "mlx_lm.lora --test completed without emitting Test loss / Test ppl.",
                  }),
                ),
              );
              return;
            }
            resume(Effect.succeed(found));
          });
        });
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            settled = true;
            const pid = childPid;
            return Effect.promise(() =>
              Promise.all([
                pid !== null ? terminateProcessGroup(pid) : Promise.resolve(),
                logWriter.end(),
              ]).then(() => undefined),
            );
          }),
        ),
      );
    });

    return parsed;
  });

  return {
    id: "mlx-lora",
    probeCapabilities,
    startTraining,
    fuse,
    runTestEval,
  };
};

export const layer = Layer.effect(
  MlxLoraTrainer,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return MlxLoraTrainer.of(
      makeMlxLoraTrainer({
        getBinDir: () =>
          settings.getSettings.pipe(
            Effect.map((current) => current.training.mlxBinDir || undefined),
            Effect.orElseSucceed(() => undefined),
          ),
      }),
    );
  }),
);

export const registryLayer = Layer.effect(
  TrainerRegistry,
  Effect.gen(function* () {
    const mlx = yield* MlxLoraTrainer;
    return makeTrainerRegistry([
      mlx,
      makeUnavailableAdapter(UNAVAILABLE_MLX_DPO_CAPABILITIES),
      makeUnavailableAdapter(UNAVAILABLE_EXTERNAL_CAPABILITIES),
    ]);
  }),
);
