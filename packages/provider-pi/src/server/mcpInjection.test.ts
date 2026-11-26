import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  T3_GATEWAY_MODELS_ENV,
  T3_GATEWAY_PROVIDER_ENV,
  T3_GATEWAY_TOKEN_ENV,
  T3_GATEWAY_URL_ENV,
} from "./gatewayExtensionSource.ts";
import {
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
  T3_PI_MCP_EXTENSION_PATH_ENV,
  T3_PI_TOOL_PROFILE_ENV,
} from "./mcpExtensionSource.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as NodePath from "effect/Path";
import * as NodeFS from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
  resolvePiToolProfile,
} from "./mcpInjection.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

const gateway = {
  server: {
    serverId: "rtx",
    displayName: "rtx",
    models: [
      {
        id: "GLM-5.3-Flash",
        contextWindow: 813056,
        reasoningEfforts: ["max", "high", "low"],
        images: true,
      },
      { id: "plain", images: false },
      // Nobody checked: Pi sends images, so a text-only server refuses them visibly.
      { id: "unchecked" },
    ],
  },
  credential: {
    serverId: "rtx",
    baseUrl: "http://127.0.0.1:43123/inference/rtx/v1",
    token: "gateway-secret",
  },
};

describe("pi T3 gateway provider", () => {
  it("hands a managed server's gateway to Pi through the environment only", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      gateway,
    });
    assert.notInclude(launch.args.join(" "), "gateway-secret");
    assert.equal(launch.env[T3_GATEWAY_URL_ENV], "http://127.0.0.1:43123/inference/rtx/v1");
    assert.equal(launch.env[T3_GATEWAY_TOKEN_ENV], "gateway-secret");
    assert.equal(launch.env[T3_GATEWAY_PROVIDER_ENV], "t3-rtx");
    assert.deepEqual(JSON.parse(launch.env[T3_GATEWAY_MODELS_ENV]!), [
      {
        id: "GLM-5.3-Flash",
        name: "GLM-5.3-Flash (rtx)",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 813056,
        maxTokens: 16384,
      },
      {
        id: "plain",
        name: "plain (rtx)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "unchecked",
        name: "unchecked (rtx)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ]);
  });

  it("loads only the gateway extension for background processes and drops stale credentials", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["--extension", "/home/user/.pi/agent/extensions/demo.ts"],
      environment: { [T3_GATEWAY_TOKEN_ENV]: "inherited" },
      mcpSession: undefined,
      extensionPath: undefined,
      gatewayExtensionPath: "/tmp/cache/pi-t3-gateway-extension.ts",
      gateway,
      ephemeral: true,
      shortLived: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-extensions",
      "--no-tools",
      "--extension",
      "/tmp/cache/pi-t3-gateway-extension.ts",
    ]);
    assert.equal(launch.env[T3_GATEWAY_TOKEN_ENV], "gateway-secret");

    const unmanaged = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_GATEWAY_TOKEN_ENV]: "inherited", [T3_GATEWAY_URL_ENV]: "http://x" },
      mcpSession: undefined,
      extensionPath: undefined,
      gatewayExtensionPath: "/tmp/cache/pi-t3-gateway-extension.ts",
      ephemeral: true,
    });
    assert.deepEqual(unmanaged.args, ["--mode", "rpc", "--no-session"]);
    assert.isUndefined(unmanaged.env[T3_GATEWAY_TOKEN_ENV]);
    assert.isUndefined(unmanaged.env[T3_GATEWAY_URL_ENV]);
  });
});

describe("pi T3 MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "approval-required",
      toolProfile: "lean",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");
    assert.equal(launch.env[T3_PI_TOOL_PROFILE_ENV], "lean");
    assert.equal(launch.env[T3_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-t3-mcp-extension.ts");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [T3_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [T3_MCP_BEARER_ENV]: "stale-token",
        [T3_PI_MCP_EXTENSION_PATH_ENV]: "/stale/extension.ts",
        [T3_PI_TOOL_PROFILE_ENV]: "lean",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.isUndefined(permissionOnly.env[T3_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[T3_MCP_BEARER_ENV]);
    assert.isUndefined(permissionOnly.env[T3_PI_TOOL_PROFILE_ENV]);
    assert.equal(permissionOnly.env[T3_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
    assert.equal(
      permissionOnly.env[T3_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-t3-mcp-extension.ts",
    );
  });

  it.each([
    ["full", false, "full"],
    ["full", true, "full"],
    ["lean", false, "lean"],
    ["lean", true, "lean"],
    ["auto", false, "full"],
    ["auto", true, "lean"],
  ] as const)(
    "the %s tool profile with an inference server link %s resolves to %s",
    (setting, linked, expected) => {
      assert.equal(resolvePiToolProfile(setting, linked), expected);
    },
  );

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      sessionPath: "/fake/persisted.jsonl",
      ephemeral: true,
      shortLived: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--offline",
      "--no-extensions",
      "--no-tools",
    ]);
    const alreadyOffline = buildPiRpcLaunch({
      launchArgs: ["--offline"],
      environment: {},
      mcpSession: undefined,
      extensionPath: undefined,
      ephemeral: true,
      shortLived: true,
    });
    assert.deepEqual(alreadyOffline.args, ["--mode", "rpc", "--no-session", "--offline"]);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });
});

describe("materializePiT3McpExtension", () => {
  // A pi launch concurrent with the materialize reads the extension file from
  // disk; a truncate-then-write exposes an empty or partial file mid-write and
  // the launch loads a broken extension.
  it.live("never exposes a torn extension file to a concurrent reader", () =>
    Effect.gen(function* () {
      const fs = yield* NodeFS.FileSystem;
      const path = yield* NodePath.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-atomic-" });
      const anomalies: Array<string> = [];
      const stopAfter = 120;
      const writer = yield* Effect.forkChild(
        Effect.gen(function* () {
          for (let index = 0; index < stopAfter; index += 1) {
            yield* fs
              .remove(path.join(directory, "pi-t3-mcp-extension.ts"), { force: true })
              .pipe(Effect.ignore);
            yield* Effect.all(
              [materializePiT3McpExtension(directory), materializePiT3McpExtension(directory)],
              { concurrency: "unbounded" },
            );
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      const reader = yield* Effect.forkChild(
        Effect.forever(
          Effect.gen(function* () {
            const text = yield* fs
              .readFileString(path.join(directory, "pi-t3-mcp-extension.ts"))
              .pipe(Effect.option);
            if (Option.isNone(text)) return; // Missing between writes: legitimate.
            // A read that SUCCEEDS must return the full extension: an empty or
            // partial read means the writer truncated the file mid-write.
            if (text.value.length === 0) {
              anomalies.push("empty: truncated mid-write");
            } else if (text.value.length !== PI_T3_MCP_EXTENSION_SOURCE.length) {
              anomalies.push(
                `partial: ${text.value.length} of ${PI_T3_MCP_EXTENSION_SOURCE.length} chars`,
              );
            }
          }),
        ),
      );
      yield* Fiber.join(writer);
      yield* Fiber.interrupt(reader);
      expect(anomalies).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
