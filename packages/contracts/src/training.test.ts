import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { InferenceGatewayQueue } from "./inference.ts";
import { WS_METHODS } from "./rpc.ts";
import { requiredScopesForServerSettingsPatch } from "./settings.ts";
import {
  TRAINING_LOG_MAX_BYTES,
  TrainingConvertDpoDatasetToSftInput,
  TrainingDatasetFilter,
  TrainingFuseArtifactInput,
  TrainingGetJobLogsInput,
  TrainingJobConfig,
  TrainingJobStreamEvent,
  TrainingLoraParams,
  TrainingOperationError,
} from "./training.ts";

const decodeFilter = Schema.decodeUnknownExit(TrainingDatasetFilter);
const decodeLora = Schema.decodeUnknownExit(TrainingLoraParams);
const decodeJobConfig = Schema.decodeUnknownExit(TrainingJobConfig);
const decodeLogsInput = Schema.decodeUnknownExit(TrainingGetJobLogsInput);
const decodeStreamEvent = Schema.decodeUnknownExit(TrainingJobStreamEvent);
const decodeQueue = Schema.decodeUnknownExit(InferenceGatewayQueue);
const decodeFuseInput = Schema.decodeUnknownExit(TrainingFuseArtifactInput);
const decodeConvertDpoInput = Schema.decodeUnknownExit(TrainingConvertDpoDatasetToSftInput);

const validFilter = {
  settledOnly: true,
  includeArchived: false,
  includeSubagents: false,
  minCompletedRuns: 1,
  includeToolCalls: true,
  includeReasoning: true,
  includeCheckpointDiffs: false,
  maxToolOutputChars: 4000,
  split: { validRatio: 0.1, testRatio: 0.1, seed: 42 },
};

const validJobConfig = {
  name: "qwen3-coder-lora",
  backend: "mlx-lora",
  datasetId: "ds_01",
  baseModel: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
  fineTuneType: "lora",
  optimizer: "adamw",
  iters: 600,
  batchSize: 2,
  gradAccumulationSteps: 4,
  learningRate: 1e-5,
  maxSeqLength: 4096,
  maskPrompt: true,
  gradCheckpoint: true,
  stepsPerReport: 10,
  stepsPerEval: 100,
  saveEvery: 200,
  valBatches: 25,
  seed: 42,
  lora: { rank: 8, scale: 20, dropout: 0, numLayers: 16 },
  autoFuse: false,
  runTestEval: true,
  trustRemoteCode: false,
  pauseLocalInference: true,
  inferenceDrainTimeoutSec: 60,
};

