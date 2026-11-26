// @effect-diagnostics nodeBuiltinImport:off -- cryptographic session id generation
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import {
  type NoNameClient,
  type NoNameContentPart,
  type NoNameEvent,
  type NoNameRequestError,
  noNameDoneError,
  noNameModelChoices,
  noNameToolKind,
} from "./api.ts";

const NONAME_MODEL_CONFIG_ID = "model";
/** NoName's own choice: the model its last turn in this conversation used, or its default. */
export const NONAME_DEFAULT_MODEL = "default";

interface BridgeSession {
  readonly cwd: string;
  model: string;
}

type ApprovalDecision = "allow" | "deny";

/** NoName's `always` is saved with its conversation and outlives the thread, so it is not offered. */
const PERMISSION_OPTIONS: ReadonlyArray<AcpSchema.PermissionOption> = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function approvalDecision(
  response: AcpSchema.RequestPermissionResponse,
): ApprovalDecision | "cancelled" {
  const outcome = response.outcome;
  if (outcome.outcome !== "selected" || !("optionId" in outcome)) return "cancelled";
  return outcome.optionId === "allow" ? "allow" : "deny";
}

function absolutePath(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

function toolLocations(cwd: string, args: unknown): ReadonlyArray<AcpSchema.ToolCallLocation> {
  if (typeof args !== "object" || args === null || !("path" in args)) return [];
  const path = (args as { readonly path: unknown }).path;
  return typeof path === "string" && path.length > 0 && !path.startsWith("ssh://")
    ? [{ path: absolutePath(cwd, path) }]
    : [];
}

function toolTitle(name: string, label: string | null | undefined): string {
  return label?.trim() ? `${name} ${label.trim()}` : name;
}

/** NoName says `pending`, `in_progress` and `completed`; anything else reads as pending. */
function planStatus(status: string): AcpSchema.PlanEntry["status"] {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

function noNamePromptContent(
  prompt: ReadonlyArray<AcpSchema.ContentBlock>,
): string | ReadonlyArray<NoNameContentPart> {
  const text: Array<string> = [];
  const images: Array<NoNameContentPart> = [];
  for (const block of prompt) {
    const part = block as { readonly type: string; readonly [key: string]: unknown };
    if (part.type === "text" && typeof part["text"] === "string") text.push(part["text"]);
    else if (
      part.type === "image" &&
      typeof part["data"] === "string" &&
      typeof part["mimeType"] === "string"
    ) {
      images.push({
        type: "image_url",
        image_url: { url: `data:${part["mimeType"]};base64,${part["data"]}` },
      });
    } else if (part.type === "resource_link" && typeof part["uri"] === "string") {
      text.push(part["uri"]);
    } else if (part.type === "resource") {
      const resource = part["resource"] as { readonly text?: unknown } | null | undefined;
      if (typeof resource?.text === "string") text.push(resource.text);
    }
  }
  const joined = text.join("\n\n");
  return images.length === 0 ? joined : [{ type: "text", text: joined }, ...images];
}

const asJson = (value: unknown) => (value ?? {}) as Schema.Json;

const requestError = (error: NoNameRequestError) =>
  new AcpError.AcpRequestError({ code: -32603, errorMessage: error.detail });

export interface NoNameAcpBridgeOptions {
  readonly client: NoNameClient;
  readonly version: string;
}

/** Registers NoName's ACP agent handlers; the caller supplies the stdio transport. */
export const registerNoNameAcpBridge = Effect.fn("NoNameAcpBridge.register")(function* (
  options: NoNameAcpBridgeOptions,
) {
  const { client } = options;
  const agent = yield* EffectAcpAgent.AcpAgent;
  const sessions = new Map<string, BridgeSession>();
  const cancelled = new Set<string>();
  let promptCount = 0;

  const modelChoices = client.models.pipe(
    Effect.map(noNameModelChoices),
    Effect.orElseSucceed(() => []),
  );

  const configOptions = Effect.fnUntraced(function* (session: BridgeSession) {
    const choices = yield* modelChoices;
    const listed = choices.some((choice) => choice.value === session.model);
    return [
      {
        configId: NONAME_MODEL_CONFIG_ID,
        name: "Model",
        category: "model",
        type: "select",
        currentValue: session.model,
        options: [
          { value: NONAME_DEFAULT_MODEL, name: "NoName default" },
          ...(listed || session.model === NONAME_DEFAULT_MODEL
            ? []
            : [{ value: session.model, name: session.model }]),
          ...choices.map((choice) => ({ value: choice.value, name: choice.name })),
        ],
      },
    ] satisfies ReadonlyArray<AcpSchema.SessionConfigOption>;
  });

  const requireSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    return session === undefined
      ? Effect.fail(AcpError.AcpRequestError.invalidParams(`Unknown session ${sessionId}`))
      : Effect.succeed(session);
  };

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 2,
      info: { name: "noname-acp", version: options.version },
      capabilities: { session: { prompt: { image: {} } } },
    }),
  );

  yield* agent.handleCreateSession((request) =>
    Effect.gen(function* () {
      const sessionId = NodeCrypto.randomUUID();
      const session: BridgeSession = { cwd: request.cwd, model: NONAME_DEFAULT_MODEL };
      sessions.set(sessionId, session);
      return { sessionId, configOptions: yield* configOptions(session) };
    }),
  );

  // NoName keeps the conversation under its id, so resuming only re-binds it here.
  yield* agent.handleResumeSession((request) =>
    Effect.gen(function* () {
      const session: BridgeSession = sessions.get(request.sessionId) ?? {
        cwd: request.cwd,
        model: NONAME_DEFAULT_MODEL,
      };
      sessions.set(request.sessionId, session);
      return { configOptions: yield* configOptions(session) };
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      const session = yield* requireSession(request.sessionId);
      if (request.configId === NONAME_MODEL_CONFIG_ID && typeof request.value === "string") {
        session.model = request.value;
      }
      return { configOptions: yield* configOptions(session) };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      cancelled.add(sessionId);
      yield* client.cancel(sessionId).pipe(Effect.ignore);
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const sessionId = request.sessionId;
      const session = yield* requireSession(sessionId);
      cancelled.delete(sessionId);
      const turn = ++promptCount;
      const update = (sessionUpdate: AcpSchema.SessionUpdate) =>
        agent.client.sessionUpdate({ sessionId, update: sessionUpdate });
      // A new message id after each tool call keeps text before and after it apart.
      const segment = yield* Ref.make(0);
      const messageId = (kind: string) =>
        Ref.get(segment).pipe(Effect.map((n) => `${kind}-${turn}-${n}`));
      const nextSegment = Ref.update(segment, (n) => n + 1);
      const ended = yield* Ref.make<{ cancelled: boolean; error: string | undefined } | null>(null);
      const lastError = yield* Ref.make<string | undefined>(undefined);

      const handle = (event: NoNameEvent): Effect.Effect<void, AcpError.AcpError> => {
        switch (event.type) {
          case "content":
          case "reasoning":
            return messageId(event.type).pipe(
              Effect.flatMap((id) =>
                update({
                  sessionUpdate:
                    event.type === "content" ? "agent_message_chunk" : "agent_thought_chunk",
                  messageId: id,
                  content: { type: "text", text: event.delta },
                }),
              ),
            );
          case "tool_call":
            return nextSegment.pipe(
              Effect.andThen(
                update({
                  sessionUpdate: "tool_call_update",
                  toolCallId: event.id,
                  name: event.name,
                  title: toolTitle(event.name, event.label),
                  kind: noNameToolKind(event.name),
                  status: "in_progress" as const,
                  rawInput: asJson(event.args),
                  locations: toolLocations(session.cwd, event.args),
                }),
              ),
            );
          case "tool_result": {
            const output = event.output ?? "";
            const diff = event.effect?.diff?.trim();
            const target = event.effect?.target;
            const content: Array<AcpSchema.ToolCallContent> = [];
            if (diff && target) {
              content.push({
                type: "diff",
                changes: [
                  {
                    operation: event.effect?.shape?.startsWith("new file") ? "add" : "modify",
                    path: absolutePath(session.cwd, target),
                    fileType: "text",
                  },
                ],
                patch: { format: "git_patch", text: `${diff}\n` },
              });
            }
            if (output.length > 0) {
              content.push({ type: "content", content: { type: "text", text: output } });
            }
            return update({
              sessionUpdate: "tool_call_update",
              toolCallId: event.id,
              status: event.ok ? "completed" : "failed",
              rawOutput: output,
              content,
            });
          }
          case "approval":
            return agent.client
              .requestPermission({
                sessionId,
                title: toolTitle(event.name, event.label),
                subject: {
                  type: "tool_call",
                  toolCall: {
                    toolCallId: event.id,
                    title: toolTitle(event.name, event.label),
                    kind: noNameToolKind(event.name),
                    status: "pending",
                    rawInput: asJson(event.args),
                  },
                },
                options: PERMISSION_OPTIONS,
              })
              .pipe(
                Effect.map(approvalDecision),
                Effect.flatMap((decision) =>
                  decision === "cancelled"
                    ? client
                        .approve(sessionId, event.id, "deny")
                        .pipe(Effect.andThen(client.cancel(sessionId)))
                    : client.approve(sessionId, event.id, decision),
                ),
                Effect.catchTags({
                  NoNameRequestError: (error) => Effect.fail(requestError(error)),
                }),
              );
          case "question": {
            const labels = (event.options ?? []).map((option) => option.label);
            return agent.client
              .elicit({
                sessionId,
                mode: "form",
                message: event.question,
                requestedSchema: {
                  type: "object",
                  properties: {
                    answer: {
                      type: "string",
                      title: event.header?.trim() || "Question",
                      description: event.question,
                      ...(labels.length === 0 ? {} : { enum: labels }),
                    },
                  },
                  required: ["answer"],
                },
              })
              .pipe(
                Effect.flatMap((response) => {
                  const content =
                    response.action === "accept" && "content" in response
                      ? (response.content as Readonly<Record<string, unknown>> | null | undefined)
                      : undefined;
                  const answer = Array.isArray(content) ? undefined : content?.["answer"];
                  return typeof answer === "string"
                    ? client.answer(sessionId, event.id, answer)
                    : client
                        .answer(sessionId, event.id, "")
                        .pipe(Effect.andThen(client.cancel(sessionId)));
                }),
                Effect.catchTags({
                  NoNameRequestError: (error) => Effect.fail(requestError(error)),
                }),
              );
          }
          case "plan":
            return update({
              sessionUpdate: "plan_update",
              plan: {
                type: "items",
                planId: "noname-plan",
                entries: event.items.map((item) => ({
                  content: item.content,
                  priority: "medium",
                  status: planStatus(item.status),
                })),
              },
            });
          case "error":
            return Ref.set(lastError, event.message);
          case "done":
            return Ref.get(lastError).pipe(
              Effect.flatMap((error) =>
                Ref.set(ended, {
                  cancelled: event.cancelled === true || cancelled.has(sessionId),
                  error:
                    event.failed === true
                      ? (noNameDoneError(event.error) ?? error ?? "NoName could not finish.")
                      : undefined,
                }),
              ),
            );
          default:
            return Effect.void;
        }
      };

      yield* client
        .chat({
          sessionId,
          workspace: session.cwd,
          content: noNamePromptContent(request.prompt),
          model: session.model === NONAME_DEFAULT_MODEL ? undefined : session.model,
        })
        .pipe(Stream.mapError(requestError), Stream.runForEach(handle));

      const outcome = yield* Ref.get(ended);
      if (outcome === null && !cancelled.has(sessionId)) {
        return yield* AcpError.AcpRequestError.internalError(
          (yield* Ref.get(lastError)) ?? "NoName stopped answering before the turn finished.",
        );
      }
      if (outcome?.error !== undefined && outcome.cancelled !== true) {
        return yield* AcpError.AcpRequestError.internalError(outcome.error);
      }
      const stopReason = outcome === null || outcome.cancelled ? "cancelled" : "end_turn";
      yield* update({ sessionUpdate: "state_update", state: "idle", stopReason });
      return {};
    }),
  );
});
