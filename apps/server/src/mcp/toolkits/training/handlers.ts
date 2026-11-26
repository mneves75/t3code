import { OrchestratorMcpFailure, type TrainingOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TrainingService from "../../../training/TrainingService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TrainingToolkit } from "./tools.ts";

const mapTrainingError = (error: TrainingOperationError): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code:
      error.code === "not_found" || error.code === "invalid_request"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(TrainingToolkit, {
  training_preview_dataset: McpToolAccess.writesOwnerWork(
    "preview local training datasets",
    (input) =>
      Effect.flatMap(TrainingService.TrainingService, (training) =>
        training.previewDataset(input).pipe(Effect.mapError(mapTrainingError)),
      ),
  ),
  training_create_dataset: McpToolAccess.writesOwnerWork(
    "create local training datasets",
    (input) =>
      Effect.flatMap(TrainingService.TrainingService, (training) =>
        training.createDataset(input).pipe(Effect.mapError(mapTrainingError)),
      ),
  ),
  training_start_job: McpToolAccess.writesOwnerWork("start local fine-tuning jobs", (input) =>
    Effect.flatMap(TrainingService.TrainingService, (training) =>
      training.startJob(input).pipe(Effect.mapError(mapTrainingError)),
    ),
  ),
  training_get_job: McpToolAccess.reads((input) =>
    Effect.flatMap(TrainingService.TrainingService, (training) =>
      training.getJob(input).pipe(Effect.mapError(mapTrainingError)),
    ),
  ),
  training_cancel_job: McpToolAccess.writesOwnerWork("cancel local fine-tuning jobs", (input) =>
    Effect.flatMap(TrainingService.TrainingService, (training) =>
      training.cancelJob(input).pipe(Effect.mapError(mapTrainingError)),
    ),
  ),
  training_run_eval: McpToolAccess.writesOwnerWork("run local model evaluations", (input) =>
    Effect.flatMap(TrainingService.TrainingService, (training) =>
      training.runEval(input).pipe(Effect.mapError(mapTrainingError)),
    ),
  ),
});
