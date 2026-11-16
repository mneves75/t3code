import type { ScopedProjectRef } from "@t3tools/contracts";
import { rotatedDefaultSelection } from "@t3tools/client-runtime/account-rotation";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { readProject } from "../state/entities";
import { readEnvironment, readEnvironmentProviders } from "../state/environments";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

/** Gives a draft that moved project or machine the model a new thread there would start with. */
export function seedDraftModelSelection(draftId: DraftId, projectRef: ScopedProjectRef): void {
  const store = useComposerDraftStore.getState();
  if (hasExplicitComposerModelSelection(store.getComposerDraft(draftId))) return;
  store.applyStickyState(draftId);
  const project = readProject(projectRef);
  const settings = readEnvironment(projectRef.environmentId)?.serverConfig?.settings;
  const providers = readEnvironmentProviders(projectRef.environmentId) ?? [];
  const resolvedProjectSettings = settings
    ? resolveProjectSettings(settings, projectRef.projectId, project ?? undefined)
    : null;
  const defaultSelection = resolvedProjectSettings
    ? resolvedProjectSettings.settings.defaultModelSelection
    : (project?.defaultModelSelection ?? null);
  const baseSelection =
    defaultSelection ??
    (useComposerDraftStore.getState().stickyActiveProvider !== null || !settings
      ? null
      : resolveProjectDefaultProviderModelSelection(providers, settings, projectRef.projectId));
  const rotatedSelection = rotatedDefaultSelection({
    selection: baseSelection,
    rotation: getClientSettings(),
    // Without environment settings the default is the project's own.
    projectDefaultSource: resolvedProjectSettings?.sources.defaultModelSelection ?? "project",
    environmentId: projectRef.environmentId,
    providers,
    ...(settings ? { settings } : {}),
    projectId: projectRef.projectId,
  });
  const resolution = resolveNewThreadModelSelection({
    defaultSelection: rotatedSelection,
    fallbackSelection: settings?.fallbackModelSelection ?? null,
    providers,
    ...(settings ? { settings } : {}),
    projectId: projectRef.projectId,
    now: Date.now(),
  });
  const selection = resolution.fallback
    ? resolution.selection
    : rotatedSelection !== baseSelection
      ? rotatedSelection
      : defaultSelection;
  if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
}
