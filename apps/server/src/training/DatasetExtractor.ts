// @effect-diagnostics nodeBuiltinImport:off -- pure synchronous SHA-256 hashing for split and provenance
import * as NodeCrypto from "node:crypto";

import {
  type RedactionOptions,
  ThreadId,
  type TrainingChatMessage,
  type TrainingDatasetFilter,
  type TrainingDatasetId,
  type TrainingDatasetPreview,
  type TrainingDatasetSummary,
  type TrainingDpoRecord,
  type TrainingObjective,
  type TrainingSftRecord,
  type TrainingToolCall,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { WITHHELD } from "../scheduledTasks/webhookUrlToken.ts";

import * as SecretRedactor from "./SecretRedactor.ts";

export class DatasetExtractionError extends Schema.TaggedError<DatasetExtractionError>()(
  "DatasetExtractionError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Dataset extraction (${this.operation}) failed: ${this.reason}`;
  }
}

interface ThreadProjectionRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly default_provider: string;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly payload_json: string;
}

interface RunProjectionRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly ordinal: number | bigint;
  readonly status: string;
  readonly payload_json: string;
}

interface RunAttemptProjectionRow {
  readonly attempt_id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly attempt_ordinal: number | bigint;
  readonly root_node_id: string;
  readonly provider_turn_id: string | null;
  readonly status: string;
  readonly payload_json: string;
}

interface MessageProjectionRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly role: string;
  readonly streaming: number | bigint;
  readonly payload_json: string;
}

interface TurnItemProjectionRow {
  readonly turn_item_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly provider_turn_id: string | null;
  readonly type: string;
  readonly status: string;
  readonly payload_json: string;
}

interface CheckpointProjectionRow {
  readonly checkpoint_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly payload_json: string;
}

interface ContextTransferProjectionRow {
  readonly source_thread_id: string;
  readonly target_thread_id: string;
  readonly payload_json: string;
}

interface ParsedThreadPayload {
  readonly providerInstanceId?: string;
  readonly modelSelection?: { readonly model?: string; readonly instanceId?: string };
  readonly tags?: ReadonlyArray<string>;
  readonly settledAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly lineage?: { readonly relationshipToParent?: string };
  readonly delegatedFrom?: unknown;
  readonly forkedFrom?: {
    readonly type?: string;
    readonly threadId?: string;
    readonly runId?: string;
  } | null;
}

const EXCLUDED_TURN_ITEM_TYPES: ReadonlySet<string> = new Set([
  "secret_request",
  "link_request",
  "feedback_request",
  "approval_request",
  "system_notice",
  "notification",
  "run_interrupt_request",
  "run_interrupt_result",
  "error",
  "compaction",
  "handoff",
  "fork",
  "thread_created",
  "subagent",
  "todo_list",
  "user_input_request",
  "web_search",
]);

const SYNTHETIC_SENDER_PREFIX = /^\[Sent by [^\]]+\]\n+/;

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function withoutWebhookSigningSecret(toolInput: unknown): unknown {
  const input = asRecord(toolInput);
  const schedule = asRecord(input?.schedule);
  const signature = asRecord(schedule?.signature);
  if (typeof signature?.secret !== "string") return toolInput;
  return { ...input, schedule: { ...schedule, signature: { ...signature, secret: WITHHELD } } };
}

function deterministicClip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n...[clipped]...\n";
  if (maxChars <= marker.length + 16) {
    return value.slice(0, maxChars);
  }
  const budget = maxChars - marker.length;
  const head = Math.ceil(budget * 0.6);
  const tail = Math.floor(budget * 0.4);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function stripSyntheticSenderWrapper(text: string): string {
  return text.replace(SYNTHETIC_SENDER_PREFIX, "");
}

function sanitizeDynamicToolOutput(value: unknown, maxChars: number): string {
  const stripImages = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(stripImages);
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (
        record.type === "image" ||
        record.type === "image_url" ||
        typeof record.dataUrl === "string"
      ) {
        return "[image omitted]";
      }
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) {
        next[k] = stripImages(v);
      }
      return next;
    }
    return node;
  };
  const cleaned = stripImages(value);
  const serialized = typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned ?? null);
  return deterministicClip(serialized, maxChars);
}

