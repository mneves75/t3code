import {
  EnvironmentId,
  InferenceServerId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type PullRequestLinkedThreadsResult,
  type RepositoryIdentity,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  findPromptLinkProjects,
  findPromptLinkPullRequestThread,
  pickPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "./promptLinks.ts";

const identity = (canonicalKey: string, origin?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
  ...(origin ? { origin: { canonicalKey: origin } } : {}),
});

describe("findPromptLinkProjects", () => {
  it("keeps exact matches in order and never a fork of the repository", () => {
    const projects = [
      {
        id: "fork",
        repositoryIdentity: identity("github.com/pingdotgg/t3code", "github.com/me/t3code"),
      },
      { id: "none", repositoryIdentity: null },
      { id: "recent", repositoryIdentity: identity("github.com/PingDotGG/T3Code") },
      { id: "older", repositoryIdentity: identity("github.com/pingdotgg/t3code") },
    ];
    const ids = (owner: string, name: string) =>
      findPromptLinkProjects(projects, { owner, name }).map((project) => project.id);
    expect(ids("pingdotgg", "t3code")).toEqual(["recent", "older"]);
    expect(ids("me", "t3code")).toEqual(["fork"]);
    expect(ids("gitlab", "x")).toEqual([]);
  });

  it("matches a checkout of the repository's GitCafe mirror", () => {
    const projects = [
      { id: "gitcafe", repositoryIdentity: identity("git.cafe/pingdotgg/t3code") },
      { id: "staging", repositoryIdentity: identity("staging.git.cafe/pingdotgg/t3code") },
      { id: "gitlab", repositoryIdentity: identity("gitlab.com/pingdotgg/t3code") },
    ];
    expect(
      findPromptLinkProjects(projects, { owner: "pingdotgg", name: "t3code" }).map(
        (project) => project.id,
      ),
    ).toEqual(["gitcafe", "staging"]);
  });
});

describe("findPromptLinkPullRequestThread", () => {
  it("takes the newest linked thread, never a side chat that inherited the link", () => {
    const link: ThreadPullRequestLink = {
      host: "github.com",
      repository: "acme/web",
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      source: "manual",
      linkedAt: "2026-01-01T00:00:00.000Z",
      snapshot: null,
      stack: null,
    };
    const thread = (id: string, updatedAt: string, sideChat?: boolean) => ({
      id,
      updatedAt,
      pullRequests: [link],
      ...(sideChat === undefined ? {} : { lineage: { sideChat } }),
    });
    const found = findPromptLinkPullRequestThread(
      [
        thread("old", "2026-01-01T00:00:00.000Z"),
        thread("parent", "2026-01-02T00:00:00.000Z", false),
        thread("side-chat", "2026-01-03T00:00:00.000Z", true),
      ],
      { owner: "acme", name: "web", number: 7 },
    );
    expect(found?.id).toBe("parent");
  });
});

describe("pickPromptLinkPullRequestThread", () => {
  it("takes the first open thread in order once every earlier lookup has answered", () => {
    const laptop = EnvironmentId.make("laptop");
    const server = EnvironmentId.make("server");
    const linked = (
      id: string,
      archivedAt: string | null = null,
    ): PullRequestLinkedThreadsResult => ({
      threads: [{ id: ThreadId.make(id), projectId: ProjectId.make("p"), title: id, archivedAt }],
    });
    const none: PullRequestLinkedThreadsResult = { threads: [] };
    const pick = (
      ...results: ReadonlyArray<AsyncResult.AsyncResult<PullRequestLinkedThreadsResult, unknown>>
    ) =>
      pickPromptLinkPullRequestThread(
        results.map((result, index) => ({ environmentId: index === 0 ? laptop : server, result })),
      );
    // A value shown while it refetches is not an answer yet.
    expect(pick(AsyncResult.success(none, { waiting: true }))).toBeUndefined();
    expect(pick(AsyncResult.success(none), AsyncResult.initial(true))).toBeUndefined();
    expect(pick(AsyncResult.initial(true), AsyncResult.success(linked("b")))).toBeUndefined();
    const laptopThread = { environmentId: laptop, id: ThreadId.make("a") };
    expect(pick(AsyncResult.success(linked("a")), AsyncResult.initial(true))).toEqual(laptopThread);
    expect(pick(AsyncResult.success(linked("a")), AsyncResult.success(linked("b")))).toEqual(
      laptopThread,
    );
    expect(pick(AsyncResult.success(none), AsyncResult.success(linked("old")))).toEqual({
      environmentId: server,
      id: ThreadId.make("old"),
    });
    expect(
      pick(
        AsyncResult.success(linked("archived", "2026-01-01T00:00:00.000Z")),
        AsyncResult.fail(1),
      ),
    ).toBeNull();
  });
});

