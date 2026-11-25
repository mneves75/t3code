import {
  type ClientSettings,
  type EnvironmentId,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import {
  antigravityWindowLimitsModel,
  type resolveNewThreadModelSelection,
} from "@t3tools/shared/usageLimits";

import type { EnvironmentThreadShell } from "./state/models.ts";

const CLAUDE_SCOPED_WINDOW_PREFIX = "seven_day_";
const CURSOR_AUTO_MODEL_PATTERN = /^(auto|default|grok|composer)/;

const scopeToken = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

function resolveModelSlug(provider: ServerProvider, model: string): string | null {
  const matched = provider.models.find(
    (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
  );
  return matched?.slug ?? null;
}

/** Whether the account can start a thread on `model` right now. */
function canStart(provider: ServerProvider, model: string): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.auth.status === "authenticated" &&
    resolveModelSlug(provider, model) !== null
  );
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reference clock for deciding whether a reported usage window has reset.
 * Uses explicit wall-clock `now` when supplied so skewed provider reports cannot clear caps early;
 * otherwise falls back to the environment's latest enabled provider report.
 */
function resolveAsOf(providers: ReadonlyArray<ServerProvider>, now?: number): number {
  if (now !== undefined && Number.isFinite(now)) return now;
  const source = providers.some((provider) => provider.enabled)
    ? providers.filter((provider) => provider.enabled)
    : providers;
  let latest = Number.NEGATIVE_INFINITY;
  for (const provider of source) {
    for (const raw of [provider.checkedAt, provider.usageLimits?.checkedAt]) {
      const parsed = parseTimestamp(raw);
      if (parsed !== null && parsed > latest) latest = parsed;
    }
  }
  return Number.isFinite(latest) ? latest : 0;
}

export interface AccountIdentityInput {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly credentialFingerprint?: string | undefined;
}

function baseAccountKey(account: AccountIdentityInput): string | null {
  const email = account.email?.trim().toLowerCase();
  if (email) return `${account.driver}:${email}`;
  return account.credentialFingerprint
    ? `${account.driver}:credential:${account.credentialFingerprint}`
    : null;
}

/**
 * Resolves each instance to its canonical underlying account so aliased instances
 * (same login & workspace) share recency, freshest usage, and settings duplicate cues.
 */
export function resolveAccountIdentities(
  accounts: ReadonlyArray<AccountIdentityInput>,
): ReadonlyMap<ProviderInstanceId, string> {
  const workspacesByBase = new Map<string, Set<string>>();
  for (const account of accounts) {
    const base = baseAccountKey(account);
    if (base && account.workspaceId) {
      const set = workspacesByBase.get(base) ?? new Set<string>();
      set.add(account.workspaceId);
      workspacesByBase.set(base, set);
    }
  }
  const identities = new Map<ProviderInstanceId, string>();
  for (const account of accounts) {
    const base = baseAccountKey(account);
    let identity = `instance:${account.instanceId}`;
    if (base !== null) {
      if (account.workspaceId) {
        identity = `${base}:${account.workspaceId}`;
      } else {
        const known = workspacesByBase.get(base);
        if (!known) identity = base;
        else if (known.size === 1) identity = `${base}:${[...known][0]}`;
      }
    }
    identities.set(account.instanceId, identity);
  }
  return identities;
}

function providerIdentityInput(provider: ServerProvider): AccountIdentityInput {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    email: provider.auth.email,
    workspaceId: provider.auth.workspaceId,
    credentialFingerprint: provider.usageLimits?.credentialFingerprint,
  };
}

const usageWindowKey = (window: ServerProviderUsageWindow) =>
  `${window.id}|${window.modelIds?.join(",") ?? ""}|${window.providerIds?.join(",") ?? ""}`;

