import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  TrainingDatasetFilter,
  TrainingDatasetId,
  TrainingDatasetSummary,
  TrainingObjective,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  CpuIcon,
  DatabaseIcon,
  HardDriveIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  curatedThreadIdsAtom,
  trainingArtifactsAtom,
  trainingArtifactsValueAtom,
  trainingCapabilitiesAtom,
  trainingCapabilitiesValueAtom,
  trainingConvertDpoDatasetToSft,
  trainingCreateDataset,
  trainingDeleteDataset,
  trainingEvalsAtom,
  trainingEvalsValueAtom,
  trainingLiveStateAtom,
  trainingPreviewDataset,
  trainingStartJob,
  trainingStreamAtom,
} from "../../state/training";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { TrainingArtifactsPanel } from "./TrainingArtifactsPanel";
import { TrainingDatasetBuilderDialog } from "./TrainingDatasetBuilderDialog";
import { TrainingJobCard } from "./TrainingJobCard";
import { TrainingJobLaunchDialog } from "./TrainingJobLaunchDialog";
import { formatTrainingBytesGb, formatTrainingTokenCount } from "./TrainingSettings.logic";

type TrainingTab = "jobs" | "datasets" | "artifacts";

interface DatasetBuilderPrefill {
  readonly name?: string;
  readonly objective?: TrainingObjective;
  readonly filter?: Partial<TrainingDatasetFilter>;
}

function failureDescription(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const err = squashAtomCommandFailure(result);
  return err instanceof Error ? (thrownErrorMessage(err, m) ?? err.message) : String(err);
}

