import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveSelfInvocation,
  type SelfInvocation,
  selfInvocationArgs,
} from "@t3tools/shared/nodeRuntime";
import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { NONAME_URL_ENV } from "../bridge.ts";
import { NoNameSettings, noNameServerUrl } from "../settings.ts";

const NONAME_PROVIDER = ProviderDriverKind.make("noname");
const DEFAULT_NONAME_SETTINGS = Schema.decodeSync(NoNameSettings)({});

/** NoName keeps its own history, so T3 cannot roll a conversation back inside it. */
const NoNameProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canRollbackThread: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface NoNameAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: NoNameSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

function buildNoNameAcpSpawnInput(
  selfInvocation: SelfInvocation,
  settings: Pick<NoNameSettings, "serverUrl">,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: selfInvocation.command,
    args: [...selfInvocationArgs(selfInvocation, ["noname-acp"])],
    cwd,
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      [NONAME_URL_ENV]: noNameServerUrl(settings),
    },
  };
}

function makeNoNameAcpAdapterFlavor(options: NoNameAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: NONAME_PROVIDER,
    runtimeHarness: "NoName",
    capabilities: NoNameProviderCapabilitiesV2,
    makeRuntime: (input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...runtimeInput,
            // T3 has the thread's history; NoName's replay would repeat it.
            resumeMethod: "resume",
            // Stop ends only once NoName reports the turn over, so nothing keeps writing after.
            cancelBehavior: "wait-for-prompt",
            spawn: buildNoNameAcpSpawnInput(options.selfInvocation, options.settings, input.cwd, {
              ...options.environment,
              ...processEnvironment,
            }),
          }),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      });
    },
  };
}

const makeNoNameAdapterV2 = Effect.fn("makeNoNameAdapterV2")(function* (
  options: NoNameAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeNoNameAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type NoNameAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const NoNameAdapterV2Driver: ProviderAdapterDriver<
  NoNameSettings,
  NoNameAdapterV2DriverEnv
> = {
  driverKind: NONAME_PROVIDER,
  configSchema: NoNameSettings,
  defaultConfig: (): NoNameSettings => DEFAULT_NONAME_SETTINGS,
  create: Effect.fn("NoNameAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<NoNameSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeNoNameAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: NONAME_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: NONAME_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create NoName ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
