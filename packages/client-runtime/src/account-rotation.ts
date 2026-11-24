import {
  type ClientSettings,
  type EnvironmentId,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import {
  antigravityWindowLimitsModel,
  resolveNewThreadModelSelection,
} from "@t3tools/shared/usageLimits";

import type { EnvironmentThreadShell } from "./state/models.ts";

const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
const CLAUDE_SCOPED_WINDOW_PREFIX = "seven_day_";
const CURSOR_AUTO_MODEL_PATTERN = /^(auto|default|grok|composer)/;

const scopeToken = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** Whether the account can start a thread on `model` right now. */
function canStart(provider: ServerProvider, model: string): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.auth.status === "authenticated" &&
    provider.models.some((candidate) => candidate.slug === model)
  );
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUsableTimestamp(timestamp: number, now: number | undefined): boolean {
  return now === undefined || !Number.isFinite(now) || timestamp <= now + CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * Reference clock for deciding whether a reported usage window has reset.
 * Uses the environment's latest provider report, ignoring timestamps skewed far into the future.
 */
function resolveAsOf(providers: ReadonlyArray<ServerProvider>, now?: number): number {
  const source = providers.some((provider) => provider.enabled)
    ? providers.filter((provider) => provider.enabled)
    : providers;
  const hasNow = now !== undefined && Number.isFinite(now);
  let latest = hasNow ? now : Number.NEGATIVE_INFINITY;
  for (const provider of source) {
    for (const raw of [provider.checkedAt, provider.usageLimits?.checkedAt]) {
      const parsed = parseTimestamp(raw);
      if (parsed !== null && isUsableTimestamp(parsed, now) && parsed > latest) {
        latest = parsed;
      }
    }
  }
  return Number.isFinite(latest) ? latest : 0;
}

function baseAccountKey(provider: ServerProvider): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  if (email) return `${provider.driver}:${email}`;
  const fingerprint = provider.usageLimits?.credentialFingerprint;
  return fingerprint ? `${provider.driver}:credential:${fingerprint}` : null;
}

/**
 * Resolves each instance to its canonical underlying account so aliased instances
 * (same login & workspace) share recency and freshest usage instead of double-counting.
 */
function resolveAccountIdentities(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyMap<ProviderInstanceId, string> {
  const workspacesByBase = new Map<string, Set<string>>();
  for (const provider of providers) {
    const base = baseAccountKey(provider);
    if (base && provider.auth.workspaceId) {
      const set = workspacesByBase.get(base) ?? new Set<string>();
      set.add(provider.auth.workspaceId);
      workspacesByBase.set(base, set);
    }
  }
  const identities = new Map<ProviderInstanceId, string>();
  for (const provider of providers) {
    const base = baseAccountKey(provider);
    let identity = `instance:${provider.instanceId}`;
    if (base !== null) {
      if (provider.auth.workspaceId) {
        identity = `${base}:${provider.auth.workspaceId}`;
      } else {
        const known = workspacesByBase.get(base);
        if (!known) identity = base;
        else if (known.size === 1) identity = `${base}:${[...known][0]}`;
      }
    }
    identities.set(provider.instanceId, identity);
  }
  return identities;
}

function resolveSharedUsageLimits(
  providers: ReadonlyArray<ServerProvider>,
  identities: ReadonlyMap<ProviderInstanceId, string>,
  now?: number,
): ReadonlyMap<string, ServerProviderUsageLimits> {
  const bestByIdentity = new Map<
    string,
    { readonly limits: ServerProviderUsageLimits; readonly checkedAt: number }
  >();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const limits = provider.usageLimits;
    if (!limits || limits.unavailable !== undefined || limits.windows.length === 0) continue;
    const identity = identities.get(provider.instanceId) ?? `instance:${provider.instanceId}`;
    const rawTs = parseTimestamp(limits.checkedAt) ?? parseTimestamp(provider.checkedAt);
    const checkedAt = rawTs !== null && isUsableTimestamp(rawTs, now) ? rawTs : 0;
    const previous = bestByIdentity.get(identity);
    if (!previous || checkedAt > previous.checkedAt) {
      bestByIdentity.set(identity, { limits, checkedAt });
    }
  }
  return new Map([...bestByIdentity].map(([key, entry]) => [key, entry.limits]));
}

