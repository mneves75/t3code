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
import { describe, expect, it } from "vite-plus/test";

import {
  chooseRotatedProviderInstance,
  resolveRotatedNewThreadSelection,
} from "./account-rotation.ts";

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

/** Every account is marked for rotation unless a case names the marked ones. */
function choose(
  providers: ReadonlyArray<ServerProvider>,
  threads: Parameters<typeof chooseRotatedProviderInstance>[0]["threads"] = [],
  selected = work,
  marked: ReadonlyArray<ProviderInstanceId> = providers.map((provider) => provider.instanceId),
  options: { readonly model?: string; readonly now?: number } = {},
) {
  return chooseRotatedProviderInstance({
    selection: { instanceId: selected, model: options.model ?? model },
    environmentId,
    providers,
    eligibleInstanceIds: new Set(marked),
    threads,
    ...(options.now !== undefined ? { now: options.now } : {}),
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
  it.each([true, false])("honors project enablement when machine enablement is %s", (enabled) => {
    const projectId = ProjectId.make("project-a");
    const providers = [account(work, [window(90)]), account(personal, [window(15)], { enabled })];
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [work]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
        [personal]: { driver: ProviderDriverKind.make("claudeAgent"), enabled },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [personal]: { enabled: false } } },
        [ProjectId.make("other")]: { providerInstances: { [personal]: { enabled: true } } },
      },
    };
    const input = {
      selection: { instanceId: work, model },
      environmentId,
      providers,
      eligibleInstanceIds: new Set([work, personal]),
      threads: [],
      project: { settings, projectId },
    };
    expect(chooseRotatedProviderInstance(input)).toBe(work);
    expect(
      chooseRotatedProviderInstance({
        ...input,
        project: { settings, projectId: ProjectId.make("other") },
      }),
    ).toBe(personal);
  });

  it("judges an account by its fullest applicable window", () => {
    const weekly = { ...window(95), id: "seven_day", kind: "weekly" as const, label: "Weekly" };
    expect(choose([account(work, [window(40)]), account(personal, [window(5), weekly])])).toBe(
      work,
    );
  });

  it("scopes windows to the selected model across Claude, Antigravity, Cursor, Codex, and OpenCode", () => {
    // Claude: seven_day_fable applies only to fable models, not opus.
    const fableModel = "claude-fable-5-1";
    const bothModels = [
      { slug: model, name: "Opus", isCustom: false, capabilities: null },
      { slug: fableModel, name: "Fable", isCustom: false, capabilities: null },
    ];
    const claudeA = account(
      work,
      [
        { ...window(20), id: "seven_day", kind: "weekly", label: "Weekly" },
        { ...window(100), id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable" },
      ],
      { models: bothModels },
    );
    const claudeB = account(
      personal,
      [
        { ...window(60), id: "seven_day", kind: "weekly", label: "Weekly" },
        { ...window(10), id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable" },
      ],
      { models: bothModels },
    );
    expect(choose([claudeA, claudeB], [], personal, [work, personal], { model })).toBe(work);
    expect(choose([claudeA, claudeB], [], work, [work, personal], { model: fableModel })).toBe(
      personal,
    );

    // Antigravity: gemini quota does not penalize claude models, and 3p quota does not penalize gemini.
    const agA = ProviderInstanceId.make("antigravity_a");
    const agB = ProviderInstanceId.make("antigravity_b");
    const agModels = [
      { slug: "gemini-3.8-pro", name: "Gemini", isCustom: false, capabilities: null },
      { slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null },
    ];
    const agProviders = [
      account(
        agA,
        [
          { ...window(95), id: "gemini-weekly", kind: "weekly", label: "Gemini" },
          { ...window(5), id: "3p-weekly", kind: "weekly", label: "3P" },
        ],
        { driver: ProviderDriverKind.make("antigravity"), models: agModels },
      ),
      account(
        agB,
        [
          { ...window(10), id: "gemini-weekly", kind: "weekly", label: "Gemini" },
          { ...window(80), id: "3p-weekly", kind: "weekly", label: "3P" },
        ],
        { driver: ProviderDriverKind.make("antigravity"), models: agModels },
      ),
    ];
    expect(choose(agProviders, [], agB, [agA, agB], { model: "claude-opus-5-5" })).toBe(agA);
    expect(choose(agProviders, [], agA, [agA, agB], { model: "gemini-3.8-pro" })).toBe(agB);

    // Cursor: composer uses min(auto, api) while third-party models use only apiPercentUsed.
    const curA = ProviderInstanceId.make("cursor_a");
    const curB = ProviderInstanceId.make("cursor_b");
    const curModels = [
      { slug: "composer-2.5", name: "Composer", isCustom: false, capabilities: null },
      { slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null },
    ];
    const curProviders = [
      account(
        curA,
        [
          { ...window(100), id: "autoPercentUsed", kind: "monthly", label: "Cursor Models" },
          { ...window(20), id: "apiPercentUsed", kind: "monthly", label: "Other Models" },
          { ...window(90), id: "totalPercentUsed", kind: "monthly", label: "Overall" },
        ],
        { driver: ProviderDriverKind.make("cursor"), models: curModels },
      ),
      account(
        curB,
        [
          { ...window(80), id: "autoPercentUsed", kind: "monthly", label: "Cursor Models" },
          { ...window(80), id: "apiPercentUsed", kind: "monthly", label: "Other Models" },
          { ...window(80), id: "totalPercentUsed", kind: "monthly", label: "Overall" },
        ],
        { driver: ProviderDriverKind.make("cursor"), models: curModels },
      ),
    ];
    expect(choose(curProviders, [], curB, [curA, curB], { model: "composer-2.5" })).toBe(curA);
    expect(choose(curProviders, [], curB, [curA, curB], { model: "claude-opus-5-5" })).toBe(curA);

    // Codex: individual credit cap is ignored when primary/secondary plan windows exist.
    const cxA = ProviderInstanceId.make("codex_a");
    const cxB = ProviderInstanceId.make("codex_b");
    const cxModels = [{ slug: "gpt-6.2-sol", name: "Sol", isCustom: false, capabilities: null }];
    const cxProviders = [
      account(
        cxA,
        [
          { ...window(10), id: "primary", kind: "weekly", label: "Weekly" },
          { ...window(100), id: "individual", kind: "other", label: "Credits" },
        ],
        { driver: ProviderDriverKind.make("codex"), models: cxModels },
      ),
      account(cxB, [{ ...window(60), id: "primary", kind: "weekly", label: "Weekly" }], {
        driver: ProviderDriverKind.make("codex"),
        models: cxModels,
      }),
    ];
    expect(choose(cxProviders, [], cxB, [cxA, cxB], { model: "gpt-6.2-sol" })).toBe(cxA);

    // OpenCode: go_* windows apply only to opencode-go/* models.
    const ocA = ProviderInstanceId.make("opencode_a");
    const ocB = ProviderInstanceId.make("opencode_b");
    const ocModels = [
      { slug: "opencode-go/model", name: "Go", isCustom: false, capabilities: null },
      { slug: "anthropic/claude", name: "Anthropic", isCustom: false, capabilities: null },
    ];
    const ocProviders = [
      account(
        ocA,
        [
          { ...window(100), id: "go_weekly", kind: "weekly", label: "Go" },
          {
            ...window(15),
            id: "anthropic_weekly",
            kind: "weekly",
            label: "Anthropic",
            providerIds: ["anthropic"],
          },
        ],
        { driver: ProviderDriverKind.make("opencode"), models: ocModels },
      ),
      account(
        ocB,
        [
          { ...window(10), id: "go_weekly", kind: "weekly", label: "Go" },
          {
            ...window(70),
            id: "anthropic_weekly",
            kind: "weekly",
            label: "Anthropic",
            providerIds: ["anthropic"],
          },
        ],
        { driver: ProviderDriverKind.make("opencode"), models: ocModels },
      ),
    ];
    expect(choose(ocProviders, [], ocA, [ocA, ocB], { model: "opencode-go/model" })).toBe(ocB);
    expect(choose(ocProviders, [], ocB, [ocA, ocB], { model: "anthropic/claude" })).toBe(ocA);
  });

  it("stops counting a window that reset before the environment's latest report and ignores future-skewed clocks", () => {
    const stale = account(personal, [window(100, "2026-09-03T11:30:00.000Z")]);
    expect(choose([account(work, [window(40)]), stale])).toBe(work);
    expect(
      choose([account(work, [window(40)], { checkedAt: "2026-09-03T12:00:00.000Z" }), stale]),
    ).toBe(personal);

    const checkedAt = "2026-09-03T10:00:00.000Z";
    const isolated = account(personal, [window(100, "2026-09-03T11:00:00.000Z")], {
      checkedAt,
      usageLimits: { checkedAt, windows: [window(100, "2026-09-03T11:00:00.000Z")] },
    });
    const report = (at: string) => ({
      checkedAt,
      usageLimits: { checkedAt: at, windows: [window(20)] },
    });
    // A report at the exact reset time already sees the window empty.
    expect(choose([isolated, account(work, [], report("2026-09-03T11:00:00.000Z"))])).toBe(
      personal,
    );
    // Another driver's report outside the pool still dates the environment.
    const codex = account(spare, [], {
      ...report("2026-09-03T12:00:00.000Z"),
      driver: ProviderDriverKind.make("codex"),
    });
    expect(choose([isolated, account(work, [], report(checkedAt)), codex])).toBe(personal);

    // A slightly or far future-skewed checkedAt does not clear a cap early when `now` is supplied.
    const capped = account(work, [window(100, "2026-09-03T11:02:00.000Z")]);
    const skewedPlus4Min = account(spare, [], {
      driver: ProviderDriverKind.make("codex"),
      checkedAt: "2026-09-03T11:04:00.000Z",
      usageLimits: { checkedAt: "2026-09-03T11:04:00.000Z", windows: [] },
    });
    expect(
      choose(
        [capped, account(personal, [window(45)]), skewedPlus4Min],
        [],
        work,
        [work, personal],
        { now: Date.parse("2026-09-03T11:00:00.000Z") },
      ),
    ).toBe(personal);
  });

  it("rotates when the selection uses a model alias", () => {
    const aliasedModels = [
      { slug: model, name: "Opus", aliases: ["opus"], isCustom: false, capabilities: null },
    ];
    expect(
      choose(
        [
          account(work, [window(90)], { models: aliasedModels }),
          account(personal, [window(10)], { models: aliasedModels }),
        ],
        [],
        work,
        [work, personal],
        { model: "opus" },
      ),
    ).toBe(personal);
  });

  it("prefers accounts with known room over silent or partial probeFailed accounts, spilling over when all reporting accounts are exhausted", () => {
    const partialProbeFailed = account(spare, [window(5)], {
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [window(5)],
        unavailable: { reason: "probeFailed" },
      },
    });
    // Even a partial probeFailed report with a 5% window must not outrank healthy known room.
    expect(
      choose([account(work, [window(40)]), account(personal, [window(25)]), partialProbeFailed]),
    ).toBe(personal);
    // When every reporting account is exhausted, rotation spills over to the silent/probeFailed account.
    expect(
      choose([account(work, [window(100)]), account(personal, [window(100)]), partialProbeFailed]),
    ).toBe(spare);

    // A partial-only Codex probeFailed report preserves sibling plan windows so individual credits don't falsely exhaust.
    const cxPartial = ProviderInstanceId.make("codex_partial");
    const cxCapped = ProviderInstanceId.make("codex_capped");
    const cxModels = [{ slug: "gpt-6.2-sol", name: "Sol", isCustom: false, capabilities: null }];
    expect(
      choose(
        [
          account(cxCapped, [{ ...window(100), id: "primary", kind: "weekly" }], {
            driver: ProviderDriverKind.make("codex"),
            models: cxModels,
          }),
          account(cxPartial, [], {
            driver: ProviderDriverKind.make("codex"),
            models: cxModels,
            usageLimits: {
              checkedAt: "2026-09-03T11:00:00.000Z",
              windows: [
                { ...window(40), id: "primary", kind: "weekly" },
                { ...window(100), id: "individual", kind: "other" },
              ],
              unavailable: { reason: "probeFailed" },
            },
          }),
        ],
        [],
        cxCapped,
        [cxCapped, cxPartial],
        { model: "gpt-6.2-sol" },
      ),
    ).toBe(cxPartial);
  });

  it("merges recency and freshest usage across aliased instances sharing the same underlying login", () => {
    const berlinA = ProviderInstanceId.make("codex_berlin");
    const berlinB = ProviderInstanceId.make("codex_agent_berlin");
    const personalCodex = ProviderInstanceId.make("codex");
    const codexModel = "gpt-6.2-sol";
    const codexModels = [{ slug: codexModel, name: "Sol", isCustom: false, capabilities: null }];
    const sharedAuth = {
      status: "authenticated" as const,
      email: "dev@example.com",
      workspaceId: "ws-berlin",
    };
    const personalAuth = {
      status: "authenticated" as const,
      email: "personal@example.com",
      workspaceId: "ws-personal",
    };
    // Recency on berlinA also counts for its alias berlinB, so equal usage rotates to personalCodex.
    const tiedProviders = [
      account(berlinA, [window(0)], {
        driver: ProviderDriverKind.make("codex"),
        auth: sharedAuth,
        models: codexModels,
      }),
      account(berlinB, [window(0)], {
        driver: ProviderDriverKind.make("codex"),
        auth: sharedAuth,
        models: codexModels,
      }),
      account(personalCodex, [window(0)], {
        driver: ProviderDriverKind.make("codex"),
        auth: personalAuth,
        models: codexModels,
      }),
    ];
    expect(
      choose(
        tiedProviders,
        [startedAt(berlinA, "2026-09-03T10:00:00.000Z")],
        berlinA,
        [berlinA, berlinB, personalCodex],
        { model: codexModel },
      ),
    ).toBe(personalCodex);

    // Fresher exhaustion on berlinA propagates to stale alias berlinB so rotation moves to personalCodex.
    const staleAliasProviders = [
      account(berlinA, [window(100)], {
        driver: ProviderDriverKind.make("codex"),
        auth: sharedAuth,
        models: codexModels,
        checkedAt: "2026-09-03T11:05:00.000Z",
        usageLimits: { checkedAt: "2026-09-03T11:05:00.000Z", windows: [window(100)] },
      }),
      account(berlinB, [window(20)], {
        driver: ProviderDriverKind.make("codex"),
        auth: sharedAuth,
        models: codexModels,
        checkedAt: "2026-09-03T11:00:00.000Z",
        usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window(20)] },
      }),
      account(personalCodex, [window(60)], {
        driver: ProviderDriverKind.make("codex"),
        auth: personalAuth,
        models: codexModels,
      }),
    ];
    expect(
      choose(staleAliasProviders, [], berlinA, [berlinA, berlinB, personalCodex], {
        model: codexModel,
      }),
    ).toBe(personalCodex);

    // A newer partial probeFailed report at 100% on an alias still overrides a stale 20% report.
    const partialExhaustedAlias = [
      account(berlinA, [window(100)], {
        driver: ProviderDriverKind.make("codex"),
        auth: sharedAuth,
        models: codexModels,
        checkedAt: "2026-09-03T11:05:00.000Z",
        usageLimits: {
          checkedAt: "2026-09-03T11:05:00.000Z",
          windows: [window(100)],
          unavailable: { reason: "probeFailed" },
        },
      }),
      account(berlinB, [window(20)], {
        driver: ProviderDriverKind.make("codex"),
        auth: sharedAuth,
        models: codexModels,
        checkedAt: "2026-09-03T11:00:00.000Z",
        usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window(20)] },
      }),
      account(personalCodex, [window(60)], {
        driver: ProviderDriverKind.make("codex"),
        auth: personalAuth,
        models: codexModels,
      }),
    ];
    expect(
      choose(partialExhaustedAlias, [], berlinB, [berlinA, berlinB, personalCodex], {
        model: codexModel,
      }),
    ).toBe(personalCodex);

    // A newer partial probeFailed report exhausting one model preserves known exhaustion and room for other models.
    const sonnetModel = "claude-sonnet-5-5";
    const haikuModel = "claude-haiku-5-5";
    const claudeFamilyModels = [
      { slug: model, name: "Opus", isCustom: false, capabilities: null },
      { slug: sonnetModel, name: "Sonnet", isCustom: false, capabilities: null },
      { slug: haikuModel, name: "Haiku", isCustom: false, capabilities: null },
    ];
    const partialScopedAlias = [
      account(
        work,
        [
          { ...window(20), id: "seven_day", kind: "weekly", label: "Weekly" },
          { ...window(100), id: "seven_day_sonnet", kind: "weekly", label: "Weekly · Sonnet" },
        ],
        {
          auth: sharedAuth,
          models: claudeFamilyModels,
          checkedAt: "2026-09-03T11:00:00.000Z",
          usageLimits: {
            checkedAt: "2026-09-03T11:00:00.000Z",
            windows: [
              { ...window(20), id: "seven_day", kind: "weekly", label: "Weekly" },
              { ...window(100), id: "seven_day_sonnet", kind: "weekly", label: "Weekly · Sonnet" },
            ],
          },
        },
      ),
      account(
        spare,
        [{ ...window(100), id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus" }],
        {
          auth: sharedAuth,
          models: claudeFamilyModels,
          checkedAt: "2026-09-03T11:05:00.000Z",
          usageLimits: {
            checkedAt: "2026-09-03T11:05:00.000Z",
            windows: [
              { ...window(100), id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus" },
            ],
            unavailable: { reason: "probeFailed" },
          },
        },
      ),
      account(personal, [{ ...window(60), id: "seven_day", kind: "weekly", label: "Weekly" }], {
        auth: personalAuth,
        models: claudeFamilyModels,
      }),
    ];
    expect(
      choose(partialScopedAlias, [], work, [work, spare, personal], { model: sonnetModel }),
    ).toBe(personal);
    expect(choose(partialScopedAlias, [], work, [work, spare, personal], { model })).toBe(personal);
    expect(
      choose(partialScopedAlias, [], personal, [work, spare, personal], { model: haikuModel }),
    ).toBe(work);

    // A project override disabling an alias does not discard its fresher exhaustion report.
    const projectId = ProjectId.make("project-a");
    const projectSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [berlinA]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        [berlinB]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        [personalCodex]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [berlinA]: { enabled: false } } },
      },
    };
    expect(
      chooseRotatedProviderInstance({
        selection: { instanceId: berlinB, model: codexModel },
        environmentId,
        providers: staleAliasProviders,
        eligibleInstanceIds: new Set([berlinB, personalCodex]),
        threads: [],
        project: { settings: projectSettings, projectId },
      }),
    ).toBe(personalCodex);
  });

  it("rotates the default before usage-limit fallback, rotates marked fallback accounts, and honors thread history", () => {
    const codexA = ProviderInstanceId.make("codex");
    const codexB = ProviderInstanceId.make("codex_personal");
    const codexModel = "gpt-6.2-sol";
    const codexModels = [{ slug: codexModel, name: "Sol", isCustom: false, capabilities: null }];
    const now = Date.parse("2026-09-03T11:00:00.000Z");

    const baseInput = {
      configuredDefaultSelection: { instanceId: work, model },
      fallbackDefaultSelection: null,
      fallbackModelSelection: { instanceId: codexA, model: codexModel },
      rotation: {
        accountRotationEnabled: true,
        accountRotationInstances: { [environmentId]: [work, personal, codexA, codexB] },
      },
      projectDefaultSource: "environment" as const,
      environmentId,
      providers: [
        account(work, [window(100)]),
        account(personal, [window(10)]),
        account(codexA, [window(80)], {
          driver: ProviderDriverKind.make("codex"),
          models: codexModels,
        }),
        account(codexB, [window(15)], {
          driver: ProviderDriverKind.make("codex"),
          models: codexModels,
        }),
      ],
      threads: [],
      projectId: null,
      now,
    };

    // Rotates to personal (10%) instead of falling back to codexA.
    expect(resolveRotatedNewThreadSelection(baseInput)).toEqual({
      selection: { instanceId: personal, model },
      fallback: null,
    });

    // When all marked default accounts AND the configured fallback are exhausted,
    // rotates the fallback to a healthy marked fallback account (codexB at 15%).
    const exhaustedFallback = resolveRotatedNewThreadSelection({
      ...baseInput,
      providers: [
        account(work, [window(100)]),
        account(personal, [window(100)]),
        account(codexA, [window(100)], {
          driver: ProviderDriverKind.make("codex"),
          models: codexModels,
        }),
        account(codexB, [window(15)], {
          driver: ProviderDriverKind.make("codex"),
          models: codexModels,
        }),
      ],
    });
    expect(exhaustedFallback.selection).toEqual({ instanceId: codexB, model: codexModel });
    expect(exhaustedFallback.fallback).not.toBeNull();

    // An unrelated Claude model-scoped cap (seven_day_fable) does not trigger fallback for Opus.
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        providers: [
          account(work, [
            { ...window(20), id: "seven_day", kind: "weekly", label: "Weekly" },
            { ...window(100), id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable" },
          ]),
          account(codexA, [window(0)], {
            driver: ProviderDriverKind.make("codex"),
            models: codexModels,
          }),
        ],
      }),
    ).toEqual({ selection: { instanceId: work, model }, fallback: null });

    // Exhaustion inherited from a fresher aliased instance triggers fallback even when the selected alias is stale.
    const sameAuth = {
      status: "authenticated" as const,
      email: "same@example.com",
      workspaceId: "ws-same",
    };
    const aliasFallback = resolveRotatedNewThreadSelection({
      ...baseInput,
      providers: [
        account(work, [window(5)], {
          auth: sameAuth,
          checkedAt: "2026-09-03T10:00:00.000Z",
          usageLimits: { checkedAt: "2026-09-03T10:00:00.000Z", windows: [window(5)] },
        }),
        account(personal, [window(100)], {
          auth: sameAuth,
          checkedAt: "2026-09-03T11:00:00.000Z",
          usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window(100)] },
        }),
        account(codexA, [window(0)], {
          driver: ProviderDriverKind.make("codex"),
          models: codexModels,
        }),
      ],
    });
    expect(aliasFallback.selection).toEqual({ instanceId: codexA, model: codexModel });
    expect(aliasFallback.fallback).not.toBeNull();

    // A fallback configured via a model alias does not select an account whose canonical slug is capped.
    const aliasedFallbackModels = [
      { slug: codexModel, name: "Sol", aliases: ["sol"], isCustom: false, capabilities: null },
    ];
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        fallbackModelSelection: { instanceId: codexA, model: "sol" },
        providers: [
          account(work, [window(100)]),
          account(personal, [window(100)]),
          account(codexA, [{ ...window(100), id: "primary", modelIds: [codexModel] }], {
            driver: ProviderDriverKind.make("codex"),
            models: aliasedFallbackModels,
          }),
        ],
      }),
    ).toEqual({ selection: { instanceId: work, model }, fallback: null });

    // Same-instance Claude fallback evaluates base and fallback windows independently.
    const sonnetModel = "claude-sonnet-5-5";
    const claudePairModels = [
      { slug: model, name: "Opus", aliases: ["opus"], isCustom: false, capabilities: null },
      {
        slug: sonnetModel,
        name: "Sonnet",
        aliases: ["sonnet"],
        isCustom: false,
        capabilities: null,
      },
    ];
    const sameInstanceHealthy = resolveRotatedNewThreadSelection({
      ...baseInput,
      fallbackModelSelection: { instanceId: work, model: "sonnet" },
      rotation: {
        accountRotationEnabled: true,
        accountRotationInstances: { [environmentId]: [work] },
      },
      providers: [
        account(
          work,
          [
            { ...window(20), id: "seven_day", kind: "weekly", label: "Weekly" },
            { ...window(100), id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus" },
            { ...window(10), id: "seven_day_sonnet", kind: "weekly", label: "Weekly · Sonnet" },
          ],
          { models: claudePairModels },
        ),
      ],
    });
    expect(sameInstanceHealthy.selection).toEqual({ instanceId: work, model: "sonnet" });
    expect(sameInstanceHealthy.fallback).not.toBeNull();

    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        fallbackModelSelection: { instanceId: work, model: "sonnet" },
        rotation: {
          accountRotationEnabled: true,
          accountRotationInstances: { [environmentId]: [work] },
        },
        providers: [
          account(
            work,
            [
              { ...window(100), id: "opus_cap", modelIds: [model] },
              { ...window(100), id: "seven_day_sonnet", kind: "weekly", label: "Weekly · Sonnet" },
            ],
            { models: claudePairModels },
          ),
        ],
      }),
    ).toEqual({ selection: { instanceId: work, model }, fallback: null });

    // A Cursor total-only 100% cap triggers the configured fallback consistently with rotation.
    const cursorA = ProviderInstanceId.make("cursor");
    const cursorFallback = resolveRotatedNewThreadSelection({
      ...baseInput,
      configuredDefaultSelection: { instanceId: cursorA, model: "auto" },
      fallbackModelSelection: { instanceId: codexA, model: codexModel },
      rotation: {
        accountRotationEnabled: true,
        accountRotationInstances: { [environmentId]: [cursorA] },
      },
      providers: [
        account(cursorA, [{ ...window(100), id: "totalPercentUsed", kind: "monthly" }], {
          driver: ProviderDriverKind.make("cursor"),
          models: [{ slug: "auto", name: "Auto", isCustom: false, capabilities: null }],
        }),
        account(codexA, [window(10)], {
          driver: ProviderDriverKind.make("codex"),
          models: codexModels,
        }),
      ],
    });
    expect(cursorFallback.selection).toEqual({ instanceId: codexA, model: codexModel });
    expect(cursorFallback.fallback).not.toBeNull();

    // Handles partial/missing client settings without throwing.
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        rotation: {},
        fallbackModelSelection: null,
      }),
    ).toEqual({ selection: { instanceId: work, model }, fallback: null });

    // Respects project-level default and disabled rotation.
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        rotation: { ...baseInput.rotation, accountRotationEnabled: false },
      }).selection,
    ).toEqual({ instanceId: codexA, model: codexModel });
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        projectDefaultSource: "project",
        fallbackModelSelection: null,
      }).selection,
    ).toEqual({ instanceId: work, model });

    // Leaves configuredDefaultSelection (null) untouched when rotation does not switch accounts.
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        configuredDefaultSelection: null,
        fallbackDefaultSelection: { instanceId: work, model },
        fallbackModelSelection: null,
        providers: [account(work, [window(10)]), account(personal, [window(50)])],
      }),
    ).toEqual({ selection: null, fallback: null });

    // Uses thread history when seeding equal-usage accounts.
    expect(
      resolveRotatedNewThreadSelection({
        ...baseInput,
        fallbackModelSelection: null,
        providers: [account(work, [window(0)]), account(personal, [window(0)])],
        threads: [startedAt(work, "2026-09-03T10:00:00.000Z")],
      }),
    ).toEqual({ selection: { instanceId: personal, model }, fallback: null });
  });

  it("gives a subagent thread no turn of its own and ignores other environments", () => {
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
        {
          ...startedAt(personal, "2026-09-03T10:30:00.000Z"),
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
    ["missing the model", { models: [] }],
  ])("leaves a selected account that is %s for one that can start the thread", (_, broken) => {
    expect(choose([account(work, [window(0)], broken), account(personal, [window(60)])])).toBe(
      personal,
    );
    expect(
      choose([account(work, [window(0)], broken), account(personal, [window(0)], broken)]),
    ).toBe(work);
  });
});

