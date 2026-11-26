import {
  IsoDateTime,
  ThreadId,
  TrainingArtifactId,
  TrainingDatasetId,
  TrainingEvalRunId,
  TrainingJobId,
  type TrainerBackendCapabilities,
  type TrainingArtifact,
  type TrainingCapabilitiesResult,
  type TrainingDatasetSummary,
  type TrainingEvalComparison,
  type TrainingJobSnapshot,
  type TrainingMetricTick,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TRAINING_LIVE_STATE,
  TRAINING_RECENT_METRICS_CAP,
  applyPresetToJobDraft,
  applyTrainingStreamEvent,
  artifactSupportsGgufExport,
  buildJobConfigFromDraft,
  createDefaultDatasetFilter,
  createDefaultRedactionOptions,
  createJobLaunchDraft,
  formatTrainingBytesGb,
  formatTrainingEta,
  formatTrainingLoss,
  formatTrainingMemoryGb,
  formatTrainingThroughput,
  formatTrainingTokenCount,
  isValidBaseModelRef,
  mergeTrainingEvalRuns,
  parseCsvTerms,
  trainingEvalStatusBadgeVariant,
  trainingJobProgressPercent,
  validateTrainingJobLaunch,
} from "./TrainingSettings.logic";

const NOW = IsoDateTime.make("2026-11-24T20:00:00.000Z");

function makeDataset(overrides: Partial<TrainingDatasetSummary> = {}): TrainingDatasetSummary {
  return {
    id: TrainingDatasetId.make("ds_1"),
    name: "Coding SFT",
    objective: "sft",
    filter: createDefaultDatasetFilter(),
    redactionOptions: createDefaultRedactionOptions(),
    redactionAudit: {
      redactorVersion: "1.0.0",
      totalRedactions: 0,
      countsByCategory: {
        api_key_provider: 0,
        jwt_bearer: 0,
        pem_private_key: 0,
        aws_gcp_cloud: 0,
        env_assignment: 0,
        url_credentials: 0,
        home_path_username: 0,
        email_address: 0,
        high_entropy_secret: 0,
      },
      affectedThreadCount: 0,
      sampleFindings: [],
      findingsTruncated: false,
    },
    storagePath: "/tmp/training/datasets/ds_1",
    provenanceHash: "abcdef1234567890",
    sourceThreadIds: [ThreadId.make("t_1")],
    trainCount: 20,
    validCount: 4,
    testCount: 4,
    estimatedTokens: 48_000,
    sizeBytes: 128_000,
    createdAt: NOW,
    ...overrides,
  };
}

function makeTick(iter: number, totalIters = 100): TrainingMetricTick {
  return {
    iter,
    totalIters,
    trainLoss: 2.0 - iter * 0.001,
    tokSec: 1200,
    peakMemGb: 18.4,
    etaSec: Math.max(0, (totalIters - iter) * 2),
    recordedAt: NOW,
  };
}

