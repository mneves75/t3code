import {
  type ModelCapabilities,
  ProviderDriverKind,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import {
  buildServerProvider,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { type NoNameSettings, noNameServerUrl } from "../settings.ts";
import { makeNoNameClient, noNameModelChoices } from "./api.ts";
import { NONAME_DEFAULT_MODEL } from "./bridge.ts";

const NONAME_DRIVER_KIND = ProviderDriverKind.make("noname");
/** NoName asks before writes and commands; Full access answers those asks itself. */
const NONAME_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;
const NONAME_PRESENTATION = {
  displayName: "NoName",
  showInteractionModeToggle: false,
  supportedRuntimeModes: NONAME_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const PROBE_TIMEOUT = "5 seconds";

const DEFAULT_MODEL: ServerProviderModel = {
  slug: NONAME_DEFAULT_MODEL,
  name: "NoName default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

const snapshot = (
  settings: NoNameSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed: ReadonlyArray<ServerProviderModel> = [DEFAULT_MODEL],
) =>
  buildServerProvider({
    driver: NONAME_DRIVER_KIND,
    presentation: NONAME_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES),
    probe,
  });

export const buildInitialNoNameProviderSnapshot = Effect.fn("NoNameProvider.buildInitialSnapshot")(
  function* (settings: NoNameSettings): Effect.fn.Return<ServerProviderDraft> {
    const now = yield* DateTime.now;
    return snapshot(settings, DateTime.formatIso(now), {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Looking for NoName..."
        : "NoName is disabled in T3 Code settings.",
    });
  },
);

export const checkNoNameProviderStatus = Effect.fn("NoNameProvider.checkStatus")(function* (
  settings: NoNameSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "NoName is disabled in T3 Code settings.",
    });
  }
  const url = noNameServerUrl(settings);
  const probed = yield* Effect.gen(function* () {
    const client = yield* makeNoNameClient(url);
    yield* client.health;
    return yield* client.models;
  }).pipe(Effect.timeout(PROBE_TIMEOUT), Effect.provide(FetchHttpClient.layer), Effect.result);
  if (probed._tag === "Failure") {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `NoName is not answering at ${url}. Start it there, or change its address.`,
    });
  }
  const choices = noNameModelChoices(probed.success);
  const listed = [
    { ...DEFAULT_MODEL, isDefault: true },
    ...choices.map((choice): ServerProviderModel => ({
      slug: choice.value,
      name: choice.name,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    })),
  ];
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
    },
    listed,
  );
});

/** Whether a NoName server answers at the default address, for switching NoName on where it runs. */
export const noNameServerAnswers = Effect.fn("NoNameProvider.serverAnswers")(function* () {
  const url = noNameServerUrl({ serverUrl: "" });
  return yield* Effect.gen(function* () {
    const client = yield* makeNoNameClient(url);
    yield* client.health;
    return true;
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed(() => false),
  );
});