function windowAppliesToModel(
  driver: ServerProvider["driver"],
  rawWindows: ReadonlyArray<ServerProviderUsageWindow>,
  window: ServerProviderUsageWindow,
  model: string,
): boolean {
  if (window.modelIds !== undefined && !window.modelIds.includes(model)) return false;
  if (window.providerIds !== undefined && !window.providerIds.includes(model.split("/")[0] ?? "")) {
    return false;
  }
  switch (driver) {
    case "claudeAgent":
      return (
        !window.id.startsWith(CLAUDE_SCOPED_WINDOW_PREFIX) ||
        scopeToken(model).includes(window.id.slice(CLAUDE_SCOPED_WINDOW_PREFIX.length))
      );
    case "antigravity":
      return antigravityWindowLimitsModel(window, model);
    case "codex":
      return (
        window.id !== "individual" ||
        !rawWindows.some((entry) => entry.id === "primary" || entry.id === "secondary")
      );
    case "opencode":
      return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
    case "cursor": {
      const hasSplit = rawWindows.some(
        (entry) => entry.id === "autoPercentUsed" || entry.id === "apiPercentUsed",
      );
      if (!hasSplit) return true;
      return CURSOR_AUTO_MODEL_PATTERN.test(model)
        ? window.id !== "totalPercentUsed"
        : window.id === "apiPercentUsed";
    }
    default:
      return true;
  }
}

function windowUsedAt(window: ServerProviderUsageWindow, asOf: number): number {
  const resetsAt = parseTimestamp(window.resetsAt);
  if (resetsAt !== null && resetsAt <= asOf) return 0;
  return window.usedPercent;
}

function summarizeModelUsage(
  driver: ServerProvider["driver"],
  limits: ServerProviderUsageLimits | undefined,
  asOf: number,
  model: string,
): { readonly hasUsage: boolean; readonly used: number; readonly exhausted: boolean } {
  const rawWindows = limits?.windows ?? [];
  const applicable = rawWindows.filter((window) =>
    windowAppliesToModel(driver, rawWindows, window, model),
  );
  if (applicable.length === 0) {
    return { hasUsage: false, used: 0, exhausted: false };
  }
  if (driver === "cursor" && CURSOR_AUTO_MODEL_PATTERN.test(model)) {
    const auto = applicable.find((window) => window.id === "autoPercentUsed");
    const api = applicable.find((window) => window.id === "apiPercentUsed");
    if (auto && api) {
      const used = Math.min(windowUsedAt(auto, asOf), windowUsedAt(api, asOf));
      return { hasUsage: true, used, exhausted: used >= 100 };
    }
  }
  let used = 0;
  for (const window of applicable) {
    used = Math.max(used, windowUsedAt(window, asOf));
  }
  return { hasUsage: true, used, exhausted: used >= 100 };
}

export interface AccountRotationInput {
  readonly selection: Pick<ModelSelection, "instanceId" | "model">;
  readonly environmentId: EnvironmentId;
  /** `environmentId`'s providers. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly project?: {
    readonly settings: ServerSettings;
    readonly projectId: ProjectId;
  };
  /** The accounts marked for rotation. An unmarked account is never rotated onto or away from. */
  readonly eligibleInstanceIds: ReadonlySet<ProviderInstanceId>;
  /** May span environments; instance ids repeat across machines, so only `environmentId`'s count. */
  readonly threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId" | "createdAt" | "lineage">
  >;
  /** Optional wall-clock reference used to guard against future-skewed `checkedAt` timestamps. */
  readonly now?: number;
}

/**
 * Picks the marked account with the most model-applicable usage left (known usage before silent,
 * then least recently started canonical account), skipping exhausted accounts while another has room.
 */
