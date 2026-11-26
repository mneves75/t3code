import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  InferenceServerId,
  ThreadId,
  type InferenceThreadLastRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const FIRST_REQUEST: InferenceThreadLastRequest = {
  serverId: InferenceServerId.make("mlx-studio"),
  model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
  completedAt: "2026-11-26T05:36:30.419Z",
  promptTokens: 10894,
  cachedPromptTokens: 10893,
  completionTokens: 4,
  queueWaitMs: 622,
  ttftMs: 187,
  decodeTokensPerSecond: null,
};

const SECOND_REQUEST: InferenceThreadLastRequest = {
  ...FIRST_REQUEST,
  completedAt: "2026-11-26T05:38:10.000Z",
  promptTokens: 22772,
  cachedPromptTokens: 22772,
  completionTokens: 28,
  decodeTokensPerSecond: 29,
};

const fixture = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  const shell = Atom.make<{ latestRun: ThreadRunSummary | null } | null>({ latestRun: null });
  let nextResponse: () => Promise<{
    readonly last: InferenceThreadLastRequest | null;
  }> = async () => ({
    last: null,
  });
  let fetchCount = 0;
  return {
    shell,
    get fetchCount() {
      return fetchCount;
    },
    resetFetchCount() {
      fetchCount = 0;
    },
    setResponder(fn: () => Promise<{ readonly last: InferenceThreadLastRequest | null }>) {
      nextResponse = fn;
    },
    invoke() {
      fetchCount += 1;
      return nextResponse();
    },
  };
});

vi.mock(import("../../state/threads"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: () => fixture.shell,
    },
  } as never;
});

vi.mock(import("../../state/server"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const getThreadInferenceRequest = {
    label: "getThreadInferenceRequest",
    run: () => Effect.promise(() => fixture.invoke()),
  };
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      inferenceServersValueAtom: () => Atom.make([{ enabled: true }]),
      getThreadInferenceRequest,
    },
  } as never;
});

import { render } from "../../../test/render";
import { ThreadDetailsLastRequest } from "./ThreadDetailsUsage";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const run = (runId: string, status: ThreadRunSummary["status"]) =>
  ({ runId, status }) as unknown as ThreadRunSummary;

it("refreshes when a turn completes, keeps the row visible during refetch, and does not double the aria-label prefix", async () => {
  fixture.resetFetchCount();
  fixture.setResponder(async () => ({ last: null }));
  const registry = AtomRegistry.make();
  registry.set(fixture.shell, { latestRun: run("run-1", "running") });

  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <ThreadDetailsLastRequest {...threadRef} />
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByLabelText(/^Last request: /)).not.toBeInTheDocument();

  // Completing run-1 refetches and renders a single "Last request: " prefix.
  fixture.setResponder(async () => ({ last: FIRST_REQUEST }));
  registry.set(fixture.shell, { latestRun: run("run-1", "completed") });

  const firstLabel =
    "Last request: 10.9K prompt tokens (100% cached) · TTFT 0.2 s · – · waited 0.6 s";
  const secondLabel =
    "Last request: 22.8K prompt tokens (100% cached) · TTFT 0.2 s · 29 tok/s · waited 0.6 s";
  const row = page.getByLabelText(/^Last request: /);
  await expect.element(row).toBeVisible();
  await expect.element(row).toHaveAttribute("aria-label", firstLabel);

  // Starting run-2 triggers a pending refetch; the previous row stays visible (no blink).
  let resolveSecond!: (value: { readonly last: InferenceThreadLastRequest | null }) => void;
  fixture.setResponder(
    () =>
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
  );
  registry.set(fixture.shell, { latestRun: run("run-2", "completed") });
  await expect.element(row).toBeVisible();
  await expect.element(row).toHaveAttribute("aria-label", firstLabel);

  resolveSecond({ last: SECOND_REQUEST });
  await expect.element(row).toHaveAttribute("aria-label", secondLabel);
});