function estimateTokens(value: unknown): number {
  const chars = JSON.stringify(value).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function threadSplitBucket(
  seed: number,
  threadId: string,
  validRatio: number,
  testRatio: number,
): "train" | "valid" | "test" {
  const hash = NodeCrypto.createHash("sha256").update(`${seed}:${threadId}`).digest();
  const unit = hash.readUInt32BE(0) / 0x1_0000_0000;
  if (unit < testRatio) return "test";
  if (unit < testRatio + validRatio) return "valid";
  return "train";
}

function normalizePromptSimilarity(a: string, b: string): number {
  const tokenize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  if (tokensA.join(" ") === tokensB.join(" ")) return 1;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type CheckpointFileSummary = {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
};

interface BuiltToolTurn {
  readonly toolName: string;
  readonly call: TrainingToolCall;
  readonly result: TrainingChatMessage;
}

function resolveMessageText(
  payload: Record<string, unknown>,
  messagesById: ReadonlyMap<string, string>,
): string {
  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  if (payload.textOmitted === true && messageId !== undefined) {
    return messagesById.get(messageId) ?? "";
  }
  if (typeof payload.text === "string" && payload.text.length > 0) {
    return payload.text;
  }
  return messageId !== undefined ? (messagesById.get(messageId) ?? "") : "";
}

function formatFileSearchEntry(entry: unknown): string {
  if (entry === null || typeof entry !== "object") return String(entry);
  const rec = entry as Record<string, unknown>;
  const file =
    typeof rec.path === "string" ? rec.path : typeof rec.file === "string" ? rec.file : "";
  const line = typeof rec.line === "number" ? `:${rec.line}` : "";
  return `${file}${line}`;
}

function buildToolTurnFromItem(
  rowType: string,
  payload: Record<string, unknown>,
  checkpointsById: ReadonlyMap<string, ReadonlyArray<CheckpointFileSummary>>,
  filter: TrainingDatasetFilter,
  callId: string,
): BuiltToolTurn | null {
  if (!filter.includeToolCalls) return null;

  switch (rowType) {
    case "command_execution": {
      const command = typeof payload.input === "string" ? payload.input : "";
      const output = typeof payload.output === "string" ? payload.output : "";
      const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
      return {
        toolName: "shell",
        call: {
          id: callId,
          type: "function",
          function: { name: "shell", arguments: JSON.stringify({ command }) },
        },
        result: {
          role: "tool",
          tool_call_id: callId,
          name: "shell",
          content: JSON.stringify({
            exitCode,
            output: deterministicClip(output, filter.maxToolOutputChars),
          }),
        },
      };
    }

    case "file_change": {
      const fileName = typeof payload.fileName === "string" ? payload.fileName : "unknown";
      const additions = typeof payload.additions === "number" ? payload.additions : undefined;
      const deletions = typeof payload.deletions === "number" ? payload.deletions : undefined;
      const diffBody =
        typeof payload.diffStr === "string" && payload.diffStr.length > 0
          ? payload.diffStr
          : JSON.stringify({
              oldStr: typeof payload.oldStr === "string" ? payload.oldStr : undefined,
              newStr: typeof payload.newStr === "string" ? payload.newStr : undefined,
            });
      return {
        toolName: "edit_file",
        call: {
          id: callId,
          type: "function",
          function: {
            name: "edit_file",
            arguments: JSON.stringify({
              path: fileName,
              ...(additions === undefined ? {} : { additions }),
              ...(deletions === undefined ? {} : { deletions }),
            }),
          },
        },
        result: {
          role: "tool",
          tool_call_id: callId,
          name: "edit_file",
          content: deterministicClip(diffBody, filter.maxToolOutputChars),
        },
      };
    }

    case "file_search": {
      const pattern = typeof payload.pattern === "string" ? payload.pattern : "";
      const results = Array.isArray(payload.results) ? payload.results : [];
      const compactResults = results
        .map(formatFileSearchEntry)
        .filter((line) => line.length > 0)
        .join("\n");
      return {
        toolName: "search_files",
        call: {
          id: callId,
          type: "function",
          function: { name: "search_files", arguments: JSON.stringify({ pattern }) },
        },
        result: {
          role: "tool",
          tool_call_id: callId,
          name: "search_files",
          content: deterministicClip(compactResults, filter.maxToolOutputChars),
        },
      };
    }

    case "dynamic_tool": {
      const toolName =
        typeof payload.toolName === "string" && payload.toolName.trim().length > 0
          ? payload.toolName.trim()
          : "tool";
      const sanitizedInput = withoutWebhookSigningSecret(payload.input ?? {});
      return {
        toolName,
        call: {
          id: callId,
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(sanitizedInput) },
        },
        result: {
          role: "tool",
          tool_call_id: callId,
          name: toolName,
          content: sanitizeDynamicToolOutput(payload.output, filter.maxToolOutputChars),
        },
      };
    }

    case "checkpoint": {
      if (!filter.includeCheckpointDiffs) return null;
      const checkpointId = typeof payload.checkpointId === "string" ? payload.checkpointId : "";
      const files =
        payload.filesOmitted === true && checkpointId.length > 0
          ? (checkpointsById.get(checkpointId) ?? [])
          : Array.isArray(payload.files)
            ? (payload.files as ReadonlyArray<CheckpointFileSummary>)
            : [];
      if (files.length === 0) return null;
      return {
        toolName: "checkpoint_summary",
        call: {
          id: callId,
          type: "function",
          function: { name: "checkpoint_summary", arguments: JSON.stringify({ checkpointId }) },
        },
        result: {
          role: "tool",
          tool_call_id: callId,
          name: "checkpoint_summary",
          content: deterministicClip(
            JSON.stringify(files.slice(0, 200)),
            filter.maxToolOutputChars,
          ),
        },
      };
    }

    default:
      return null;
  }
}

function buildMessagesForItems(input: {
  readonly items: ReadonlyArray<TurnItemProjectionRow>;
  readonly messagesById: ReadonlyMap<string, string>;
  readonly checkpointsById: ReadonlyMap<string, ReadonlyArray<CheckpointFileSummary>>;
  readonly filter: TrainingDatasetFilter;
}): { readonly messages: Array<TrainingChatMessage>; readonly usedTools: Set<string> } {
  const messages: Array<TrainingChatMessage> = [];
  const usedTools = new Set<string>();
  let pendingReasoning: Array<string> = [];
  let pendingToolCalls: Array<TrainingToolCall> = [];
  let pendingToolResults: Array<TrainingChatMessage> = [];
  let toolCounter = 0;

  const flushToolBatch = () => {
    if (pendingToolCalls.length === 0) return;
    const prefix =
      input.filter.includeReasoning && pendingReasoning.length > 0
        ? `<think>\n${pendingReasoning.join("\n")}\n</think>`
        : null;
    pendingReasoning = [];
    messages.push({ role: "assistant", content: prefix, tool_calls: pendingToolCalls });
    messages.push(...pendingToolResults);
    pendingToolCalls = [];
    pendingToolResults = [];
  };

  const pushAssistantText = (rawText: string) => {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) return;
    flushToolBatch();

    const reasoningPrefix =
      input.filter.includeReasoning && pendingReasoning.length > 0
        ? `<think>\n${pendingReasoning.join("\n")}\n</think>\n\n`
        : "";
    pendingReasoning = [];
    const content = `${reasoningPrefix}${trimmed}`;

    const last = messages.at(-1);
    if (last !== undefined && last.role === "assistant" && last.tool_calls === undefined) {
      messages[messages.length - 1] = {
        ...last,
        content:
          last.content === null || last.content.length === 0
            ? content
            : `${last.content}\n\n${content}`,
      };
    } else {
      messages.push({ role: "assistant", content });
    }
  };

  for (const row of input.items) {
    if (EXCLUDED_TURN_ITEM_TYPES.has(row.type)) continue;
    const payload = safeJsonParse(row.payload_json);

    if (row.type === "user_message") {
      if (payload.idleCompaction !== undefined || payload.workflowScript === true) continue;
      const cleaned = stripSyntheticSenderWrapper(
        resolveMessageText(payload, input.messagesById),
      ).trim();
      if (cleaned.length === 0 || cleaned.toLowerCase() === "/compact") continue;
      flushToolBatch();
      pendingReasoning = [];
      messages.push({ role: "user", content: cleaned });
      continue;
    }

    if (row.type === "reasoning") {
      if (!input.filter.includeReasoning || payload.streaming === true) continue;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text.length > 0) pendingReasoning.push(text);
      continue;
    }

    if (row.type === "assistant_message") {
      if (payload.streaming === true) continue;
      pushAssistantText(resolveMessageText(payload, input.messagesById));
      continue;
    }

    if (row.type === "proposed_plan") {
      if (row.status === "superseded" || payload.streaming === true) continue;
      const markdown = typeof payload.markdown === "string" ? payload.markdown.trim() : "";
      if (markdown.length > 0) pushAssistantText(markdown);
      continue;
    }

    const toolTurn = buildToolTurnFromItem(
      row.type,
      payload,
      input.checkpointsById,
      input.filter,
      `call_${toolCounter + 1}`,
    );
    if (toolTurn !== null) {
      toolCounter += 1;
      usedTools.add(toolTurn.toolName);
      pendingToolCalls.push(toolTurn.call);
      pendingToolResults.push(toolTurn.result);
    }
  }

  flushToolBatch();
  return { messages, usedTools };
}

