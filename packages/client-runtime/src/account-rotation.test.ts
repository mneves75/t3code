import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { chooseRotatedProviderInstance, rotatesAccountsForProject } from "./account-rotation.ts";

const environmentId = EnvironmentId.make("mac");
const work = ProviderInstanceId.make("claudeAgent");
const personal = ProviderInstanceId.make("claudeAgent_personal");
const spare = ProviderInstanceId.make("claudeAgent_spare");
const model = "claude-opus-5-5";

function window(usedPercent: number, resetsAt = "2026-09-03T14:00:00.000Z") {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt,
  } satisfies ServerProviderUsageWindow;
}

function account(
  instanceId: ProviderInstanceId,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [{ slug: model, name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
    ...overrides,
  };
}

function choose(
  providers: ReadonlyArray<ServerProvider>,
  threads: Parameters<typeof chooseRotatedProviderInstance>[0]["threads"] = [],
  selected = work,
) {
  return chooseRotatedProviderInstance({
    selection: { instanceId: selected, model },
    environmentId,
    providers,
    threads,
  });
}

const startedAt = (providerInstanceId: ProviderInstanceId, createdAt: string) => ({
  environmentId,
  providerInstanceId,
  createdAt,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make(`thread-${createdAt}`),
  },
});

describe("rotating a new thread across accounts of one provider", () => {
  it("starts on the account with the most usage left", () => {
    expect(choose([account(work, [window(90)]), account(personal, [window(15)])])).toBe(personal);
  });

  it.each(["claudeAgent", "codex", "cursor"])("treats %s accounts alike", (driver) => {
    const first = ProviderInstanceId.make(driver);
    const second = ProviderInstanceId.make(`${driver}_personal`);
    const of = { driver: ProviderDriverKind.make(driver) };
    const providers = [account(first, [window(90)], of), account(second, [window(15)], of)];
    expect(choose(providers, [], first)).toBe(second);
    expect(choose(providers, [], second)).toBe(second);
  });

  it("judges an account by its fullest window", () => {
    const weekly = { ...window(95), id: "seven_day", kind: "weekly" as const, label: "Weekly" };
    expect(choose([account(work, [window(40)]), account(personal, [window(5), weekly])])).toBe(
      work,
    );
  });

  it("stops counting a window that reset before the environment's latest report", () => {
    const stale = account(personal, [window(100, "2026-09-03T11:30:00.000Z")]);
    expect(choose([account(work, [window(40)]), stale])).toBe(work);
    expect(
      choose([account(work, [window(40)], { checkedAt: "2026-09-03T12:00:00.000Z" }), stale]),
    ).toBe(personal);
  });

  it("takes turns when accounts report the same usage or none", () => {
    const providers = [account(work, []), account(personal, []), account(spare, [])];
    expect(choose(providers)).toBe(work);
    const first = [startedAt(work, "2026-09-03T09:00:00.000Z")];
    expect(choose(providers, first)).toBe(personal);
    const second = [...first, startedAt(personal, "2026-09-03T10:00:00.000Z")];
    expect(choose(providers, second)).toBe(spare);
    const third = [...second, startedAt(spare, "2026-09-03T11:00:00.000Z")];
    expect(choose(providers, third)).toBe(work);
  });

  it("gives a subagent thread no turn of its own", () => {
    const providers = [account(work, []), account(personal, [])];
    const spawned = startedAt(personal, "2026-09-03T10:00:00.000Z");
    expect(
      choose(providers, [
        startedAt(work, "2026-09-03T09:00:00.000Z"),
        {
          ...spawned,
          lineage: {
            ...spawned.lineage,
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent" as const,
          },
        },
      ]),
    ).toBe(personal);
  });

  it("ignores threads on another environment's account of the same name", () => {
    const providers = [account(work, []), account(personal, [])];
    expect(
      choose(providers, [
        startedAt(work, "2026-09-03T09:00:00.000Z"),
        {
          ...startedAt(personal, "2026-09-03T10:00:00.000Z"),
          environmentId: EnvironmentId.make("vps"),
        },
      ]),
    ).toBe(personal);
  });

  it("skips accounts that cannot run the selected model right now", () => {
    const idle = [window(0)];
    expect(
      choose([
        account(work, [window(80)]),
        account(personal, idle, { enabled: false }),
        account(spare, idle, { auth: { status: "unauthenticated" } }),
        account(ProviderInstanceId.make("claudeAgent_unknown"), idle, {
          auth: { status: "unknown" },
        }),
        account(ProviderInstanceId.make("claudeAgent_broken"), idle, { status: "error" }),
        account(ProviderInstanceId.make("claudeAgent_gone"), idle, {
          availability: "unavailable",
        }),
        account(ProviderInstanceId.make("claudeAgent_sonnet"), idle, {
          models: [
            { slug: "claude-sonnet-5-5", name: "Sonnet", isCustom: false, capabilities: null },
          ],
        }),
        account(ProviderInstanceId.make("codex"), idle, {
          driver: ProviderDriverKind.make("codex"),
        }),
      ]),
    ).toBe(work);
  });

  it.each<[string, Partial<ServerProvider>]>([
    ["signed out", { auth: { status: "unauthenticated" } }],
    ["failing", { status: "error" }],
    ["missing the model", { models: [] }],
  ])("leaves a selected account that is %s for one that can start the thread", (_, broken) => {
    expect(choose([account(work, [window(0)], broken), account(personal, [window(60)])])).toBe(
      personal,
    );
    // With nowhere better to go, the selection stands and the composer reports it.
    expect(
      choose([account(work, [window(0)], broken), account(personal, [window(0)], broken)]),
    ).toBe(work);
  });

  it("never moves a thread onto an account billed outside a subscription", () => {
    const apiKey = ProviderInstanceId.make("claudeAgent_api");
    const metered = {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [],
      unavailable: { reason: "unsupported" as const },
    };
    expect(
      choose([account(work, [window(99)]), account(apiKey, [], { usageLimits: metered })]),
    ).toBe(work);
    // The reverse holds too: a deliberate API-key selection is left alone.
    expect(
      choose(
        [account(work, [window(0)]), account(apiKey, [], { usageLimits: metered })],
        [],
        apiKey,
      ),
    ).toBe(apiKey);
  });

  it("still rotates accounts whose usage could not be read", () => {
    const unread = {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    const providers = [
      account(work, [], { usageLimits: unread }),
      account(personal, [], { usageLimits: unread }),
    ];
    expect(choose(providers, [startedAt(work, "2026-09-03T09:00:00.000Z")])).toBe(personal);
  });

  it("keeps the selection when it is not a configured account", () => {
    expect(choose([account(personal, [window(0)])])).toBe(work);
  });
});

describe("which projects rotate accounts", () => {
  const projectId = ProjectId.make("project");
  const pinned = { instanceId: work, model };

  it("follows the environment setting, including with an environment default model", () => {
    expect(rotatesAccountsForProject(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null))).toBe(
      false,
    );
    expect(
      rotatesAccountsForProject(
        resolveProjectSettings(
          {
            ...DEFAULT_SERVER_SETTINGS,
            rotateProviderAccounts: true,
            defaultModelSelection: pinned,
          },
          projectId,
        ),
      ),
    ).toBe(true);
  });

  it("leaves a project with its own default model on that account", () => {
    expect(
      rotatesAccountsForProject(
        resolveProjectSettings(
          {
            ...DEFAULT_SERVER_SETTINGS,
            rotateProviderAccounts: true,
            projectSettingsOverrides: { [projectId]: { defaultModelSelection: pinned } },
          },
          projectId,
        ),
      ),
    ).toBe(false);
  });
});
