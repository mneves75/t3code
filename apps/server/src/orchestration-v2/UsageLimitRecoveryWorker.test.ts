import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const codex = ProviderInstanceId.make("codex");
const fallback: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-sonnet-4-6",
};

const limitedShell = (now: DateTime.Utc, resetAt: string | null): OrchestrationV2ThreadShell => ({
  id: ThreadId.make("thread:limited"),
  projectId: ProjectId.make("project:test"),
  title: "Limited",
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: null,
  worktreePath: null,
  lineage: {
    rootThreadId: ThreadId.make("thread:limited"),
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make("run:limited"),
  latestRunCompletedAt: now,
  activeRunId: null,
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: resetAt,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: now,
  hasActionableProposedPlan: false,
  itemCount: 1,
  visibleItemCount: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  pinnedAt: null,
  deletedAt: null,
  limitRecovery: null,
});

const sweepFixture = (input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly settings: Partial<typeof DEFAULT_SERVER_SETTINGS>;
  readonly rejectFallback: boolean;
}) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(input.shell);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const candidateOptions = yield* Ref.make<
      ReadonlyArray<
        Parameters<ProjectionStore.ProjectionStoreV2Shape["getLimitRecoveryCandidates"]>[0]
      >
    >([]);
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(
            Effect.andThen(
              command.type === "message.dispatch"
                ? input.rejectFallback
                  ? Effect.fail(
                      new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                        projectId: input.shell.projectId,
                        instanceId: fallback.instanceId,
                      }),
                    )
                  : Ref.update(current, (shell) => ({
                      ...shell,
                      status: "running" as const,
                      providerInstanceId:
                        command.modelSelection?.instanceId ?? shell.providerInstanceId,
                    }))
                : command.type === "thread.metadata.update" && command.limitRecovery != null
                  ? Ref.update(current, (shell) => ({
                      ...shell,
                      limitRecovery: {
                        runId: command.limitRecovery!.runId,
                        resetAt: command.limitRecovery!.resetAt,
                        autoResume: command.limitRecovery!.autoResume ?? false,
                        snooze: command.limitRecovery!.snooze ?? false,
                      },
                    }))
                  : Effect.void,
            ),
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getLimitRecoveryCandidates: (options) =>
          Ref.update(candidateOptions, (all) => [...all, options]).pipe(
            Effect.andThen(Ref.get(current)),
            Effect.map((shell) => (shell.status === "failed" ? [shell] : [])),
          ),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...input.settings }),
      }),
    );
    const layerWorker = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(layerDependencies),
      Layer.provide(Scheduler.layer),
    );
    return { current, commands, candidateOptions, layerWorker };
  });

it.effect("the sweep asks for fallback candidates and continues on the fallback model", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const fixture = yield* sweepFixture({
      shell: limitedShell(now, null),
      settings: { usageLimitFallbackModelSelection: fallback },
      rejectFallback: false,
    });
    yield* Effect.gen(function* () {
      // The scheduler sweeps once on registration, then once per tick.
      yield* TestClock.adjust("5 seconds");
      const options = yield* Ref.get(fixture.candidateOptions);
      assert.lengthOf(options, 2);
      assert.deepEqual(options[0]!.fallback, {
        instanceId: fallback.instanceId,
        failedSince: DateTime.subtract(now, {
          milliseconds: UsageLimitRecoveryWorker.LIMIT_FALLBACK_WINDOW_MS,
        }),
      });
      const delivered = yield* Ref.get(fixture.commands);
      assert.lengthOf(delivered, 1);
      expect(delivered[0]).toMatchObject({
        type: "message.dispatch",
        manualContinuationOfRunId: RunId.make("run:limited"),
        modelSelection: fallback,
        dispatchMode: { type: "start_immediately" },
        creationSource: "server",
      });
      yield* TestClock.adjust("5 seconds");
      assert.lengthOf(yield* Ref.get(fixture.commands), 1);
    }).pipe(Effect.provide(fixture.layerWorker));
  }),
);

it.effect("the sweep passes no fallback option while the setting is off", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const fixture = yield* sweepFixture({
      shell: limitedShell(now, null),
      settings: {},
      rejectFallback: false,
    });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      const options = yield* Ref.get(fixture.candidateOptions);
      assert.lengthOf(options, 2);
      assert.isTrue(options.every((option) => option.fallback === undefined));
      assert.deepEqual(yield* Ref.get(fixture.commands), []);
    }).pipe(Effect.provide(fixture.layerWorker));
  }),
);

it.effect("a rejected fallback arms reset recovery once and is not retried", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 60 }));
    const fixture = yield* sweepFixture({
      shell: limitedShell(now, resetAt),
      settings: { usageLimitFallbackModelSelection: fallback, autoResumeLimitedThreads: true },
      rejectFallback: true,
    });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      const afterFirst = yield* Ref.get(fixture.commands);
      assert.deepEqual(
        afterFirst.map((command) => command.type),
        ["message.dispatch", "thread.metadata.update"],
      );
      expect(afterFirst[1]).toMatchObject({
        commandId: CommandId.make(`limit-arm:thread:limited:run:limited:${Date.parse(resetAt)}`),
        limitRecovery: { runId: RunId.make("run:limited"), resetAt, autoResume: true },
      });
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      assert.lengthOf(yield* Ref.get(fixture.commands), 2);
    }).pipe(Effect.provide(fixture.layerWorker));
  }),
);
