import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { seedDraftModelSelection } from "~/lib/seedDraftModelSelection";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShells } from "~/state/entities";
import { readEnvironmentProviders } from "~/state/environments";
import { environmentServerConfigsAtom } from "~/state/server";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

type ServerConfigEvent = {
  readonly version: 1;
  readonly type: "snapshot";
  readonly config: ServerConfig;
};

const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");

const driverOverride = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  settingsPatch: {} as Partial<ServerSettings>,
  shellThreads: [] as ReadonlyArray<OrchestrationV2ThreadShell>,
  shellSeq: 10,
  latestProjects: [] as ReadonlyArray<OrchestrationProjectShell>,
  configSubscribers: new Set<Queue.Queue<ServerConfigEvent>>(),
  shellSubscribers: new Set<Queue.Queue<OrchestrationV2ShellStreamItem>>(),
  latestBaseConfig: null as ServerConfig | null,
  transform(config: ServerConfig): ServerConfig {
    this.latestBaseConfig = config;
    return {
      ...config,
      providers: (this.providers ?? config.providers) as ServerConfig["providers"],
      settings: {
        ...config.settings,
        ...this.settingsPatch,
      },
    };
  },
  pushConfig(next: {
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly settingsPatch?: Partial<ServerSettings>;
  }) {
    if (next.providers !== undefined) this.providers = next.providers;
    if (next.settingsPatch !== undefined) this.settingsPatch = next.settingsPatch;
    if (!this.latestBaseConfig) return;
    const event: ServerConfigEvent = {
      version: 1,
      type: "snapshot",
      config: this.transform(this.latestBaseConfig),
    };
    for (const queue of this.configSubscribers) Queue.offerUnsafe(queue, event);
  },
  pushShell(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
    this.shellThreads = threads;
    if (this.latestProjects.length === 0) return;
    this.shellSeq += 1;
    const seq = this.shellSeq;
    const items: ReadonlyArray<OrchestrationV2ShellStreamItem> = [
      {
        kind: "snapshot",
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: seq,
          projects: this.latestProjects,
          threads,
          archivedThreads: [],
        },
      },
      { kind: "synchronized" },
    ];
    for (const queue of this.shellSubscribers) Queue.offerAllUnsafe(queue, items);
  },
  reset() {
    this.providers = null;
    this.settingsPatch = {};
    this.shellThreads = [];
  },
}));

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  const wrappedDriver: FakeDriver = {
    ...fakeDriver,
    connect: (entry) =>
      fakeDriver.connect(entry).pipe(
        Effect.map((lease) => {
          const clientProxy = new Proxy(lease.session.client, {
            get(target, prop, receiver) {
              if (prop === ORCHESTRATION_V2_WS_METHODS.subscribeShell) {
                return (input: never) =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const upstream = (
                        target[ORCHESTRATION_V2_WS_METHODS.subscribeShell] as unknown as (
                          i: never,
                        ) => Stream.Stream<OrchestrationV2ShellStreamItem>
                      )(input);
                      const initialItems = yield* upstream.pipe(
                        Stream.takeUntil((item) => item.kind === "synchronized"),
                        Stream.runCollect,
                      );
                      for (const item of initialItems) {
                        if (item.kind === "snapshot") {
                          driverOverride.latestProjects = item.snapshot.projects;
                        }
                      }
                      const queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
                      driverOverride.shellSubscribers.add(queue);
                      yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                          driverOverride.shellSubscribers.delete(queue);
                        }),
                      );
                      driverOverride.shellSeq += 1;
                      yield* Queue.offerAll(queue, [
                        {
                          kind: "snapshot",
                          snapshot: {
                            schemaVersion: 1,
                            snapshotSequence: driverOverride.shellSeq,
                            projects: driverOverride.latestProjects,
                            threads: driverOverride.shellThreads,
                            archivedThreads: [],
                          },
                        },
                        { kind: "synchronized" },
                      ]);
                      return Stream.fromQueue(queue);
                    }),
                  );
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return {
            ...lease,
            session: {
              ...lease.session,
              client: clientProxy,
              initialConfig: lease.session.initialConfig.pipe(
                Effect.map((config) => driverOverride.transform(config)),
              ),
              subscribeServerConfig: (() =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    const base = yield* lease.session.initialConfig;
                    const queue = yield* Queue.unbounded<ServerConfigEvent>();
                    driverOverride.configSubscribers.add(queue);
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        driverOverride.configSubscribers.delete(queue);
                      }),
                    );
                    yield* Queue.offer(queue, {
                      version: 1,
                      type: "snapshot",
                      config: driverOverride.transform(base),
                    });
                    return Stream.fromQueue(queue);
                  }),
                )) as unknown as typeof lease.session.subscribeServerConfig,
            },
          };
        }),
      ),
  };
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, wrappedDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const CODEX_A = ProviderInstanceId.make("codex");
const CODEX_B = ProviderInstanceId.make("codex_personal");
const CLAUDE_A = ProviderInstanceId.make("claudeAgent");
const CUSTOM_INSTANCES = {
  [CODEX_B]: { driver: ProviderDriverKind.make("codex"), enabled: true },
};

