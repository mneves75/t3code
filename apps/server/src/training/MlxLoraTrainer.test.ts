// @effect-diagnostics nodeBuiltinImport:off -- temp subprocess fixtures in live test
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { TrainingDatasetId, TrainingJobId, type TrainingJobConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import {
  buildMlxFuseArgv,
  buildMlxLoraArgv,
  buildMlxLoraConfigYaml,
  isGgufSupportedModelType,
  makeMlxLoraTrainer,
  scanCachedHfModels,
  validateBaseModelRef,
} from "./MlxLoraTrainer.ts";

const makeConfig = (overrides: Partial<TrainingJobConfig> = {}): TrainingJobConfig => ({
  name: "Smoke LoRA",
  backend: "mlx-lora",
  datasetId: TrainingDatasetId.make("ds-1"),
  baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
  fineTuneType: "lora",
  optimizer: "adamw",
  iters: 20,
  batchSize: 2,
  gradAccumulationSteps: 1,
  learningRate: 1e-5,
  maxSeqLength: 2048,
  maskPrompt: true,
  gradCheckpoint: true,
  stepsPerReport: 5,
  stepsPerEval: 10,
  saveEvery: 10,
  valBatches: 2,
  seed: 42,
  lora: { rank: 8, scale: 20, dropout: 0.05, numLayers: 16 },
  autoFuse: false,
  runTestEval: true,
  trustRemoteCode: false,
  pauseLocalInference: true,
  inferenceDrainTimeoutSec: 60,
  ...overrides,
});

describe("MlxLoraTrainer", () => {
  it("validates baseModel refs against flag injection and builds exact CLI argv and YAML config", () => {
    expect(validateBaseModelRef("--malicious-flag").ok).toBe(false);
    expect(validateBaseModelRef("mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")).toEqual({
      ok: true,
      kind: "hf_slug",
    });

    expect(isGgufSupportedModelType("llama")).toBe(true);
    expect(isGgufSupportedModelType("mistral")).toBe(true);
    expect(isGgufSupportedModelType("qwen2")).toBe(false);

    const config = makeConfig();
    const yaml = buildMlxLoraConfigYaml(config);
    expect(yaml).toContain("rank: 8");
    expect(yaml).toContain("scale: 20");
    expect(yaml).toContain("dropout: 0.05");

    const argvFor = (testCount: number) =>
      buildMlxLoraArgv({
        config,
        configYamlPath: "/tmp/job/config.yaml",
        datasetDir: "/tmp/ds",
        adapterDir: "/tmp/job/adapters",
        effectiveValBatches: 0,
        testCount,
      });
    const argv = argvFor(2);
    expect(argv).toContain("--train");
    expect(argv).toContain("--mask-prompt");
    expect(argv).toContain("--grad-checkpoint");
    expect(argv).toContain("--test");
    // mlx_lm saves the adapter, then its --test pass fails on a split smaller than one batch.
    expect(argvFor(1)).not.toContain("--test");
    expect(argv).not.toContain("--trust-remote-code");
    expect(argv[argv.indexOf("--val-batches") + 1]).toBe("0");

    const fuseArgv = buildMlxFuseArgv({
      baseModel: "org/llama-3",
      adapterPath: "/tmp/adapters",
      savePath: "/tmp/fused",
      exportGguf: true,
      ggufPath: "/tmp/fused/model.gguf",
      trustRemoteCode: false,
    });
    expect(fuseArgv).toContain("--dequantize");
    expect(fuseArgv).toContain("--export-gguf");
    expect(fuseArgv).toContain("/tmp/fused/model.gguf");
  });

  it.live("rejects datasets with trainCount < batchSize and GGUF export on non-llama models", () =>
    Effect.gen(function* () {
      const tmpRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mlx-preflight-")),
      );
      try {
        const datasetDir = NodePath.join(tmpRoot, "ds");
        const modelDir = NodePath.join(tmpRoot, "qwen-model");
        const jobDir = NodePath.join(tmpRoot, "job");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(datasetDir, { recursive: true });
          await NodeFSP.mkdir(modelDir, { recursive: true });
          await NodeFSP.mkdir(jobDir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(datasetDir, "train.jsonl"),
            '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"ok"}]}\n',
          );
          await NodeFSP.writeFile(
            NodePath.join(modelDir, "config.json"),
            JSON.stringify({ model_type: "qwen2" }),
          );
        });

        const trainer = makeMlxLoraTrainer({
          resolveBinary: () => "/bin/echo",
          minFreeBytesLora: 1,
          minFreeBytesFullOrFuse: 1,
        });

        const trainExit = yield* Effect.exit(
          Effect.scoped(
            trainer.startTraining({
              jobId: TrainingJobId.make("job-small"),
              config: makeConfig({ baseModel: modelDir, batchSize: 4 }),
              datasetDir,
              jobDir,
              logFilePath: NodePath.join(jobDir, "run.log"),
              metricsFilePath: NodePath.join(jobDir, "metrics.jsonl"),
            }),
          ),
        );
        expect(Exit.isFailure(trainExit)).toBe(true);
        expect(String(trainExit)).toContain("dataset_invalid");

        const fuseExit = yield* Effect.exit(
          trainer.fuse({
            baseModel: modelDir,
            adapterPath: NodePath.join(jobDir, "adapters"),
            savePath: NodePath.join(jobDir, "fused"),
            exportGguf: true,
            trustRemoteCode: false,
            logFilePath: NodePath.join(jobDir, "fuse.log"),
          }),
        );
        expect(Exit.isFailure(fuseExit)).toBe(true);
        expect(String(fuseExit)).toContain("qwen2");

        // SEC-05: path traversal in ggufFilename is rejected even on llama models
        const llamaModelDir = NodePath.join(tmpRoot, "llama-model");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(llamaModelDir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(llamaModelDir, "config.json"),
            JSON.stringify({ model_type: "llama" }),
          );
        });
        const traversalExit = yield* Effect.exit(
          trainer.fuse({
            baseModel: llamaModelDir,
            adapterPath: NodePath.join(jobDir, "adapters"),
            savePath: NodePath.join(jobDir, "fused"),
            exportGguf: true,
            ggufFilename: "../../../../statev2.sqlite",
            trustRemoteCode: false,
            logFilePath: NodePath.join(jobDir, "fuse.log"),
          }),
        );
        expect(Exit.isFailure(traversalExit)).toBe(true);
        expect(String(traversalExit)).toContain("invalid_config");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
      }
    }),
  );

  it.live("probes mlx-lm version via sibling python when mlx_lm.lora --version fails", () =>
    Effect.gen(function* () {
      const tmpRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mlx-ver-")),
      );
      try {
        const fakeLora = NodePath.join(tmpRoot, "mlx_lm.lora");
        const fakePython = NodePath.join(tmpRoot, "python3");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(fakeLora, "#!/bin/sh\necho 'usage: mlx_lm.lora' >&2\nexit 2\n", {
            mode: 0o755,
          });
          await NodeFSP.writeFile(fakePython, "#!/bin/sh\necho '0.32.2'\n", { mode: 0o755 });
        });
        const trainer = makeMlxLoraTrainer({
          resolveBinary: (name) => (name === "mlx_lm.lora" ? fakeLora : null),
        });
        const caps = yield* trainer.probeCapabilities;
        expect(caps.available).toBe(true);
        expect(caps.version).toBe("0.32.2");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
      }
    }),
  );

  it.live(
    "streams parsed Rich metrics, writes run.log/metrics.jsonl, and completes with test eval",
    () =>
      Effect.gen(function* () {
        const tmpRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mlx-run-")),
        );
        try {
          const fakeBin = NodePath.join(tmpRoot, "fake-mlx-lora.sh");
          const datasetDir = NodePath.join(tmpRoot, "ds");
          const jobDir = NodePath.join(tmpRoot, "job");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(datasetDir, { recursive: true });
            await NodeFSP.mkdir(jobDir, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(datasetDir, "train.jsonl"),
              '{"messages":[]}\n{"messages":[]}\n',
            );
            await NodeFSP.writeFile(
              NodePath.join(datasetDir, "test.jsonl"),
              '{"messages":[]}\n{"messages":[]}\n',
            );
            await NodeFSP.writeFile(
              fakeBin,
              [
                "#!/bin/sh",
                "printf '\\033[32m  10    1.842 ▼    1,420     4.2k\\033[0m\\n'",
                "printf '[WARNING] Some sequences are longer than 2048 tokens. The longest sentence 3000\\n'",
                "printf '  20    val 1.512    2.10s\\n'",
                `case " $* " in *" --test "*) printf 'Test loss 1.400, Test ppl 4.055.\\n' ;; esac`,
                "exit 0",
              ].join("\n"),
              { mode: 0o755 },
            );
          });

          const trainer = makeMlxLoraTrainer({
            resolveBinary: () => fakeBin,
            minFreeBytesLora: 1,
            minFreeBytesFullOrFuse: 1,
          });

          const logPath = NodePath.join(jobDir, "run.log");
          const metricsPath = NodePath.join(jobDir, "metrics.jsonl");

          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* trainer.startTraining({
                jobId: TrainingJobId.make("job-ok"),
                config: makeConfig(),
                datasetDir,
                jobDir,
                logFilePath: logPath,
                metricsFilePath: metricsPath,
              });
              const [ticks, warnings, completion] = yield* Effect.all(
                [
                  Stream.runCollect(handle.metrics),
                  Stream.runCollect(handle.warnings),
                  handle.completion,
                ],
                { concurrency: "unbounded" },
              );
              return { ticks: [...ticks], warnings: [...warnings], completion };
            }),
          );

          expect(outcome.ticks).toHaveLength(2);
          expect(outcome.ticks[0]?.trainLoss).toBe(1.842);
          expect(outcome.ticks[1]?.valLoss).toBe(1.512);
          expect(outcome.warnings).toEqual([
            { kind: "sequence_truncated", maxLen: 2048, observedLen: 3000 },
          ]);
          expect(outcome.completion.testLoss).toBe(1.4);
          expect(outcome.completion.testPerplexity).toBe(4.055);
          expect(NodeFS.existsSync(NodePath.join(jobDir, "config.yaml"))).toBe(true);
          expect(NodeFS.readFileSync(logPath, "utf8")).toContain("Test loss 1.400");
          expect(NodeFS.readFileSync(metricsPath, "utf8").trim().split("\n")).toHaveLength(2);
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
        }
      }),
  );

  it.live("evaluates a test split smaller than mlx_lm's default batch in one smaller batch", () =>
    Effect.gen(function* () {
      const tmpRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mlx-test-eval-")),
      );
      try {
        const fakeBin = NodePath.join(tmpRoot, "fake-mlx-lora.sh");
        const argsPath = NodePath.join(tmpRoot, "args.txt");
        const datasetDir = NodePath.join(tmpRoot, "ds");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(datasetDir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(datasetDir, "test.jsonl"),
            '{"messages":[]}\n{"messages":[]}\n',
          );
          await NodeFSP.writeFile(
            fakeBin,
            [
              "#!/bin/sh",
              `echo "$*" > '${argsPath}'`,
              "printf 'Test loss 1.400, Test ppl 4.055.\\n'",
            ].join("\n"),
            { mode: 0o755 },
          );
        });
        const { runTestEval } = makeMlxLoraTrainer({ resolveBinary: () => fakeBin });
        if (runTestEval === undefined) throw new Error("MLX trainer must support test eval");

        const result = yield* runTestEval({
          baseModel: "org/model",
          datasetDir,
          adapterPath: null,
          logFilePath: NodePath.join(tmpRoot, "eval.log"),
        });

        expect(result.testPerplexity).toBe(4.055);
        expect(NodeFS.readFileSync(argsPath, "utf8")).toContain("--batch-size 2");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
      }
    }),
  );

  it.live("scans HF_HUB_CACHE models with model_type and GGUF capability", () =>
    Effect.gen(function* () {
      const tmpRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-hf-cache-")),
      );
      try {
        const snap1 = NodePath.join(
          tmpRoot,
          "models--mlx-community--Llama-3.2-3B",
          "snapshots",
          "rev1",
        );
        const snap2 = NodePath.join(
          tmpRoot,
          "models--mlx-community--Qwen3-8B",
          "snapshots",
          "rev2",
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(snap1, { recursive: true });
          await NodeFSP.mkdir(snap2, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(snap1, "config.json"),
            JSON.stringify({ model_type: "llama" }),
          );
          await NodeFSP.writeFile(
            NodePath.join(snap2, "config.json"),
            JSON.stringify({ model_type: "qwen3" }),
          );
        });

        const models = scanCachedHfModels({ HF_HUB_CACHE: tmpRoot });
        expect(models).toHaveLength(2);
        expect(models.find((m) => m.id === "mlx-community/Llama-3.2-3B")?.supportsGgufExport).toBe(
          true,
        );
        expect(models.find((m) => m.id === "mlx-community/Qwen3-8B")?.supportsGgufExport).toBe(
          false,
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
      }
    }),
  );
});
