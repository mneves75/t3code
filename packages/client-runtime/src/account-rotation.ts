import {
  type ClientSettings,
  type EnvironmentId,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";

import type { EnvironmentThreadShell } from "./state/models.ts";

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

/** An API key, or a probe that failed with nothing kept, reports no window. */
function reportsUsage(provider: ServerProvider): boolean {
  return (provider.usageLimits?.windows.length ?? 0) > 0;
}

/**
 * How full the account's fullest window is, 0..100. No provider says which
 * window a model draws from, so every window counts. A window that reset
 * before `asOf` holds nothing.
 */
function usedPercent(provider: ServerProvider, asOf: number): number {
  let used = 0;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= asOf) continue;
    used = Math.max(used, window.usedPercent);
  }
  return used;
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
}

/**
 * Picks the marked account with the most usage left (ranked only when all report usage),
 * then the least recently started, passing over exhausted accounts while another has room.
 * Only for unstarted threads: moving a started one is a
 * provider switch. Resets use the environment's latest provider report, not the client clock.
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

  // Turns follow thread starts. Later messages would move an open draft from
  // account to account, and a subagent thread rides on its parent's account.
  const lastStartedAt = new Map<ProviderInstanceId, number>();
  for (const thread of input.threads) {
    if (
      thread.environmentId !== input.environmentId ||
      thread.lineage.relationshipToParent === "subagent"
    ) {
      continue;
    }
    const startedAt = Date.parse(thread.createdAt);
    if (startedAt > (lastStartedAt.get(thread.providerInstanceId) ?? 0)) {
      lastStartedAt.set(thread.providerInstanceId, startedAt);
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
  const asOf = Math.max(
    ...providers
      .flatMap((provider) => [provider.checkedAt, provider.usageLimits?.checkedAt ?? ""])
      .map((checkedAt) => Date.parse(checkedAt))
      .filter((time) => !Number.isNaN(time)),
  );
  const withRoom = startable.filter(
    (candidate) => !exhaustedUsageWindow(candidate, asOf, selection.model),
  );
  const pool = withRoom.length > 0 ? withRoom : startable;
  // One silent account would otherwise look emptier than every account that
  // reports, and take each new thread.
  const rankByUsage = pool.every(reportsUsage);
  let chosen = pool[0] ?? selected;
  for (const candidate of pool) {
    const usage = rankByUsage ? usedPercent(candidate, asOf) - usedPercent(chosen, asOf) : 0;
    const idle =
      (lastStartedAt.get(chosen.instanceId) ?? 0) - (lastStartedAt.get(candidate.instanceId) ?? 0);
    // Only a strictly better account replaces the current pick.
    if (usage < 0 || (usage === 0 && idle > 0)) chosen = candidate;
  }
  return chosen.instanceId;
}

/**
 * The default a new draft starts from, and its usage-limit fallback is judged from, when
 * rotation applies. Thread history is left out; the composer refines the turn order while
 * the draft is empty.
 */
export function rotatedDefaultSelection(input: {
  readonly selection: ModelSelection | null;
  readonly rotation: Pick<ClientSettings, "accountRotationEnabled" | "accountRotationInstances">;
  readonly projectDefaultSource: ResolvedProjectSettings["sources"]["defaultModelSelection"];
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings?: ServerSettings;
  readonly projectId: ProjectId | null;
}): ModelSelection | null {
  const { selection, rotation, environmentId, settings, projectId } = input;
  if (!selection || !rotation.accountRotationEnabled || input.projectDefaultSource === "project") {
    return selection;
  }
  const instanceId = chooseRotatedProviderInstance({
    selection,
    environmentId,
    providers: input.providers,
    eligibleInstanceIds: new Set(rotation.accountRotationInstances[environmentId] ?? []),
    threads: [],
    ...(settings && projectId ? { project: { settings, projectId } } : {}),
  });
  // The same object when the account stays, so a caller can tell a rotation by identity.
  return instanceId === selection.instanceId ? selection : { ...selection, instanceId };
}