function overlayPartialExhaustedLimits(
  usable: { readonly limits: ServerProviderUsageLimits; readonly checkedAt: number } | undefined,
  partials: ReadonlyArray<{
    readonly limits: ServerProviderUsageLimits;
    readonly checkedAt: number;
  }>,
  asOf: number,
): ServerProviderUsageLimits | undefined {
  const exhausted = new Map<
    string,
    { readonly window: ServerProviderUsageWindow; readonly checkedAt: number }
  >();
  let latestPartial:
    | { readonly limits: ServerProviderUsageLimits; readonly checkedAt: number }
    | undefined;
  for (const entry of partials) {
    if (usable && entry.checkedAt <= usable.checkedAt) continue;
    for (const window of entry.limits.windows) {
      if (windowUsedAt(window, asOf) < 100) continue;
      if (!latestPartial || entry.checkedAt > latestPartial.checkedAt) latestPartial = entry;
      const key = usageWindowKey(window);
      const previous = exhausted.get(key);
      if (!previous || entry.checkedAt > previous.checkedAt) {
        exhausted.set(key, { window, checkedAt: entry.checkedAt });
      }
    }
  }
  if (exhausted.size === 0 || !latestPartial) return usable?.limits;
  if (!usable) {
    return {
      ...latestPartial.limits,
      windows: [...exhausted.values()].map((entry) => entry.window),
    };
  }
  const mergedWindows = new Map<string, ServerProviderUsageWindow>(
    usable.limits.windows.map((window) => [usageWindowKey(window), window]),
  );
  for (const [key, entry] of exhausted) mergedWindows.set(key, entry.window);
  return {
    ...usable.limits,
    checkedAt: latestPartial.limits.checkedAt,
    windows: [...mergedWindows.values()],
  };
}

function resolveSharedUsageLimits(
  providers: ReadonlyArray<ServerProvider>,
  identities: ReadonlyMap<ProviderInstanceId, string>,
  asOf: number,
): ReadonlyMap<string, ServerProviderUsageLimits> {
  const bestUsable = new Map<
    string,
    { readonly limits: ServerProviderUsageLimits; readonly checkedAt: number }
  >();
  const partialsByIdentity = new Map<
    string,
    Array<{ readonly limits: ServerProviderUsageLimits; readonly checkedAt: number }>
  >();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const limits = provider.usageLimits;
    if (!limits || limits.windows.length === 0) continue;
    const identity = identities.get(provider.instanceId) ?? `instance:${provider.instanceId}`;
    const checkedAt = parseTimestamp(limits.checkedAt) ?? parseTimestamp(provider.checkedAt) ?? 0;
    if (limits.unavailable === undefined) {
      const previous = bestUsable.get(identity);
      if (!previous || checkedAt > previous.checkedAt) {
        bestUsable.set(identity, { limits, checkedAt });
      }
      continue;
    }
    const list = partialsByIdentity.get(identity);
    if (list) list.push({ limits, checkedAt });
    else partialsByIdentity.set(identity, [{ limits, checkedAt }]);
  }
  const merged = new Map<string, ServerProviderUsageLimits>();
  for (const [identity, entry] of bestUsable) {
    merged.set(identity, entry.limits);
  }
  for (const [identity, partials] of partialsByIdentity) {
    const combined = overlayPartialExhaustedLimits(bestUsable.get(identity), partials, asOf);
    if (combined) merged.set(identity, combined);
  }
  return merged;
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
): {
  readonly hasUsage: boolean;
  readonly used: number;
  readonly exhausted: boolean;
  readonly exhaustedWindow: ServerProviderUsageWindow | undefined;
} {
  const rawWindows = limits?.windows ?? [];
  const applicable = rawWindows.filter((window) =>
    windowAppliesToModel(driver, rawWindows, window, model),
  );
  if (applicable.length === 0) {
    return { hasUsage: false, used: 0, exhausted: false, exhaustedWindow: undefined };
  }
  let used = 0;
  let exhaustedWindow: ServerProviderUsageWindow | undefined;
  const cursorAuto =
    driver === "cursor" && CURSOR_AUTO_MODEL_PATTERN.test(model)
      ? {
          auto: applicable.find((window) => window.id === "autoPercentUsed"),
          api: applicable.find((window) => window.id === "apiPercentUsed"),
        }
      : null;
  if (cursorAuto?.auto && cursorAuto.api) {
    used = Math.min(windowUsedAt(cursorAuto.auto, asOf), windowUsedAt(cursorAuto.api, asOf));
    exhaustedWindow = used >= 100 ? cursorAuto.api : undefined;
  } else {
    for (const window of applicable) {
      const windowUsed = windowUsedAt(window, asOf);
      if (windowUsed > used) used = windowUsed;
      if (!exhaustedWindow && windowUsed >= 100) exhaustedWindow = window;
    }
  }
  const exhausted = used >= 100;
  // Partial `unavailable` (e.g. probeFailed) reports still flag exhaustion, never outrank known room.
  if (limits?.unavailable !== undefined) {
    return { hasUsage: false, used: 0, exhausted, exhaustedWindow };
  }
  return { hasUsage: true, used, exhausted, exhaustedWindow };
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
  /** Optional wall-clock reference used for window resets instead of skewed `checkedAt` timestamps. */
  readonly now?: number;
}

/**
 * Picks the marked account with the most model-applicable usage left (known usage before silent,
 * then least recently started canonical account), skipping exhausted accounts while another has room.
 */
