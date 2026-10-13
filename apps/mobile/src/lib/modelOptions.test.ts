import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  buildModelOptions,
  describeUnavailableModelSelection,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
  type ModelOption,
} from "./modelOptions";

describe("mobile model options", () => {
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null, undefined, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", subtitle: "", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("carries configured ACP identity into model and provider catalogs", () => {
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg";
    const config = {
      providers: [
        {
          instanceId: "acpRegistry_antigravity",
          driver: "acpRegistry",
          displayName: "Antigravity",
          iconUrl,
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "default",
              name: "Default",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [group] = groupByProvider(buildModelOptions(config, null, undefined, null));

    expect(group).toMatchObject({
      providerKey: "acpRegistry_antigravity",
      providerLabel: "Antigravity",
      models: [
        {
          providerDriver: "acpRegistry",
          providerIconUrl: iconUrl,
        },
      ],
    });
  });

  it("distinguishes same-name OpenCode models without changing their routing", () => {
    const sources = [
      { id: "anthropic", label: "Anthropic" },
      { id: "github-copilot", label: "GitHub Copilot" },
      { id: "opencode", label: "OpenCode Zen" },
    ];
    const config = {
      providers: [
        {
          instanceId: "opencode_work",
          driver: "opencode",
          displayName: "OpenCode Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: sources.map((source) => ({
            slug: `${source.id}/claude-fable-5`,
            name: "Claude Fable 5",
            subProvider: source.label,
            isCustom: false,
            capabilities: null,
          })),
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("opencode_work"),
      model: "github-copilot/claude-fable-5",
    };

    const options = buildModelOptions(config, selection, undefined, null);

    expect(options).toMatchObject(
      sources.map((source) => ({
        key: `opencode_work:${source.id}/claude-fable-5`,
        label: "Claude Fable 5",
        subtitle: source.label,
        providerLabel: "OpenCode Work",
        selection: {
          instanceId: "opencode_work",
          model: `${source.id}/claude-fable-5`,
        },
      })),
    );
    expect(groupByProvider(options)).toEqual([
      { providerKey: "opencode_work", providerLabel: "OpenCode Work", models: options },
    ]);
  });

  it("does not materialize catalog defaults for missing stored options", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
      },
      undefined,
      null,
    );

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toBeUndefined();

    const [emptyOption] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
        options: [],
      },
      undefined,
      null,
    );
    expect(emptyOption?.selection).toEqual(option?.selection);

    const [explicitOption] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
        options: [{ id: "serviceTier", value: "priority" }],
      },
      undefined,
      null,
    );
    expect(explicitOption?.selection.options).toEqual([{ id: "serviceTier", value: "priority" }]);
  });

  it("limits existing threads to their provider while new tasks keep every provider", () => {
    const providers = ["codex", "claudeAgent"].map((instanceId) => ({
      instanceId,
      driver: instanceId,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "test", name: instanceId, capabilities: null }],
    }));
    const config = { providers } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };

    expect(
      buildModelOptions(config, selection, undefined, null).map((option) => option.providerKey),
    ).toEqual(["codex", "claudeAgent"]);
    expect(buildModelOptions(config, selection, selection.instanceId, null)).toEqual(
      buildModelOptions(config, selection, undefined, null).filter(
        (option) => option.providerKey === "codex",
      ),
    );
  });

  it.each(["disabled", "unavailable", "missing"] as const)(
    "retains the selected %s provider's fallback in a filtered catalog",
    (state) => {
      const selection = {
        instanceId: ProviderInstanceId.make("google_work"),
        model: "saved-model",
        options: [{ id: "native-option", value: "saved-choice" }],
      };
      const provider = {
        instanceId: selection.instanceId,
        driver: "antigravity",
        displayName: "Google Work",
        enabled: state !== "disabled",
        installed: true,
        availability: state === "unavailable" ? "unavailable" : "available",
        auth: { status: "authenticated" },
        models: [{ slug: selection.model, name: "Saved model", capabilities: null }],
      };
      const config = {
        providers: state === "missing" ? [] : [provider],
        settings: { providerInstances: { google_work: { driver: "antigravity" } } },
      } as unknown as ServerConfig;
      const options = buildModelOptions(config, selection, selection.instanceId, null);
      expect(options).toEqual(buildModelOptions(config, selection, undefined, null));
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection, isUnavailable: true });
    },
  );

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable, null)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled, null)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed, null)).toBeNull();
    // Disabled is disabled even with no settings to consult; only a provider
    // that is merely missing or unauthenticated falls through silently.
    expect(isModelSelectionUnavailable(config, disabled, null)).toBe(true);
    expect(isModelSelectionUnavailable(config, removed, null)).toBe(false);
    // An offline environment has no config to validate.
    expect(resolveSelectableModelSelection(null, disabled, null)).toBe(disabled);
  });

  describe("Antigravity selections", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("google_work"),
      model: "gemini-3.1-pro-high",
      options: [{ id: "native-option", value: "saved/opaque-choice" }],
    };
    const model = {
      slug: selection.model,
      name: "Gemini 3.1 Pro High",
      subProvider: "Google",
      isCustom: false,
      isDefault: true,
      isLegacy: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "native-option",
            label: "Native option",
            type: "select",
            options: [{ id: "current/default", label: "Default", isDefault: true }],
            currentValue: "current/default",
          },
        ],
      },
    };
    const config = {
      providers: [
        {
          instanceId: selection.instanceId,
          driver: "antigravity",
          displayName: "Google Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [model],
        },
      ],
    } as unknown as ServerConfig;

    it.each([
      ["disabled", { enabled: false }],
      ["uninstalled", { installed: false }],
      ["signed out", { auth: { status: "unauthenticated" } }],
      ["unavailable", { availability: "unavailable" }],
    ] as const)("keeps a %s provider's selection and known model details", (_state, update) => {
      const unavailableConfig = {
        ...config,
        providers: config.providers.map((provider) => ({ ...provider, ...update })),
      };

      expect(resolveSelectableModelSelection(unavailableConfig, selection, null)).toBe(selection);
      expect(resolveDefaultableModelSelection(unavailableConfig, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(unavailableConfig, selection, null)).toBe(true);
      expect(buildModelOptions(unavailableConfig, null, undefined, null)).toEqual([]);
      const [option] = buildModelOptions(unavailableConfig, selection, undefined, null);
      expect(option).toMatchObject({
        key: `google_work:${selection.model}`,
        label: model.name,
        subtitle: "Google",
        providerKey: "google_work",
        providerLabel: "Google Work",
        providerDriver: "antigravity",
        isDefault: false,
        isLegacy: true,
        isUnavailable: true,
        capabilities: model.capabilities,
      });
      expect(option?.selection).toBe(selection);
    });

    it("keeps an exact selection when its model leaves and returns to the catalog", () => {
      const changedConfig = {
        ...config,
        providers: config.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, slug: "gemini-3.1-pro-low" })),
        })),
      };

      expect(resolveDefaultableModelSelection(changedConfig, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(changedConfig, selection, null)).toBe(true);
      const options = buildModelOptions(changedConfig, selection, undefined, null);
      const missing = options.find((option) => option.selection.model === selection.model);
      expect(missing).toMatchObject({
        label: selection.model,
        providerLabel: "Google Work",
        providerDriver: "antigravity",
        isUnavailable: true,
        capabilities: null,
      });
      expect(missing?.selection).toBe(selection);
      expect(
        resolveNewTaskModelSelection({
          draftSelection: null,
          projectDefaultSelection: resolveDefaultableModelSelection(changedConfig, selection, null),
          stickySelection: null,
          modelOptions: options,
        }),
      ).toBe(selection);

      const [restored] = buildModelOptions(config, selection, undefined, null);
      expect(isModelSelectionUnavailable(config, selection, null)).toBe(false);
      expect(restored?.isUnavailable).not.toBe(true);
      expect(restored?.selection).toBe(selection);
      expect(resolveDefaultableModelSelection(config, selection, null)).toBe(selection);
      expect(
        buildModelOptions(config, null, undefined, null)[0]?.selection.options,
      ).toBeUndefined();
    });

    it("uses configured instance metadata when provider status is missing", () => {
      const missingStatusConfig = {
        providers: [],
        settings: {
          providerInstances: {
            [selection.instanceId]: { driver: "antigravity", displayName: "Google Work" },
          },
        },
      } as unknown as ServerConfig;

      expect(resolveDefaultableModelSelection(missingStatusConfig, selection, null)).toBe(
        selection,
      );
      expect(isModelSelectionUnavailable(missingStatusConfig, selection, null)).toBe(true);
      expect(buildModelOptions(missingStatusConfig, selection, undefined, null)).toMatchObject([
        {
          providerDriver: "antigravity",
          providerLabel: "Google Work",
          isUnavailable: true,
          selection,
        },
      ]);
    });

    it("keeps offline selections without assuming that an unknown instance is Antigravity", () => {
      const unknownConfig = { ...config, providers: [] };

      expect(resolveDefaultableModelSelection(null, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(null, selection, null)).toBe(false);
      expect(buildModelOptions(null, selection, undefined, null)[0]?.selection).toBe(selection);
      expect(buildModelOptions(null, selection, undefined, null)[0]?.isUnavailable).not.toBe(true);
      expect(isModelSelectionUnavailable(unknownConfig, selection, null)).toBe(false);
      expect(resolveSelectableModelSelection(unknownConfig, selection, null)).toBeNull();
    });
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current, null)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy, null)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy, null)).toBe(legacy);
  });

  it("resolves new tasks from draft, project, sticky, then provider defaults", () => {
    const draft = { instanceId: ProviderInstanceId.make("codex"), model: "draft" };
    const project = { instanceId: ProviderInstanceId.make("codex"), model: "project" };
    const sticky = { instanceId: ProviderInstanceId.make("codex"), model: "sticky" };
    const providerDefault = {
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
      isDefault: true,
    } as ModelOption;
    const resolve = (
      draftSelection: ModelSelection | null,
      projectDefaultSelection: ModelSelection | null,
      stickySelection: ModelSelection | null,
    ) =>
      resolveNewTaskModelSelection({
        draftSelection,
        projectDefaultSelection,
        stickySelection,
        modelOptions: [providerDefault],
      });

    expect(resolve(draft, project, sticky)).toBe(draft);
    expect(resolve(null, project, sticky)).toBe(project);
    expect(resolve(null, null, sticky)).toBe(sticky);
    expect(resolve(null, null, null)).toBe(providerDefault.selection);

    const unavailable = { ...providerDefault, isUnavailable: true };
    expect(
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: null,
        modelOptions: [unavailable],
      }),
    ).toBeNull();
  });

  describe("project-aware enablement", () => {
    const projectId = ProjectId.make("project-a");
    const instanceId = ProviderInstanceId.make("codex_work");

    function configWith(settings: ServerSettings): ServerConfig {
      return {
        providers: [
          {
            instanceId,
            driver: "codex",
            displayName: "Codex Work",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
          },
        ],
        settings,
      } as unknown as ServerConfig;
    }

    it("words a project's own turn-off apart from missing setup", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(
        describeUnavailableModelSelection(configWith(settings), selection, projectId).title,
      ).toBe("Model turned off for this project");
      expect(describeUnavailableModelSelection(configWith(settings), selection, null).title).toBe(
        "Antigravity model unavailable",
      );
    });

    it("refuses to send a non-Antigravity model the project turned off", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(false);
    });

    it("hides an instance the project disables even though the machine enables it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("shows an instance the project enables even though the machine disables it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toHaveLength(1);
    });

    it("falls back to the machine value with no project in scope", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, null)).toHaveLength(1);
    });

    it("hides a machine-disabled instance for a project with no override, even though another project's keep-alive left it running", () => {
      const otherProjectId = ProjectId.make("project-b");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
        projectSettingsOverrides: {
          [otherProjectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      };

      // configWith's snapshot always reports enabled: true, standing in for
      // the server keeping the instance alive to serve project-b's override.
      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("refuses to send an instance the project merely inherits as disabled, not just an explicit override", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
      };
      const selection = { instanceId, model: "model-a" };

      // configWith's snapshot always reports enabled: true, standing in for
      // the server keeping the instance alive for another project's keep-alive.
      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(
        describeUnavailableModelSelection(configWith(settings), selection, projectId).title,
      ).toBe("Model turned off for this project");
      // With no project in scope, the machine value applies and is disabled.
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(true);
    });

    it("marks a project-disabled instance's fallback selection unavailable instead of reviving it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const fallback = { instanceId, model: "model-a" };

      const options = buildModelOptions(configWith(settings), fallback, undefined, projectId);

      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection: fallback, isUnavailable: true });
    });

    it("rejects a project-disabled instance's selection via resolveSelectableModelSelection", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(
        resolveSelectableModelSelection(configWith(settings), selection, projectId),
      ).toBeNull();
      expect(resolveSelectableModelSelection(configWith(settings), selection, null)).toBe(
        selection,
      );
    });

    it("rejects a project-disabled antigravity instance's selection instead of keeping it", () => {
      const antigravityInstanceId = ProviderInstanceId.make("antigravity_work");
      const config = {
        providers: [
          {
            instanceId: antigravityInstanceId,
            driver: "antigravity",
            displayName: "Antigravity Work",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            availability: "available",
            models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
          },
        ],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [antigravityInstanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              enabled: true,
            },
          },
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [antigravityInstanceId]: { enabled: false } } },
          },
        },
      } as unknown as ServerConfig;
      const selection = { instanceId: antigravityInstanceId, model: "model-a" };

      expect(resolveSelectableModelSelection(config, selection, projectId)).toBeNull();
      expect(resolveSelectableModelSelection(config, selection, null)).toBe(selection);
      expect(
        resolveSelectableModelSelection({ ...config, providers: [] }, selection, projectId),
      ).toBeNull();
    });
  });
});

