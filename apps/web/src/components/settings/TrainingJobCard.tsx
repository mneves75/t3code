import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  TRAINING_LOG_MAX_BYTES,
  type EnvironmentId,
  type TrainingCapabilitiesResult,
  type TrainingEvalComparison,
  type TrainingGetJobLogsResult,
  type TrainingJobSnapshot,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AlertTriangleIcon,
  FileTextIcon,
  FlaskConicalIcon,
  LayersIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import {
  trainingCancelJob,
  trainingFuseArtifact,
  trainingGetJobLogs,
  trainingRunEval,
  trainingServeArtifact,
  trainingStopServedArtifact,
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
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { toastManager } from "../ui/toast";
import { TrainingLossChart } from "./TrainingLossChart";
import {
  TRAINING_JOB_STATUS_LABELS,
  formatTrainingBytesGb,
  formatTrainingEta,
  formatTrainingLoss,
  formatTrainingMemoryGb,
  formatTrainingThroughput,
  isTrainingJobActive,
  trainingJobProgressPercent,
  trainingJobStatusBadgeVariant,
} from "./TrainingSettings.logic";

function commandFailureText(cause: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const err = squashAtomCommandFailure(cause);
  return err instanceof Error ? (thrownErrorMessage(err, m) ?? err.message) : String(err);
}

export function TrainingJobCard({
  environmentId,
  job,
  isHoldingGpuLease,
  capabilities: _capabilities,
  evalRuns = [],
  onArtifactUpdated,
}: {
  readonly environmentId: EnvironmentId;
  readonly job: TrainingJobSnapshot;
  readonly isHoldingGpuLease: boolean;
  readonly capabilities: TrainingCapabilitiesResult | null;
  readonly evalRuns?: ReadonlyArray<TrainingEvalComparison>;
  readonly onArtifactUpdated?: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();

  const canCancel = useAtomValue(trainingCancelJob.permissionAtom(environmentId));
  const canReadLogs = useAtomValue(trainingGetJobLogs.permissionAtom(environmentId));
  const canFuse = useAtomValue(trainingFuseArtifact.permissionAtom(environmentId));
  const canServe = useAtomValue(trainingServeArtifact.permissionAtom(environmentId));
  const canStopServed = useAtomValue(trainingStopServedArtifact.permissionAtom(environmentId));
  const canEval = useAtomValue(trainingRunEval.permissionAtom(environmentId));

  const runCancel = useAtomCommand(trainingCancelJob);
  const runGetLogs = useAtomCommand(trainingGetJobLogs);
  const runFuse = useAtomCommand(trainingFuseArtifact);
  const runServe = useAtomCommand(trainingServeArtifact);
  const runStopServed = useAtomCommand(trainingStopServedArtifact);
  const runEval = useAtomCommand(trainingRunEval);

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsResult, setLogsResult] = useState<TrainingGetJobLogsResult | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"fuse" | "serve" | "stop" | "eval" | null>(null);

  const active = isTrainingJobActive(job.status);
  const progress = trainingJobProgressPercent(job);
  const metric = job.latestMetric;
  const artifact = job.artifact;
  const isPerplexityEvalRunning = evalRuns.some(
    (run) => run.suite === "heldout_perplexity" && run.status === "running",
  );
  const isAnyEvalRunning = evalRuns.some((run) => run.status === "running");

  const fetchLogs = async () => {
    setLogsLoading(true);
    setLogsError(null);
    const result = await runGetLogs({
      environmentId,
      input: { jobId: job.id, tailBytes: TRAINING_LOG_MAX_BYTES },
    });
    setLogsLoading(false);
    if (result._tag === "Success") {
      setLogsResult(result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      setLogsError(commandFailureText(result));
    }
  };

  const handleOpenLogs = () => {
    setLogsOpen(true);
    void fetchLogs();
  };

  const handleConfirmCancel = async () => {
    setCancelling(true);
    const result = await runCancel({ environmentId, input: { jobId: job.id } });
    setCancelling(false);
    setCancelDialogOpen(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "info",
        title: gt("Training job cancelled"),
        description: job.config.name,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not cancel training job"),
        description: commandFailureText(result),
      });
    }
  };

  const handleFuse = async () => {
    if (!artifact) return;
    setBusyAction("fuse");
    const result = await runFuse({
      environmentId,
      input: { artifactId: artifact.id, exportGguf: false },
    });
    setBusyAction(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Model fused"),
        description: result.value.fusedModelPath ?? artifact.adapterPath,
      });
      onArtifactUpdated?.();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Fuse failed"),
        description: commandFailureText(result),
      });
    }
  };

  const handleServeAndRegister = async () => {
    if (!artifact) return;
    setBusyAction("serve");
    const result = await runServe({
      environmentId,
      input: {
        artifactId: artifact.id,
        mode: artifact.fusedModelPath ? "fused" : "adapter",
        autoRegisterInInference: true,
        displayName: `MLX Fine-Tune: ${job.config.name}`,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Adapter serving and registered in Inference"),
        description: result.value.baseUrl,
      });
      onArtifactUpdated?.();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not serve fine-tuned model"),
        description: commandFailureText(result),
      });
    }
  };

  const handleStopServing = async () => {
    if (!artifact) return;
    setBusyAction("stop");
    const result = await runStopServed({
      environmentId,
      input: { artifactId: artifact.id, removeInferenceServer: false },
    });
    setBusyAction(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "info",
        title: gt("Stopped serving fine-tuned model"),
      });
      onArtifactUpdated?.();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not stop served model"),
        description: commandFailureText(result),
      });
    }
  };

  const handleRunEval = async () => {
    if (!artifact) return;
    setBusyAction("eval");
    const result = await runEval({
      environmentId,
      input: { artifactId: artifact.id, suite: "heldout_perplexity" },
    });
    setBusyAction(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: result.value.status === "failed" ? "error" : "info",
        title: gt("Held-out perplexity evaluation running"),
        description: gt("Results will update automatically when complete."),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not start evaluation"),
        description: commandFailureText(result),
      });
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{job.config.name}</h3>
            <Badge variant={trainingJobStatusBadgeVariant(job.status)}>
              {messages(TRAINING_JOB_STATUS_LABELS[job.status])}
            </Badge>
            <Badge variant="outline">{job.config.fineTuneType.toUpperCase()}</Badge>
            {isHoldingGpuLease ? (
              <Badge variant="warning">
                <T>GPU lease active</T>
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{job.config.baseModel}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {canReadLogs ? (
            <Button size="sm" variant="outline" onClick={handleOpenLogs}>
              <FileTextIcon />
              <T>View Logs</T>
            </Button>
          ) : null}
          {active && canCancel ? (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={cancelling}
              onClick={() => setCancelDialogOpen(true)}
            >
              <XCircleIcon />
              <T>Cancel</T>
            </Button>
          ) : null}
        </div>
      </div>

      {active || job.status === "completed" ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
            <span>{job.statusMessage ?? messages(TRAINING_JOB_STATUS_LABELS[job.status])}</span>
            <span>{progress}%</span>
          </div>
          <div
            role="progressbar"
            aria-label={gt("{name} training progress", { name: job.config.name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCell label={gt("Iter")} value={`${metric?.iter ?? 0} / ${job.config.iters}`} />
        <StatCell label={gt("Train Loss")} value={formatTrainingLoss(metric?.trainLoss)} />
        <StatCell label={gt("Val Loss")} value={formatTrainingLoss(metric?.valLoss)} />
        <StatCell label={gt("Throughput")} value={formatTrainingThroughput(metric?.tokSec)} />
        <StatCell label={gt("Peak Mem")} value={formatTrainingMemoryGb(metric?.peakMemGb)} />
        <StatCell label={gt("ETA")} value={active ? formatTrainingEta(metric?.etaSec) : "--"} />
      </div>

      {job.status === "failed" && job.statusMessage ? (
        <Alert variant="error">
          <AlertTriangleIcon />
          <AlertTitle>
            <T>Training failed</T>
          </AlertTitle>
          <AlertDescription>{job.statusMessage}</AlertDescription>
        </Alert>
      ) : null}

      {job.truncationWarningsCount > 0 ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertDescription>
            <T>
              <Var>{job.truncationWarningsCount}</Var> sequences exceeded max sequence length (
              <Var>{job.config.maxSeqLength}</Var>) and were truncated during training.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}

      {job.recentMetrics.length > 0 || job.status === "training" ? (
        <TrainingLossChart metrics={job.recentMetrics} />
      ) : null}

      {job.status === "completed" && artifact !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {artifact.testPerplexity !== undefined ? (
              <Badge variant="outline">
                <T>
                  Test ppl <Var>{artifact.testPerplexity.toFixed(2)}</Var>
                </T>
              </Badge>
            ) : null}
            {artifact.servingPort !== null ? (
              <Badge variant="success">
                <T>
                  Serving on port <Var>{artifact.servingPort}</Var>
                </T>
              </Badge>
            ) : null}
            {isAnyEvalRunning ? (
              <Badge variant="info">
                <T>Eval running</T>
              </Badge>
            ) : null}
            {artifact.registeredInferenceServerId !== null ? (
              <Link
                to="/settings/inference"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                <T>Open in Inference settings</T>
              </Link>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {canFuse ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void handleFuse()}
              >
                <LayersIcon />
                {artifact.fusedModelPath ? <T>Re-fuse Model</T> : <T>Fuse Model</T>}
              </Button>
            ) : null}
            {artifact.servingPort !== null ? (
              canStopServed ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={() => void handleStopServing()}
                >
                  <SquareIcon />
                  <T>Stop Serving</T>
                </Button>
              ) : null
            ) : canServe ? (
              <Button
                size="sm"
                variant="default"
                disabled={busyAction !== null}
                onClick={() => void handleServeAndRegister()}
              >
                <PlayIcon />
                <T>Serve & Register in Inference</T>
              </Button>
            ) : null}
            {canEval ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction !== null || isPerplexityEvalRunning}
                onClick={() => void handleRunEval()}
              >
                <FlaskConicalIcon />
                {isPerplexityEvalRunning ? <T>Eval Running</T> : <T>Run Eval</T>}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Cancel training job?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This sends SIGTERM to the running trainer process for <Var>{job.config.name}</Var>{" "}
                and releases the local GPU lease. Saved checkpoints remain in the job folder.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Keep running</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={cancelling}
              onClick={() => void handleConfirmCancel()}
            >
              <T>Cancel job</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Sheet open={logsOpen} onOpenChange={setLogsOpen}>
        <SheetPopup side="right" className="max-w-2xl">
          <SheetHeader>
            <div className="flex items-center justify-between gap-2 pe-8">
              <div className="min-w-0">
                <SheetTitle>{job.config.name}</SheetTitle>
                <SheetDescription>
                  {logsResult ? (
                    logsResult.truncated ? (
                      <T>
                        Showing last <Var>{formatTrainingBytesGb(logsResult.content.length)}</Var>{" "}
                        of <Var>{formatTrainingBytesGb(logsResult.totalBytes)}</Var> (truncated)
                      </T>
                    ) : (
                      <T>
                        Showing last <Var>{formatTrainingBytesGb(logsResult.content.length)}</Var>{" "}
                        of <Var>{formatTrainingBytesGb(logsResult.totalBytes)}</Var>
                      </T>
                    )
                  ) : (
                    <T>Trainer process output (bounded tail).</T>
                  )}
                </SheetDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={logsLoading}
                onClick={() => void fetchLogs()}
              >
                <RefreshCwIcon />
                <T>Refresh</T>
              </Button>
            </div>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
            {logsError ? (
              <Alert variant="error">
                <AlertDescription>{logsError}</AlertDescription>
              </Alert>
            ) : logsLoading && logsResult === null ? (
              <p className="text-sm text-muted-foreground">
                <T>Loading logs...</T>
              </p>
            ) : (
              <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
                <ScrollArea className="flex-1">
                  <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground select-text">
                    {logsResult && logsResult.content.length > 0
                      ? logsResult.content
                      : gt("No log output recorded yet.")}
                  </pre>
                </ScrollArea>
              </div>
            )}
          </div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function StatCell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 px-2.5 py-2">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs font-medium text-foreground tabular-nums">
        {value}
      </div>
    </div>
  );
}
