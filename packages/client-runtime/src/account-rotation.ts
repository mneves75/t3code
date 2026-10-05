import {
  type EnvironmentId,
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";

import type { EnvironmentThreadShell } from "./state/models.ts";

/**
 * Whether new threads in this project rotate accounts. A project's own default
 * model names the account it wants, so rotation leaves that project alone.
 */
export function rotatesAccountsForProject(
  project: Pick<ResolvedProjectSettings, "settings" | "sources">,
): boolean {
  return (
    project.settings.rotateProviderAccounts && project.sources.defaultModelSelection !== "project"
  );
}

/**
 * Billed to a subscription. An account that can never report usage is billed
 * elsewhere (API key, Bedrock, a proxy), so it is neither rotated away from
 * nor onto. An account connected with ChatGPT reports none either, because
 * ChatGPT keeps that usage to itself, yet it is a subscription like the rest.
 */
function isSubscriptionAccount(provider: ServerProvider): boolean {
  return (
    provider.usageLimits !== undefined &&
    (provider.usageLimits.unavailable?.reason !== "unsupported" || usesChatGptSharing(provider))
  );
}

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

/**
 * How full the account's fullest window is, 0..100. No provider says which
 * window a model draws from, so every window counts. A window that reset
 * before `asOf` holds nothing, and an account that reports no window is taken
 * as empty: its turn then comes from thread starts alone.
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
  /** May span environments; instance ids repeat across machines, so only `environmentId`'s count. */
  readonly threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId" | "createdAt" | "lineage">
  >;
}

/**
 * The account a new thread should start on when the user left that choice to
 * T3: among the accounts of the selected provider that offer the selected
 * model, the one with the most usage left, then the one whose last thread was
 * started longest ago.
 *
 * Only for a thread that has not started. Moving a started thread to another
 * account is a provider switch, which is the user's call.
 *
 * Resets are judged against the environment's latest provider report, not the
 * client's clock, which need not agree with the server's.
 */
export function chooseRotatedProviderInstance(input: AccountRotationInput): ProviderInstanceId {
  const { selection, providers } = input;
  const selected = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (selected === undefined || !isSubscriptionAccount(selected)) {
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

  const asOf = Math.max(...providers.map((provider) => Date.parse(provider.checkedAt)));
  // A selection that cannot start the thread gives way to any account that can.
  let chosen = canStart(selected, selection.model) ? selected : null;
  for (const candidate of providers) {
    if (
      candidate === selected ||
      candidate.driver !== selected.driver ||
      !isSubscriptionAccount(candidate) ||
      !canStart(candidate, selection.model)
    ) {
      continue;
    }
    if (chosen === null) {
      chosen = candidate;
      continue;
    }
    const usage = usedPercent(candidate, asOf) - usedPercent(chosen, asOf);
    const idle =
      (lastStartedAt.get(chosen.instanceId) ?? 0) - (lastStartedAt.get(candidate.instanceId) ?? 0);
    // Only a strictly better account replaces the current pick, so a full tie
    // keeps the selection and then the provider list's own order.
    if (usage < 0 || (usage === 0 && idle > 0)) chosen = candidate;
  }
  return (chosen ?? selected).instanceId;
}
