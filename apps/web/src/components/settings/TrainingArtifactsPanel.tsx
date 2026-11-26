import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type TrainingArtifact,
  type TrainingArtifactId,
  type TrainingCapabilitiesResult,
  type TrainingEvalComparison,
  type TrainingEvalModelSummary,
  type TrainingEvalSuite,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ExternalLinkIcon,
  FlaskConicalIcon,
  LayersIcon,
  PlayIcon,
  ServerIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import {
  trainingFuseArtifact,
  trainingRegisterArtifactInInference,
  trainingRunEval,
  trainingServeArtifact,
  trainingStopServedArtifact,
} from "../../state/training";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";
import {
  TRAINING_EVAL_STATUS_LABELS,
  artifactSupportsGgufExport,
  formatTrainingLoss,
  trainingEvalStatusBadgeVariant,
} from "./TrainingSettings.logic";

function failureDescription(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const err = squashAtomCommandFailure(result);
  return err instanceof Error ? (thrownErrorMessage(err, m) ?? err.message) : String(err);
}

function formatEvalSummary(
  suite: TrainingEvalSuite,
  summary: TrainingEvalModelSummary | null,
): string {
  if (!summary) return "--";
  if (suite === "heldout_perplexity") {
    const loss = formatTrainingLoss(summary.testLoss);
    const ppl =
      summary.testPerplexity !== undefined && Number.isFinite(summary.testPerplexity)
        ? summary.testPerplexity.toFixed(2)
        : "--";
    return `loss ${loss} / ppl ${ppl}`;
  }
  const passed = summary.passedCases ?? 0;
  const total = summary.totalCases ?? 0;
  const pct =
    summary.passRate !== undefined && Number.isFinite(summary.passRate)
      ? `${Math.round(summary.passRate * 100)}%`
      : "--";
  return `${passed}/${total} (${pct})`;
}

function formatEvalDelta(evalRun: TrainingEvalComparison): string {
  const base = evalRun.baseSummary;
  const tuned = evalRun.tunedSummary;
  if (!base || !tuned) return "--";
  if (evalRun.suite === "heldout_perplexity") {
    if (base.testPerplexity === undefined || tuned.testPerplexity === undefined) return "--";
    const diff = tuned.testPerplexity - base.testPerplexity;
    return `${diff <= 0 ? "" : "+"}${diff.toFixed(2)} ppl`;
  }
  if (base.passRate === undefined || tuned.passRate === undefined) return "--";
  const diffPct = Math.round((tuned.passRate - base.passRate) * 100);
  return `${diffPct >= 0 ? "+" : ""}${diffPct}%`;
}