function buildToolDefinitions(usedTools: ReadonlySet<string>): ReadonlyArray<Schema.Json> {
  const definitions: Array<Schema.Json> = [];
  for (const name of [...usedTools].toSorted()) {
    if (name === "shell") {
      definitions.push({
        type: "function",
        function: {
          name: "shell",
          description: "Execute a shell command in the workspace.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      });
    } else if (name === "edit_file") {
      definitions.push({
        type: "function",
        function: {
          name: "edit_file",
          description: "Modify a file in the workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              additions: { type: "integer" },
              deletions: { type: "integer" },
            },
            required: ["path"],
          },
        },
      });
    } else if (name === "search_files") {
      definitions.push({
        type: "function",
        function: {
          name: "search_files",
          description: "Search files in the workspace.",
          parameters: {
            type: "object",
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
          },
        },
      });
    } else {
      definitions.push({
        type: "function",
        function: {
          name,
          description: `Invoke tool ${name}.`,
          parameters: { type: "object", additionalProperties: true },
        },
      });
    }
  }
  return definitions;
}

function firstUserText(messages: ReadonlyArray<TrainingChatMessage>): string {
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

function hasAssistantOutput(messages: ReadonlyArray<TrainingChatMessage>): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      ((message.content !== null && message.content.trim().length > 0) ||
        (message.tool_calls !== undefined && message.tool_calls.length > 0)),
  );
}

function isSettledThread(payload: ParsedThreadPayload): boolean {
  return payload.settledAt != null || payload.settledOverride === "settled";
}

interface ThreadBundleData {
  readonly runs: ReadonlyArray<RunProjectionRow>;
  readonly attempts: ReadonlyArray<RunAttemptProjectionRow>;
  readonly items: ReadonlyArray<TurnItemProjectionRow>;
  readonly messagesById: ReadonlyMap<string, string>;
  readonly checkpointsById: ReadonlyMap<string, ReadonlyArray<CheckpointFileSummary>>;
}

interface ThreadBundleEntry {
  readonly row: ThreadProjectionRow;
  readonly payload: ParsedThreadPayload;
  readonly bundle: ThreadBundleData;
}

interface ForkLink {
  readonly parentThreadId: string;
  readonly forkThreadId: string;
  readonly divergenceRunId?: string;
}

function filterCandidateThreads(
  allThreads: ReadonlyArray<ThreadProjectionRow>,
  filter: TrainingDatasetFilter,
): {
  readonly candidates: Array<{
    readonly row: ThreadProjectionRow;
    readonly payload: ParsedThreadPayload;
  }>;
  readonly skippedCount: number;
} {
  const allowSet =
    filter.threadIds !== undefined && filter.threadIds.length > 0
      ? new Set<string>(filter.threadIds)
      : null;
  const excludeSet = new Set<string>(filter.excludeThreadIds ?? []);
  const projectSet =
    filter.projectIds !== undefined && filter.projectIds.length > 0
      ? new Set<string>(filter.projectIds)
      : null;
  const providerSet =
    filter.providerInstanceIds !== undefined && filter.providerInstanceIds.length > 0
      ? new Set<string>(filter.providerInstanceIds)
      : null;
  const modelPatterns = filter.modelIds?.map((m) => m.toLowerCase()) ?? null;
  const requiredTags = filter.tags ?? null;

  const candidates: Array<{
    readonly row: ThreadProjectionRow;
    readonly payload: ParsedThreadPayload;
  }> = [];
  let skippedCount = 0;

  for (const row of allThreads) {
    if (allowSet !== null && !allowSet.has(row.thread_id)) continue;
    if (excludeSet.has(row.thread_id)) {
      skippedCount += 1;
      continue;
    }
    if (projectSet !== null && !projectSet.has(row.project_id)) continue;
    if (!filter.includeArchived && row.archived_at !== null) {
      skippedCount += 1;
      continue;
    }
    if (filter.createdAfter !== undefined && row.created_at < filter.createdAfter) continue;
    if (filter.createdBefore !== undefined && row.created_at > filter.createdBefore) continue;

    const payload = safeJsonParse(row.payload_json) as ParsedThreadPayload;
    const providerId = payload.providerInstanceId ?? row.default_provider;
    if (providerSet !== null && !providerSet.has(providerId)) continue;

    if (modelPatterns !== null && modelPatterns.length > 0) {
      const modelSlug = (payload.modelSelection?.model ?? "").toLowerCase();
      if (!modelPatterns.some((pattern) => modelSlug.includes(pattern))) continue;
    }

    if (requiredTags !== null && requiredTags.length > 0) {
      const threadTags = new Set(payload.tags ?? []);
      if (!requiredTags.some((tag) => threadTags.has(tag))) continue;
    }

    if (filter.settledOnly && !isSettledThread(payload)) {
      skippedCount += 1;
      continue;
    }

    const isSubagent =
      payload.lineage?.relationshipToParent === "subagent" || payload.delegatedFrom != null;
    if (!filter.includeSubagents && isSubagent) {
      skippedCount += 1;
      continue;
    }

    candidates.push({ row, payload });
  }

  return { candidates, skippedCount };
}

function groupByRunId<T extends { readonly run_id: string | null }>(
  rows: ReadonlyArray<T>,
): Map<string, Array<T>> {
  const map = new Map<string, Array<T>>();
  for (const row of rows) {
    if (row.run_id === null) continue;
    const list = map.get(row.run_id);
    if (list === undefined) map.set(row.run_id, [row]);
    else list.push(row);
  }
  return map;
}