function makeJob(overrides: Partial<TrainingJobSnapshot> = {}): TrainingJobSnapshot {
  const datasetId = TrainingDatasetId.make("ds_1");
  const draft = createJobLaunchDraft({
    datasetId,
    baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
  });
  return {
    id: TrainingJobId.make("job_1"),
    config: buildJobConfigFromDraft({ ...draft, name: "Smoke Run" }, datasetId),
    status: "training",
    latestMetric: null,
    recentMetrics: [],
    truncationWarningsCount: 0,
    artifact: null,
    jobDir: "/tmp/training/jobs/job_1",
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

const MLX_LORA_BACKEND: TrainerBackendCapabilities = {
  id: "mlx-lora",
  available: true,
  binaryPath: "/Users/test/.local/bin/mlx_lm.lora",
  version: "0.32.2",
  supportedObjectives: ["sft"],
  supportedFineTuneTypes: ["lora", "dora", "full"],
  supportsFuse: true,
  supportsGgufExport: true,
  supportsAdapterServing: true,
};

describe("TrainingSettings.logic", () => {
  describe("presets", () => {
    it("replaces preset hyperparameters while preserving user-entered job metadata", () => {
      const datasetId = TrainingDatasetId.make("ds_1");
      const base = {
        ...createJobLaunchDraft({
          presetId: "quick_smoke",
          datasetId,
          baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
        }),
        name: "My Custom Run",
      };
      const deep = applyPresetToJobDraft(base, "deep_lora");
      expect(deep.name).toBe("My Custom Run");
      expect(deep.datasetId).toBe(datasetId);
      expect(deep.baseModel).toBe("mlx-community/Qwen2.5-Coder-7B-Instruct-4bit");
      expect(deep.iters).toBeGreaterThan(base.iters);
      expect(deep.loraNumLayers).toBe(-1);
    });
  });

  describe("formatters", () => {
    it("formats ETA, loss, throughput, memory, tokens, and storage sizes", () => {
      expect(formatTrainingEta(undefined)).toBe("--");
      expect(formatTrainingEta(45)).toBe("45s");
      expect(formatTrainingEta(125)).toBe("2m 5s");
      expect(formatTrainingEta(3660)).toBe("1h 1m");

      expect(formatTrainingLoss(undefined)).toBe("--");
      expect(formatTrainingLoss(1.8426)).toBe("1.843");

      expect(formatTrainingThroughput(1420.4)).toBe("1,420 tok/s");
      expect(formatTrainingThroughput(45.24)).toBe("45.2 tok/s");

      expect(formatTrainingMemoryGb(18.44)).toBe("18.4 GB");
      expect(formatTrainingTokenCount(0)).toBe("0");
      expect(formatTrainingTokenCount(4200)).toBe("4.2k");
      expect(formatTrainingTokenCount(1_250_000)).toBe("1.25M");

      expect(formatTrainingBytesGb(64 * 1_073_741_824)).toBe("64.0 GB");
      expect(formatTrainingBytesGb(330 * 1_073_741_824)).toBe("330 GB");
      expect(formatTrainingBytesGb(512 * 1_048_576)).toBe("512 MB");
    });

    it("computes bounded job progress percentages", () => {
      expect(trainingJobProgressPercent(makeJob({ status: "completed" }))).toBe(100);
      expect(trainingJobProgressPercent(makeJob({ latestMetric: makeTick(50, 200) }))).toBe(25);
      expect(trainingJobProgressPercent(makeJob({ latestMetric: makeTick(250, 200) }))).toBe(100);
    });

    it("deduplicates comma and newline separated terms", () => {
      expect(parseCsvTerms(" acme, beta\nacme ,  gamma ")).toEqual(["acme", "beta", "gamma"]);
    });
  });

  describe("pre-flight validation", () => {
    it("accepts a valid SFT job launch draft", () => {
      const dataset = makeDataset({ trainCount: 16, validCount: 4 });
      const draft = {
        ...createJobLaunchDraft({
          datasetId: dataset.id,
          baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
        }),
        name: "My LoRA",
      };
      const result = validateTrainingJobLaunch({
        draft,
        dataset,
        backend: MLX_LORA_BACKEND,
        availableStorageFreeBytes: 100 * 1_073_741_824,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.dpoIncompatibleWithBackend).toBe(false);
    });

    it("rejects baseModel starting with '-' and invalid slugs", () => {
      expect(isValidBaseModelRef("--inject")).toBe(false);
      expect(isValidBaseModelRef("mlx-community/Qwen2.5-7B")).toBe(true);
      expect(isValidBaseModelRef("/Volumes/MARCUS_S7/models/qwen")).toBe(true);

      const dataset = makeDataset();
      const draft = {
        ...createJobLaunchDraft({ datasetId: dataset.id, baseModel: "--config=/etc/passwd" }),
        name: "Bad Model",
      };
      const result = validateTrainingJobLaunch({
        draft,
        dataset,
        backend: MLX_LORA_BACKEND,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes("'-'"))).toBe(true);
    });

    it("rejects dataset trainCount smaller than batchSize and warns on small valid split", () => {
      const dataset = makeDataset({ trainCount: 2, validCount: 1 });
      const draft = {
        ...createJobLaunchDraft({
          datasetId: dataset.id,
          baseModel: "mlx-community/Qwen2.5-7B",
        }),
        name: "Too Few",
        batchSize: 4,
      };
      const result = validateTrainingJobLaunch({
        draft,
        dataset,
        backend: MLX_LORA_BACKEND,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes("fewer than batch size"))).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("Validation split"))).toBe(true);
    });

    it("flags DPO dataset paired with SFT-only mlx-lora backend", () => {
      const dataset = makeDataset({ objective: "dpo", trainCount: 12 });
      const draft = {
        ...createJobLaunchDraft({
          datasetId: dataset.id,
          baseModel: "mlx-community/Qwen2.5-7B",
        }),
        name: "DPO Attempt",
      };
      const result = validateTrainingJobLaunch({
        draft,
        dataset,
        backend: MLX_LORA_BACKEND,
      });
      expect(result.valid).toBe(false);
      expect(result.dpoIncompatibleWithBackend).toBe(true);
    });
  });

  describe("applyTrainingStreamEvent", () => {
    it("applies snapshot, job_updated, metric_tick (capped at 500), dataset_changed, and gpu_lease_changed", () => {
      const ds1 = makeDataset();
      const job1 = makeJob();

      let state = applyTrainingStreamEvent(EMPTY_TRAINING_LIVE_STATE, {
        type: "snapshot",
        jobs: [job1],
        datasets: [ds1],
        activeGpuLeaseJobId: null,
      });
      expect(state.loaded).toBe(true);
      expect(state.jobs).toHaveLength(1);
      expect(state.datasets).toHaveLength(1);

      state = applyTrainingStreamEvent(state, {
        type: "gpu_lease_changed",
        activeGpuLeaseJobId: job1.id,
      });
      expect(state.activeGpuLeaseJobId).toBe(job1.id);

      for (let i = 1; i <= TRAINING_RECENT_METRICS_CAP + 25; i += 1) {
        state = applyTrainingStreamEvent(state, {
          type: "metric_tick",
          jobId: job1.id,
          tick: makeTick(i, 600),
        });
      }
      expect(state.jobs[0]?.recentMetrics).toHaveLength(TRAINING_RECENT_METRICS_CAP);
      expect(state.jobs[0]?.recentMetrics[0]?.iter).toBe(26);
      expect(state.jobs[0]?.latestMetric?.iter).toBe(TRAINING_RECENT_METRICS_CAP + 25);

      const ds2 = makeDataset({ id: TrainingDatasetId.make("ds_2"), name: "Second" });
      state = applyTrainingStreamEvent(state, {
        type: "dataset_changed",
        datasetId: ds2.id,
        dataset: ds2,
      });
      expect(state.datasets.map((dataset) => dataset.id)).toEqual([ds2.id, ds1.id]);

      state = applyTrainingStreamEvent(state, {
        type: "dataset_changed",
        datasetId: ds1.id,
        dataset: null,
      });
      expect(state.datasets.map((dataset) => dataset.id)).toEqual([ds2.id]);

      state = applyTrainingStreamEvent(state, {
        type: "job_updated",
        job: { ...job1, status: "completed" },
      });
      expect(state.jobs[0]?.status).toBe("completed");

      const runningEval: TrainingEvalComparison = {
        id: TrainingEvalRunId.make("eval_1"),
        artifactId: TrainingArtifactId.make("art_1"),
        suite: "local_coding",
        status: "running",
        baseSummary: null,
        tunedSummary: null,
        reportPath: null,
        createdAt: NOW,
        completedAt: null,
      };
      state = applyTrainingStreamEvent(state, {
        type: "eval_updated",
        evalRun: runningEval,
      });
      expect(state.evalRuns).toEqual([runningEval]);

      const completedEval: TrainingEvalComparison = {
        ...runningEval,
        status: "completed",
        baseSummary: { model: "base", passedCases: 6, totalCases: 12, passRate: 0.5 },
        tunedSummary: { model: "tuned", passedCases: 9, totalCases: 12, passRate: 0.75 },
        completedAt: IsoDateTime.make("2026-11-24T20:05:00.000Z"),
      };
      state = applyTrainingStreamEvent(state, {
        type: "eval_updated",
        evalRun: completedEval,
      });
      expect(state.evalRuns).toEqual([completedEval]);
    });

    it("merges persisted and live eval runs preferring terminal status and newest first", () => {
      const older: TrainingEvalComparison = {
        id: TrainingEvalRunId.make("eval_old"),
        artifactId: TrainingArtifactId.make("art_1"),
        suite: "heldout_perplexity",
        status: "completed",
        baseSummary: { model: "base", testLoss: 2.1, testPerplexity: 8.17 },
        tunedSummary: { model: "tuned", testLoss: 1.7, testPerplexity: 5.47 },
        reportPath: null,
        createdAt: IsoDateTime.make("2026-11-24T19:00:00.000Z"),
        completedAt: IsoDateTime.make("2026-11-24T19:02:00.000Z"),
      };
      const running: TrainingEvalComparison = {
        id: TrainingEvalRunId.make("eval_new"),
        artifactId: TrainingArtifactId.make("art_1"),
        suite: "local_coding",
        status: "running",
        baseSummary: null,
        tunedSummary: null,
        reportPath: null,
        createdAt: IsoDateTime.make("2026-11-24T20:00:00.000Z"),
        completedAt: null,
      };
      const finished: TrainingEvalComparison = {
        ...running,
        status: "completed",
        baseSummary: { model: "base", passedCases: 5, totalCases: 12, passRate: 5 / 12 },
        tunedSummary: { model: "tuned", passedCases: 8, totalCases: 12, passRate: 8 / 12 },
        completedAt: IsoDateTime.make("2026-11-24T20:04:00.000Z"),
      };

      expect(mergeTrainingEvalRuns([older], [])).toEqual([older]);
      expect(mergeTrainingEvalRuns([older, running], [finished])).toEqual([finished, older]);
      expect(mergeTrainingEvalRuns([older, finished], [running])).toEqual([finished, older]);
      expect(trainingEvalStatusBadgeVariant("running")).toBe("info");
      expect(trainingEvalStatusBadgeVariant("completed")).toBe("success");
      expect(trainingEvalStatusBadgeVariant("failed")).toBe("error");
      expect(trainingEvalStatusBadgeVariant("cancelled")).toBe("secondary");
    });
  });

  describe("artifactSupportsGgufExport", () => {
    it("prefers cached model capability metadata and restricts unknown models to llama/mistral/mixtral", () => {
      const artifact: TrainingArtifact = {
        id: TrainingArtifactId.make("art_1"),
        jobId: TrainingJobId.make("job_1"),
        datasetId: TrainingDatasetId.make("ds_1"),
        baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
        fineTuneType: "lora",
        adapterPath: "/tmp/adapter",
        fusedModelPath: null,
        ggufPath: null,
        provenanceHash: "hash1234",
        sourceThreadIds: [],
        registeredInferenceServerId: null,
        servingPort: null,
        createdAt: NOW,
      };
      const capabilities: TrainingCapabilitiesResult = {
        backends: [MLX_LORA_BACKEND],
        hostMemoryBytes: 64 * 1_073_741_824,
        isAppleSilicon: true,
        activeStorageDir: "/tmp/training",
        activeStorageFreeBytes: 100 * 1_073_741_824,
        storageRoots: [],
        cachedModels: [
          {
            id: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
            path: "/Volumes/MARCUS_S7/.hf_home/hub/qwen",
            modelType: "qwen2",
            supportsGgufExport: false,
          },
          {
            id: "mlx-community/Mistral-7B-Instruct-v0.3-4bit",
            path: "/Volumes/MARCUS_S7/.hf_home/hub/mistral",
            modelType: "mistral",
            supportsGgufExport: true,
          },
        ],
        activeGpuLeaseJobId: null,
      };

      expect(artifactSupportsGgufExport(artifact, capabilities)).toBe(false);
      expect(
        artifactSupportsGgufExport(
          { ...artifact, baseModel: "mlx-community/Mistral-7B-Instruct-v0.3-4bit" },
          capabilities,
        ),
      ).toBe(true);
      expect(
        artifactSupportsGgufExport(
          { ...artifact, baseModel: "mlx-community/Llama-3.2-3B-Instruct-4bit" },
          capabilities,
        ),
      ).toBe(true);
    });
  });
});