describe("the rotation choice is stable for any small pool", () => {
  type Usage = "none" | "idle" | "half" | "halfReset" | "exhausted";
  type Started = "never" | "early" | "late";
  interface Spec {
    readonly marked: boolean;
    readonly usage: Usage;
    readonly started: Started;
    readonly canStart: boolean;
  }
  const usages: ReadonlyArray<Usage> = ["none", "idle", "half", "halfReset", "exhausted"];
  const startedLevels: ReadonlyArray<Started> = ["never", "early", "late"];
  const specs: ReadonlyArray<Spec> = [];
  for (const marked of [true, false])
    for (const usage of usages)
      for (const started of startedLevels)
        for (const canStart of [true, false])
          (specs as Spec[]).push({ marked, usage, started, canStart });
  const thirdSpecs: ReadonlyArray<Spec> = [
    { marked: true, usage: "none", started: "never", canStart: true },
    { marked: true, usage: "half", started: "late", canStart: true },
  ];

  const ids = [work, personal, spare];
  const startTime = { early: "2026-09-03T09:00:00.000Z", late: "2026-09-03T10:00:00.000Z" };
  // checkedAt is 11:00, so a window resetting at 10:30 has already reset.
  const windowsOf = (usage: Usage) =>
    usage === "none"
      ? []
      : usage === "idle"
        ? [window(0)]
        : usage === "half"
          ? [window(50)]
          : usage === "exhausted"
            ? [window(100)]
            : [window(100, "2026-09-03T10:30:00.000Z")];

  /** The requirement, written from the spec rather than from the implementation. */
  function expected(selectedIndex: number, pool: ReadonlyArray<Spec>) {
    const selected = pool[selectedIndex]!;
    if (!selected.marked) return new Set([ids[selectedIndex]!]);
    const members = pool
      .map((spec, index) => ({ spec, index }))
      .filter(({ spec, index }) => spec.canStart && (index === selectedIndex || spec.marked));
    if (members.length === 0) return new Set([ids[selectedIndex]!]);
    const withRoom = members.filter(({ spec }) => spec.usage !== "exhausted");
    const active = withRoom.length > 0 ? withRoom : members;
    const rank = ({ spec }: { spec: Spec }) =>
      [
        spec.usage === "none" ? 1 : 0,
        spec.usage === "exhausted" ? 100 : spec.usage === "half" ? 50 : 0,
        spec.started === "never" ? 0 : spec.started === "early" ? 1 : 2,
      ] as const;
    const less = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
      a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
    const best = active.reduce((a, b) => (less(rank(b), rank(a)) ? b : a));
    const bestRank = rank(best);
    return new Set(
      active
        .filter(({ spec }) => {
          const r = rank({ spec });
          return r[0] === bestRank[0] && r[1] === bestRank[1] && r[2] === bestRank[2];
        })
        .map(({ index }) => ids[index]!),
    );
  }

  function run(pool: ReadonlyArray<Spec>, selectedIndex: number) {
    const providers = pool.map((spec, index) =>
      account(ids[index]!, windowsOf(spec.usage), spec.canStart ? {} : { status: "error" }),
    );
    const threads = pool.flatMap((spec, index) =>
      spec.started === "never" ? [] : [startedAt(ids[index]!, startTime[spec.started])],
    );
    const marked = pool.flatMap((spec, index) => (spec.marked ? [ids[index]!] : []));
    const pick = (from: ProviderInstanceId) =>
      chooseRotatedProviderInstance({
        selection: { instanceId: from, model },
        environmentId,
        providers,
        eligibleInstanceIds: new Set(marked),
        threads,
      });
    return { first: pick(ids[selectedIndex]!), pick };
  }

  it("answers with a best account and answers the same when asked from its own answer", () => {
    let cases = 0;
    for (const a of specs)
      for (const b of specs)
        for (const pool of [[a, b], ...thirdSpecs.map((c) => [a, b, c])]) {
          for (let selectedIndex = 0; selectedIndex < pool.length; selectedIndex++) {
            const { first, pick } = run(pool, selectedIndex);
            const context = JSON.stringify({ pool, selectedIndex, first });
            expect(expected(selectedIndex, pool).has(first), `not a best account ${context}`).toBe(
              true,
            );
            expect(pick(first), `unstable ${context}`).toBe(first);
            cases++;
          }
        }
    expect(cases).toBe(specs.length ** 2 * (2 + thirdSpecs.length * 3));
  });
});
