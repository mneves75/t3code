import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EffectAcpAgent from "effect-acp/agent";
import type * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import type { NoNameChatInput, NoNameClient, NoNameEvent } from "./api.ts";
import { registerNoNameAcpBridge } from "./bridge.ts";

type Handler = (request: unknown, context?: unknown) => Effect.Effect<unknown, AcpError.AcpError>;

interface Harness {
  readonly calls: Array<string>;
  readonly chats: Array<NoNameChatInput>;
  readonly updates: Array<AcpSchema.SessionUpdate>;
  readonly call: (name: string, request: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
}

/** Registers the bridge on a stand-in agent whose user answers with `permission` and `answer`. */
const harness = (input: {
  readonly events: ReadonlyArray<NoNameEvent>;
  readonly permission?: AcpSchema.RequestPermissionResponse;
  readonly answer?: AcpSchema.CreateElicitationResponse;
}) =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const calls: Array<string> = [];
    const chats: Array<NoNameChatInput> = [];
    const updates: Array<AcpSchema.SessionUpdate> = [];
    const register = (name: string) => (handler: Handler) =>
      Effect.sync(() => void handlers.set(name, handler));
    const agent = {
      handleInitialize: register("initialize"),
      handleCreateSession: register("createSession"),
      handleResumeSession: register("resumeSession"),
      handleSetSessionConfigOption: register("setConfig"),
      handleCancel: register("cancel"),
      handlePrompt: register("prompt"),
      client: {
        sessionUpdate: (notification: AcpSchema.SessionNotification) =>
          Effect.sync(() => void updates.push(notification.update)),
        requestPermission: () =>
          Effect.succeed(
            input.permission ?? { outcome: { outcome: "selected", optionId: "allow" } },
          ),
        elicit: () => Effect.succeed(input.answer ?? { action: "cancel" }),
      },
    } as unknown as EffectAcpAgent.AcpAgent["Service"];
    const client: NoNameClient = {
      models: Effect.succeed({
        providers: [{ id: "spark1", name: "Spark1", models: ["GLM"] }],
      }),
      health: Effect.succeed({ ok: true }),
      chat: (chat) => {
        chats.push(chat);
        return Stream.fromIterable(input.events);
      },
      approve: (_session, id, decision) =>
        Effect.sync(() => void calls.push(`approve ${id} ${decision}`)),
      answer: (_session, id, text) => Effect.sync(() => void calls.push(`answer ${id} ${text}`)),
      cancel: () => Effect.sync(() => void calls.push("cancel")),
    };
    yield* registerNoNameAcpBridge({ client, version: "test" }).pipe(
      Effect.provideService(EffectAcpAgent.AcpAgent, agent),
    );
    const call = (name: string, request: unknown) => {
      const handler = handlers.get(name);
      return handler === undefined ? Effect.die(`no ${name} handler`) : handler(request);
    };
    return { calls, chats, updates, call } satisfies Harness;
  });

const newSession = (bridge: Harness) =>
  bridge
    .call("createSession", { cwd: "/work", mcpServers: [] })
    .pipe(Effect.map((response) => (response as AcpSchema.NewSessionResponse).sessionId));

