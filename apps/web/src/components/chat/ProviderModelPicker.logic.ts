import type { ProviderDriverKind } from "@t3tools/contracts";

import type { ModelEsque } from "./providerIconUtils";

/** Keeps a hidden model visible while its provider is locked or turned off. */
export function retainedModelWhileProviderLocked(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name" | "shortName" | "subProvider">>;
  } | null,
  model: string,
): ModelEsque | undefined {
  if (!entry || (entry.enabled && entry.isAvailable) || !model) return undefined;
  if (entry.driverKind === "opencode" || entry.driverKind === "antigravity") return undefined;
  return entry.models.find((candidate) => candidate.slug === model) ?? { slug: model, name: model };
}

/** A managed model's name ends with its server's name, as "qwen3 (MLX)"; that ending, or null. */
export function serverSuffixOf(modelName: string, serverName: string | undefined): string | null {
  if (!serverName) return null;
  const suffix = ` (${serverName})`;
  return modelName.length > suffix.length && modelName.endsWith(suffix) ? suffix : null;
}
