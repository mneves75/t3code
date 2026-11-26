import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  TrainingArtifactId,
  TrainingDatasetId,
  TrainingEvalRunId,
  TrainingJobId,
  TrainingOperationError,
  type TrainingDatasetPreview,
  type TrainingDatasetSummary,
  type TrainingEvalComparison,
  type TrainingJobConfig,
  type TrainingJobSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { REDACTOR_VERSION } from "../../../training/SecretRedactor.ts";
import * as TrainingService from "../../../training/TrainingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as TrainingHandlers from "./handlers.ts";
import { TrainingToolkit } from "./tools.ts";

const fullAccess = { sessionId: "session-1", label: "t3 CLI", access: "full-access" } as const;
const supervised = { sessionId: "session-2", label: "Bot", access: "approval-required" } as const;

const emptyAudit = {
  redactorVersion: REDACTOR_VERSION,
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
};

const sampleFilter = {
  settledOnly: false,
  includeArchived: false,
  includeSubagents: false,
  minCompletedRuns: 1,
  includeToolCalls: true,
  includeReasoning: false,
  includeCheckpointDiffs: false,
  maxToolOutputChars: 2000,
  split: { validRatio: 0.1, testRatio: 0.1, seed: 42 },
};

const sampleRedaction = {
  redactEnvAssignments: true,
  redactHomePaths: true,
  redactEmails: true,
  redactHighEntropy: true,
};

const sampleJobConfig: TrainingJobConfig = {
  name: "MCP LoRA",
  backend: "mlx-lora",
  datasetId: TrainingDatasetId.make("ds-1"),
  baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
  fineTuneType: "lora",
  optimizer: "adamw",
  iters: 50,
  batchSize: 2,
  gradAccumulationSteps: 1,
  learningRate: 1e-5,
  maxSeqLength: 2048,
  maskPrompt: true,
  gradCheckpoint: true,
  stepsPerReport: 10,
  stepsPerEval: 25,
  saveEvery: 25,
  valBatches: 2,
  seed: 42,
  autoFuse: false,
  runTestEval: false,
  trustRemoteCode: false,
  pauseLocalInference: true,
  inferenceDrainTimeoutSec: 60,
};

const sampleJob: TrainingJobSnapshot = {
  id: TrainingJobId.make("job-1"),
  config: sampleJobConfig,
  status: "queued",
  latestMetric: null,
  recentMetrics: [],
  truncationWarningsCount: 0,
  artifact: null,
  jobDir: "/tmp/training/jobs/job-1",
  createdAt: "2026-11-24T20:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

const handlersWith = (
  service: Partial<TrainingService.TrainingService["Service"]>,
  scope: Partial<McpInvocationContext.McpInvocationScope> = {},
) =>
  McpToolAccess.HandlersLayer.layer(TrainingHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:training"),
          requestNamespace: "client:training",
          thread: undefined,
          client: fullAccess,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          ...scope,
        }),
        Layer.mock(TrainingService.TrainingService)(service),
      ),
    ),
  );

const invokeTool = (name: string, input: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* TrainingToolkit;
    return yield* toolkit.handle(name as never, input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
  });

