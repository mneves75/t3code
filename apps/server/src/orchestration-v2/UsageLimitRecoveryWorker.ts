import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// Enabling the fallback must not wake every thread that stopped on a limit long ago.
export const LIMIT_FALLBACK_WINDOW_MS = 10 * 60_000;

/**
 * Continues a root thread stopped by a usage limit on the fallback model at once,
 * whatever the reset time. The run start builds the portable handoff from the
 * thread's history, so the exhausted provider writes nothing. A fallback that is
 * itself limited fails on its own instance and is never retried.
 */
export function limitFallbackCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  fallback: ModelSelection | null,
  nowMs: number,
): OrchestrationV2Command | null {
  if (
    fallback === null ||
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.providerInstanceId === fallback.instanceId ||
    thread.lineage.relationshipToParent === "subagent" ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    // The user already chose to wait for the reset on this run.
    thread.limitRecovery?.runId === thread.latestRunId ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs) ||
    nowMs - DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt) >
      LIMIT_FALLBACK_WINDOW_MS
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-fallback:${identity}`),
    messageId: MessageId.make(`limit-fallback:${identity}`),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: fallback,
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const fallback = preferences.usageLimitFallbackModelSelection;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      ...(fallback === null
        ? {}
        : {
            fallback: {
              instanceId: fallback.instanceId,
              failedSince: DateTime.subtract(now, { milliseconds: LIMIT_FALLBACK_WINDOW_MS }),
            },
          }),
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const fallbackCommand = limitFallbackCommand(thread, fallback, nowMs);
      if (fallbackCommand !== null) {
        // A rejected fallback (say, a disabled instance) leaves the thread to reset recovery.
        const switched = yield* threads.dispatch(fallbackCommand).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-recovery.fallback-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (switched) continue;
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