function providerWithUsage(
  base: typeof CODEX_PROVIDER | typeof CLAUDE_PROVIDER,
  instanceId: ProviderInstanceId,
  usedPercent: number,
  displayName?: string,
): ServerProvider {
  const checkedAt = "2026-03-17T19:12:28.000Z";
  return {
    ...(base as unknown as ServerProvider),
    slashCommands: "slashCommands" in base ? base.slashCommands : [],
    skills: [],
    instanceId,
    ...(displayName ? { displayName } : {}),
    checkedAt,
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  };
}

function makeShellThread(
  id: string,
  modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string },
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: AT,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: AT,
    deletedAt: null,
  };
}

function captureLaunches() {
  const calls: Array<{
    readonly modelSelection: { readonly instanceId: string; readonly model: string };
  }> = [];
  const disposable = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    (input: (typeof calls)[number]) => {
      calls.push(input);
      return Effect.never;
    },
  );
  return { calls, [Symbol.dispose]: () => disposable[Symbol.dispose]() };
}

async function mountWithSyncedEnvironment(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settingsPatch: Partial<ServerSettings>;
  readonly shellThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly initialRoute?: string;
}) {
  driverOverride.providers = input.providers;
  driverOverride.settingsPatch = input.settingsPatch;
  driverOverride.shellThreads = input.shellThreads ?? [];

  const router = getRouter(
    createMemoryHistory({ initialEntries: [input.initialRoute ?? "/settings/general"] }),
  );
  await router.load();
  const rendered = await render(<AppRoot router={router} />, { router: false });

  await vi.waitFor(
    () => {
      expect(driverOverride.configSubscribers.size).toBeGreaterThan(0);
      expect(driverOverride.shellSubscribers.size).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
  driverOverride.pushConfig({
    providers: input.providers,
    settingsPatch: input.settingsPatch,
  });
  driverOverride.pushShell(input.shellThreads ?? []);
  await vi.waitFor(
    () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(ENVIRONMENT_ID);
      expect(config).toBeDefined();
      expect(readEnvironmentProviders(ENVIRONMENT_ID)?.length).toBe(input.providers.length);
      if ("defaultModelSelection" in input.settingsPatch) {
        expect(config?.settings.defaultModelSelection).toEqual(
          input.settingsPatch.defaultModelSelection,
        );
      }
      if ("fallbackModelSelection" in input.settingsPatch) {
        expect(config?.settings.fallbackModelSelection).toEqual(
          input.settingsPatch.fallbackModelSelection,
        );
      }
      expect(readThreadShells().map((t) => t.id)).toEqual(
        (input.shellThreads ?? []).map((t) => t.id),
      );
    },
    { timeout: 5_000 },
  );

  return { router, rendered };
}

function useRotationTestScope() {
  localStorage.clear();
  sessionStorage.clear();
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  driverOverride.reset();
  return {
    [Symbol.dispose]() {
      driverOverride.reset();
      useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    },
  };
}

describe("ChatView account rotation integration", () => {
  it("applies fallbackModelSelection to an open empty draft whose non-explicit activeProvider was seeded by rotation", async () => {
    using _scope = useRotationTestScope();
    const codexA = providerWithUsage(CODEX_PROVIDER, CODEX_A, 90, "Codex Work");
    const codexB = providerWithUsage(CODEX_PROVIDER, CODEX_B, 10, "Codex Personal");
    const claude = providerWithUsage(CLAUDE_PROVIDER, CLAUDE_A, 0, "Claude");
    using _environment = installFakeEnvironment([], {
      acceptCommands: true,
      providers: [codexA, codexB, claude],
    });
    using launches = captureLaunches();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      accountRotationEnabled: true,
      accountRotationInstances: { [ENVIRONMENT_ID]: [CODEX_A, CODEX_B] },
    });

    const { router, rendered } = await mountWithSyncedEnvironment({
      providers: [codexA, codexB, claude],
      settingsPatch: {
        providerInstances: CUSTOM_INSTANCES,
        defaultThreadEnvMode: "local",
        defaultModelSelection: { instanceId: CODEX_A, model: "gpt-5.4" },
        fallbackModelSelection: { instanceId: CLAUDE_A, model: "claude-opus-4-6" },
      },
    });
    await using _app = rendered;

    await router.navigate({ to: "/" });
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();
    await vi.waitFor(
      () => {
        const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadKey);
        expect(drafts.some((draft) => draft.activeProvider === CODEX_B)).toBe(true);
      },
      { timeout: 5_000 },
    );

    driverOverride.pushConfig({
      providers: [
        providerWithUsage(CODEX_PROVIDER, CODEX_A, 100, "Codex Work"),
        providerWithUsage(CODEX_PROVIDER, CODEX_B, 100, "Codex Personal"),
        claude,
      ],
    });
    await vi.waitFor(() => {
      const updated = readEnvironmentProviders(ENVIRONMENT_ID)?.find(
        (provider) => provider.instanceId === CODEX_B,
      );
      expect(updated?.usageLimits?.windows[0]?.usedPercent).toBe(100);
    });

    await userEvent.click(editor);
    await userEvent.keyboard("Fallback when rotated draft runs out{Enter}");
    await vi.waitFor(() => expect(launches.calls).toHaveLength(1));

    expect(launches.calls[0]!.modelSelection).toEqual({
      instanceId: CLAUDE_A,
      model: "claude-opus-4-6",
    });
  });

  it("applies fallbackModelSelection on a new draft even when stickyActiveProvider remembers the exhausted provider", async () => {
    using _scope = useRotationTestScope();
    const codexA = providerWithUsage(CODEX_PROVIDER, CODEX_A, 100, "Codex Work");
    const codexB = providerWithUsage(CODEX_PROVIDER, CODEX_B, 100, "Codex Personal");
    const claude = providerWithUsage(CLAUDE_PROVIDER, CLAUDE_A, 0, "Claude");
    using _environment = installFakeEnvironment([], {
      acceptCommands: true,
      providers: [codexA, codexB, claude],
    });
    using launches = captureLaunches();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      accountRotationEnabled: true,
      accountRotationInstances: { [ENVIRONMENT_ID]: [CODEX_A, CODEX_B] },
    });

    const { router, rendered } = await mountWithSyncedEnvironment({
      providers: [codexA, codexB, claude],
      settingsPatch: {
        providerInstances: CUSTOM_INSTANCES,
        defaultThreadEnvMode: "local",
        defaultModelSelection: null,
        fallbackModelSelection: { instanceId: CLAUDE_A, model: "claude-opus-4-6" },
      },
    });
    await using _app = rendered;

    useComposerDraftStore.getState().setStickyModelSelection({
      instanceId: CODEX_A,
      model: "gpt-5.4",
    });
    await router.navigate({ to: "/" });
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();

    await userEvent.click(editor);
    await userEvent.keyboard("Sticky fallback check{Enter}");
    await vi.waitFor(() => expect(launches.calls).toHaveLength(1));

    expect(launches.calls[0]!.modelSelection).toEqual({
      instanceId: CLAUDE_A,
      model: "claude-opus-4-6",
    });
  });

  it("rotates tied fallback accounts by thread history in ChatView even when the exhausted default comes from project settings", async () => {
    using _scope = useRotationTestScope();
    const existingCodexShell = makeShellThread("existing-codex", {
      instanceId: CODEX_A,
      model: "gpt-5.4",
    });
    const claude = providerWithUsage(CLAUDE_PROVIDER, CLAUDE_A, 100, "Claude");
    const codexA = providerWithUsage(CODEX_PROVIDER, CODEX_A, 20, "Codex Work");
    const codexB = providerWithUsage(CODEX_PROVIDER, CODEX_B, 20, "Codex Personal");
    using _environment = installFakeEnvironment(
      [threadWithHistory("existing-codex", 1, { instanceId: CODEX_A, model: "gpt-5.4" })],
      {
        acceptCommands: true,
        providers: [claude, codexA, codexB],
      },
    );
    using launches = captureLaunches();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      accountRotationEnabled: true,
      accountRotationInstances: { [ENVIRONMENT_ID]: [CLAUDE_A, CODEX_A, CODEX_B] },
    });

    const { router, rendered } = await mountWithSyncedEnvironment({
      providers: [claude, codexA, codexB],
      settingsPatch: {
        providerInstances: CUSTOM_INSTANCES,
        defaultModelSelection: null,
        fallbackModelSelection: { instanceId: CODEX_A, model: "gpt-5.4" },
        projectSettingsOverrides: {
          [PROJECT_ID]: {
            defaultModelSelection: { instanceId: CLAUDE_A, model: "claude-opus-4-6" },
          },
        },
      },
      shellThreads: [existingCodexShell],
    });
    await using _app = rendered;

    const draftId = DraftId.make("draft-project-fallback-rotation");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
        threadId: ThreadId.make("thread-project-fallback-rotation"),
      });

    await router.navigate({ to: "/draft/$draftId", params: { draftId } });
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();

    await userEvent.click(editor);
    await userEvent.keyboard("Fallback least recently started{Enter}");
    await vi.waitFor(() => expect(launches.calls).toHaveLength(1));

    expect(launches.calls[0]!.modelSelection).toEqual({
      instanceId: CODEX_B,
      model: "gpt-5.4",
    });
  });

  it("rotates away from high-usage stickyActiveProvider when seeding a draft that already has content", async () => {
    using _scope = useRotationTestScope();
    const codexA = providerWithUsage(CODEX_PROVIDER, CODEX_A, 90, "Codex Work");
    const codexB = providerWithUsage(CODEX_PROVIDER, CODEX_B, 10, "Codex Personal");
    using _environment = installFakeEnvironment([], {
      acceptCommands: true,
      providers: [codexA, codexB],
    });
    using launches = captureLaunches();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      accountRotationEnabled: true,
      accountRotationInstances: { [ENVIRONMENT_ID]: [CODEX_A, CODEX_B] },
    });

    const { router, rendered } = await mountWithSyncedEnvironment({
      providers: [codexA, codexB],
      settingsPatch: {
        providerInstances: CUSTOM_INSTANCES,
        defaultModelSelection: null,
        fallbackModelSelection: null,
        projectSettingsOverrides: {},
      },
    });
    await using _app = rendered;

    const draftId = DraftId.make("draft-seeded-with-content");
    const projectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
    const store = useComposerDraftStore.getState();
    store.setStickyModelSelection({ instanceId: CODEX_A, model: "gpt-5.4" });
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId: ThreadId.make("thread-seeded-with-content"),
    });
    store.setPrompt(draftId, "Pre-populated prompt");

    await router.navigate({ to: "/draft/$draftId", params: { draftId } });
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toBeVisible();
    seedDraftModelSelection(draftId, projectRef);

    await userEvent.click(editor);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(launches.calls).toHaveLength(1));

    expect(launches.calls[0]!.modelSelection).toEqual({
      instanceId: CODEX_B,
      model: "gpt-5.4",
    });
  });
});