describe("synchronized mobile model visibility", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const other = ProviderInstanceId.make("codex_personal");
  const models = [
    { slug: "hidden", name: "Hidden", isCustom: false, capabilities: null },
    { slug: "first", name: "First", isCustom: false, capabilities: null },
    { slug: "second", name: "Second", isCustom: false, capabilities: null },
    { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
  ];
  const config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      // A live snapshot entry always has a matching configured instance (or
      // is a driver's own default id); these are stand-ins for neither, so
      // the enablement fixture needs its own entry to read as enabled.
      providerInstances: {
        [provider]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        [other]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      providerModelPreferences: {
        [provider]: {
          hiddenModels: ["hidden", "custom", "missing"],
          modelOrder: ["second", "first"],
        },
      },
    },
    providers: [provider, other].map((instanceId) => ({
      instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models,
    })),
  } as unknown as ServerConfig;

  it("applies server visibility and ordering independently to each provider instance", () => {
    const options = buildModelOptions(config, null, undefined, null);
    expect(
      options
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["second", "first", "custom"]);
    expect(
      options
        .filter((option) => option.providerKey === other)
        .map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  it("exposes hidden built-ins for management without offering custom visibility controls", () => {
    const options = buildModelOptions(
      config,
      { instanceId: provider, model: "hidden" },
      provider,
      null,
      true,
    );
    expect(options.map((option) => option.selection.model)).toEqual([
      "second",
      "first",
      "hidden",
      "custom",
    ]);
    expect(options.find((option) => option.selection.model === "hidden")).toMatchObject({
      isHidden: true,
      canHide: true,
    });
    expect(options.find((option) => option.selection.model === "custom")).toMatchObject({
      isHidden: false,
      canHide: false,
    });
  });

  it.each(["hidden", "missing"])("does not resurrect the hidden fallback %s", (model) => {
    expect(
      buildModelOptions(config, { instanceId: provider, model }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toEqual(["second", "first", "custom"]);
  });

  it("keeps custom models visible and restores built-in models when the server clears hidden models", () => {
    expect(
      buildModelOptions(config, { instanceId: provider, model: "custom" }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toContain("custom");
    const cleared = { ...config, settings: { ...config.settings, providerModelPreferences: {} } };
    expect(
      buildModelOptions(cleared, null, provider, null).map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });
});

describe("rotating a new task across accounts", () => {
  const work = ProviderInstanceId.make("claudeAgent");
  const personal = ProviderInstanceId.make("claudeAgent_personal");
  const account = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2026-09-03T14:00:00.000Z",
        },
      ],
    },
  });
  const rotation = {
    environmentId: EnvironmentId.make("mac"),
    providers: [account(work, 90), account(personal, 10)],
    eligibleInstanceIds: new Set([work, personal]),
    threads: [],
  };
  const onWork: ModelSelection = {
    instanceId: work,
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  };
  const resolve = (input: {
    draftSelection?: ModelSelection;
    projectDefaultSelection?: ModelSelection;
    stickySelection?: ModelSelection;
    heldInstanceId?: ProviderInstanceId;
  }) =>
    resolveNewTaskModelSelection({
      draftSelection: input.draftSelection ?? null,
      projectDefaultSelection: input.projectDefaultSelection ?? null,
      stickySelection: input.stickySelection ?? null,
      modelOptions: [],
      rotation: { ...rotation, heldInstanceId: input.heldInstanceId ?? null },
    });

  it("starts an implicit selection on the account with the most usage left", () => {
    expect(resolve({ stickySelection: onWork })).toEqual({ ...onWork, instanceId: personal });
    expect(resolve({ projectDefaultSelection: onWork })).toEqual({
      ...onWork,
      instanceId: personal,
    });
  });

  it("keeps the account picked for this task", () => {
    expect(resolve({ draftSelection: onWork, stickySelection: onWork })).toBe(onWork);
  });

  it("keeps the account shown while the user is writing the task", () => {
    expect(resolve({ stickySelection: onWork, heldInstanceId: work })).toBe(onWork);
    // Usage moved on since the task opened on Personal; Work now has more left.
    expect(
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: onWork,
        modelOptions: [],
        rotation: {
          ...rotation,
          providers: [account(work, 10), account(personal, 90)],
          heldInstanceId: personal,
        },
      }),
    ).toEqual({ ...onWork, instanceId: personal });
  });

  describe("a held account that no longer fits this environment", () => {
    const spare = ProviderInstanceId.make("claudeAgent_spare");
    const onPersonal: ModelSelection = { ...onWork, instanceId: personal };
    const resolveWith = (
      selection: ModelSelection,
      held: ProviderInstanceId,
      overrides: Partial<typeof rotation> = {},
    ) =>
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: selection,
        modelOptions: [],
        rotation: { ...rotation, ...overrides, heldInstanceId: held },
      });

    it("ignores a held account of another provider or one this environment does not have", () => {
      const codex = ProviderInstanceId.make("codex");
      expect(resolveWith(onWork, codex)).toEqual({ ...onWork, instanceId: personal });
      expect(resolveWith(onWork, ProviderInstanceId.make("claudeAgent_gone"))).toEqual({
        ...onWork,
        instanceId: personal,
      });
    });

    it("does not rotate onto a held account this environment has not marked", () => {
      expect(
        resolveWith(onPersonal, work, { eligibleInstanceIds: new Set([personal, spare]) }),
      ).toBe(onPersonal);
    });

    it("does not rotate away from a selection that is not marked", () => {
      expect(resolveWith(onWork, personal, { eligibleInstanceIds: new Set([personal]) })).toBe(
        onWork,
      );
    });

    it("lets a held account that cannot start the task give way", () => {
      const signedOut = { ...account(personal, 10), auth: { status: "unauthenticated" as const } };
      expect(resolveWith(onWork, personal, { providers: [account(work, 90), signedOut] })).toBe(
        onWork,
      );
    });
  });
});