describe("training contracts", () => {
  it("validates dataset split boundaries", () => {
    expect(Exit.isSuccess(decodeFilter(validFilter))).toBe(true);
    expect(
      Exit.isFailure(
        decodeFilter({ ...validFilter, split: { validRatio: 0.5, testRatio: 0.1, seed: 1 } }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeFilter({ ...validFilter, split: { validRatio: 0.1, testRatio: 0.4, seed: 1 } }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeFilter({ ...validFilter, minCompletedRuns: 0 }))).toBe(true);
  });

  it("validates LoRA parameter bounds including numLayers = -1 for all layers", () => {
    expect(Exit.isSuccess(decodeLora({ rank: 8, scale: 20, dropout: 0.05, numLayers: -1 }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeLora({ rank: 0, scale: 20, dropout: 0, numLayers: 16 }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeLora({ rank: 512, scale: 20, dropout: 0, numLayers: 16 }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeLora({ rank: 8, scale: 0, dropout: 0, numLayers: 16 }))).toBe(true);
    expect(Exit.isFailure(decodeLora({ rank: 8, scale: 20, dropout: 0.6, numLayers: 16 }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeLora({ rank: 8, scale: 20, dropout: 0, numLayers: 0 }))).toBe(true);
    expect(Exit.isFailure(decodeLora({ rank: 8, scale: 20, dropout: 0, numLayers: -2 }))).toBe(
      true,
    );
  });

  it("rejects flag-like baseModel values and invalid numeric job config bounds", () => {
    expect(Exit.isSuccess(decodeJobConfig(validJobConfig))).toBe(true);
    expect(
      Exit.isFailure(decodeJobConfig({ ...validJobConfig, baseModel: "--trust-remote-code" })),
    ).toBe(true);
    expect(Exit.isFailure(decodeJobConfig({ ...validJobConfig, learningRate: 0 }))).toBe(true);
    expect(Exit.isFailure(decodeJobConfig({ ...validJobConfig, valBatches: -2 }))).toBe(true);
    expect(Exit.isSuccess(decodeJobConfig({ ...validJobConfig, valBatches: -1 }))).toBe(true);
  });

  it("enforces bounded log read sizes", () => {
    expect(
      Exit.isSuccess(decodeLogsInput({ jobId: "job_1", tailBytes: TRAINING_LOG_MAX_BYTES })),
    ).toBe(true);
    expect(
      Exit.isFailure(decodeLogsInput({ jobId: "job_1", tailBytes: TRAINING_LOG_MAX_BYTES + 1 })),
    ).toBe(true);
    expect(Exit.isFailure(decodeLogsInput({ jobId: "job_1", tailBytes: 0 }))).toBe(true);
  });

  it("decodes stream events, GPU pause queue flag, and structured errors", () => {
    expect(
      Exit.isSuccess(
        decodeStreamEvent({
          type: "metric_tick",
          jobId: "job_1",
          tick: {
            iter: 10,
            totalIters: 600,
            trainLoss: 1.842,
            tokSec: 1420,
            trainedTokens: 4200,
            peakMemGb: 18.4,
            recordedAt: "2026-11-24T00:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);

    expect(
      Exit.isSuccess(
        decodeQueue({
          capacity: 2,
          pausedForTraining: true,
          active: [],
          waiting: [{ purpose: "interactive", position: 1 }],
        }),
      ),
    ).toBe(true);

    const err = new TrainingOperationError({
      code: "insufficient_disk",
      operation: "TrainingService.startJob",
      resourceId: "job_1",
      reason: "At least 5 GiB free is required.",
    });
    expect(err.message).toContain("insufficient_disk");
    expect(err.message).toContain("At least 5 GiB free is required.");
  });

  it("enforces SEC-01/04/05/06 scopes, ggufFilename traversal guard, and eval_updated/DPO-to-SFT schemas", () => {
    // SEC-01: training.mlxBinDir and training.storageDir require terminal:operate
    expect(requiredScopesForServerSettingsPatch({ training: { mlxBinDir: "/opt/bin" } })).toContain(
      AuthTerminalOperateScope,
    );
    expect(
      requiredScopesForServerSettingsPatch({ training: { storageDir: "/Volumes/SSD/t3" } }),
    ).toContain(AuthTerminalOperateScope);
    expect(
      requiredScopesForServerSettingsPatch({ training: { defaultPauseLocalInference: false } }),
    ).toEqual([AuthSettingsWriteScope]);

    // SEC-04 & SEC-06: multi-scope enforcement on serving/registering & providers:manage on discovery
    for (const method of [
      WS_METHODS.trainingServeArtifact,
      WS_METHODS.trainingStopServedArtifact,
      WS_METHODS.trainingRegisterArtifactInInference,
    ]) {
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([
        AuthTerminalOperateScope,
        AuthProvidersManageScope,
      ]);
    }
    expect(clientRpcRequiredScopes(WS_METHODS.serverDiscoverInferenceServers, undefined)).toEqual([
      AuthProvidersManageScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.trainingConvertDpoDatasetToSft, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);

    // SEC-05: ggufFilename rejects path traversal
    expect(
      Exit.isFailure(
        decodeFuseInput({
          artifactId: "art_1",
          exportGguf: true,
          ggufFilename: "../../../../statev2.sqlite",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeFuseInput({
          artifactId: "art_1",
          exportGguf: true,
          ggufFilename: "sub/model.gguf",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeFuseInput({
          artifactId: "art_1",
          exportGguf: true,
          ggufFilename: "ggml-model-f16.gguf",
        }),
      ),
    ).toBe(true);

    // Gap #2 & Gap #3 contracts
    expect(
      Exit.isSuccess(decodeConvertDpoInput({ datasetId: "ds_dpo_1", name: "Chosen SFT" })),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeStreamEvent({
          type: "eval_updated",
          evalRun: {
            id: "eval_1",
            artifactId: "art_1",
            suite: "heldout_perplexity",
            status: "running",
            baseSummary: null,
            tunedSummary: null,
            reportPath: "/tmp/evals/eval_1/comparison.json",
            createdAt: "2026-11-24T00:00:00.000Z",
            completedAt: null,
          },
        }),
      ),
    ).toBe(true);
  });
});
