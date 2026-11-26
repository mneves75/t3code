import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type InferenceServerSnapshot,
  type InferenceServerStatus,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  collectLocalUsageModels,
  isLocalUsageModel,
  type ModelTotals,
} from "@t3tools/shared/usageMerge";
import { Atom } from "effect/reactivity";

function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

export function providerInstanceInitials(label: string): string {
  // Punctuation separates words so "Codex (hub)" reads CH, not C(. An apostrophe
  // inside a word stays ("Theo's Codex" is TC); a quoting one does not
  // ("Codex 'hub'" is CH). A single camel-case word splits at its humps, so
  // "ClaudeProx" is CP, but "ClaudeProx Work" keeps its own words and is CW.
  const toWords = (text: string) =>
    text
      .split(/\s+/u)
      .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
      .filter(Boolean);
  let words = toWords(label.replace(/[^\P{P}'’]+/gu, " "));
  if (words.length === 1) words = toWords(words[0]!.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

export function providerAccentForegroundColor(accentColor: string) {
  const linearChannel = (offset: number) => {
    const value = Number.parseInt(accentColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  }>,
): boolean {
  if (normalizeProviderAccentColor(entry.accentColor)) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    // Historical threads still need to distinguish accounts that are all disabled.
    if (entry.enabled && !candidate.enabled) continue;
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}

export const INFERENCE_SERVER_STATUS_LABELS: Readonly<Record<InferenceServerStatus, string>> = {
  checking: "Checking",
  ready: "Ready",
  unreachable: "Unreachable",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- existing server-status English label; no behavior change in this cleanup
  error: "Error",
};

/**
 * Where an instance's models run: "Pi · rtx · Ready" for one linked to a known inference server,
 * "Pi · Local" for one marked local by hand.
 */
export function providerInstanceInferenceLabel(
  displayName: string,
  snapshot: Pick<ServerProvider, "inference" | "inferenceServerId">,
  inferenceServers: ReadonlyArray<InferenceServerSnapshot> | null | undefined,
): string {
  const server =
    snapshot.inferenceServerId === undefined
      ? undefined
      : inferenceServers?.find((candidate) => candidate.id === snapshot.inferenceServerId);
  if (server) {
    const status = server.enabled ? INFERENCE_SERVER_STATUS_LABELS[server.status] : "Disabled";
    const place = ` · ${server.displayName}`;
    const name = displayName.endsWith(place) ? displayName : `${displayName}${place}`;
    return `${name} · ${status}`;
  }
  // oxlint-disable-next-line t3code/no-untranslated-copy -- existing local-provider English label; no behavior change in this cleanup
  return snapshot.inference === "local" ? `${displayName} · Local` : displayName;
}

/** Model keys that run on the user's own servers, from collectLocalUsageModels. */
export type LocalUsageModels = ReadonlySet<string>;

/**
 * How Usage shows a model's cost: "estimate" when the server priced local runs from a price the
 * user set (what the same tokens would cost from an API), "local" for other local models, null
 * for any other model.
 */
export function localUsageModelCost(
  model: Pick<ModelTotals, "model" | "estimatedCostUsd">,
  localModels: LocalUsageModels,
): "local" | "estimate" | null {
  if (model.estimatedCostUsd > 0) return "estimate";
  return isLocalUsageModel(model.model, localModels) ? "local" : null;
}

/** Local models across the environments (ids as a JSON array), for the Usage page of each client. */
export function makeLocalUsageModelsAtom(server: {
  readonly providersValueAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<ServerProvider> | null>;
  readonly inferenceServersValueAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<InferenceServerSnapshot> | null>;
}) {
  return Atom.family((idsJson: string) =>
    Atom.make((get): LocalUsageModels => {
      const local = new Set<string>();
      for (const id of JSON.parse(idsJson) as EnvironmentId[]) {
        collectLocalUsageModels(
          get(server.providersValueAtom(id)) ?? [],
          get(server.inferenceServersValueAtom(id)) ?? [],
          local,
        );
      }
      return local;
    }).pipe(Atom.withLabel(`local-usage-models:${idsJson}`)),
  );
}