export function TrainingArtifactsPanel({
  environmentId,
  artifacts,
  evalRuns,
  capabilities,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly artifacts: ReadonlyArray<TrainingArtifact>;
  readonly evalRuns: ReadonlyArray<TrainingEvalComparison>;
  readonly capabilities: TrainingCapabilitiesResult | null;
  readonly onRefresh: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canFuse = useAtomValue(trainingFuseArtifact.permissionAtom(environmentId));
  const canServe = useAtomValue(trainingServeArtifact.permissionAtom(environmentId));
  const canStop = useAtomValue(trainingStopServedArtifact.permissionAtom(environmentId));
  const canRegister = useAtomValue(
    trainingRegisterArtifactInInference.permissionAtom(environmentId),
  );
  const canEval = useAtomValue(trainingRunEval.permissionAtom(environmentId));

  const runFuse = useAtomCommand(trainingFuseArtifact);
  const runServe = useAtomCommand(trainingServeArtifact);
  const runStop = useAtomCommand(trainingStopServedArtifact);
  const runRegister = useAtomCommand(trainingRegisterArtifactInInference);
  const runEval = useAtomCommand(trainingRunEval);

  const [ggufSelection, setGgufSelection] = useState<Readonly<Record<string, boolean>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  const handleFuse = async (artifact: TrainingArtifact, exportGguf: boolean) => {
    setBusyKey(`fuse:${artifact.id}`);
    const result = await runFuse({
      environmentId,
      input: { artifactId: artifact.id, exportGguf },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: exportGguf ? gt("Fused model and exported GGUF") : gt("Model fused"),
        description: result.value.fusedModelPath ?? artifact.adapterPath,
      });
      onRefresh();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not fuse model"),
        description: failureDescription(result),
      });
    }
  };

  const handleServeToggle = async (artifact: TrainingArtifact) => {
    const serving = artifact.servingPort !== null;
    setBusyKey(`serve:${artifact.id}`);
    if (serving) {
      const result = await runStop({
        environmentId,
        input: { artifactId: artifact.id, removeInferenceServer: false },
      });
      setBusyKey(null);
      if (result._tag === "Success") {
        toastManager.add({ type: "info", title: gt("Stopped serving artifact") });
        onRefresh();
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: gt("Could not stop served artifact"),
          description: failureDescription(result),
        });
      }
      return;
    }

    const result = await runServe({
      environmentId,
      input: {
        artifactId: artifact.id,
        mode: artifact.fusedModelPath ? "fused" : "adapter",
        autoRegisterInInference: false,
      },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Artifact server started"),
        description: result.value.baseUrl,
      });
      onRefresh();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not serve artifact"),
        description: failureDescription(result),
      });
    }
  };

  const handleRegister = async (artifact: TrainingArtifact) => {
    setBusyKey(`register:${artifact.id}`);
    const result = await runRegister({
      environmentId,
      input: { artifactId: artifact.id },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Registered in Inference settings"),
        description: result.value.baseUrl,
      });
      onRefresh();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not register in Inference"),
        description: failureDescription(result),
      });
    }
  };

  const handleRunEval = async (artifactId: TrainingArtifactId, suite: TrainingEvalSuite) => {
    setBusyKey(`eval:${artifactId}:${suite}`);
    const result = await runEval({
      environmentId,
      input: { artifactId, suite },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: result.value.status === "failed" ? "error" : "info",
        title:
          suite === "heldout_perplexity"
            ? gt("Held-out perplexity evaluation running")
            : gt("Local coding evaluation running"),
        description: gt("Results will update automatically when complete."),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not start evaluation"),
        description: failureDescription(result),
      });
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={gt("Trained Artifacts")}>
        {artifacts.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayersIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>No trained artifacts yet</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  Completed fine-tuning jobs appear here so you can fuse weights, serve with
                  mlx_lm.server, register in Inference, and compare evals.
                </T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y divide-border/50">
            {artifacts.map((artifact) => {
              const ggufAllowed = artifactSupportsGgufExport(artifact, capabilities);
              const exportGguf = ggufAllowed && ggufSelection[artifact.id] === true;
              const isBusy = busyKey !== null;
              const isPerplexityEvalRunning = evalRuns.some(
                (run) =>
                  run.artifactId === artifact.id &&
                  run.suite === "heldout_perplexity" &&
                  run.status === "running",
              );
              const isCodingEvalRunning = evalRuns.some(
                (run) =>
                  run.artifactId === artifact.id &&
                  run.suite === "local_coding" &&
                  run.status === "running",
              );

              return (
                <div key={artifact.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium text-foreground">
                          {artifact.baseModel}
                        </span>
                        <Badge variant="outline">{artifact.fineTuneType.toUpperCase()}</Badge>
                        {artifact.servingPort !== null ? (
                          <Badge variant="success">
                            <T>
                              Serving :<Var>{artifact.servingPort}</Var>
                            </T>
                          </Badge>
                        ) : null}
                        {artifact.registeredInferenceServerId !== null ? (
                          <Badge variant="info">
                            <T>In Inference</T>
                          </Badge>
                        ) : null}
                        {isPerplexityEvalRunning || isCodingEvalRunning ? (
                          <Badge variant="info">
                            <T>Eval running</T>
                          </Badge>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">
                          <T>
                            Provenance <Var>{artifact.provenanceHash.slice(0, 12)}</Var>
                          </T>
                        </span>
                        <span>
                          <T>
                            <Var>{artifact.sourceThreadIds.length}</Var> source threads
                          </T>
                        </span>
                        {artifact.testPerplexity !== undefined ? (
                          <span className="tabular-nums">
                            <T>
                              Test ppl <Var>{artifact.testPerplexity.toFixed(2)}</Var>
                            </T>
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {artifact.registeredInferenceServerId !== null ? (
                      <Link
                        to="/settings/inference"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
                      >
                        <T>View in Inference</T>
                        <ExternalLinkIcon className="size-3" />
                      </Link>
                    ) : null}
                  </div>

                  <div className="space-y-1 rounded-lg border border-border/50 bg-background/50 p-2.5 font-mono text-2xs text-muted-foreground">
                    <div className="truncate">
                      <T>
                        Adapter: <Var>{artifact.adapterPath}</Var>
                      </T>
                    </div>
                    {artifact.fusedModelPath ? (
                      <div className="truncate">
                        <T>
                          Fused: <Var>{artifact.fusedModelPath}</Var>
                        </T>
                      </div>
                    ) : null}
                    {artifact.ggufPath ? (
                      <div className="truncate">
                        <T>
                          GGUF: <Var>{artifact.ggufPath}</Var>
                        </T>
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      {canFuse ? (
                        <div className="flex items-center gap-2">
                          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                            <Checkbox
                              checked={exportGguf}
                              disabled={!ggufAllowed || isBusy}
                              onCheckedChange={(checked) =>
                                setGgufSelection({
                                  ...ggufSelection,
                                  [artifact.id]: checked === true,
                                })
                              }
                            />
                            <span>
                              {ggufAllowed ? (
                                <T>Export GGUF</T>
                              ) : (
                                <T>GGUF unsupported for this model family</T>
                              )}
                            </span>
                          </label>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => void handleFuse(artifact, exportGguf)}
                          >
                            <LayersIcon />
                            {artifact.fusedModelPath ? <T>Re-fuse</T> : <T>Fuse</T>}
                          </Button>
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {artifact.servingPort !== null ? (
                        canStop ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => void handleServeToggle(artifact)}
                          >
                            <SquareIcon />
                            <T>Stop Server</T>
                          </Button>
                        ) : null
                      ) : canServe ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isBusy}
                          onClick={() => void handleServeToggle(artifact)}
                        >
                          <PlayIcon />
                          <T>Serve (mlx_lm)</T>
                        </Button>
                      ) : null}

                      {canRegister ? (
                        <Button
                          size="sm"
                          variant={artifact.registeredInferenceServerId ? "outline" : "default"}
                          disabled={isBusy}
                          onClick={() => void handleRegister(artifact)}
                        >
                          <ServerIcon />
                          {artifact.registeredInferenceServerId ? (
                            <T>Re-register in Inference</T>
                          ) : (
                            <T>Register in Inference</T>
                          )}
                        </Button>
                      ) : null}

                      {canEval ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy || isPerplexityEvalRunning}
                            onClick={() => void handleRunEval(artifact.id, "heldout_perplexity")}
                          >
                            <FlaskConicalIcon />
                            {isPerplexityEvalRunning ? (
                              <T>Running Perplexity...</T>
                            ) : (
                              <T>Eval Perplexity</T>
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy || isCodingEvalRunning}
                            onClick={() => void handleRunEval(artifact.id, "local_coding")}
                          >
                            <FlaskConicalIcon />
                            {isCodingEvalRunning ? <T>Running Coding...</T> : <T>Eval Coding</T>}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={gt("Base vs. Fine-Tuned Evaluations")}>
        {evalRuns.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            <T>
              No evaluation runs yet. Run a held-out perplexity or local coding comparison from an
              artifact above.
            </T>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <T>Artifact</T>
                </TableHead>
                <TableHead>
                  <T>Suite</T>
                </TableHead>
                <TableHead>
                  <T>Status</T>
                </TableHead>
                <TableHead>
                  <T>Base Model</T>
                </TableHead>
                <TableHead>
                  <T>Fine-Tuned</T>
                </TableHead>
                <TableHead>
                  <T>Delta</T>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {evalRuns.map((evalRun) => {
                const artifact = artifactById.get(evalRun.artifactId);
                return (
                  <TableRow key={evalRun.id}>
                    <TableCell>
                      <span className="block max-w-48 truncate font-mono">
                        {artifact?.baseModel ?? evalRun.artifactId}
                      </span>
                    </TableCell>
                    <TableCell>
                      {evalRun.suite === "heldout_perplexity" ? (
                        <T>Held-out Perplexity</T>
                      ) : (
                        <T>Local Coding</T>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={trainingEvalStatusBadgeVariant(evalRun.status)}>
                        {messages(TRAINING_EVAL_STATUS_LABELS[evalRun.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono tabular-nums">
                        {formatEvalSummary(evalRun.suite, evalRun.baseSummary)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono tabular-nums">
                        {formatEvalSummary(evalRun.suite, evalRun.tunedSummary)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono font-medium tabular-nums">
                        {formatEvalDelta(evalRun)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SettingsSection>
    </div>
  );
}