export function chooseRotatedProviderInstance(input: AccountRotationInput): ProviderInstanceId {
  const { selection, project } = input;
  const providers = project
    ? input.providers.map((provider) => ({
        ...provider,
        enabled: resolveProjectProviderInstanceEnabled(
          project.settings,
          project.projectId,
          provider.instanceId,
        ),
      }))
    : input.providers;
  const selected = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (selected === undefined || !input.eligibleInstanceIds.has(selected.instanceId)) {
    return selection.instanceId;
  }

  const identities = resolveAccountIdentities(providers);
  const sharedLimits = resolveSharedUsageLimits(providers, identities, input.now);

  // Turns follow thread starts keyed by canonical account. Later messages would move an
  // open draft from account to account, and a subagent thread rides on its parent's account.
  const lastStartedByIdentity = new Map<string, number>();
  for (const thread of input.threads) {
    if (
      thread.environmentId !== input.environmentId ||
      thread.lineage.relationshipToParent === "subagent"
    ) {
      continue;
    }
    const startedAt = parseTimestamp(thread.createdAt);
    if (startedAt === null) continue;
    const identity =
      identities.get(thread.providerInstanceId) ?? `instance:${thread.providerInstanceId}`;
    if (startedAt > (lastStartedByIdentity.get(identity) ?? 0)) {
      lastStartedByIdentity.set(identity, startedAt);
    }
  }

  // The selection goes first, so a full tie keeps it and then the provider
  // list's own order. A selection that cannot start the thread gives way.
  const startable = [
    ...(canStart(selected, selection.model) ? [selected] : []),
    ...providers.filter(
      (candidate) =>
        candidate !== selected &&
        candidate.driver === selected.driver &&
        input.eligibleInstanceIds.has(candidate.instanceId) &&
        canStart(candidate, selection.model),
    ),
  ];
  if (startable.length === 0) return selection.instanceId;

  const asOf = resolveAsOf(providers, input.now);
  const candidates = startable.map((provider) => {
    const identity = identities.get(provider.instanceId) ?? `instance:${provider.instanceId}`;
    const limits = sharedLimits.get(identity) ?? provider.usageLimits;
    const usage = summarizeModelUsage(provider.driver, limits, asOf, selection.model);
    return {
      provider,
      ...usage,
      lastStarted: lastStartedByIdentity.get(identity) ?? 0,
    };
  });

  const withRoom = candidates.filter((candidate) => !candidate.exhausted);
  const pool = withRoom.length > 0 ? withRoom : candidates;

  let chosen = pool[0]!;
  for (const candidate of pool) {
    const tierDiff = (candidate.hasUsage ? 0 : 1) - (chosen.hasUsage ? 0 : 1);
    const usageDiff = candidate.hasUsage && chosen.hasUsage ? candidate.used - chosen.used : 0;
    const idleDiff = chosen.lastStarted - candidate.lastStarted;
    // Only a strictly better account replaces the current pick.
    if (tierDiff < 0 || (tierDiff === 0 && (usageDiff < 0 || (usageDiff === 0 && idleDiff > 0)))) {
      chosen = candidate;
    }
  }
  return chosen.provider.instanceId;
}

/**
 * Resolves the starting model selection for a new thread by rotating the default across
 * marked accounts first, applying the configured usage-limit fallback only when no marked
 * account has room, and rotating the fallback too when it is marked.
 */
export function resolveRotatedNewThreadSelection(input: {
  readonly configuredDefaultSelection: ModelSelection | null;
  readonly fallbackDefaultSelection: ModelSelection | null;
  readonly fallbackModelSelection: ModelSelection | null;
  readonly rotation: Pick<ClientSettings, "accountRotationEnabled" | "accountRotationInstances">;
  readonly projectDefaultSource: ResolvedProjectSettings["sources"]["defaultModelSelection"];
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threads: AccountRotationInput["threads"];
  readonly settings?: ServerSettings;
  readonly projectId: ProjectId | null;
  readonly now: number;
}): {
  readonly selection: ModelSelection | null;
  readonly fallback: ReturnType<typeof resolveNewThreadModelSelection>["fallback"];
} {
  const {
    configuredDefaultSelection,
    fallbackDefaultSelection,
    fallbackModelSelection,
    rotation,
    projectDefaultSource,
    environmentId,
    providers,
    threads,
    settings,
    projectId,
    now,
  } = input;
  const baseSelection = configuredDefaultSelection ?? fallbackDefaultSelection;
  const eligibleInstanceIds = new Set(rotation.accountRotationInstances[environmentId] ?? []);
  const rotate = (selection: ModelSelection | null, respectProjectDefault: boolean) => {
    if (
      !selection ||
      !rotation.accountRotationEnabled ||
      (respectProjectDefault && projectDefaultSource === "project")
    ) {
      return selection;
    }
    const instanceId = chooseRotatedProviderInstance({
      selection,
      environmentId,
      providers,
      eligibleInstanceIds,
      threads,
      now,
      ...(settings && projectId ? { project: { settings, projectId } } : {}),
    });
    return instanceId === selection.instanceId ? selection : { ...selection, instanceId };
  };

  const rotatedBase = rotate(baseSelection, true);
  const resolution = resolveNewThreadModelSelection({
    defaultSelection: rotatedBase,
    fallbackSelection: fallbackModelSelection,
    providers,
    ...(settings ? { settings } : {}),
    projectId,
    now,
  });
  if (resolution.fallback) {
    return {
      selection: rotate(resolution.selection, false),
      fallback: resolution.fallback,
    };
  }
  return {
    selection: rotatedBase !== baseSelection ? rotatedBase : configuredDefaultSelection,
    fallback: null,
  };
}
