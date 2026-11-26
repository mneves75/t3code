import { resolveRotatedNewThreadSelection } from "@t3tools/client-runtime/account-rotation";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { readProject, readThreadShells } from "../state/entities";
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
  const draftState = useComposerDraftStore.getState();
  const stickySelection =
    draftState.stickyActiveProvider !== null
      ? (draftState.stickyModelSelectionByProvider?.[draftState.stickyActiveProvider] ?? null)
      : null;
  const { selection } = resolveRotatedNewThreadSelection({
    configuredDefaultSelection: defaultSelection,
    fallbackDefaultSelection: defaultSelection
      ? null
      : (stickySelection ??
        (draftState.stickyActiveProvider !== null || !settings
          ? null
          : resolveProjectDefaultProviderModelSelection(
              providers,
              settings,
              projectRef.projectId,
            ))),
    fallbackModelSelection: settings?.fallbackModelSelection ?? null,
    rotation: getClientSettings(),
    // Without environment settings the default is the project's own.
    projectDefaultSource: resolvedProjectSettings?.sources.defaultModelSelection ?? "project",
    environmentId: projectRef.environmentId,
    providers,
    threads: readThreadShells(),
    ...(settings ? { settings } : {}),
    projectId: projectRef.projectId,
    now: Date.now(),
  });
  if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
}

/**
 * An open draft holds the model it was seeded with, so a new default would otherwise reach only
 * drafts opened later. Drafts whose model the user picked keep it.
 */
export function followDefaultModelInOpenDrafts(
  environmentId: EnvironmentId,
  settings: ServerSettings,
): void {
  const store = useComposerDraftStore.getState();
  for (const [rawDraftId, draftThread] of Object.entries(store.draftThreadsByThreadKey)) {
    if (draftThread.environmentId !== environmentId || draftThread.promotedTo != null) continue;
    const draftId = DraftId.make(rawDraftId);
    if (hasExplicitComposerModelSelection(store.getComposerDraft(draftId))) continue;
    const project = readProject(scopeProjectRef(environmentId, draftThread.projectId));
    const selection = resolveProjectSettings(settings, draftThread.projectId, project).settings
      .defaultModelSelection;
    if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
  }
}