function collectRollbackDpoRecords(
  threadId: ThreadId,
  bundle: ThreadBundleData,
  itemsByRun: ReadonlyMap<string, ReadonlyArray<TurnItemProjectionRow>>,
  filter: TrainingDatasetFilter,
): Array<TrainingDpoRecord> {
  const records: Array<TrainingDpoRecord> = [];
  let index = 0;

  while (index < bundle.runs.length) {
    if (bundle.runs[index]!.status !== "rolled_back") {
      index += 1;
      continue;
    }
    const startIdx = index;
    while (index < bundle.runs.length && bundle.runs[index]!.status === "rolled_back") {
      index += 1;
    }
    const rolledBackRuns = bundle.runs.slice(startIdx, index);
    const replacement = bundle.runs[index];
    if (replacement === undefined || replacement.status !== "completed") continue;

    const prefixItems = bundle.runs
      .slice(0, startIdx)
      .filter((run) => run.status === "completed")
      .flatMap((run) => itemsByRun.get(run.run_id) ?? []);
    const rejectedItems = rolledBackRuns.flatMap((run) => itemsByRun.get(run.run_id) ?? []);
    const chosenItems = itemsByRun.get(replacement.run_id) ?? [];

    const prefixMessages = buildMessagesForItems({
      items: prefixItems,
      messagesById: bundle.messagesById,
      checkpointsById: bundle.checkpointsById,
      filter,
    }).messages;
    const rejectedAll = buildMessagesForItems({
      items: rejectedItems,
      messagesById: bundle.messagesById,
      checkpointsById: bundle.checkpointsById,
      filter,
    }).messages;
    const chosenAll = buildMessagesForItems({
      items: chosenItems,
      messagesById: bundle.messagesById,
      checkpointsById: bundle.checkpointsById,
      filter,
    }).messages;

    const similarity = normalizePromptSimilarity(
      firstUserText(rejectedAll),
      firstUserText(chosenAll),
    );
    if (similarity < 0.85) continue;

    const promptMessages: Array<TrainingChatMessage> = [
      ...prefixMessages,
      ...(chosenAll[0]?.role === "user" ? [chosenAll[0]] : []),
    ];
    const chosenResponse = chosenAll[0]?.role === "user" ? chosenAll.slice(1) : chosenAll;
    const rejectedResponse = rejectedAll[0]?.role === "user" ? rejectedAll.slice(1) : rejectedAll;

    if (hasAssistantOutput(chosenResponse) && hasAssistantOutput(rejectedResponse)) {
      records.push({
        prompt: promptMessages,
        chosen: chosenResponse,
        rejected: rejectedResponse,
        metadata: {
          source: "rollback",
          sourceThreadId: threadId,
          chosenThreadId: threadId,
          rejectedThreadId: threadId,
          divergenceRunOrdinal: Number(rolledBackRuns[0]!.ordinal),
          confidence: similarity >= 0.99 ? "high" : "medium",
        },
      });
    }
  }

  return records;
}

function collectRetryAttemptDpoRecords(
  threadId: ThreadId,
  bundle: ThreadBundleData,
  itemsByRun: ReadonlyMap<string, ReadonlyArray<TurnItemProjectionRow>>,
  filter: TrainingDatasetFilter,
): Array<TrainingDpoRecord> {
  const records: Array<TrainingDpoRecord> = [];
  const attemptsByRun = groupByRunId(bundle.attempts);

  for (let runIdx = 0; runIdx < bundle.runs.length; runIdx += 1) {
    const run = bundle.runs[runIdx]!;
    if (run.status !== "completed") continue;
    const attempts = attemptsByRun.get(run.run_id) ?? [];
    if (attempts.length < 2) continue;

    const winning = [...attempts].toReversed().find((attempt) => {
      if (attempt.status !== "completed") return false;
      const payload = safeJsonParse(attempt.payload_json);
      return payload.reason === "retry" || payload.reason === "steering_restart";
    });
    if (winning === undefined) continue;

    const failedAttempts = attempts.filter(
      (attempt) =>
        Number(attempt.attempt_ordinal) < Number(winning.attempt_ordinal) &&
        (attempt.status === "failed" ||
          attempt.status === "interrupted" ||
          attempt.status === "superseded"),
    );
    if (failedAttempts.length === 0) continue;

    const runItems = itemsByRun.get(run.run_id) ?? [];
    const itemsForAttempt = (attempt: RunAttemptProjectionRow) =>
      runItems.filter(
        (item) =>
          item.type !== "user_message" &&
          (item.node_id === attempt.root_node_id ||
            (attempt.provider_turn_id !== null &&
              item.provider_turn_id === attempt.provider_turn_id)),
      );

    const chosenMsgs = buildMessagesForItems({
      items: itemsForAttempt(winning),
      messagesById: bundle.messagesById,
      checkpointsById: bundle.checkpointsById,
      filter,
    }).messages;
    if (!hasAssistantOutput(chosenMsgs)) continue;

    const prefixItems = bundle.runs
      .slice(0, runIdx)
      .filter((r) => r.status === "completed")
      .flatMap((r) => itemsByRun.get(r.run_id) ?? []);
    const runUserItems = runItems.filter((item) => item.type === "user_message");
    const promptMessages = buildMessagesForItems({
      items: [...prefixItems, ...runUserItems],
      messagesById: bundle.messagesById,
      checkpointsById: bundle.checkpointsById,
      filter,
    }).messages;

    for (const losing of failedAttempts) {
      const rejectedMsgs = buildMessagesForItems({
        items: itemsForAttempt(losing),
        messagesById: bundle.messagesById,
        checkpointsById: bundle.checkpointsById,
        filter,
      }).messages;
      if (!hasAssistantOutput(rejectedMsgs)) continue;

      records.push({
        prompt: promptMessages,
        chosen: chosenMsgs,
        rejected: rejectedMsgs,
        metadata: {
          source: "retry_attempt",
          sourceThreadId: threadId,
          chosenThreadId: threadId,
          rejectedThreadId: threadId,
          divergenceRunOrdinal: Number(run.ordinal),
          confidence: "high",
        },
      });
    }
  }

  return records;
}

function scoreForkBranch(
  payload: ParsedThreadPayload,
  runs: ReadonlyArray<RunProjectionRow>,
): number {
  let score = 0;
  if (isSettledThread(payload)) score += 3;
  if (runs.at(-1)?.status === "completed") score += 2;
  if (
    runs.some(
      (r) => r.status === "failed" || r.status === "interrupted" || r.status === "rolled_back",
    )
  ) {
    score -= 2;
  }
  return score;
}

