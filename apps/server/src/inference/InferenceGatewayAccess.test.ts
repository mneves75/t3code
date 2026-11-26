import { expect, it } from "@effect/vitest";
import {
  type InferenceApiProtocol,
  type InferenceServerSnapshot,
  InferenceServerId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as InferenceGateway from "@t3tools/provider-core/server/inferenceGateway";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InferenceGatewayAccess from "./InferenceGatewayAccess.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

const rtx = InferenceServerId.make("rtx");
const pi = ProviderInstanceId.make("pi_local");

const ready: InferenceServerSnapshot = {
  id: rtx,
  displayName: "rtx",
  baseUrl: "http://localhost:8888/v1",
  enabled: true,
  status: "ready",
  checkedAt: null,
  models: [
    {
      id: "GLM-5.3-Flash",
      servedContextWindow: 813056,
      trainedContextWindow: 1_000_000,
      reasoningEfforts: ["high", "low"],
      capabilities: {
        image: { supported: true, source: "checked", checkedAt: "2026-11-07T00:00:00Z" },
      },
    },
  ],
  apiProtocols: ["chat-completions", "messages"],
};

type ServerEntry = {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  fallbackServerId?: InferenceServerId;
};

const layerFor = (
  snapshot: InferenceServerSnapshot | ReadonlyArray<InferenceServerSnapshot>,
  enabled = true,
  inferenceServers: Record<string, ServerEntry> = {
    [rtx]: { baseUrl: "http://localhost:8888/v1", apiKey: "", enabled },
  },
) =>
  InferenceGatewayAccess.layer.pipe(
    Layer.provide([
      ServerSettings.layerTest({
        inferenceServers,
        providerInstances: {
          [pi]: { driver: ProviderDriverKind.make("pi"), inferenceServerId: rtx },
        },
      }),
      Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
        current: Effect.succeed([snapshot].flat()),
      }),
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        issueBackgroundInference: ({ id: serverId, config }, holder) =>
          Effect.succeed({
            serverId,
            pinnedTo: config.baseUrl,
            baseUrl: "http://t3/inference/rtx/v1",
            token: holder === undefined ? "bg" : `instance:${holder}`,
          }),
      }),
    ]),
  );

const access = (
  snapshot: InferenceServerSnapshot,
  enabled = true,
  protocol: InferenceApiProtocol = "chat-completions",
) =>
  Effect.gen(function* () {
    const service = yield* InferenceGateway.InferenceGatewayAccess;
    const managed = yield* service.managedServer(pi, protocol);
    const background = yield* Effect.scoped(service.backgroundCredential(pi, protocol));
    return { managed, background };
  }).pipe(Effect.provide(layerFor(snapshot, enabled)));

it.effect(
  "manages a linked server only while it is enabled, ready, and serves the harness's protocol",
  () =>
    Effect.gen(function* () {
      const managed = yield* access(ready);
      expect(managed.managed).toEqual({
        serverId: rtx,
        displayName: "rtx",
        models: [
          {
            id: "GLM-5.3-Flash",
            contextWindow: 813056,
            reasoningEfforts: ["high", "low"],
            images: true,
          },
        ],
      });
      expect(managed.background?.credential.token).toBe("bg");

      for (const unmanaged of [
        yield* access(ready, false),
        yield* access({ ...ready, status: "unreachable" }),
        yield* access({ ...ready, apiProtocols: ["messages"] }),
        yield* access({ ...ready, models: [] }),
        yield* access(ready, true, "responses"),
      ]) {
        expect(unmanaged).toEqual({ managed: undefined, background: undefined });
      }
    }),
);

it.effect(
  "keeps a linked instance local while its server is down, but not once it is disabled",
  () =>
    Effect.gen(function* () {
      const resolve = (snapshot: InferenceServerSnapshot, enabled: boolean) =>
        Effect.gen(function* () {
          const service = yield* InferenceGateway.InferenceGatewayAccess;
          return yield* service.resolve(pi, "chat-completions");
        }).pipe(Effect.provide(layerFor(snapshot, enabled)));
      expect(yield* resolve({ ...ready, status: "unreachable" }, true)).toMatchObject({
        managed: false,
        local: true,
      });
      expect(yield* resolve(ready, false)).toEqual({
        managed: false,
        reason: "Inference server rtx is disabled.",
      });
      // A removed server is not a choice to use the cloud either.
      const removed = yield* Effect.gen(function* () {
        const service = yield* InferenceGateway.InferenceGatewayAccess;
        return yield* service.resolve(pi, "chat-completions");
      }).pipe(Effect.provide(layerFor(ready, true, {})));
      expect(removed).toMatchObject({ managed: false, local: true });
    }),
);

