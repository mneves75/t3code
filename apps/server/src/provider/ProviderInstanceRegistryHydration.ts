import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
  isLocalProviderInstance,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { noNameServerAnswers } from "@t3tools/provider-noname/server";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ManagedProviders from "../policy/managedProviders.ts";
import * as Settings from "../serverSettings.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import type * as PortScanner from "../preview/PortScanner.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | Path.Path
  | FileSystem.FileSystem
  // Secret provider reads.
  | SecureRandom.SecureRandom
  // The Claude runner counts its CLIs as running agents for port discovery.
  | PortScanner.PortDiscovery
  // Adapter ids read which subagent threads predate short ids.
  | SqlClient.SqlClient;

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    if (driver.metadata.hasDefaultInstance === false) continue;
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) continue;
    merged[instanceId] = { driver: driver.driverKind };
  }

  // Probe project-enabled instances even if disabled machine-wide; project threads can still route to them.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined || resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  // The registry stamps the envelope's mark, so a link's locality is resolved into it here.
  for (const [rawInstanceId, entry] of Object.entries(merged)) {
    if (entry.inferenceServerId === undefined) continue;
    const { inference: _mark, ...unmarked } = entry;
    merged[rawInstanceId] = isLocalProviderInstance(entry, settings.inferenceServers)
      ? { ...unmarked, inference: "local" }
      : entry.inference === "local"
        ? unmarked
        : entry;
  }

  return merged as ProviderInstanceConfigMap;
};

export const DEV_REPLAY_INSTANCE_ID = ProviderInstanceId.make("devReplay");

/**
 * Dev servers run from source keep a free ACP agent that replays recorded turns, so UI checks
 * need no paid model. Bundled servers, such as desktop dev, have no agent script and skip it.
 */
export const seedDevReplayInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedDevReplayInstance",
)(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (config.devUrl === undefined) return;
  const path = yield* Path.Path;
  const agentPath = yield* path.fromFileUrl(
    new URL("../../scripts/dev-replay-agent.ts", import.meta.url),
  );
  if (!(yield* (yield* FileSystem.FileSystem).exists(agentPath))) return;
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  // Rewritten only when stale: the node and checkout paths can move.
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath
  ) {
    return;
  }
  // Keeps user edits, such as turning the provider off.
  const instance: ProviderInstanceConfig = {
    displayName: "Replay (dev)",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: DEV_REPLAY_INSTANCE_ID,
    instance,
  });
});

export interface LocalAgentDetector {
  readonly driver: ProviderDriverKind;
  readonly found: Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;
}

const commandOnPath = (command: string) =>
  resolveCommandPath(command).pipe(
    Effect.map((resolved) => resolved !== null),
    Effect.orElseSucceed(() => false),
  );

/** Agents that run local models, and how to tell one is on this machine. */
const LOCAL_AGENT_DETECTORS: ReadonlyArray<LocalAgentDetector> = [
  { driver: ProviderDriverKind.make("pi"), found: commandOnPath("pi") },
  { driver: ProviderDriverKind.make("opencode"), found: commandOnPath("opencode") },
  { driver: ProviderDriverKind.make("noname"), found: noNameServerAnswers() },
];

/**
 * Local agents start off like other optional drivers, so settings-only fallbacks never pick one
 * that is missing. One found on this machine is switched on, unless its instance was configured
 * here before: turning it off is a configuration and is kept.
 */
export const seedLocalAgentInstances = Effect.fn(
  "ProviderInstanceRegistryHydration.seedLocalAgentInstances",
)(function* (detectors: ReadonlyArray<LocalAgentDetector> = LOCAL_AGENT_DETECTORS) {
  const serverSettings = yield* Settings.ServerSettingsService;
  const configured = (yield* serverSettings.getSettings).providerInstances;
  const candidates = detectors.filter(
    ({ driver }) =>
      !(defaultInstanceIdForDriver(driver) in configured) &&
      ManagedProviders.disallowedDriverReason(serverSettings.managedPolicy, driver) === undefined,
  );
  const found = yield* Effect.filter(candidates, (detector) => detector.found, {
    concurrency: "unbounded",
  });
  for (const { driver } of found) {
    yield* serverSettings.updateProviderInstance({
      operation: "upsert",
      instanceId: defaultInstanceIdForDriver(driver),
      instance: { driver, enabled: true },
    });
  }
});

// A label is display-only, so only kind and config can change what a vault returns.
const vaultConfigs = (settings: ServerSettings) =>
  Object.entries(settings.secretProviders).map(([id, { kind, config }]) => [id, kind, config]);

// A host built earlier (for the ACP registry) lacks PortDiscovery; build this one fresh.
export const providerHostLayer = Layer.fresh(ProviderHostLive.layer);

export const layerSettingsWatcher = (
  settingsChanges: Stream.Stream<ServerSettings>,
  // The settings the registry was built from: a change queued during startup differs from these.
  initialSettings: ServerSettings | undefined,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      let secretProviders = initialSettings && vaultConfigs(initialSettings);
      yield* settingsChanges.pipe(
        Stream.runForEach(() =>
          // The subscription predates the seed read, so a queued change can be
          // older than the seed. A failed current read must leave the registry intact.
          serverSettings.getSettings.pipe(
            Effect.flatMap((current) =>
              Effect.gen(function* () {
                yield* mutator.reconcile(deriveProviderInstanceConfigMap(current));
                // Reconcile leaves instances parked on an unreadable secret alone,
                // and a corrected secret provider is what can make them readable.
                const next = vaultConfigs(current);
                if (!NodeUtil.isDeepStrictEqual(secretProviders, next)) {
                  secretProviders = next;
                  yield* mutator.reloadSecrets();
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );

export const layer: Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    yield* seedDevReplayInstance().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Dev replay agent unavailable", cause)),
    );
    yield* seedLocalAgentInstances().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Local agent discovery failed", cause)),
    );
    // Subscribe before the seed read so saves during registry construction are queued.
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings);

    // Drivers launch from the host environment, minus launch overrides a policy ignores.
    const hostEnvironment = ManagedProviders.providerHostEnvironment(
      serverSettings.managedPolicy,
      yield* HostProcess.Environment,
    );
    // Instances of drivers the policy leaves out stay listed, as unavailable, so their threads
    // explain why instead of losing their provider.
    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
      blockedReason: (driver) =>
        ManagedProviders.disallowedDriverReason(serverSettings.managedPolicy, driver),
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(providerHostLayer),
      Layer.provide(Layer.succeed(HostProcess.Environment, hostEnvironment)),
      Layer.provide(SecretResolver.layer),
    );

    return layerSettingsWatcher(settingsChanges, initialSettings).pipe(
      Layer.provideMerge(layerMutable),
    );
  }),
) as Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