const prompt = (bridge: Harness, sessionId: string) =>
  bridge.call("prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });

describe("NoName ACP bridge", () => {
  it.effect("turns a NoName turn into ACP updates and answers NoName's asks", () =>
    Effect.gen(function* () {
      const bridge = yield* harness({
        answer: { action: "accept", content: { answer: "HTML" } },
        events: [
          { type: "reasoning", delta: "thinking" },
          { type: "content", delta: "Writing it." },
          {
            type: "tool_call",
            id: "c1",
            name: "write_file",
            args: { path: "a.md" },
            label: "a.md",
          },
          { type: "approval", id: "c1", name: "write_file", label: "a.md", args: { path: "a.md" } },
          {
            type: "tool_result",
            id: "c1",
            ok: true,
            output: "wrote a.md",
            effect: { kind: "file", target: "a.md", diff: "+# A", shape: "new file, 1 line" },
          },
          { type: "question", id: "q1", question: "Which format?", options: [{ label: "HTML" }] },
          { type: "plan", items: [{ content: "write", status: "completed" }] },
          { type: "content", delta: "Done." },
          { type: "done", failed: false, cancelled: false },
        ],
      });
      const sessionId = yield* newSession(bridge);
      yield* prompt(bridge, sessionId);

      expect(bridge.chats[0]).toEqual({
        sessionId,
        workspace: "/work",
        content: "go",
        model: undefined,
      });
      expect(bridge.calls).toEqual(["approve c1 allow", "answer q1 HTML"]);
      expect(bridge.updates).toEqual([
        {
          sessionUpdate: "agent_thought_chunk",
          messageId: "reasoning-1-0",
          content: { type: "text", text: "thinking" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "content-1-0",
          content: { type: "text", text: "Writing it." },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          name: "write_file",
          title: "write_file a.md",
          kind: "edit",
          status: "in_progress",
          rawInput: { path: "a.md" },
          locations: [{ path: "/work/a.md" }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          rawOutput: "wrote a.md",
          content: [
            {
              type: "diff",
              changes: [{ operation: "add", path: "/work/a.md", fileType: "text" }],
              patch: { format: "git_patch", text: "+# A\n" },
            },
            { type: "content", content: { type: "text", text: "wrote a.md" } },
          ],
        },
        {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "noname-plan",
            entries: [{ content: "write", priority: "medium", status: "completed" }],
          },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "content-1-1",
          content: { type: "text", text: "Done." },
        },
        { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      ]);
    }),
  );

  it.effect("a dismissed approval denies the call and stops the turn", () =>
    Effect.gen(function* () {
      const bridge = yield* harness({
        permission: { outcome: { outcome: "cancelled" } },
        events: [
          { type: "approval", id: "c1", name: "run_command", label: "rm -rf x" },
          { type: "done", cancelled: true },
        ],
      });
      yield* prompt(bridge, yield* newSession(bridge));
      expect(bridge.calls).toEqual(["approve c1 deny", "cancel"]);
      expect(bridge.updates.at(-1)).toEqual({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      });
    }),
  );

  it.effect.each([
    {
      name: "a failed turn",
      events: [
        { type: "error", message: "model server is down" },
        { type: "done", failed: true },
      ] satisfies ReadonlyArray<NoNameEvent>,
      message: "model server is down",
    },
    {
      name: "a stream that ends without done",
      events: [{ type: "content", delta: "half" }] satisfies ReadonlyArray<NoNameEvent>,
      message: "NoName stopped answering before the turn finished.",
    },
  ])("fails the prompt on $name", ({ events, message }) =>
    Effect.gen(function* () {
      const bridge = yield* harness({ events });
      const error = yield* prompt(bridge, yield* newSession(bridge)).pipe(
        Effect.asVoid,
        Effect.flip,
      );
      expect(error).toMatchObject({ errorMessage: message });
    }),
  );

  it.effect("sends the chosen model, and a resumed session keeps NoName's id", () =>
    Effect.gen(function* () {
      const bridge = yield* harness({ events: [{ type: "done" }] });
      const configured = (yield* bridge.call("resumeSession", {
        sessionId: "abc",
        cwd: "/work",
      })) as AcpSchema.ResumeSessionResponse;
      expect(configured.configOptions?.[0]).toMatchObject({
        configId: "model",
        currentValue: "default",
        options: [
          { value: "default", name: "NoName default" },
          { value: "spark1/GLM", name: "GLM · Spark1" },
        ],
      });
      yield* bridge.call("setConfig", { sessionId: "abc", configId: "model", value: "spark1/GLM" });
      yield* prompt(bridge, "abc");
      expect(bridge.chats[0]).toMatchObject({ sessionId: "abc", model: "spark1/GLM" });
    }),
  );
});