describe("resolvePromptLinkModelSelection", () => {
  const provider = (
    instanceId: string,
    driver: string,
    status: "ready" | "warning" | "error" | "disabled" = "ready",
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    status,
    models: [
      { slug: "small", name: "Small" },
      { slug: "big", name: "Big", aliases: ["opus"], isDefault: true },
    ],
  });

  it("maps the requested provider and model onto a usable instance", () => {
    const providers = [provider("broken", "claudeAgent", "error"), provider("work", "claudeAgent")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claude", model: "small" }),
    ).toEqual({
      selection: { instanceId: "work", model: "small" },
      exact: true,
    });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claudeagent", model: "opus" }),
    ).toEqual({
      selection: { instanceId: "work", model: "big" },
      exact: true,
    });
  });

  it("defaults a local instance to a model its server serves, not the harness's own choice", () => {
    const local = (
      instanceId: string,
      driver: string,
      models: ReadonlyArray<{ slug: string; isDefault?: boolean }>,
      link: { inference?: "local"; inferenceServerId?: InferenceServerId } = {},
    ) => ({
      ...provider(instanceId, driver),
      ...link,
      models: models.map((model) => ({ name: model.slug, ...model })),
    });
    const resolve = (instance: ReturnType<typeof local>, providerName: string) =>
      resolvePromptLinkModelSelection([instance], { provider: providerName, model: null });
    // "default" defers to Pi's own configured model, which need not be the linked server's.
    const piModels = [{ slug: "default", isDefault: true }, { slug: "t3-mlx/qwen-0.5b" }];
    expect(resolve(local("pi", "pi", piModels, { inference: "local" }), "pi")).toEqual({
      selection: { instanceId: "pi", model: "t3-mlx/qwen-0.5b" },
      exact: true,
    });
    expect(resolve(local("pi", "pi", piModels), "pi")).toEqual({
      selection: { instanceId: "pi", model: "default" },
      exact: true,
    });
    const link = {
      inference: "local",
      inferenceServerId: InferenceServerId.make("mlx-studio"),
    } as const;
    const openCodeModels = [
      { slug: "opencode/beam-free", isDefault: true },
      { slug: "t3-mlx-studio/qwen3-4b" },
    ];
    expect(resolve(local("opencode-mlx", "opencode", openCodeModels, link), "opencode")).toEqual({
      selection: { instanceId: "opencode-mlx", model: "t3-mlx-studio/qwen3-4b" },
      exact: true,
    });
    // Codex reaches its linked server under the server's bare model ids.
    const codexModels = [{ slug: "default", isDefault: true }, { slug: "qwen3-4b" }];
    expect(resolve(local("codex-mlx", "codex", codexModels, link), "codex")).toEqual({
      selection: { instanceId: "codex-mlx", model: "qwen3-4b" },
      exact: true,
    });
  });

  it("uses the instance default for an unknown model, and nothing for a missing provider", () => {
    const providers = [provider("codex", "codex")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "codex", model: "nope" }),
    ).toEqual({
      selection: { instanceId: "codex", model: "big" },
      exact: false,
    });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "cursor", model: null }),
    ).toBeNull();
  });
});