export function chooseRotatedProviderInstance(input: AccountRotationInput): ProviderInstanceId {
  const { selection, project } = input;
  const asOf = resolveAsOf(input.providers, input.now);
  // Merge freshest alias usage from machine-enabled providers before applying project enablement.
  const identities = resolveAccountIdentities(input.providers.map(providerIdentityInput));
  const sharedLimits = resolveSharedUsageLimits(input.providers, identities, asOf);

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

  const candidates = startable.map((provider) => {
    const identity = identities.get(provider.instanceId) ?? `instance:${provider.instanceId}`;
    const limits = sharedLimits.get(identity) ?? provider.usageLimits;
    const canonicalModel = resolveModelSlug(provider, selection.model) ?? selection.model;
    const usage = summarizeModelUsage(provider.driver, limits, asOf, canonicalModel);
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
 * Resolves the starting model selection for a new thread by rotating both the default and
 * fallback across marked accounts first, then applying usage-limit fallback with consistent
 * alias-merged and model-scoped usage windows.
 */
export function resolveRotatedNewThreadSelection(input: {
  readonly configuredDefaultSelection: ModelSelection | null;
  readonly fallbackDefaultSelection: ModelSelection | null;
  readonly fallbackModelSelection: ModelSelection | null;
  readonly rotation:
    | Partial<Pick<ClientSettings, "accountRotationEnabled" | "accountRotationInstances">>
    | undefined;
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
  const rotationEnabled = rotation?.accountRotationEnabled === true;
  const eligibleInstanceIds = rotationEnabled
    ? new Set(rotation.accountRotationInstances?.[environmentId] ?? [])
    : new Set<ProviderInstanceId>();
  const baseSelection = configuredDefaultSelection ?? fallbackDefaultSelection;
  const rotate = (selection: ModelSelection | null, respectProjectDefault: boolean) => {
    if (
      !selection ||
      !rotationEnabled ||
      eligibleInstanceIds.size === 0 ||
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
  const rotatedFallback = rotate(fallbackModelSelection, false);

  const asOf = resolveAsOf(providers, now);
  const identities = resolveAccountIdentities(providers.map(providerIdentityInput));
  const sharedLimits = resolveSharedUsageLimits(providers, identities, asOf);
  const resolveCanonicalSelection = (selection: ModelSelection | null) => {
    if (!selection) return null;
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    const slug = provider ? resolveModelSlug(provider, selection.model) : null;
    return slug && slug !== selection.model ? { ...selection, model: slug } : selection;
  };
  const canonicalBase = resolveCanonicalSelection(rotatedBase);
  const canonicalFallback = resolveCanonicalSelection(rotatedFallback);
  if (canonicalBase && canonicalFallback) {
    const rawBase = providers.find((entry) => entry.instanceId === canonicalBase.instanceId);
    const rawFallback = providers.find(
      (entry) => entry.instanceId === canonicalFallback.instanceId,
    );
    const baseLimits = rawBase
      ? (sharedLimits.get(identities.get(rawBase.instanceId) ?? `instance:${rawBase.instanceId}`) ??
        rawBase.usageLimits)
      : undefined;
    const fallbackLimits = rawFallback
      ? (sharedLimits.get(
          identities.get(rawFallback.instanceId) ?? `instance:${rawFallback.instanceId}`,
        ) ?? rawFallback.usageLimits)
      : undefined;
    const baseUsage = rawBase
      ? summarizeModelUsage(rawBase.driver, baseLimits, asOf, canonicalBase.model)
      : undefined;
    const fallbackUsage = rawFallback
      ? summarizeModelUsage(rawFallback.driver, fallbackLimits, asOf, canonicalFallback.model)
      : undefined;
    if (
      rawBase &&
      baseUsage?.exhaustedWindow &&
      rawFallback?.enabled &&
      rawFallback.installed &&
      rawFallback.auth.status !== "unauthenticated" &&
      isProviderAvailable(rawFallback) &&
      !fallbackUsage?.exhausted &&
      (!settings ||
        resolveProjectProviderInstanceEnabled(settings, projectId, rawFallback.instanceId))
    ) {
      const provider =
        baseLimits && baseLimits !== rawBase.usageLimits
          ? { ...rawBase, usageLimits: baseLimits }
          : rawBase;
      return {
        selection: rotatedFallback,
        fallback: { provider, resetsAt: baseUsage.exhaustedWindow.resetsAt ?? null },
      };
    }
  }
  return {
    selection: rotatedBase !== baseSelection ? rotatedBase : configuredDefaultSelection,
    fallback: null,
  };
}
