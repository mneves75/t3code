import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chooseRotatedProviderInstance } from "./account-rotation.ts";

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
  latestUserMessageAt: null,
});

describe("rotating a new thread across accounts of one provider", () => {
  it("starts on the account with the most usage left", () => {
    expect(choose([account(work, [window(90)]), account(personal, [window(15)])])).toBe(personal);
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

  it("counts a message sent to an older thread as use of that account", () => {
    const providers = [account(work, []), account(personal, [])];
    expect(
      choose(providers, [
        {
          ...startedAt(work, "2026-09-01T09:00:00.000Z"),
          latestUserMessageAt: "2026-09-03T11:00:00.000Z",
        },
        startedAt(personal, "2026-09-03T10:00:00.000Z"),
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
