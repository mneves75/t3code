import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { followDefaultModelInOpenDrafts } from "./seedDraftModelSelection";

const devbox = EnvironmentId.make("environment-devbox");
const laptop = EnvironmentId.make("environment-laptop");
const mugshot = ProjectId.make("project-mugshot");
const kiosk = ProjectId.make("project-kiosk");
const pinned = ProjectId.make("project-pinned");

const replay = createModelSelection(ProviderInstanceId.make("devReplay"), "showcase");
const local = createModelSelection(ProviderInstanceId.make("pi-devbox"), "devbox/qwen3-4b");
const ownDefault = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");

function openDraft(
  id: string,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  selection: ModelSelection,
  explicit = false,
) {
  const draftId = DraftId.make(id);
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId: ThreadId.make(`thread-${id}`),
  });
  store.setModelSelection(draftId, selection, { explicit, replaceOptions: true });
  return draftId;
}

const shownModel = (draftId: DraftId) => {
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  return draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : undefined;
};

describe("followDefaultModelInOpenDrafts", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyOptionsByModelByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("moves an open draft nobody picked a model for to the machine's new default", () => {
    const seeded = openDraft("seeded", devbox, mugshot, replay);
    const picked = openDraft("picked", devbox, kiosk, replay, true);
    const elsewhere = openDraft("elsewhere", laptop, mugshot, replay);
    const ownProject = openDraft("own-project", devbox, pinned, replay);

    followDefaultModelInOpenDrafts(devbox, {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: local,
      projectSettingsOverrides: { [pinned]: { defaultModelSelection: ownDefault } },
    });

    expect(shownModel(seeded)).toEqual(local);
    expect(shownModel(picked)).toEqual(replay);
    expect(shownModel(elsewhere)).toEqual(replay);
    expect(shownModel(ownProject)).toEqual(ownDefault);
  });
});
