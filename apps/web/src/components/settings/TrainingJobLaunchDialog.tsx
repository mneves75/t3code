import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type TrainingCapabilitiesResult,
  type TrainingDatasetId,
  type TrainingDatasetSummary,
  type TrainingFineTuneType,
  type TrainingJobSnapshot,
  type TrainingOptimizer,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { AlertTriangleIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { trainingStartJob } from "../../state/training";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  TRAINING_PRESETS,
  type TrainingJobLaunchDraft,
  type TrainingPresetId,
  applyPresetToJobDraft,
  buildJobConfigFromDraft,
  createJobLaunchDraft,
  formatTrainingBytesGb,
  validateTrainingJobLaunch,
} from "./TrainingSettings.logic";

const CUSTOM_MODEL = "__custom__";
const DEFAULT_STORAGE = "__default__";

const OPTIMIZERS: ReadonlyArray<TrainingOptimizer> = ["adamw", "adam", "muon", "sgd", "adafactor"];

function failureDescription(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const err = squashAtomCommandFailure(result);
  return err instanceof Error ? (thrownErrorMessage(err, m) ?? err.message) : String(err);
}

export function TrainingJobLaunchDialog({
  open,
  onClose,
  environmentId,
  datasets,
  capabilities,
  initialDatasetId,
  onConvertDpoToSft,
  onStarted,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly datasets: ReadonlyArray<TrainingDatasetSummary>;
  readonly capabilities: TrainingCapabilitiesResult | null;
  readonly initialDatasetId?: TrainingDatasetId;
  readonly onConvertDpoToSft?: (
    dataset: TrainingDatasetSummary,
  ) => Promise<TrainingDatasetSummary | null>;
  readonly onStarted?: (job: TrainingJobSnapshot) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canStart = useAtomValue(trainingStartJob.permissionAtom(environmentId));
  const runStartJob = useAtomCommand(trainingStartJob);

  const defaultDataset =
    datasets.find((dataset) => dataset.id === initialDatasetId) ?? datasets[0] ?? null;
  const defaultModel = capabilities?.cachedModels[0]?.id ?? "";

  const [presetId, setPresetId] = useState<TrainingPresetId>("balanced_lora");
  const [draft, setDraft] = useState<TrainingJobLaunchDraft>(() => ({
    ...createJobLaunchDraft({
      presetId: "balanced_lora",
      datasetId: defaultDataset?.id ?? "",
      baseModel: defaultModel,
    }),
    name: defaultDataset ? `${defaultDataset.name} LoRA` : "",
  }));
  const [learningRateText, setLearningRateText] = useState(String(draft.learningRate));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [convertingDpo, setConvertingDpo] = useState(false);
  const [createdDatasets, setCreatedDatasets] = useState<ReadonlyArray<TrainingDatasetSummary>>([]);

  const availableDatasets = [
    ...createdDatasets.filter((created) => !datasets.some((dataset) => dataset.id === created.id)),
    ...datasets,
  ];
  const selectedDataset =
    availableDatasets.find((dataset) => dataset.id === draft.datasetId) ?? null;
  const selectedBackend =
    capabilities?.backends.find((backend) => backend.id === draft.backend) ?? null;
  const selectedRoot = capabilities?.storageRoots.find((root) => root.path === draft.outputBaseDir);
  const freeBytes = selectedRoot?.freeBytes ?? capabilities?.activeStorageFreeBytes ?? null;

  const preflight = validateTrainingJobLaunch(
    {
      draft,
      dataset: selectedDataset,
      backend: selectedBackend,
      availableStorageFreeBytes: freeBytes,
    },
    messages,
  );

  const update = (patch: Partial<TrainingJobLaunchDraft>) => setDraft({ ...draft, ...patch });

  const matchedCachedModel = capabilities?.cachedModels.find(
    (model) => model.id === draft.baseModel || model.path === draft.baseModel,
  );

  const handleSelectPreset = (nextId: TrainingPresetId) => {
    setPresetId(nextId);
    const updated = applyPresetToJobDraft(draft, nextId);
    setDraft(updated);
    setLearningRateText(String(updated.learningRate));
  };

  const handleConvertDpo = async (dpoDataset: TrainingDatasetSummary) => {
    if (!onConvertDpoToSft || convertingDpo) return;
    setConvertingDpo(true);
    const created = await onConvertDpoToSft(dpoDataset);
    setConvertingDpo(false);
    if (created === null) return;
    setCreatedDatasets((prev) =>
      prev.some((entry) => entry.id === created.id) ? prev : [created, ...prev],
    );
    setDraft((prev) => ({
      ...prev,
      datasetId: created.id,
      ...(prev.name === `${dpoDataset.name} LoRA` ? { name: `${created.name} LoRA` } : {}),
    }));
  };

  const handleStart = async () => {
    if (!preflight.valid || !selectedDataset) return;
    setSubmitting(true);
    const config = buildJobConfigFromDraft(draft, selectedDataset.id);
    const result = await runStartJob({
      environmentId,
      input: { config },
    });
    setSubmitting(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Training job queued"),
        description: result.value.config.name,
      });
      onStarted?.(result.value);
      onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not start training job"),
        description: failureDescription(result),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Launch Fine-Tuning Job</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Configure a local MLX training run. Local inference pauses automatically during the
              GPU lease if enabled.
            </T>
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="training-job-name">
                  <T>Job name</T>
                </Label>
                <Input
                  id="training-job-name"
                  value={draft.name}
                  placeholder={gt("e.g. Qwen3-Coder LoRA v1")}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label>
                  <T>Dataset</T>
                </Label>
                <Select<string>
                  value={draft.datasetId}
                  onValueChange={(value) => {
                    if (value) update({ datasetId: value as TrainingDatasetId });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={gt("Select a dataset")} />
                  </SelectTrigger>
                  <SelectPopup>
                    {availableDatasets.map((dataset) => (
                      <SelectItem key={dataset.id} value={dataset.id}>
                        {dataset.name} ({dataset.objective.toUpperCase()}, {dataset.trainCount}{" "}
                        train)
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            {preflight.dpoIncompatibleWithBackend && selectedDataset ? (
              <Alert variant="warning">
                <AlertTriangleIcon />
                <AlertTitle>
                  <T>DPO dataset requires an SFT conversion or external DPO trainer</T>
                </AlertTitle>
                <AlertDescription>
                  <p className="text-xs">
                    <T>
                      The local mlx-lora trainer supports SFT datasets only. You can export the DPO
                      JSONL at{" "}
                      <code className="font-mono">
                        <Var>{selectedDataset.storagePath}</Var>
                      </code>{" "}
                      or create an SFT dataset from the chosen completions.
                    </T>
                  </p>
                </AlertDescription>
                {onConvertDpoToSft ? (
                  <AlertAction>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={convertingDpo || submitting}
                      onClick={() => void handleConvertDpo(selectedDataset)}
                    >
                      {convertingDpo ? <T>Converting...</T> : <T>Create SFT dataset from chosen</T>}
                    </Button>
                  </AlertAction>
                ) : null}
              </Alert>
            ) : null}

            <div className="space-y-2">
              <Label>
                <T>Base model</T>
              </Label>
              {capabilities && capabilities.cachedModels.length > 0 ? (
                <Select
                  value={matchedCachedModel ? matchedCachedModel.id : CUSTOM_MODEL}
                  onValueChange={(value) => {
                    if (value && value !== CUSTOM_MODEL) {
                      update({ baseModel: value });
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={gt("Choose a cached HF / MLX model")} />
                  </SelectTrigger>
                  <SelectPopup>
                    {capabilities.cachedModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.id}
                        {model.sizeBytes ? ` (${formatTrainingBytesGb(model.sizeBytes)})` : ""}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_MODEL}>
                      <T>Custom HuggingFace slug or local path</T>
                    </SelectItem>
                  </SelectPopup>
                </Select>
              ) : null}
              <Input
                aria-label={gt("Base model slug or local directory")}
                font="mono"
                value={draft.baseModel}
                placeholder={gt("mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")}
                onChange={(event) => update({ baseModel: event.target.value })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>
                  <T>Fine-tune type</T>
                </Label>
                <div>
                  <ToggleGroup
                    value={[draft.fineTuneType]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next === "lora" || next === "dora" || next === "full") {
                        update({ fineTuneType: next as TrainingFineTuneType });
                      }
                    }}
                  >
                    <Toggle value="lora">LoRA</Toggle>
                    <Toggle value="dora">DoRA</Toggle>
                    <Toggle value="full">
                      <T>Full</T>
                    </Toggle>
                  </ToggleGroup>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>
                  <T>Preset</T>
                </Label>
                <div>
                  <ToggleGroup
                    value={[presetId]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (
                        next === "quick_smoke" ||
                        next === "balanced_lora" ||
                        next === "deep_lora"
                      ) {
                        handleSelectPreset(next);
                      }
                    }}
                  >
                    {TRAINING_PRESETS.map((preset) => (
                      <Toggle key={preset.id} value={preset.id}>
                        {messages(preset.label)}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {messages(
                TRAINING_PRESETS.find((preset) => preset.id === presetId)?.description ??
                  TRAINING_PRESETS[1]!.description,
              )}
            </p>

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs font-medium text-foreground">
                <span>
                  <T>Advanced hyperparameters & storage</T>
                </span>
                <ChevronDownIcon
                  className={
                    advancedOpen
                      ? "size-4 rotate-180 transition-transform"
                      : "size-4 transition-transform"
                  }
                />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="mt-3 space-y-4 rounded-lg border border-border/60 p-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <NumberInputCell
                      label={gt("Iterations")}
                      value={draft.iters}
                      min={1}
                      max={100_000}
                      step={50}
                      onChange={(iters) => update({ iters })}
                    />
                    <NumberInputCell
                      label={gt("Batch size")}
                      value={draft.batchSize}
                      min={1}
                      max={64}
                      onChange={(batchSize) => update({ batchSize })}
                    />
                    <NumberInputCell
                      label={gt("Grad accumulation")}
                      value={draft.gradAccumulationSteps}
                      min={1}
                      max={64}
                      onChange={(gradAccumulationSteps) => update({ gradAccumulationSteps })}
                    />
                    <div className="space-y-1.5">
                      <Label htmlFor="training-lr">
                        <T>Learning rate</T>
                      </Label>
                      <Input
                        id="training-lr"
                        font="mono"
                        value={learningRateText}
                        onChange={(event) => {
                          setLearningRateText(event.target.value);
                          const parsed = Number(event.target.value);
                          if (Number.isFinite(parsed) && parsed > 0) {
                            update({ learningRate: parsed });
                          }
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>
                        <T>Optimizer</T>
                      </Label>
                      <Select
                        value={draft.optimizer}
                        onValueChange={(value) => {
                          if (value) update({ optimizer: value as TrainingOptimizer });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {OPTIMIZERS.map((optimizer) => (
                            <SelectItem key={optimizer} value={optimizer}>
                              {optimizer}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                    <NumberInputCell
                      label={gt("Max seq length")}
                      value={draft.maxSeqLength}
                      min={128}
                      max={32_768}
                      step={512}
                      onChange={(maxSeqLength) => update({ maxSeqLength })}
                    />
                  </div>

                  {draft.fineTuneType !== "full" ? (
                    <div className="grid gap-3 border-t border-border/50 pt-3 sm:grid-cols-4">
                      <NumberInputCell
                        label={gt("LoRA rank")}
                        value={draft.loraRank}
                        min={1}
                        max={256}
                        onChange={(loraRank) => update({ loraRank })}
                      />
                      <NumberInputCell
                        label={gt("LoRA scale")}
                        value={draft.loraScale}
                        min={1}
                        max={128}
                        onChange={(loraScale) => update({ loraScale })}
                      />
                      <NumberInputCell
                        label={gt("LoRA dropout")}
                        value={draft.loraDropout}
                        min={0}
                        max={0.5}
                        step={0.01}
                        onChange={(loraDropout) => update({ loraDropout })}
                      />
                      <NumberInputCell
                        label={gt("Layers (-1 = all)")}
                        value={draft.loraNumLayers}
                        min={-1}
                        max={128}
                        onChange={(loraNumLayers) => update({ loraNumLayers })}
                      />
                    </div>
                  ) : null}

                  {capabilities && capabilities.storageRoots.length > 0 ? (
                    <div className="space-y-1.5 border-t border-border/50 pt-3">
                      <Label>
                        <T>Output storage root</T>
                      </Label>
                      <Select
                        value={draft.outputBaseDir || DEFAULT_STORAGE}
                        onValueChange={(value) =>
                          update({
                            outputBaseDir: value && value !== DEFAULT_STORAGE ? value : "",
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value={DEFAULT_STORAGE}>
                            <T>
                              Default (
                              <Var>
                                {formatTrainingBytesGb(capabilities.activeStorageFreeBytes)}
                              </Var>{" "}
                              free)
                            </T>
                          </SelectItem>
                          {capabilities.storageRoots.map((root) => (
                            <SelectItem key={root.path} value={root.path}>
                              {root.label} ({formatTrainingBytesGb(root.freeBytes)} free)
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  ) : null}

                  <div className="grid gap-2 border-t border-border/50 pt-3 sm:grid-cols-2">
                    <SwitchField
                      label={gt("Mask prompt tokens")}
                      checked={draft.maskPrompt}
                      onCheckedChange={(maskPrompt) => update({ maskPrompt })}
                    />
                    <SwitchField
                      label={gt("Gradient checkpointing")}
                      checked={draft.gradCheckpoint}
                      onCheckedChange={(gradCheckpoint) => update({ gradCheckpoint })}
                    />
                    <SwitchField
                      label={gt("Pause local inference during run")}
                      checked={draft.pauseLocalInference}
                      onCheckedChange={(pauseLocalInference) => update({ pauseLocalInference })}
                    />
                    <SwitchField
                      label={gt("Auto-fuse adapter on completion")}
                      checked={draft.autoFuse}
                      onCheckedChange={(autoFuse) => update({ autoFuse })}
                    />
                    <SwitchField
                      label={gt("Run held-out test eval")}
                      checked={draft.runTestEval}
                      onCheckedChange={(runTestEval) => update({ runTestEval })}
                    />
                    <SwitchField
                      label={gt("Trust remote code")}
                      checked={draft.trustRemoteCode}
                      onCheckedChange={(trustRemoteCode) => update({ trustRemoteCode })}
                    />
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>

            {preflight.warnings.length > 0 ? (
              <Alert variant="warning">
                <AlertTriangleIcon />
                <AlertDescription>
                  <ul className="list-disc space-y-1 ps-4 text-xs">
                    {preflight.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {preflight.errors.length > 0 && !preflight.dpoIncompatibleWithBackend ? (
              <Alert variant="error">
                <AlertTriangleIcon />
                <AlertDescription>
                  <ul className="list-disc space-y-1 ps-4 text-xs">
                    {preflight.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={!canStart || !preflight.valid || submitting}
            onClick={() => void handleStart()}
          >
            {submitting ? <T>Starting...</T> : <T>Start Training Job</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function NumberInputCell({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <NumberField
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}

function SwitchField({
  label,
  checked,
  onCheckedChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border/50 px-2.5 py-2 text-xs">
      <span className="text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