export function TrainingSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();

  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <EnvironmentTrainingSettings key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection title={gt("Training")}>
          <SettingsRow
            title={gt("No environment connected.")}
            description={gt(
              "Connect an environment to build datasets and run local MLX fine-tuning jobs.",
            )}
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentTrainingSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const gt = useGT();
  const environmentId: EnvironmentId = environment.environmentId;

  const streamResult = useAtomValue(trainingStreamAtom({ environmentId, input: {} }));
  const liveState = useAtomValue(trainingLiveStateAtom(environmentId));
  const capabilities = useAtomValue(trainingCapabilitiesValueAtom(environmentId));
  const curatedThreadIds = useAtomValue(curatedThreadIdsAtom(environmentId));
  const artifacts = useAtomValue(trainingArtifactsValueAtom(environmentId));
  const evalRuns = useAtomValue(trainingEvalsValueAtom(environmentId));

  const refreshCapabilities = useAtomRefresh(trainingCapabilitiesAtom(environmentId));
  const refreshArtifacts = useAtomRefresh(trainingArtifactsAtom(environmentId));
  const refreshEvals = useAtomRefresh(trainingEvalsAtom(environmentId));

  const canPreviewDataset = useAtomValue(trainingPreviewDataset.permissionAtom(environmentId));
  const canCreateDataset = useAtomValue(trainingCreateDataset.permissionAtom(environmentId));
  const canConvertDpoDataset = useAtomValue(
    trainingConvertDpoDatasetToSft.permissionAtom(environmentId),
  );
  const canDeleteDataset = useAtomValue(trainingDeleteDataset.permissionAtom(environmentId));
  const canStartJob = useAtomValue(trainingStartJob.permissionAtom(environmentId));

  const runConvertDpoDataset = useAtomCommand(trainingConvertDpoDatasetToSft);
  const runDeleteDataset = useAtomCommand(trainingDeleteDataset);

  const [activeTab, setActiveTab] = useState<TrainingTab>("jobs");
  const [datasetDialogOpen, setDatasetDialogOpen] = useState(false);
  const [datasetPrefill, setDatasetPrefill] = useState<DatasetBuilderPrefill | null>(null);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const [launchDialogSession, setLaunchDialogSession] = useState(0);
  const [launchDatasetId, setLaunchDatasetId] = useState<TrainingDatasetId | undefined>(undefined);
  const [deletingDataset, setDeletingDataset] = useState<TrainingDatasetSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const mlxBackend = capabilities?.backends.find((backend) => backend.id === "mlx-lora") ?? null;
  const activeLeaseId = liveState.activeGpuLeaseJobId ?? capabilities?.activeGpuLeaseJobId ?? null;
  const activeLeaseJob =
    activeLeaseId === null
      ? null
      : (liveState.jobs.find((job) => job.id === activeLeaseId) ?? null);

  const refreshAll = () => {
    refreshCapabilities();
    refreshArtifacts();
    refreshEvals();
  };

  const openDatasetBuilder = (prefill: DatasetBuilderPrefill | null = null) => {
    setDatasetPrefill(prefill);
    setDatasetDialogOpen(true);
  };

  const openJobLauncher = (datasetId?: TrainingDatasetId) => {
    setLaunchDatasetId(datasetId);
    setLaunchDialogSession((count) => count + 1);
    setLaunchDialogOpen(true);
  };

  const handleConvertDpoToSft = async (
    dpoDataset: TrainingDatasetSummary,
  ): Promise<TrainingDatasetSummary | null> => {
    const result = await runConvertDpoDataset({
      environmentId,
      input: {
        datasetId: dpoDataset.id,
        name: `${dpoDataset.name} (SFT)`,
      },
    });
    if (result._tag === "Success") {
      setLaunchDatasetId(result.value.id);
      toastManager.add({
        type: "success",
        title: gt("SFT dataset created from chosen completions"),
        description: result.value.name,
      });
      return result.value;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not convert DPO dataset to SFT"),
        description: failureDescription(result),
      });
    }
    return null;
  };

  const handleConfirmDeleteDataset = async () => {
    if (!deletingDataset) return;
    setDeleting(true);
    const result = await runDeleteDataset({
      environmentId,
      input: { datasetId: deletingDataset.id },
    });
    setDeleting(false);
    setDeletingDataset(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "info",
        title: gt("Dataset deleted"),
        description: deletingDataset.name,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not delete dataset"),
        description: failureDescription(result),
      });
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        title={gt("Local Fine-Tuning (MLX)")}
        icon={<CpuIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={refreshAll}>
              <RefreshCwIcon />
              <T>Refresh</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canPreviewDataset || !canCreateDataset}
              onClick={() => openDatasetBuilder(null)}
            >
              <DatabaseIcon />
              <T>New Dataset</T>
            </Button>
            <Button
              size="sm"
              variant="default"
              disabled={!canStartJob || liveState.datasets.length === 0}
              onClick={() => openJobLauncher(undefined)}
            >
              <PlusIcon />
              <T>New Training Job</T>
            </Button>
          </div>
        }
      >
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {mlxBackend ? (
              mlxBackend.available ? (
                <Badge variant="success">
                  <T>
                    mlx_lm <Var>{mlxBackend.version ?? "ready"}</Var>
                  </T>
                </Badge>
              ) : (
                <Badge variant="warning">
                  <T>mlx_lm unavailable</T>
                </Badge>
              )
            ) : (
              <Badge variant="outline">
                <T>Probing trainer...</T>
              </Badge>
            )}

            {capabilities ? (
              <Badge variant="outline">
                <CpuIcon />
                {capabilities.isAppleSilicon ? (
                  <T>
                    Apple Silicon (<Var>{formatTrainingBytesGb(capabilities.hostMemoryBytes)}</Var>{" "}
                    unified)
                  </T>
                ) : (
                  <T>
                    <Var>{formatTrainingBytesGb(capabilities.hostMemoryBytes)}</Var> RAM
                  </T>
                )}
              </Badge>
            ) : null}

            {capabilities ? (
              <Badge variant="outline">
                <HardDriveIcon />
                <T>
                  <Var>{formatTrainingBytesGb(capabilities.activeStorageFreeBytes)}</Var> free
                </T>
              </Badge>
            ) : null}

            <Badge variant={activeLeaseId !== null ? "warning" : "secondary"}>
              {activeLeaseId !== null ? (
                <T>
                  GPU lease: <Var>{activeLeaseJob?.config.name ?? activeLeaseId}</Var>
                </T>
              ) : (
                <T>GPU idle</T>
              )}
            </Badge>

            <Badge variant="outline">
              <T>
                <Var>{curatedThreadIds.size}</Var> curated threads
              </T>
            </Badge>
          </div>

          {capabilities ? (
            <p className="truncate font-mono text-xs text-muted-foreground">
              <T>
                Storage: <Var>{capabilities.activeStorageDir}</Var>
              </T>
            </p>
          ) : null}

          {mlxBackend && !mlxBackend.available && mlxBackend.unavailableReason ? (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>
                <T>Local MLX trainer unavailable</T>
              </AlertTitle>
              <AlertDescription>{mlxBackend.unavailableReason}</AlertDescription>
            </Alert>
          ) : null}

          {AsyncResult.isFailure(streamResult) ? (
            <Alert variant="error">
              <AlertTriangleIcon />
              <AlertTitle>
                <T>Training stream disconnected</T>
              </AlertTitle>
              <AlertDescription>
                <T>
                  Could not subscribe to live training updates on <Var>{environment.label}</Var>.
                </T>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </SettingsSection>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          value={[activeTab]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "jobs" || next === "datasets" || next === "artifacts") {
              setActiveTab(next);
            }
          }}
        >
          <Toggle value="jobs">
            <T>
              Jobs (<Var>{liveState.jobs.length}</Var>)
            </T>
          </Toggle>
          <Toggle value="datasets">
            <T>
              Datasets (<Var>{liveState.datasets.length}</Var>)
            </T>
          </Toggle>
          <Toggle value="artifacts">
            <T>
              Artifacts & Evals (<Var>{artifacts.length}</Var>)
            </T>
          </Toggle>
        </ToggleGroup>
      </div>

      {activeTab === "jobs" ? (
        liveState.jobs.length === 0 ? (
          <SettingsGroup>
            <Empty size="compact">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CpuIcon />
                </EmptyMedia>
                <EmptyTitle>
                  <T>No training jobs yet</T>
                </EmptyTitle>
                <EmptyDescription>
                  <T>
                    Build a redacted dataset from your threads, then launch a local MLX LoRA or DoRA
                    run.
                  </T>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </SettingsGroup>
        ) : (
          <div className="space-y-4">
            {liveState.jobs.map((job) => (
              <TrainingJobCard
                key={job.id}
                environmentId={environmentId}
                job={job}
                isHoldingGpuLease={activeLeaseId === job.id}
                capabilities={capabilities}
                evalRuns={
                  job.artifact ? evalRuns.filter((run) => run.artifactId === job.artifact?.id) : []
                }
                onArtifactUpdated={refreshAll}
              />
            ))}
          </div>
        )
      ) : activeTab === "datasets" ? (
        <SettingsGroup>
          {liveState.datasets.length === 0 ? (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DatabaseIcon />
                </EmptyMedia>
                <EmptyTitle>
                  <T>No training datasets yet</T>
                </EmptyTitle>
                <EmptyDescription>
                  <T>
                    Extract SFT or DPO datasets from durable thread history with built-in secret
                    redaction.
                  </T>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y divide-border/50">
              {liveState.datasets.map((dataset) => (
                <div
                  key={dataset.id}
                  className="flex flex-wrap items-start justify-between gap-3 p-4"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">{dataset.name}</h3>
                      <Badge variant="outline">{dataset.objective.toUpperCase()}</Badge>
                      <Badge variant="secondary">
                        <ShieldCheckIcon />
                        <T>
                          <Var>{dataset.redactionAudit.totalRedactions}</Var> redacted
                        </T>
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                      <span>
                        <T>
                          Train <Var>{dataset.trainCount}</Var> / Valid{" "}
                          <Var>{dataset.validCount}</Var> / Test <Var>{dataset.testCount}</Var>
                        </T>
                      </span>
                      <span>
                        <T>
                          ~<Var>{formatTrainingTokenCount(dataset.estimatedTokens)}</Var> tokens
                        </T>
                      </span>
                      <span>
                        <T>
                          <Var>{dataset.sourceThreadIds.length}</Var> threads
                        </T>
                      </span>
                      <span className="font-mono">{dataset.provenanceHash.slice(0, 12)}</span>
                    </div>
                    <p className="truncate font-mono text-2xs text-muted-foreground">
                      {dataset.storagePath}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {canStartJob ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openJobLauncher(dataset.id)}
                      >
                        <PlayIcon />
                        <T>Train</T>
                      </Button>
                    ) : null}
                    {canDeleteDataset ? (
                      <Button
                        size="icon-sm"
                        variant="ghost-destructive"
                        aria-label={gt("Delete dataset {name}", { name: dataset.name })}
                        onClick={() => setDeletingDataset(dataset)}
                      >
                        <Trash2Icon />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsGroup>
      ) : (
        <TrainingArtifactsPanel
          environmentId={environmentId}
          artifacts={artifacts}
          evalRuns={evalRuns}
          capabilities={capabilities}
          onRefresh={refreshAll}
        />
      )}

      {datasetDialogOpen ? (
        <TrainingDatasetBuilderDialog
          key={JSON.stringify(datasetPrefill ?? {})}
          open={datasetDialogOpen}
          onClose={() => setDatasetDialogOpen(false)}
          environmentId={environmentId}
          capabilities={capabilities}
          curatedThreadIds={curatedThreadIds}
          {...(datasetPrefill?.name !== undefined ? { initialName: datasetPrefill.name } : {})}
          {...(datasetPrefill?.objective !== undefined
            ? { initialObjective: datasetPrefill.objective }
            : {})}
          {...(datasetPrefill?.filter !== undefined
            ? { initialFilter: datasetPrefill.filter }
            : {})}
          onCreated={(dataset) => {
            setActiveTab("datasets");
            setLaunchDatasetId(dataset.id);
          }}
        />
      ) : null}

      {launchDialogOpen ? (
        <TrainingJobLaunchDialog
          key={launchDialogSession}
          open={launchDialogOpen}
          onClose={() => setLaunchDialogOpen(false)}
          environmentId={environmentId}
          datasets={liveState.datasets}
          capabilities={capabilities}
          {...(launchDatasetId !== undefined ? { initialDatasetId: launchDatasetId } : {})}
          {...(canConvertDpoDataset ? { onConvertDpoToSft: handleConvertDpoToSft } : {})}
          onStarted={() => setActiveTab("jobs")}
        />
      ) : null}

      <AlertDialog
        open={deletingDataset !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingDataset(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Delete dataset?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This removes <Var>{deletingDataset?.name ?? ""}</Var> and its JSONL files from disk.
                Your original threads remain untouched.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleConfirmDeleteDataset()}
            >
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