function collectForkLinks(
  bundlesByThreadId: ReadonlyMap<string, ThreadBundleEntry>,
  transferRows: ReadonlyArray<ContextTransferProjectionRow>,
): Array<ForkLink> {
  const forkLinks: Array<ForkLink> = [];
  const seenForkPairs = new Set<string>();

  for (const { row, payload } of bundlesByThreadId.values()) {
    if (payload.forkedFrom?.type !== "run" || payload.forkedFrom.threadId === undefined) continue;
    const key = `${payload.forkedFrom.threadId}->${row.thread_id}`;
    if (seenForkPairs.has(key)) continue;
    seenForkPairs.add(key);
    forkLinks.push({
      parentThreadId: payload.forkedFrom.threadId,
      forkThreadId: row.thread_id,
      ...(payload.forkedFrom.runId === undefined
        ? {}
        : { divergenceRunId: payload.forkedFrom.runId }),
    });
  }

  for (const transfer of transferRows) {
    const key = `${transfer.source_thread_id}->${transfer.target_thread_id}`;
    if (seenForkPairs.has(key)) continue;
    const payload = safeJsonParse(transfer.payload_json);
    const sourcePoint =
      payload.sourcePoint !== null && typeof payload.sourcePoint === "object"
        ? (payload.sourcePoint as Record<string, unknown>)
        : {};
    seenForkPairs.add(key);
    forkLinks.push({
      parentThreadId: transfer.source_thread_id,
      forkThreadId: transfer.target_thread_id,
      ...(typeof sourcePoint.runId === "string" ? { divergenceRunId: sourcePoint.runId } : {}),
    });
  }

  return forkLinks;
}

function collectForkDpoRecords(
  bundlesByThreadId: ReadonlyMap<string, ThreadBundleEntry>,
  forkLinks: ReadonlyArray<ForkLink>,
  filter: TrainingDatasetFilter,
): Array<TrainingDpoRecord> {
  const records: Array<TrainingDpoRecord> = [];
  const itemsForRuns = (entry: ThreadBundleEntry, runs: ReadonlyArray<RunProjectionRow>) => {
    const ids = new Set(runs.map((r) => r.run_id));
    return entry.bundle.items.filter((item) => item.run_id !== null && ids.has(item.run_id));
  };

  for (const link of forkLinks) {
    const parentEntry = bundlesByThreadId.get(link.parentThreadId);
    const forkEntry = bundlesByThreadId.get(link.forkThreadId);
    if (parentEntry === undefined || forkEntry === undefined) continue;

    const divergenceIdx =
      link.divergenceRunId === undefined
        ? -1
        : parentEntry.bundle.runs.findIndex((run) => run.run_id === link.divergenceRunId);
    const prefixRuns =
      divergenceIdx >= 0 ? parentEntry.bundle.runs.slice(0, divergenceIdx + 1) : [];
    const parentPostRuns =
      divergenceIdx >= 0
        ? parentEntry.bundle.runs.slice(divergenceIdx + 1)
        : parentEntry.bundle.runs;
    const forkPostRuns = forkEntry.bundle.runs;

    const parentPostMsgs = buildMessagesForItems({
      items: itemsForRuns(parentEntry, parentPostRuns),
      messagesById: parentEntry.bundle.messagesById,
      checkpointsById: parentEntry.bundle.checkpointsById,
      filter,
    }).messages;
    const forkPostMsgs = buildMessagesForItems({
      items: itemsForRuns(forkEntry, forkPostRuns),
      messagesById: forkEntry.bundle.messagesById,
      checkpointsById: forkEntry.bundle.checkpointsById,
      filter,
    }).messages;

    if (!hasAssistantOutput(parentPostMsgs) || !hasAssistantOutput(forkPostMsgs)) continue;

    const parentScore = scoreForkBranch(parentEntry.payload, parentPostRuns);
    const forkScore = scoreForkBranch(forkEntry.payload, forkPostRuns);
    if (parentScore === forkScore) continue;

    const forkPreferred = forkScore > parentScore;
    const promptMessages = buildMessagesForItems({
      items: itemsForRuns(parentEntry, prefixRuns),
      messagesById: parentEntry.bundle.messagesById,
      checkpointsById: parentEntry.bundle.checkpointsById,
      filter,
    }).messages;

    records.push({
      prompt: promptMessages,
      chosen: forkPreferred ? forkPostMsgs : parentPostMsgs,
      rejected: forkPreferred ? parentPostMsgs : forkPostMsgs,
      metadata: {
        source: "fork",
        sourceThreadId: ThreadId.make(link.parentThreadId),
        chosenThreadId: ThreadId.make(forkPreferred ? link.forkThreadId : link.parentThreadId),
        rejectedThreadId: ThreadId.make(forkPreferred ? link.parentThreadId : link.forkThreadId),
        divergenceRunOrdinal:
          divergenceIdx >= 0 ? Number(parentEntry.bundle.runs[divergenceIdx]!.ordinal) : 0,
        confidence: Math.abs(parentScore - forkScore) >= 3 ? "high" : "medium",
      },
    });
  }

  return records;
}

function buildCorpusWarnings(
  filter: TrainingDatasetFilter,
  totalExamples: number,
  trainCount: number,
  validCount: number,
): Array<string> {
  const warnings: Array<string> = [];
  if (totalExamples === 0) {
    warnings.push("No training examples matched the current filter criteria.");
  } else if (trainCount < 4) {
    warnings.push(
      `Train split has only ${trainCount} example(s); mlx_lm.lora requires trainCount >= batchSize.`,
    );
  }
  if (filter.split.validRatio > 0 && validCount === 0 && totalExamples > 0) {
    warnings.push(
      "Validation split is empty due to small thread count; training will run with valBatches = 0.",
    );
  }
  return warnings;
}

const encodePrettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const parseDpoJsonlToSft = (raw: string): ReadonlyArray<TrainingSftRecord> => {
  const records: Array<TrainingSftRecord> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = JSON.parse(trimmed) as TrainingDpoRecord;
    records.push({
      messages: [...parsed.prompt, ...parsed.chosen],
    });
  }
  return records;
};

export class DatasetExtractor extends Context.Service<
  DatasetExtractor,
  {
    readonly preview: (input: {
      readonly objective: TrainingObjective;
      readonly filter: TrainingDatasetFilter;
      readonly redactionOptions: RedactionOptions;
    }) => Effect.Effect<TrainingDatasetPreview, DatasetExtractionError>;
    readonly materialize: (input: {
      readonly datasetId: TrainingDatasetId;
      readonly name: string;
      readonly objective: TrainingObjective;
      readonly filter: TrainingDatasetFilter;
      readonly redactionOptions: RedactionOptions;
      readonly outputDir: string;
    }) => Effect.Effect<TrainingDatasetSummary, DatasetExtractionError>;
    readonly materializeSftFromDpo: (input: {
      readonly sourceDataset: TrainingDatasetSummary;
      readonly targetDatasetId: TrainingDatasetId;
      readonly targetName: string;
      readonly outputDir: string;
    }) => Effect.Effect<TrainingDatasetSummary, DatasetExtractionError>;
  }
