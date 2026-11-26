import * as Layer from "effect/Layer";

import * as DatasetExtractor from "./DatasetExtractor.ts";
import * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
import * as MlxLoraTrainer from "./MlxLoraTrainer.ts";
import * as SecretRedactor from "./SecretRedactor.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
import * as TrainingEvalRunner from "./TrainingEvalRunner.ts";
import * as TrainingService from "./TrainingService.ts";
import * as TrainingStore from "./TrainingStore.ts";

export * as DatasetExtractor from "./DatasetExtractor.ts";
export * as LocalGpuCoordinator from "./LocalGpuCoordinator.ts";
export * as MlxLoraMetricParser from "./MlxLoraMetricParser.ts";
export * as MlxLoraTrainer from "./MlxLoraTrainer.ts";
export * as SecretRedactor from "./SecretRedactor.ts";
export * as TrainerAdapter from "./TrainerAdapter.ts";
export * as TrainingAdapterServer from "./TrainingAdapterServer.ts";
export * as TrainingEvalRunner from "./TrainingEvalRunner.ts";
export * as TrainingService from "./TrainingService.ts";
export * as TrainingStore from "./TrainingStore.ts";

// Composed layer providing TrainingService; requires ServerConfig, ServerSettingsService, SqlClient, FileSystem, Path, InferenceAdmission, and InferenceServerRegistry.
const trainerAndServerLayer = Layer.mergeAll(
  TrainingStore.layer,
  DatasetExtractor.layer.pipe(Layer.provide(SecretRedactor.layer)),
  MlxLoraTrainer.registryLayer.pipe(Layer.provide(MlxLoraTrainer.layer)),
  TrainingAdapterServer.layer,
);

const coordinatorLayer = LocalGpuCoordinator.layer.pipe(Layer.provideMerge(trainerAndServerLayer));

const evalRunnerLayer = TrainingEvalRunner.layer.pipe(Layer.provideMerge(coordinatorLayer));

export const TrainingLayer = TrainingService.layer.pipe(Layer.provideMerge(evalRunnerLayer));