it.effect("says why a linked server is not managed, and issues instance credentials", () =>
  Effect.gen(function* () {
    const service = yield* InferenceGateway.InferenceGatewayAccess;
    expect(yield* service.resolve(pi, "responses")).toEqual({
      managed: false,
      reason: "Inference server rtx does not serve the OpenAI Responses API this provider needs.",
      local: true,
    });
    expect(yield* service.resolve(ProviderInstanceId.make("unlinked"), "responses")).toBe(
      undefined,
    );
    const held = yield* Effect.scoped(service.instanceCredential(pi, "chat-completions"));
    expect(held?.credential).toMatchObject({
      token: `instance:${pi}`,
      pinnedTo: "http://localhost:8888/v1",
    });
  }).pipe(Effect.provide(layerFor(ready))),
);

const spark = InferenceServerId.make("spark");
const backup: InferenceServerSnapshot = {
  ...ready,
  id: spark,
  displayName: "spark",
  baseUrl: "http://localhost:9999/v1",
  models: [{ id: "GLM-5.3-Flash", servedContextWindow: 131072 }],
};
const down: InferenceServerSnapshot = { ...ready, status: "unreachable", models: [] };
const withBackup = (backupEnabled = true): Record<string, ServerEntry> => ({
  [rtx]: {
    baseUrl: "http://localhost:8888/v1",
    apiKey: "",
    enabled: true,
    fallbackServerId: spark,
  },
  [spark]: { baseUrl: "http://localhost:9999/v1", apiKey: "", enabled: backupEnabled },
});

it.effect("keeps a linked instance managed through a ready backup while its server is down", () =>
  Effect.gen(function* () {
    const managedWith = (
      snapshots: ReadonlyArray<InferenceServerSnapshot>,
      servers = withBackup(),
      protocol: InferenceApiProtocol = "chat-completions",
    ) =>
      Effect.gen(function* () {
        const service = yield* InferenceGateway.InferenceGatewayAccess;
        const managed = yield* service.managedServer(pi, protocol);
        const background = yield* Effect.scoped(service.backgroundCredential(pi, protocol));
        return { managed, background };
      }).pipe(Effect.provide(layerFor(snapshots, true, servers)));

    // The thread's credential stays on its own server; the gateway routes to the backup.
    const covered = yield* managedWith([down, backup]);
    expect(covered.managed).toEqual({
      serverId: rtx,
      displayName: "rtx",
      models: [{ id: "GLM-5.3-Flash", contextWindow: 131072 }],
    });
    expect(covered.background?.credential).toMatchObject({
      serverId: rtx,
      pinnedTo: "http://localhost:8888/v1",
    });

    // Once its own server answers, it lists that server's models again.
    expect((yield* managedWith([ready, backup])).managed?.models[0]?.contextWindow).toBe(813056);

    for (const uncovered of [
      yield* managedWith([down, backup], withBackup(false)),
      yield* managedWith([down, { ...backup, status: "unreachable" }]),
      yield* managedWith([down, { ...backup, apiProtocols: ["messages"] }]),
      yield* managedWith([down, { ...backup, models: [] }]),
      yield* managedWith([down]),
      // Its first probe has not landed yet, so it is not known to be down.
      yield* managedWith([{ ...down, status: "checking" }, backup]),
    ]) {
      expect(uncovered).toEqual({ managed: undefined, background: undefined });
    }
  }),
);

it.live("re-discovers a down server's linked instances when only its backup changes", () =>
  Effect.gen(function* () {
    const refreshed = yield* Deferred.make<void>();
    let refreshes = 0;
    const instance = {
      snapshot: {
        refresh: Effect.suspend(() => {
          refreshes += 1;
          return refreshes === 2 ? Deferred.succeed(refreshed, undefined) : Effect.void;
        }),
      },
    } as unknown as ProviderInstance;
    yield* Layer.build(
      InferenceGatewayAccess.layerRefreshLinkedInstances.pipe(
        Layer.provide([
          ServerSettings.layerTest({
            inferenceServers: withBackup(),
            providerInstances: {
              [pi]: { driver: ProviderDriverKind.make("pi"), inferenceServerId: rtx },
            },
          }),
          Layer.mock(InferenceServerRegistry.InferenceServerRegistry)({
            streamChanges: Stream.make(
              [down, backup],
              [down, { ...backup, status: "unreachable" }],
            ),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (id) => Effect.succeed(id === pi ? instance : undefined),
          }),
        ]),
      ),
    );
    yield* Deferred.await(refreshed).pipe(Effect.timeout("2 seconds"));
    expect(refreshes).toBe(2);
  }).pipe(Effect.scoped),
);