describe("Training MCP Toolkit", () => {
  it.effect("delegates all 6 training tools to TrainingService and maps domain errors", () =>
    Effect.gen(function* () {
      const preview: TrainingDatasetPreview = {
        objective: "sft",
        matchedThreadCount: 2,
        skippedThreadCount: 0,
        totalExamples: 2,
        trainExamples: 2,
        validExamples: 0,
        testExamples: 0,
        estimatedTokens: 500,
        redactionAudit: emptyAudit,
        sampleSftRecords: [],
        warnings: [],
      };
      const summary: TrainingDatasetSummary = {
        id: TrainingDatasetId.make("ds-1"),
        name: "My DS",
        objective: "sft",
        filter: sampleFilter,
        redactionOptions: sampleRedaction,
        redactionAudit: emptyAudit,
        storagePath: "/tmp/ds-1",
        provenanceHash: "a".repeat(64),
        sourceThreadIds: [],
        trainCount: 2,
        validCount: 0,
        testCount: 0,
        estimatedTokens: 500,
        sizeBytes: 1024,
        createdAt: "2026-11-24T20:00:00.000Z",
      };
      const evalRes: TrainingEvalComparison = {
        id: TrainingEvalRunId.make("eval-1"),
        artifactId: TrainingArtifactId.make("art-1"),
        suite: "heldout_perplexity",
        status: "completed",
        baseSummary: { model: "base", testLoss: 2.0, testPerplexity: 7.39 },
        tunedSummary: { model: "tuned", testLoss: 1.5, testPerplexity: 4.48 },
        reportPath: "/tmp/report.json",
        createdAt: "2026-11-24T20:00:00.000Z",
        completedAt: "2026-11-24T20:01:00.000Z",
      };

      const layer = handlersWith({
        previewDataset: () => Effect.succeed(preview),
        createDataset: () => Effect.succeed(summary),
        startJob: () => Effect.succeed(sampleJob),
        getJob: () => Effect.succeed({ job: sampleJob }),
        cancelJob: () =>
          Effect.fail(
            new TrainingOperationError({
              code: "not_found",
              operation: "cancelJob",
              reason: "Job not found",
            }),
          ),
        runEval: () => Effect.succeed(evalRes),
      });

      const results = yield* Effect.all([
        invokeTool("training_preview_dataset", {
          objective: "sft",
          filter: sampleFilter,
          redactionOptions: sampleRedaction,
        }),
        invokeTool("training_create_dataset", {
          name: "My DS",
          objective: "sft",
          filter: sampleFilter,
          redactionOptions: sampleRedaction,
        }),
        invokeTool("training_start_job", { config: sampleJobConfig }),
        invokeTool("training_get_job", { jobId: TrainingJobId.make("job-1") }),
        invokeTool("training_cancel_job", { jobId: TrainingJobId.make("job-missing") }),
        invokeTool("training_run_eval", {
          artifactId: TrainingArtifactId.make("art-1"),
          suite: "heldout_perplexity",
        }),
      ]).pipe(Effect.provide(layer));

      expect(results[0]).toEqual(preview);
      expect(results[1]).toEqual(summary);
      expect(results[2]).toEqual(sampleJob);
      expect(results[3]).toEqual({ job: sampleJob });
      expect(results[4]).toMatchObject({ code: "invalid_request" });
      expect(results[5]).toEqual(evalRes);
    }),
  );

  it.effect(
    "blocks supervised callers from creating datasets, starting/cancelling jobs, or running evals while allowing preview_dataset and get_job",
    () =>
      Effect.gen(function* () {
        const preview: TrainingDatasetPreview = {
          objective: "sft",
          matchedThreadCount: 1,
          skippedThreadCount: 0,
          totalExamples: 1,
          trainExamples: 1,
          validExamples: 0,
          testExamples: 0,
          estimatedTokens: 100,
          redactionAudit: emptyAudit,
          sampleSftRecords: [],
          warnings: [],
        };
        const layer = handlersWith(
          {
            previewDataset: () => Effect.succeed(preview),
            createDataset: () => Effect.die("should not run"),
            startJob: () => Effect.succeed(sampleJob),
            cancelJob: () => Effect.succeed(sampleJob),
            runEval: () => Effect.die("should not run"),
            getJob: () => Effect.succeed({ job: sampleJob }),
          },
          { client: supervised },
        );

        const [previewRes, createRes, startRes, cancelRes, evalRes, getRes] = yield* Effect.all([
          invokeTool("training_preview_dataset", {
            objective: "sft",
            filter: sampleFilter,
            redactionOptions: sampleRedaction,
          }),
          invokeTool("training_create_dataset", {
            name: "Blocked DS",
            objective: "sft",
            filter: sampleFilter,
            redactionOptions: sampleRedaction,
            outputBaseDir: "/Users/victim/.ssh",
          }),
          invokeTool("training_start_job", { config: sampleJobConfig }),
          invokeTool("training_cancel_job", { jobId: TrainingJobId.make("job-1") }),
          invokeTool("training_run_eval", {
            artifactId: TrainingArtifactId.make("art-1"),
            suite: "heldout_perplexity",
          }),
          invokeTool("training_get_job", { jobId: TrainingJobId.make("job-1") }),
        ]).pipe(Effect.provide(layer));

        expect(previewRes).toEqual(preview);
        expect(createRes).toMatchObject({ code: "capability_denied" });
        expect(startRes).toMatchObject({ code: "capability_denied" });
        expect(cancelRes).toMatchObject({ code: "capability_denied" });
        expect(evalRes).toMatchObject({ code: "capability_denied" });
        expect(getRes).toEqual({ job: sampleJob });
      }),
  );
});
