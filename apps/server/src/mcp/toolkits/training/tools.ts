import {
  OrchestratorMcpFailure,
  TrainingCancelJobInput,
  TrainingCreateDatasetInput,
  TrainingDatasetPreview,
  TrainingDatasetSummary,
  TrainingEvalComparison,
  TrainingGetJobInput,
  TrainingGetJobResult,
  TrainingJobSnapshot,
  TrainingPreviewDatasetInput,
  TrainingRunEvalInput,
  TrainingStartJobInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TrainingService from "../../../training/TrainingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const TrainingPreviewDatasetTool = Tool.make("training_preview_dataset", {
  description:
    "Preview a fine-tuning dataset extracted from durable thread transcripts, returning example counts, split sizes, redacted sample records, and the mandatory secret redaction audit report without writing files.",
  parameters: TrainingPreviewDatasetInput,
  success: TrainingDatasetPreview,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TrainingService.TrainingService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Preview training dataset")
  .annotate(Tool.Readonly, true);

const TrainingCreateDatasetTool = Tool.make("training_create_dataset", {
  description:
    "Materialize a redacted SFT or DPO fine-tuning dataset (train/valid/test JSONL + manifest with SHA-256 provenance) from durable thread transcripts into the configured training storage directory.",
  parameters: TrainingCreateDatasetInput,
  success: TrainingDatasetSummary,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TrainingService.TrainingService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Create training dataset")
  .annotate(Tool.Destructive, false);

const TrainingStartJobTool = Tool.make("training_start_job", {
  description:
    "Queue and start a local MLX fine-tuning job (LoRA/DoRA/Full) against a materialized dataset. Automatically coordinates exclusive local GPU access and drains local inference servers when pauseLocalInference is enabled.",
  parameters: TrainingStartJobInput,
  success: TrainingJobSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TrainingService.TrainingService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Start fine-tuning job")
  .annotate(Tool.Destructive, true);

const TrainingGetJobTool = Tool.make("training_get_job", {
  description:
    "Read the current snapshot of a fine-tuning job, including status, latest metrics, bounded metric history, truncation warning count, and completed artifact metadata.",
  parameters: TrainingGetJobInput,
  success: TrainingGetJobResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TrainingService.TrainingService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Get fine-tuning job")
  .annotate(Tool.Readonly, true);

const TrainingCancelJobTool = Tool.make("training_cancel_job", {
  description:
    "Cancel a queued or running local fine-tuning job by terminating its process group cleanly and releasing the local GPU lease.",
  parameters: TrainingCancelJobInput,
  success: TrainingJobSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TrainingService.TrainingService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Cancel fine-tuning job")
  .annotate(Tool.Destructive, true);

const TrainingRunEvalTool = Tool.make("training_run_eval", {
  description:
    "Run a base-vs-tuned evaluation suite (`heldout_perplexity` or `local_coding`) on a fine-tuned training artifact and persist the comparison report.",
  parameters: TrainingRunEvalInput,
  success: TrainingEvalComparison,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TrainingService.TrainingService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Run training eval comparison")
  .annotate(Tool.Destructive, true);

export const TrainingToolkit = Toolkit.make(
  TrainingPreviewDatasetTool,
  TrainingCreateDatasetTool,
  TrainingStartJobTool,
  TrainingGetJobTool,
  TrainingCancelJobTool,
  TrainingRunEvalTool,
);
