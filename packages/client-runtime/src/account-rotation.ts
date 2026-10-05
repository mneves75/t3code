import {
  type EnvironmentId,
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/**
 * A subscription account that can start a thread on `model` right now. An
 * account that can never report usage is billed outside a subscription (API
 * key, Bedrock, a proxy), so it is neither rotated away from nor onto.
 */
function canRotate(provider: ServerProvider, model: string): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.auth.status === "authenticated" &&
    provider.usageLimits !== undefined &&
    provider.usageLimits.unavailable?.reason !== "unsupported" &&
    provider.models.some((candidate) => candidate.slug === model)
  );
}

/**
 * How full the account's fullest window is, 0..100. No provider says which
 * window a model draws from, so every window counts. A window that reset
 * before `asOf` holds nothing, and an account that reports no window is taken
 * as empty: its turn then comes from `threads` alone.
 */
function usedPercent(provider: ServerProvider, asOf: number): number {
  let used = 0;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= asOf) continue;
    used = Math.max(used, window.usedPercent);
  }
  return used;
}

/**
 * The account a new thread should start on when the user left that choice to
 * T3: among the accounts of the selected provider that offer the selected
 * model, the one with the most usage left, then the one used longest ago.
 *
 * Callers pass the environment's providers, and only for a thread that has
 * not started. Moving a started thread to another account is a provider
 * switch, which is the user's call. `threads` may span environments: instance
 * ids repeat across machines, so only `environmentId`'s threads count.
 *
 * Resets are judged against the environment's latest provider report, not the
 * client's clock, which need not agree with the server's.
 */
export function chooseRotatedProviderInstance(input: {
  readonly selection: Pick<ModelSelection, "instanceId" | "model">;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "providerInstanceId" | "createdAt" | "latestUserMessageAt"
    >
  >;
}): ProviderInstanceId {
  const { selection, providers } = input;
  const selected = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (selected === undefined || !canRotate(selected, selection.model)) {
    return selection.instanceId;
  }

  const lastUsedAt = new Map<ProviderInstanceId, number>();
  for (const thread of input.threads) {
    if (thread.environmentId !== input.environmentId) continue;
    const usedAt = Date.parse(thread.latestUserMessageAt ?? thread.createdAt);
    if (usedAt > (lastUsedAt.get(thread.providerInstanceId) ?? 0)) {
      lastUsedAt.set(thread.providerInstanceId, usedAt);
    }
  }

  const asOf = Math.max(...providers.map((provider) => Date.parse(provider.checkedAt)));
  let chosen = selected;
  for (const candidate of providers) {
    if (
      candidate === selected ||
      candidate.driver !== selected.driver ||
      !canRotate(candidate, selection.model)
    ) {
      continue;
    }
    const usage = usedPercent(candidate, asOf) - usedPercent(chosen, asOf);
    const idle =
      (lastUsedAt.get(chosen.instanceId) ?? 0) - (lastUsedAt.get(candidate.instanceId) ?? 0);
    // Only a strictly better account replaces the current pick, so a full tie
    // keeps the selection and then the provider list's own order.
    if (usage < 0 || (usage === 0 && idle > 0)) chosen = candidate;
  }
  return chosen.instanceId;
}
