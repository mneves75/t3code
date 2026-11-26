import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type RedactionOptions,
  type RedactionRuleCategory,
  type ThreadId,
  type TrainingCapabilitiesResult,
  type TrainingDatasetFilter,
  type TrainingDatasetPreview,
  type TrainingDatasetSummary,
  type TrainingObjective,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { AlertTriangleIcon, ArrowLeftIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { trainingCreateDataset, trainingPreviewDataset } from "../../state/training";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  REDACTION_CATEGORY_LABELS,
  createDefaultDatasetFilter,
  createDefaultRedactionOptions,
  formatTrainingBytesGb,
  formatTrainingTokenCount,
  parseCsvTerms,
} from "./TrainingSettings.logic";

const ALL_VALUE = "__all__";
const DEFAULT_STORAGE = "__default__";

function failureDescription(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const err = squashAtomCommandFailure(result);
  return err instanceof Error ? (thrownErrorMessage(err, m) ?? err.message) : String(err);
}

export function TrainingDatasetBuilderDialog({
  open,
  onClose,
  environmentId,
  capabilities,
  curatedThreadIds,
  initialName,
  initialObjective = "sft",
  initialFilter,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly capabilities: TrainingCapabilitiesResult | null;
  readonly curatedThreadIds: ReadonlySet<ThreadId>;
  readonly initialName?: string;
  readonly initialObjective?: TrainingObjective;
  readonly initialFilter?: Partial<TrainingDatasetFilter>;
  readonly onCreated?: (dataset: TrainingDatasetSummary) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const allProjects = useProjects();
  const providersByEnvironment = useEnvironmentProviders();
  const envProjects = allProjects.filter((project) => project.environmentId === environmentId);
  const envProviders = providersByEnvironment.get(environmentId) ?? [];

  const canPreview = useAtomValue(trainingPreviewDataset.permissionAtom(environmentId));
  const canCreate = useAtomValue(trainingCreateDataset.permissionAtom(environmentId));
  const runPreview = useAtomCommand(trainingPreviewDataset);
  const runCreate = useAtomCommand(trainingCreateDataset);

  const defaultFilter = { ...createDefaultDatasetFilter(), ...initialFilter };

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(initialName ?? "");
  const [objective, setObjective] = useState<TrainingObjective>(initialObjective);
  const [useCuratedOnly, setUseCuratedOnly] = useState(
    (initialFilter?.threadIds?.length ?? 0) > 0 || curatedThreadIds.size > 0,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    initialFilter?.projectIds?.[0] ?? ALL_VALUE,
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    initialFilter?.providerInstanceIds?.[0] ?? ALL_VALUE,
  );
  const [modelIdsText, setModelIdsText] = useState(initialFilter?.modelIds?.join(", ") ?? "");
  const [tagsText, setTagsText] = useState(initialFilter?.tags?.join(", ") ?? "");
  const [settledOnly, setSettledOnly] = useState(defaultFilter.settledOnly);
  const [includeArchived, setIncludeArchived] = useState(defaultFilter.includeArchived);
  const [includeSubagents, setIncludeSubagents] = useState(defaultFilter.includeSubagents);
  const [minCompletedRuns, setMinCompletedRuns] = useState(defaultFilter.minCompletedRuns);
  const [includeToolCalls, setIncludeToolCalls] = useState(defaultFilter.includeToolCalls);
  const [includeReasoning, setIncludeReasoning] = useState(defaultFilter.includeReasoning);
  const [includeCheckpointDiffs, setIncludeCheckpointDiffs] = useState(
    defaultFilter.includeCheckpointDiffs,
  );
  const [maxToolOutputChars, setMaxToolOutputChars] = useState(defaultFilter.maxToolOutputChars);
  const [validRatio, setValidRatio] = useState(defaultFilter.split.validRatio);
  const [testRatio, setTestRatio] = useState(defaultFilter.split.testRatio);
  const [splitSeed, setSplitSeed] = useState(defaultFilter.split.seed);
  const [fromForks, setFromForks] = useState(defaultFilter.dpoSources?.fromForks ?? true);
  const [fromRollbacks, setFromRollbacks] = useState(
    defaultFilter.dpoSources?.fromRollbacks ?? true,
  );
  const [fromRetryAttempts, setFromRetryAttempts] = useState(
    defaultFilter.dpoSources?.fromRetryAttempts ?? true,
  );

  const defaultRedaction = createDefaultRedactionOptions();
  const [redactEnvAssignments, setRedactEnvAssignments] = useState(
    defaultRedaction.redactEnvAssignments,
  );
  const [redactHomePaths, setRedactHomePaths] = useState(defaultRedaction.redactHomePaths);
  const [redactEmails, setRedactEmails] = useState(defaultRedaction.redactEmails);
  const [redactHighEntropy, setRedactHighEntropy] = useState(defaultRedaction.redactHighEntropy);
  const [customTermsText, setCustomTermsText] = useState("");
  const [outputBaseDir, setOutputBaseDir] = useState(DEFAULT_STORAGE);

  const [preview, setPreview] = useState<TrainingDatasetPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);

  const buildFilter = (): TrainingDatasetFilter => {
    const modelIds = parseCsvTerms(modelIdsText);
    const tags = parseCsvTerms(tagsText);
    const curatedIds = initialFilter?.threadIds?.length
      ? initialFilter.threadIds
      : [...curatedThreadIds];
    return {
      ...(useCuratedOnly && curatedIds.length > 0 ? { threadIds: curatedIds } : {}),
      ...(selectedProjectId !== ALL_VALUE ? { projectIds: [selectedProjectId as ProjectId] } : {}),
      ...(selectedProviderId !== ALL_VALUE
        ? { providerInstanceIds: [selectedProviderId as ProviderInstanceId] }
        : {}),
      ...(modelIds.length > 0 ? { modelIds: [...modelIds] } : {}),
      ...(tags.length > 0 ? { tags: [...tags] } : {}),
      settledOnly,
      includeArchived,
      includeSubagents,
      minCompletedRuns: Math.max(1, Math.round(minCompletedRuns)),
      includeToolCalls,
      includeReasoning,
      includeCheckpointDiffs,
      maxToolOutputChars: Math.max(256, Math.round(maxToolOutputChars)),
      split: {
        validRatio: Math.min(0.4, Math.max(0, validRatio)),
        testRatio: Math.min(0.3, Math.max(0, testRatio)),
        seed: Math.max(0, Math.round(splitSeed)),
      },
      ...(objective === "dpo"
        ? {
            dpoSources: {
              fromForks,
              fromRollbacks,
              fromRetryAttempts,
            },
          }
        : {}),
    };
  };

  const buildRedactionOptions = (): RedactionOptions => {
    const customLiteralTerms = parseCsvTerms(customTermsText);
    return {
      redactEnvAssignments,
      redactHomePaths,
      redactEmails,
      redactHighEntropy,
      ...(customLiteralTerms.length > 0 ? { customLiteralTerms: [...customLiteralTerms] } : {}),
    };
  };

  const handleRunPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    const result = await runPreview({
      environmentId,
      input: {
        objective,
        filter: buildFilter(),
        redactionOptions: buildRedactionOptions(),
      },
    });
    setPreviewing(false);
    if (result._tag === "Success") {
      setPreview(result.value);
      setStep(2);
    } else if (!isAtomCommandInterrupted(result)) {
      setPreviewError(failureDescription(result));
    }
  };

  const handleCreate = async () => {
    if (!preview || name.trim().length === 0) return;
    setCreating(true);
    const result = await runCreate({
      environmentId,
      input: {
        name: name.trim(),
        objective,
        filter: buildFilter(),
        redactionOptions: buildRedactionOptions(),
        ...(outputBaseDir !== DEFAULT_STORAGE ? { outputBaseDir } : {}),
      },
    });
    setCreating(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Training dataset created"),
        description: result.value.name,
      });
      onCreated?.(result.value);
      onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not create dataset"),
        description: failureDescription(result),
      });
    }
  };

  const nonZeroRedactionCategories = preview
    ? (
        Object.entries(preview.redactionAudit.countsByCategory) as Array<
          [RedactionRuleCategory, number]
        >
      ).filter(([, count]) => count > 0)
    : [];

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
            {step === 1 ? <T>Build Training Dataset</T> : <T>Redaction Audit & Sample Preview</T>}
          </DialogTitle>
          <DialogDescription>
            {step === 1 ? (
              <T>
                Step 1 of 2: choose threads, extraction rules, and secret redaction before auditing
                samples.
              </T>
            ) : (
              <T>
                Step 2 of 2: verify redacted snippets and sample records before writing JSONL to
                disk.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {step === 1 ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="training-dataset-name">
                    <T>Dataset name</T>
                  </Label>
                  <Input
                    id="training-dataset-name"
                    value={name}
                    placeholder={gt("e.g. TypeScript coding sessions")}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>
                    <T>Objective</T>
                  </Label>
                  <div>
                    <ToggleGroup
                      value={[objective]}
                      onValueChange={(values) => {
                        const next = values[0];
                        if (next === "sft" || next === "dpo") {
                          setObjective(next);
                          setPreview(null);
                        }
                      }}
                    >
                      <Toggle value="sft">SFT</Toggle>
                      <Toggle value="dpo">DPO</Toggle>
                    </ToggleGroup>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    <T>Use curated threads only</T>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      <Var>{curatedThreadIds.size}</Var> curated threads in your training bucket.
                    </T>
                  </p>
                </div>
                <Switch
                  checked={useCuratedOnly}
                  disabled={
                    curatedThreadIds.size === 0 && (initialFilter?.threadIds?.length ?? 0) === 0
                  }
                  onCheckedChange={(checked) => {
                    setUseCuratedOnly(checked);
                    setPreview(null);
                  }}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>
                    <T>Project</T>
                  </Label>
                  <Select
                    value={selectedProjectId}
                    onValueChange={(value) => {
                      setSelectedProjectId(value ?? ALL_VALUE);
                      setPreview(null);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={gt("All projects")} />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={ALL_VALUE}>
                        <T>All projects</T>
                      </SelectItem>
                      {envProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>
                    <T>Provider</T>
                  </Label>
                  <Select
                    value={selectedProviderId}
                    onValueChange={(value) => {
                      setSelectedProviderId(value ?? ALL_VALUE);
                      setPreview(null);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={gt("All providers")} />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={ALL_VALUE}>
                        <T>All providers</T>
                      </SelectItem>
                      {envProviders.map((provider) => (
                        <SelectItem key={provider.instanceId} value={provider.instanceId}>
                          {provider.displayName}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="training-dataset-models">
                    <T>Model filter</T>
                  </Label>
                  <Input
                    id="training-dataset-models"
                    value={modelIdsText}
                    placeholder={gt("claude-opus, qwen3 (optional)")}
                    onChange={(event) => {
                      setModelIdsText(event.target.value);
                      setPreview(null);
                    }}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="training-dataset-tags">
                    <T>Tags</T>
                  </Label>
                  <Input
                    id="training-dataset-tags"
                    value={tagsText}
                    placeholder={gt("Comma-separated tags (optional)")}
                    onChange={(event) => {
                      setTagsText(event.target.value);
                      setPreview(null);
                    }}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <ToggleRow
                  label={gt("Settled threads only")}
                  checked={settledOnly}
                  onCheckedChange={setSettledOnly}
                />
                <ToggleRow
                  label={gt("Include archived")}
                  checked={includeArchived}
                  onCheckedChange={setIncludeArchived}
                />
                <ToggleRow
                  label={gt("Include subagents")}
                  checked={includeSubagents}
                  onCheckedChange={setIncludeSubagents}
                />
                <ToggleRow
                  label={gt("Include tool calls")}
                  checked={includeToolCalls}
                  onCheckedChange={setIncludeToolCalls}
                />
                <ToggleRow
                  label={gt("Include reasoning")}
                  checked={includeReasoning}
                  onCheckedChange={setIncludeReasoning}
                />
                <ToggleRow
                  label={gt("Checkpoint diffs")}
                  checked={includeCheckpointDiffs}
                  onCheckedChange={setIncludeCheckpointDiffs}
                />
              </div>

              {objective === "dpo" ? (
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <div className="text-xs font-medium text-foreground">
                    <T>DPO preference pair sources</T>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <CheckboxRow
                      label={gt("Thread forks")}
                      checked={fromForks}
                      onCheckedChange={setFromForks}
                    />
                    <CheckboxRow
                      label={gt("Checkpoint rollbacks")}
                      checked={fromRollbacks}
                      onCheckedChange={setFromRollbacks}
                    />
                    <CheckboxRow
                      label={gt("Superseded retry attempts")}
                      checked={fromRetryAttempts}
                      onCheckedChange={setFromRetryAttempts}
                    />
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1.5">
                  <Label>
                    <T>Min turns</T>
                  </Label>
                  <NumberField
                    value={minCompletedRuns}
                    min={1}
                    max={50}
                    onValueChange={(value) => {
                      if (value !== null) setMinCompletedRuns(value);
                    }}
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement />
                      <NumberFieldInput />
                      <NumberFieldIncrement />
                    </NumberFieldGroup>
                  </NumberField>
                </div>

                <div className="space-y-1.5">
                  <Label>
                    <T>Valid ratio</T>
                  </Label>
                  <NumberField
                    value={validRatio}
                    min={0}
                    max={0.4}
                    step={0.05}
                    onValueChange={(value) => {
                      if (value !== null) setValidRatio(value);
                    }}
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement />
                      <NumberFieldInput />
                      <NumberFieldIncrement />
                    </NumberFieldGroup>
                  </NumberField>
                </div>

                <div className="space-y-1.5">
                  <Label>
                    <T>Test ratio</T>
                  </Label>
                  <NumberField
                    value={testRatio}
                    min={0}
                    max={0.3}
                    step={0.05}
                    onValueChange={(value) => {
                      if (value !== null) setTestRatio(value);
                    }}
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement />
                      <NumberFieldInput />
                      <NumberFieldIncrement />
                    </NumberFieldGroup>
                  </NumberField>
                </div>

                <div className="space-y-1.5">
                  <Label>
                    <T>Max tool chars</T>
                  </Label>
                  <NumberField
                    value={maxToolOutputChars}
                    min={500}
                    max={64_000}
                    step={1000}
                    onValueChange={(value) => {
                      if (value !== null) setMaxToolOutputChars(value);
                    }}
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement />
                      <NumberFieldInput />
                      <NumberFieldIncrement />
                    </NumberFieldGroup>
                  </NumberField>
                </div>
              </div>

              <div className="space-y-2.5 rounded-lg border border-border/60 p-3">
                <div className="flex items-center gap-2">
                  <ShieldCheckIcon className="size-4 text-success" />
                  <span className="text-xs font-medium text-foreground">
                    <T>Secret redaction</T>
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  <T>
                    Always active: provider API keys, JWT/bearer tokens, PEM private keys, cloud
                    credentials, and URL credentials.
                  </T>
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <CheckboxRow
                    label={gt("Redact env secret assignments")}
                    checked={redactEnvAssignments}
                    onCheckedChange={setRedactEnvAssignments}
                  />
                  <CheckboxRow
                    label={gt("Redact home paths & usernames")}
                    checked={redactHomePaths}
                    onCheckedChange={setRedactHomePaths}
                  />
                  <CheckboxRow
                    label={gt("Redact email addresses")}
                    checked={redactEmails}
                    onCheckedChange={setRedactEmails}
                  />
                  <CheckboxRow
                    label={gt("Redact high-entropy tokens")}
                    checked={redactHighEntropy}
                    onCheckedChange={setRedactHighEntropy}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="training-custom-redaction-terms">
                    <T>Custom terms to redact</T>
                  </Label>
                  <Textarea
                    id="training-custom-redaction-terms"
                    rows={2}
                    value={customTermsText}
                    placeholder={gt("Internal company or client names, separated by commas")}
                    onChange={(event) => setCustomTermsText(event.target.value)}
                  />
                </div>
              </div>

              {capabilities && capabilities.storageRoots.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>
                      <T>Storage location</T>
                    </Label>
                    <Select
                      value={outputBaseDir}
                      onValueChange={(value) => setOutputBaseDir(value ?? DEFAULT_STORAGE)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value={DEFAULT_STORAGE}>
                          <T>
                            Default (
                            <Var>{formatTrainingBytesGb(capabilities.activeStorageFreeBytes)}</Var>{" "}
                            free)
                          </T>
                        </SelectItem>
                        {capabilities.storageRoots.map((root) => (
                          <SelectItem key={root.path} value={root.path}>
                            {root.label} ({formatTrainingBytesGb(root.freeBytes)})
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>
                      <T>Split seed</T>
                    </Label>
                    <NumberField
                      value={splitSeed}
                      min={0}
                      max={999_999}
                      onValueChange={(value) => {
                        if (value !== null) setSplitSeed(value);
                      }}
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement />
                        <NumberFieldInput />
                        <NumberFieldIncrement />
                      </NumberFieldGroup>
                    </NumberField>
                  </div>
                </div>
              ) : null}

              {previewError ? (
                <Alert variant="error">
                  <AlertTriangleIcon />
                  <AlertTitle>
                    <T>Preview failed</T>
                  </AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : preview !== null ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <PreviewStat
                  label={gt("Matched threads")}
                  value={`${preview.matchedThreadCount} (${preview.skippedThreadCount} skipped)`}
                />
                <PreviewStat
                  label={gt("Examples (T / V / Test)")}
                  value={`${preview.trainExamples} / ${preview.validExamples} / ${preview.testExamples}`}
                />
                <PreviewStat
                  label={gt("Est. tokens")}
                  value={formatTrainingTokenCount(preview.estimatedTokens)}
                />
                <PreviewStat
                  label={gt("Redactions")}
                  value={`${preview.redactionAudit.totalRedactions} (${preview.redactionAudit.affectedThreadCount} threads)`}
                />
              </div>

              {preview.warnings.length > 0 ? (
                <Alert variant="warning">
                  <AlertTriangleIcon />
                  <AlertTitle>
                    <T>Extraction warnings</T>
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 ps-4 text-xs">
                      {preview.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    <T>Redaction audit</T>
                  </span>
                  <Badge variant="outline">v{preview.redactionAudit.redactorVersion}</Badge>
                </div>

                {nonZeroRedactionCategories.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {nonZeroRedactionCategories.map(([category, count]) => (
                      <Badge key={category} variant="secondary">
                        {messages(REDACTION_CATEGORY_LABELS[category])}: {count}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    <T>No secrets or sensitive values matched in the selected transcripts.</T>
                  </p>
                )}

                {preview.redactionAudit.sampleFindings.length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="overflow-hidden rounded-md border border-border/50">
                      <ScrollArea className="max-h-48">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>
                                <T>Category</T>
                              </TableHead>
                              <TableHead>
                                <T>Source</T>
                              </TableHead>
                              <TableHead>
                                <T>Redacted snippet</T>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {preview.redactionAudit.sampleFindings.map((finding) => (
                              <TableRow
                                key={`${finding.threadId}:${finding.ruleId}:${finding.sourceKind}:${finding.matchDigestPrefix}:${finding.redactedSnippet}`}
                              >
                                <TableCell>
                                  {messages(REDACTION_CATEGORY_LABELS[finding.category])}
                                </TableCell>
                                <TableCell>
                                  <span className="font-mono">{finding.sourceKind}</span>
                                </TableCell>
                                <TableCell>
                                  <span className="font-mono whitespace-normal break-all">
                                    {finding.redactedSnippet}
                                  </span>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </ScrollArea>
                    </div>
                    {preview.redactionAudit.findingsTruncated ? (
                      <p className="text-xs text-muted-foreground">
                        <T>Showing the first 100 representative findings.</T>
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">
                  <T>Redacted sample records</T>
                </div>
                <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20">
                  <ScrollArea className="max-h-56">
                    <div className="p-3">
                      {preview.objective === "sft" ? (
                        preview.sampleSftRecords && preview.sampleSftRecords.length > 0 ? (
                          <div className="space-y-3">
                            {preview.sampleSftRecords.slice(0, 3).map((record, recordIndex) => (
                              <div
                                key={`${record.messages.length}:${record.messages[0]?.role ?? ""}:${record.messages[0]?.content?.slice(0, 40) ?? ""}:${record.messages[record.messages.length - 1]?.content?.slice(0, 40) ?? ""}`}
                                className="space-y-1.5 rounded-md border border-border/50 bg-background/70 p-2.5"
                              >
                                <div className="text-2xs font-medium text-muted-foreground">
                                  <T>
                                    Example <Var>{recordIndex + 1}</Var> (
                                    <Var>{record.messages.length}</Var> messages)
                                  </T>
                                </div>
                                {record.messages.slice(0, 4).map((msgItem) => (
                                  <div
                                    key={`${msgItem.role}:${msgItem.tool_call_id ?? ""}:${msgItem.name ?? ""}:${msgItem.content?.slice(0, 48) ?? ""}`}
                                    className="space-y-0.5 text-xs"
                                  >
                                    <Badge variant="outline" size="sm">
                                      {msgItem.role}
                                    </Badge>
                                    <p className="line-clamp-3 font-mono text-2xs whitespace-pre-wrap break-words text-foreground">
                                      {msgItem.content ??
                                        (msgItem.tool_calls
                                          ? gt(
                                              "{count, plural, one {[{count} tool call]} other {[{count} tool calls]}}",
                                              { count: msgItem.tool_calls.length },
                                            )
                                          : "")}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            <T>No SFT sample records produced by these filters.</T>
                          </p>
                        )
                      ) : preview.sampleDpoRecords && preview.sampleDpoRecords.length > 0 ? (
                        <div className="space-y-3">
                          {preview.sampleDpoRecords.slice(0, 3).map((record) => (
                            <div
                              key={`${record.metadata.sourceThreadId}:${record.metadata.chosenThreadId}:${record.metadata.rejectedThreadId}:${record.metadata.divergenceRunOrdinal}`}
                              className="space-y-1.5 rounded-md border border-border/50 bg-background/70 p-2.5 text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" size="sm">
                                  {record.metadata.source}
                                </Badge>
                                <Badge variant="secondary" size="sm">
                                  {record.metadata.confidence}
                                </Badge>
                              </div>
                              <div className="font-mono text-2xs text-muted-foreground">
                                <T>
                                  Prompt: <Var>{record.prompt.length}</Var> msgs | Chosen:{" "}
                                  <Var>{record.chosen.length}</Var> | Rejected:{" "}
                                  <Var>{record.rejected.length}</Var>
                                </T>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          <T>No DPO preference pairs found for these filters.</T>
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button
                disabled={!canPreview || previewing || name.trim().length === 0}
                onClick={() => void handleRunPreview()}
              >
                {previewing ? <T>Scanning & redacting...</T> : <T>Preview & Audit Redaction</T>}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeftIcon />
                <T>Back to Filters</T>
              </Button>
              <Button
                disabled={
                  !canCreate ||
                  creating ||
                  preview === null ||
                  preview.totalExamples === 0 ||
                  name.trim().length === 0
                }
                onClick={() => void handleCreate()}
              >
                {creating ? <T>Creating...</T> : <T>Create Dataset</T>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ToggleRow({
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

function CheckboxRow({
  label,
  checked,
  onCheckedChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <span>{label}</span>
    </label>
  );
}

function PreviewStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}
