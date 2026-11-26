import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { NoNameSettings } from "../settings.ts";
import {
  makeNoNameClient,
  noNameChatBody,
  noNameErrorText,
  noNameModelChoices,
  parseNoNameSseLine,
  splitNoNameModel,
} from "./api.ts";

describe("noNameModelChoices", () => {
  it("lists every model of each switched-on provider, default first, without repeats", () => {
    expect(
      noNameModelChoices({
        providers: [
          {
            id: "spark1",
            name: "Spark1",
            models: ["deepseek-v4.1-flash", "GLM-5.3-EXL3"],
            default_model: "GLM-5.3-Flash-EXL3",
          },
          { id: "old", name: "Old", models: ["x"], off: true },
          { id: "chatgpt", name: null, models: ["gpt-6-sol", "gpt-6-sol"] },
        ],
      }),
    ).toEqual([
      { value: "spark1/GLM-5.3-Flash-EXL3", name: "GLM-5.3-Flash-EXL3 · Spark1", isDefault: true },
      {
        value: "spark1/deepseek-v4.1-flash",
        name: "deepseek-v4.1-flash · Spark1",
        isDefault: false,
      },
      { value: "spark1/GLM-5.3-EXL3", name: "GLM-5.3-EXL3 · Spark1", isDefault: false },
      { value: "chatgpt/gpt-6-sol", name: "gpt-6-sol · chatgpt", isDefault: false },
    ]);
  });
});

describe("splitNoNameModel", () => {
  it("splits at the first slash, since model ids can contain more", () => {
    expect(splitNoNameModel("hf/org/model")).toEqual({ provider: "hf", model: "org/model" });
    expect(splitNoNameModel("default")).toBeUndefined();
    expect(splitNoNameModel("/x")).toBeUndefined();
  });
});

describe("noNameChatBody", () => {
  it("runs an agent turn in the thread's folder, naming the model only when one is chosen", () => {
    expect(
      noNameChatBody({ sessionId: "s1", workspace: "/w", content: "hi", model: "spark1/GLM" }),
    ).toEqual({
      session_id: "s1",
      mode: "agent",
      workspace: "/w",
      content: "hi",
      provider: "spark1",
      model: "GLM",
    });
    expect(
      noNameChatBody({ sessionId: "s1", workspace: "/w", content: "hi", model: undefined }),
    ).not.toHaveProperty("provider");
  });
});

describe("parseNoNameSseLine", () => {
  it("reads the events the bridge maps and drops the rest", () => {
    expect(parseNoNameSseLine('data: {"type": "content", "delta": "Hi"}')).toEqual({
      type: "content",
      delta: "Hi",
    });
    expect(
      parseNoNameSseLine(
        'data: {"type": "approval", "id": "c1", "name": "write_file", "label": "a.md", "args": {"path": "a.md"}, "risk": "write"}',
      ),
    ).toMatchObject({ type: "approval", id: "c1", name: "write_file" });
    expect(parseNoNameSseLine('data: {"type": "step", "n": 1, "max": 200}')).toBeUndefined();
    expect(parseNoNameSseLine(": keepalive")).toBeUndefined();
    expect(parseNoNameSseLine("data: not json")).toBeUndefined();
  });
});

describe("noNameErrorText", () => {
  it("shows NoName's message and hint, such as a turn already running", () => {
    expect(
      noNameErrorText(
        409,
        '{"error": {"message": "this conversation is still working", "hint": "press Stop first"}}',
      ),
    ).toBe("this conversation is still working. press Stop first");
    expect(noNameErrorText(502, "<html>")).toBe("NoName answered HTTP 502.");
  });
});

describe("NoName URL scheme validation (SEC-10)", () => {
  const decodeSettings = Schema.decodeUnknownExit(NoNameSettings);

  it("rejects non-http(s) serverUrl values in settings", () => {
    expect(Exit.isSuccess(decodeSettings({ serverUrl: "" }))).toBe(true);
    expect(Exit.isSuccess(decodeSettings({ serverUrl: "http://127.0.0.1:8890" }))).toBe(true);
    expect(Exit.isSuccess(decodeSettings({ serverUrl: "https://noname.local" }))).toBe(true);
    expect(Exit.isFailure(decodeSettings({ serverUrl: "file:///etc/passwd" }))).toBe(true);
    expect(Exit.isFailure(decodeSettings({ serverUrl: "javascript:alert(1)" }))).toBe(true);
  });

  it.effect("refuses requests when client baseUrl is not http(s)", () =>
    Effect.gen(function* () {
      const client = yield* makeNoNameClient("file:///etc/passwd");
      const err = yield* client.health.pipe(Effect.flip);
      expect(err.detail).toContain("http:// or https://");
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("should not execute")),
        ),
      ),
    ),
  );
});