>()("t3/training/DatasetExtractor") {}

interface ExtractedCorpus {
  readonly matchedThreadIds: ReadonlyArray<ThreadId>;
  readonly skippedThreadCount: number;
  readonly trainSft: ReadonlyArray<TrainingSftRecord>;
  readonly validSft: ReadonlyArray<TrainingSftRecord>;
  readonly testSft: ReadonlyArray<TrainingSftRecord>;
  readonly trainDpo: ReadonlyArray<TrainingDpoRecord>;
  readonly validDpo: ReadonlyArray<TrainingDpoRecord>;
  readonly testDpo: ReadonlyArray<TrainingDpoRecord>;
  readonly estimatedTokens: number;
  readonly redactionAudit: TrainingDatasetPreview["redactionAudit"];
  readonly warnings: ReadonlyArray<string>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const redactor = yield* SecretRedactor.SecretRedactor;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const loadThreadBundle = Effect.fn("DatasetExtractor.loadThreadBundle")(function* (
    threadId: string,
  ) {
    const [runs, attempts, messages, items, checkpoints] = yield* Effect.all([
      sql<RunProjectionRow>`
        SELECT run_id, thread_id, ordinal, status, payload_json
        FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId}
        ORDER BY ordinal ASC, run_id ASC
      `,
      sql<RunAttemptProjectionRow>`
        SELECT attempt_id, thread_id, run_id, attempt_ordinal, root_node_id,
               provider_turn_id, status, payload_json
        FROM orchestration_v2_projection_run_attempts
        WHERE thread_id = ${threadId}
        ORDER BY run_id ASC, attempt_ordinal ASC
      `,
      sql<MessageProjectionRow>`
        SELECT message_id, thread_id, run_id, node_id, role, streaming, payload_json
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId}
      `,
      sql<TurnItemProjectionRow>`
        SELECT item.turn_item_id, item.thread_id, item.run_id, item.node_id,
               item.provider_turn_id, item.type, item.status, item.payload_json
        FROM orchestration_v2_projection_turn_items AS item
        LEFT JOIN orchestration_v2_turn_item_positions AS pos
          ON pos.thread_id = item.thread_id AND pos.turn_item_id = item.turn_item_id
        WHERE item.thread_id = ${threadId}
        ORDER BY COALESCE(pos.ordinal, item.ordinal) ASC, item.turn_item_id ASC
      `,
      sql<CheckpointProjectionRow>`
        SELECT checkpoint_id, thread_id, run_id, payload_json
        FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ${threadId}
      `,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new DatasetExtractionError({
            operation: "loadThreadBundle",
            reason: "Failed to read durable thread projection tables.",
            cause,
          }),
      ),
    );

    const messagesById = new Map<string, string>();
    for (const msg of messages) {
      const parsed = safeJsonParse(msg.payload_json);
      if (typeof parsed.text === "string") {
        messagesById.set(msg.message_id, parsed.text);
      }
    }

    const checkpointsById = new Map<
      string,
      ReadonlyArray<{
        readonly path: string;
        readonly additions?: number;
        readonly deletions?: number;
      }>
    >();
    for (const cp of checkpoints) {
      const parsed = safeJsonParse(cp.payload_json);
      if (Array.isArray(parsed.files)) {
        checkpointsById.set(
          cp.checkpoint_id,
          parsed.files as ReadonlyArray<{
            readonly path: string;
            readonly additions?: number;
            readonly deletions?: number;
          }>,
        );
      }
    }

    return { runs, attempts, items, messagesById, checkpointsById };
  });

