import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  InferenceServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

const LINKED_ENVIRONMENT = vi.hoisted(() => "linked-environment");
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const config = Atom.make({
    environment: { label: "devbox", capabilities: {} },
    inferenceServers: [
      ["mlx-studio", "MLX"],
      ["attic", "Mac Studio in the attic upstairs"],
    ].map(([id, displayName]) => ({
      id,
      displayName,
      baseUrl: "http://127.0.0.1:8082/v1",
      enabled: true,
      status: "ready",
      checkedAt: null,
      models: [],
    })),
  });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: ((id: never) =>
        id === LINKED_ENVIRONMENT ? config : actual.serverEnvironment.configValueAtom(id)) as never,
    },
  };
});

/** Whether `text` inside `row` runs past an ancestor that clips it. */
function isClipped(row: HTMLElement, text: string) {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const right = range.getBoundingClientRect().right;
    for (let box = node.parentElement; box !== null && row.contains(box); box = box.parentElement) {
      if (getComputedStyle(box).overflowX === "visible") continue;
      if (right > box.getBoundingClientRect().right + 0.5) return true;
    }
    return false;
  }
  throw new Error(`"${text}" is not in the row`);
}

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("lists a model reported twice by one provider once, with contiguous jump shortcuts", async () => {
  const instanceId = ProviderInstanceId.make("claude");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      ["a", "b", "c", "c", "d", "d"].map((slug) => ({
        slug,
        name: `Model ${slug.toUpperCase()}`,
      })),
    ],
  ]);
  const keybindings = compileResolvedKeybindingsConfig(
    ([1, 2, 3, 4, 5, 6] as const).map((index) => ({
      key: `mod+${index}`,
      command: `modelPicker.jump.${index}` as const,
      when: "modelPickerOpen",
    })),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model="a"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      keybindings={keybindings}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Model A/ })).toBeVisible();
  await vi.waitFor(() =>
    expect(
      page
        .getByRole("option")
        .elements()
        .map((row) => [
          row.textContent?.match(/Model [A-Z]/)?.[0],
          row.querySelector("kbd")?.textContent?.slice(-1),
        ]),
    ).toEqual([
      ["Model A", "1"],
      ["Model B", "2"],
      ["Model C", "3"],
      ["Model D", "4"],
    ]),
  );
});

it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: name === "Codex",
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex, claude] = entries;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: claude!.instanceId, model: "claude" }],
  });
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Codex model/ })).toBeVisible();
});

it("keeps the touch keyboard down while choosing a provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex] = entries;
  const matchMedia = window.matchMedia.bind(window);
  using _touch = vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(pointer: coarse)"
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList)
      : matchMedia(query),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  const popup = search.element().closest('[data-slot="popover-popup"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(popup));

  await page.getByRole("button", { name: /^Claude/ }).click();
  await expect.element(page.getByRole("option", { name: /Claude model/ })).toBeVisible();
  await expect.element(search).not.toHaveFocus();
});

it("keeps what tells a managed model apart in view when its name is cut off", async () => {
  const linkedPi = (server: string, serverName: string) => ({
    instanceId: ProviderInstanceId.make(`pi-${server}`),
    driver: ProviderDriverKind.make("pi"),
    displayName: `Pi · ${serverName}`,
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-01-01T00:00:00.000Z",
    inference: "local" as const,
    inferenceServerId: InferenceServerId.make(server),
    models: [],
    slashCommands: [],
    skills: [],
  });
  const atticName = "Mac Studio in the attic upstairs";
  const entries = deriveProviderInstanceEntries([
    linkedPi("mlx-studio", "MLX"),
    linkedPi("attic", atticName),
  ]);
  const [mlx, attic] = entries.map((entry) => entry.instanceId);
  const managed = (server: string, serverName: string, model: string) => ({
    slug: `t3-${server}/${model}`,
    name: `${model} (${serverName})`,
    subProvider: `t3-${server}`,
  });
  const small = "mlx-community/Qwen2.5-0.5B-Instruct-4bit";
  const coder = "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ";
  const options = new Map([
    [mlx!, [small, coder, "phi4"].map((model) => managed("mlx-studio", "MLX", model))],
    [attic!, [managed("attic", atticName, "gemma3:4b")]],
  ]);

  await using screen = await render(
    <ProviderModelPicker
      environmentId={EnvironmentId.make(LINKED_ENVIRONMENT)}
      activeInstanceId={mlx!}
      model={`t3-mlx-studio/${coder}`}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  const chip = screen.getByRole("button", { name: /^Choose model, runs on/ });
  // The chip names the machine beside the model, so it drops the server the name ends with.
  await expect.element(chip).not.toHaveTextContent("(MLX)");
  await chip.click();
  const row = async (text: string) => {
    const option = page.getByRole("option").filter({ hasText: text });
    await expect.element(option).toBeVisible();
    return option.element() as HTMLElement;
  };

  // Two models from one organization: the shared prefix gives way, the model and server stay.
  const coderRow = await row(`${coder} (MLX)`);
  expect(isClipped(coderRow, "mlx-community")).toBe(true);
  expect(isClipped(coderRow, "Qwen3-Coder")).toBe(false);
  expect(isClipped(coderRow, "(MLX)")).toBe(false);
  const smallRow = await row(`${small} (MLX)`);
  expect(isClipped(smallRow, "Qwen2.5-0.5B")).toBe(false);
  // With only the organization cut, hovering still names the model in full.
  await page.getByText("Qwen2.5-0.5B-Instruct-4bit", { exact: true }).hover();
  expect(smallRow.querySelector("[title]")?.getAttribute("title")).toBe(`${small} (MLX)`);
  expect(isClipped(await row("phi4 (MLX)"), "(MLX)")).toBe(false);
  // The server's name says where it runs; the gateway's internal provider id says nothing more.
  expect(coderRow.textContent).not.toContain("t3-mlx-studio");

  // A long server name is cut before it can crowd out the model.
  await page.getByRole("button", { name: new RegExp(`^Pi · ${atticName}`) }).click();
  const gemmaRow = await row(`gemma3:4b (${atticName})`);
  expect(isClipped(gemmaRow, "gemma3:4b")).toBe(false);
  expect(isClipped(gemmaRow, "(Mac")).toBe(false);
});