  const extractCorpus = Effect.fn("DatasetExtractor.extractCorpus")(function* (input: {
    readonly objective: TrainingObjective;
    readonly filter: TrainingDatasetFilter;
    readonly redactionOptions: RedactionOptions;
  }): Effect.fn.Return<ExtractedCorpus, DatasetExtractionError> {
    const allThreads = yield* sql<ThreadProjectionRow>`
      SELECT thread_id, project_id, default_provider, created_at, archived_at, deleted_at, payload_json
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC, thread_id ASC
    `.pipe(
      Effect.mapError(
        (cause) =>
          new DatasetExtractionError({
            operation: "listCandidateThreads",
            reason: "Failed to query threads from durable SQLite projections.",
            cause,
          }),
      ),
    );

    const { candidates: candidateThreads, skippedCount } = filterCandidateThreads(
      allThreads,
      input.filter,
    );
    let skippedThreadCount = skippedCount;

    const collector = redactor.createCollector();
    const matchedThreadIds = new Set<ThreadId>();
    const trainSft: Array<TrainingSftRecord> = [];
    const validSft: Array<TrainingSftRecord> = [];
    const testSft: Array<TrainingSftRecord> = [];
    const trainDpo: Array<TrainingDpoRecord> = [];
    const validDpo: Array<TrainingDpoRecord> = [];
    const testDpo: Array<TrainingDpoRecord> = [];
    let estimatedTokens = 0;

    const bundlesByThreadId = new Map<string, ThreadBundleEntry>();
    for (const candidate of candidateThreads) {
      const bundle = yield* loadThreadBundle(candidate.row.thread_id);
      bundlesByThreadId.set(candidate.row.thread_id, {
        row: candidate.row,
        payload: candidate.payload,
        bundle,
      });
    }

    if (input.objective === "sft") {
      for (const { row, bundle } of bundlesByThreadId.values()) {
        const completedRuns = bundle.runs.filter((run) => run.status === "completed");
        if (completedRuns.length < input.filter.minCompletedRuns) {
          skippedThreadCount += 1;
          continue;
        }
        const completedRunIds = new Set(completedRuns.map((run) => run.run_id));
        const relevantItems = bundle.items.filter(
          (item) => item.run_id !== null && completedRunIds.has(item.run_id),
        );
        const { messages, usedTools } = buildMessagesForItems({
          items: relevantItems,
          messagesById: bundle.messagesById,
          checkpointsById: bundle.checkpointsById,
          filter: input.filter,
        });

        if (!messages.some((m) => m.role === "user") || !hasAssistantOutput(messages)) {
          skippedThreadCount += 1;
          continue;
        }

        const tools = input.filter.includeToolCalls ? buildToolDefinitions(usedTools) : [];
        const threadId = ThreadId.make(row.thread_id);
        const redactedRecord = yield* redactor.redactSftRecord({
          record: { messages, ...(tools.length > 0 ? { tools } : {}) },
          options: input.redactionOptions,
          collector,
          threadId,
        });

        matchedThreadIds.add(threadId);
        estimatedTokens += estimateTokens(redactedRecord);
        const bucket = threadSplitBucket(
          input.filter.split.seed,
          row.thread_id,
          input.filter.split.validRatio,
          input.filter.split.testRatio,
        );
        if (bucket === "test") testSft.push(redactedRecord);
        else if (bucket === "valid") validSft.push(redactedRecord);
        else trainSft.push(redactedRecord);
      }
    } else {
      const dpoSources = input.filter.dpoSources ?? {
        fromForks: true,
        fromRollbacks: true,
        fromRetryAttempts: true,
      };
      const rawDpoRecords: Array<TrainingDpoRecord> = [];

      for (const { row, bundle } of bundlesByThreadId.values()) {
        const threadId = ThreadId.make(row.thread_id);
        const itemsByRun = groupByRunId(bundle.items);
        if (dpoSources.fromRollbacks) {
          rawDpoRecords.push(
            ...collectRollbackDpoRecords(threadId, bundle, itemsByRun, input.filter),
          );
        }
        if (dpoSources.fromRetryAttempts) {
          rawDpoRecords.push(
            ...collectRetryAttemptDpoRecords(threadId, bundle, itemsByRun, input.filter),
          );
        }
      }

      if (dpoSources.fromForks) {
        const transferRows = yield* sql<ContextTransferProjectionRow>`
          SELECT source_thread_id, target_thread_id, payload_json
          FROM orchestration_v2_projection_context_transfers
          WHERE type = 'fork'
        `.pipe(
          Effect.mapError(
            (cause) =>
              new DatasetExtractionError({
                operation: "listForkTransfers",
                reason: "Failed to query fork context transfers.",
                cause,
              }),
          ),
        );
        const forkLinks = collectForkLinks(bundlesByThreadId, transferRows);
        rawDpoRecords.push(...collectForkDpoRecords(bundlesByThreadId, forkLinks, input.filter));
      }

      for (const rawRecord of rawDpoRecords) {
        const redacted = yield* redactor.redactDpoRecord({
          record: rawRecord,
          options: input.redactionOptions,
          collector,
        });
        matchedThreadIds.add(redacted.metadata.sourceThreadId);
        estimatedTokens += estimateTokens(redacted);
        const bucket = threadSplitBucket(
          input.filter.split.seed,
          redacted.metadata.sourceThreadId,
          input.filter.split.validRatio,
          input.filter.split.testRatio,
        );
        if (bucket === "test") testDpo.push(redacted);
        else if (bucket === "valid") validDpo.push(redacted);
        else trainDpo.push(redacted);
      }
    }

    const totalExamples =
      input.objective === "sft"
        ? trainSft.length + validSft.length + testSft.length
        : trainDpo.length + validDpo.length + testDpo.length;
    const trainCount = input.objective === "sft" ? trainSft.length : trainDpo.length;
    const validCount = input.objective === "sft" ? validSft.length : validDpo.length;

    return {
      matchedThreadIds: [...matchedThreadIds].toSorted(),
      skippedThreadCount,
      trainSft,
      validSft,
      testSft,
      trainDpo,
      validDpo,
      testDpo,
      estimatedTokens,
      redactionAudit: collector.toReport(),
      warnings: buildCorpusWarnings(input.filter, totalExamples, trainCount, validCount),
    };
  });

  const toJsonl = (records: ReadonlyArray<unknown>): string =>
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");

  const sha256Hex = (content: string): string =>
    NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

  return DatasetExtractor.of({
    preview: Effect.fn("DatasetExtractor.preview")(function* (input) {
      const corpus = yield* extractCorpus(input);
      const isSft = input.objective === "sft";
      const allSft = [...corpus.trainSft, ...corpus.validSft, ...corpus.testSft];
      const allDpo = [...corpus.trainDpo, ...corpus.validDpo, ...corpus.testDpo];

      return {
        objective: input.objective,
        matchedThreadCount: corpus.matchedThreadIds.length,
        skippedThreadCount: corpus.skippedThreadCount,
        totalExamples: isSft ? allSft.length : allDpo.length,
        trainExamples: isSft ? corpus.trainSft.length : corpus.trainDpo.length,
        validExamples: isSft ? corpus.validSft.length : corpus.validDpo.length,
        testExamples: isSft ? corpus.testSft.length : corpus.testDpo.length,
        estimatedTokens: corpus.estimatedTokens,
        redactionAudit: corpus.redactionAudit,
        ...(isSft
          ? { sampleSftRecords: allSft.slice(0, 10) }
          : { sampleDpoRecords: allDpo.slice(0, 10) }),
        warnings: corpus.warnings,
      };
    }),

    materialize: Effect.fn("DatasetExtractor.materialize")(function* (input) {
      const corpus = yield* extractCorpus({
        objective: input.objective,
        filter: input.filter,
        redactionOptions: input.redactionOptions,
      });

      const isSft = input.objective === "sft";
      const trainRecords = isSft ? corpus.trainSft : corpus.trainDpo;
      const validRecords = isSft ? corpus.validSft : corpus.validDpo;
      const testRecords = isSft ? corpus.testSft : corpus.testDpo;

      if (trainRecords.length === 0) {
        return yield* new DatasetExtractionError({
          operation: "materialize",
          reason: "Dataset produced zero training examples in the train split.",
        });
      }

      const trainJsonl = toJsonl(trainRecords);
      const validJsonl = toJsonl(validRecords);
      const testJsonl = toJsonl(testRecords);

      const trainSha256 = sha256Hex(trainJsonl);
      const validSha256 = sha256Hex(validJsonl);
      const testSha256 = sha256Hex(testJsonl);

      const provenanceHash = sha256Hex(
        canonicalJson({
          filter: input.filter,
          redactionOptions: input.redactionOptions,
          redactorVersion: corpus.redactionAudit.redactorVersion,
          sortedThreadIds: corpus.matchedThreadIds,
          trainSha256,
          validSha256,
          testSha256,
        }),
      );

      yield* fs.makeDirectory(input.outputDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DatasetExtractionError({
              operation: "materialize",
              reason: "Failed to create dataset output directory.",
              cause,
            }),
        ),
      );

      const trainPath = pathService.join(input.outputDir, "train.jsonl");
      const validPath = pathService.join(input.outputDir, "valid.jsonl");
      const testPath = pathService.join(input.outputDir, "test.jsonl");
      const manifestPath = pathService.join(input.outputDir, "manifest.json");

      const writeFile = (filePath: string, content: string) =>
        fs.writeFileString(filePath, content).pipe(
          Effect.mapError(
            (cause) =>
              new DatasetExtractionError({
                operation: "materialize",
                reason: "Failed to write dataset file.",
                cause,
              }),
          ),
        );

      yield* writeFile(trainPath, trainJsonl);
      let sizeBytes = Buffer.byteLength(trainJsonl, "utf8");
      if (validRecords.length > 0) {
        yield* writeFile(validPath, validJsonl);
        sizeBytes += Buffer.byteLength(validJsonl, "utf8");
      }
      if (testRecords.length > 0) {
        yield* writeFile(testPath, testJsonl);
        sizeBytes += Buffer.byteLength(testJsonl, "utf8");
      }

      const createdAt = yield* nowIso;
      const summary: TrainingDatasetSummary = {
        id: input.datasetId,
        name: input.name,
        objective: input.objective,
        filter: input.filter,
        redactionOptions: input.redactionOptions,
        redactionAudit: corpus.redactionAudit,
        storagePath: input.outputDir,
        provenanceHash,
        sourceThreadIds: corpus.matchedThreadIds,
        trainCount: trainRecords.length,
        validCount: validRecords.length,
        testCount: testRecords.length,
        estimatedTokens: corpus.estimatedTokens,
        sizeBytes,
        createdAt,
      };

      const manifestContent = encodePrettyJson({
        ...summary,
        files: {
          train: { sha256: trainSha256, count: trainRecords.length },
          ...(validRecords.length > 0
            ? { valid: { sha256: validSha256, count: validRecords.length } }
            : {}),
          ...(testRecords.length > 0
            ? { test: { sha256: testSha256, count: testRecords.length } }
            : {}),
        },
      });
      yield* writeFile(manifestPath, manifestContent);

      return summary;
    }),

    materializeSftFromDpo: Effect.fn("DatasetExtractor.materializeSftFromDpo")(function* (input) {
      if (input.sourceDataset.objective !== "dpo") {
        return yield* new DatasetExtractionError({
          operation: "materializeSftFromDpo",
          reason: "Source dataset must have objective 'dpo'.",
        });
      }

      const readSplit = Effect.fn("DatasetExtractor.readDpoSplit")(function* (filename: string) {
        const fullPath = pathService.join(input.sourceDataset.storagePath, filename);
        const exists = yield* fs.exists(fullPath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [] as ReadonlyArray<TrainingSftRecord>;
        const raw = yield* fs.readFileString(fullPath).pipe(
          Effect.mapError(
            (cause) =>
              new DatasetExtractionError({
                operation: "materializeSftFromDpo",
                reason: `Failed to read ${filename} from DPO dataset.`,
                cause,
              }),
          ),
        );
        return parseDpoJsonlToSft(raw);
      });

      const [trainSft, validSft, testSft] = yield* Effect.all([
        readSplit("train.jsonl"),
        readSplit("valid.jsonl"),
        readSplit("test.jsonl"),
      ]);

      if (trainSft.length === 0) {
        return yield* new DatasetExtractionError({
          operation: "materializeSftFromDpo",
          reason: "DPO dataset contains zero train records to convert.",
        });
      }

      const trainJsonl = toJsonl(trainSft);
      const validJsonl = toJsonl(validSft);
      const testJsonl = toJsonl(testSft);

      yield* fs.makeDirectory(input.outputDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DatasetExtractionError({
              operation: "materializeSftFromDpo",
              reason: "Failed to create converted SFT dataset directory.",
              cause,
            }),
        ),
      );

      yield* fs.writeFileString(pathService.join(input.outputDir, "train.jsonl"), trainJsonl).pipe(
        Effect.mapError(
          (cause) =>
            new DatasetExtractionError({
              operation: "materializeSftFromDpo",
              reason: "Failed to write converted train.jsonl.",
              cause,
            }),
        ),
      );
      let sizeBytes = Buffer.byteLength(trainJsonl, "utf8");
      if (validSft.length > 0) {
        yield* fs
          .writeFileString(pathService.join(input.outputDir, "valid.jsonl"), validJsonl)
          .pipe(
            Effect.mapError(
              (cause) =>
                new DatasetExtractionError({
                  operation: "materializeSftFromDpo",
                  reason: "Failed to write converted valid.jsonl.",
                  cause,
                }),
            ),
          );
        sizeBytes += Buffer.byteLength(validJsonl, "utf8");
      }
      if (testSft.length > 0) {
        yield* fs.writeFileString(pathService.join(input.outputDir, "test.jsonl"), testJsonl).pipe(
          Effect.mapError(
            (cause) =>
              new DatasetExtractionError({
                operation: "materializeSftFromDpo",
                reason: "Failed to write converted test.jsonl.",
                cause,
              }),
          ),
        );
        sizeBytes += Buffer.byteLength(testJsonl, "utf8");
      }

      const provenanceHash = sha256Hex(
        canonicalJson({
          convertedFromDatasetId: input.sourceDataset.id,
          sourceProvenanceHash: input.sourceDataset.provenanceHash,
          trainSha256: sha256Hex(trainJsonl),
          validSha256: sha256Hex(validJsonl),
          testSha256: sha256Hex(testJsonl),
        }),
      );
      const estimatedTokens = [...trainSft, ...validSft, ...testSft].reduce(
        (sum, rec) => sum + estimateTokens(rec),
        0,
      );
      const createdAt = yield* nowIso;
      const summary: TrainingDatasetSummary = {
        id: input.targetDatasetId,
        name: input.targetName,
        objective: "sft",
        filter: input.sourceDataset.filter,
        redactionOptions: input.sourceDataset.redactionOptions,
        redactionAudit: input.sourceDataset.redactionAudit,
        storagePath: input.outputDir,
        provenanceHash,
        sourceThreadIds: input.sourceDataset.sourceThreadIds,
        trainCount: trainSft.length,
        validCount: validSft.length,
        testCount: testSft.length,
        estimatedTokens,
        sizeBytes,
        createdAt,
      };
      yield* fs
        .writeFileString(
          pathService.join(input.outputDir, "manifest.json"),
          encodePrettyJson(summary),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DatasetExtractionError({
                operation: "materializeSftFromDpo",
                reason: "Failed to write converted manifest.json.",
                cause,
              }),
          ),
        );

      return summary;
    }),
  });
});

export const layer = Layer.effect(DatasetExtractor, make);
