import { describe, expect, it } from "@effect/vitest";
import { InferenceServerId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as InferenceAdmission from "./InferenceAdmission.ts";
import * as InferenceRetry from "./InferenceRetry.ts";
import * as InferenceRouting from "./InferenceRouting.ts";
import { makeInferenceWatchdog } from "./InferenceWatchdog.ts";

type Purpose = "interactive" | "scheduled" | "background";
type FailureKind = "none" | "pre_dispatch" | "mid_stream" | "busy" | "cancel";
type RequestPhase =
  | "new"
  | "waiting"
  | "active_primary"
  | "active_fallback"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";
type WatchdogState = "ok" | "stopped" | "finished";
type TrainingPhase = "idle" | "draining" | "holding";

interface ModelRequest {
  readonly id: number;
  readonly purpose: Purpose;
  readonly phase: RequestPhase;
  readonly enqueuedAt: number;
  readonly seq: number;
  readonly retries: number;
  readonly primaryFailure: FailureKind;
  readonly watchdog: WatchdogState;
}

interface ModelState {
  readonly now: number;
  readonly nextSeq: number;
  readonly capacity: number;
  readonly training: TrainingPhase;
  readonly requests: ReadonlyArray<ModelRequest>;
  readonly lastDispatchedRankViolation: boolean;
  readonly lastReleaseLeftInteractiveStuck: boolean;
}

interface FaultInjection {
  readonly retryOnCancel?: boolean;
  readonly skipGpuLockCheck?: boolean;
  readonly fallbackOnMidStream?: boolean;
  readonly phantomIdleAfterComplete?: boolean;
  readonly skipAging?: boolean;
}

interface Counterexample {
  readonly invariant: string;
  readonly trace: ReadonlyArray<string>;
  readonly state: ModelState;
}

const RANK: Record<Purpose, number> = { interactive: 0, scheduled: 1, background: 2 };
const AGING_STEP = InferenceAdmission.AGING_MS;

const effectiveRank = (req: ModelRequest, now: number, skipAging: boolean): number =>
  !skipAging && now - req.enqueuedAt >= AGING_STEP ? RANK.interactive : RANK[req.purpose];

const compareWaiters = (a: ModelRequest, b: ModelRequest, now: number, skipAging: boolean) =>
  effectiveRank(a, now, skipAging) - effectiveRank(b, now, skipAging) || a.seq - b.seq;

const activeRequests = (state: ModelState) =>
  state.requests.filter((req) => req.phase === "active_primary" || req.phase === "active_fallback");

const waitingRequests = (state: ModelState) =>
  state.requests.filter((req) => req.phase === "waiting");

const serializeState = (state: ModelState): string =>
  JSON.stringify([
    state.now,
    state.training,
    state.lastDispatchedRankViolation,
    state.lastReleaseLeftInteractiveStuck,
    state.requests.map((r) => [
      r.id,
      r.purpose,
      r.phase,
      r.enqueuedAt,
      r.seq,
      r.retries,
      r.primaryFailure,
      r.watchdog,
    ]),
  ]);

function checkInvariants(state: ModelState): string | undefined {
  const active = activeRequests(state);
  if (active.length > state.capacity) return "capacity-bound";
  if (state.training === "holding" && active.length > 0) return "gpu-mutual-exclusion";
  if (state.lastDispatchedRankViolation) return "starvation-free-aging";
  if (state.lastReleaseLeftInteractiveStuck) return "gpu-release-resumes-interactive";
  for (const req of state.requests) {
    if (req.phase === "cancelled" && req.retries > 0) return "no-retry-on-cancel";
    if (req.primaryFailure === "cancel" && req.retries > 0) return "no-retry-on-cancel";
    if (req.phase === "active_fallback" && req.primaryFailure !== "pre_dispatch") {
      return "pre-dispatch-only-fallback";
    }
    if (req.phase === "completed" && req.watchdog === "stopped") {
      return "no-phantom-watchdog-after-complete";
    }
  }
  return undefined;
}

function dispatchModel(state: ModelState, faults: FaultInjection): ModelState {
  const paused = state.training !== "idle";
  if (paused && !faults.skipGpuLockCheck) return state;
  const activeCount = activeRequests(state).length;
  const free = Math.max(0, state.capacity - activeCount);
  if (free === 0) return state;

  const waiting = waitingRequests(state);
  if (waiting.length === 0) return state;

  const orderedByModel = waiting.toSorted((a, b) =>
    compareWaiters(a, b, state.now, faults.skipAging === true),
  );
  const orderedBySpec = waiting.toSorted((a, b) => compareWaiters(a, b, state.now, false));
  const picked = orderedByModel.slice(0, free);
  const pickedIds = new Set(picked.map((req) => req.id));
  const specFirst = orderedBySpec[0];
  const rankViolation =
    specFirst !== undefined &&
    picked[0] !== undefined &&
    compareWaiters(picked[0], specFirst, state.now, false) > 0;

  return {
    ...state,
    lastDispatchedRankViolation: state.lastDispatchedRankViolation || rankViolation,
    requests: state.requests.map((req) =>
      pickedIds.has(req.id) ? { ...req, phase: "active_primary" } : req,
    ),
  };
}

function nextTransitions(
  state: ModelState,
  faults: FaultInjection,
): ReadonlyArray<{ readonly label: string; readonly next: ModelState }> {
  const edges: Array<{ label: string; next: ModelState }> = [];
  const replace = (id: number, patch: Partial<ModelRequest>): ReadonlyArray<ModelRequest> =>
    state.requests.map((req) => (req.id === id ? { ...req, ...patch } : req));

  const tryFinishDrain = (candidate: ModelState): ModelState =>
    candidate.training === "draining" && activeRequests(candidate).length === 0
      ? { ...candidate, training: "holding" }
      : candidate;

  for (const req of state.requests) {
    // Admit new request
    if (req.phase === "new") {
      if (state.training !== "idle" && req.purpose !== "interactive") {
        edges.push({
          label: `admit_rejected_training(r${req.id}:${req.purpose})`,
          next: {
            ...state,
            requests: replace(req.id, { phase: "rejected", primaryFailure: "busy" }),
          },
        });
      } else {
        const enqueued: ModelState = {
          ...state,
          nextSeq: state.nextSeq + 1,
          requests: replace(req.id, {
            phase: "waiting",
            enqueuedAt: state.now,
            seq: state.nextSeq,
          }),
        };
        edges.push({
          label: `admit(r${req.id}:${req.purpose})`,
          next: dispatchModel(enqueued, faults),
        });
      }
    }

    // Cancel from waiting
    if (req.phase === "waiting") {
      edges.push({
        label: `cancel_waiting(r${req.id})`,
        next: {
          ...state,
          requests: replace(req.id, { phase: "cancelled", primaryFailure: "cancel" }),
        },
      });
    }

    // Transitions from active_primary
    if (req.phase === "active_primary") {
      // Cancel active request
      if (faults.retryOnCancel) {
        edges.push({
          label: `cancel_active_buggy_retry(r${req.id})`,
          next: {
            ...state,
            requests: replace(req.id, {
              phase: "cancelled",
              primaryFailure: "cancel",
              retries: req.retries + 1,
            }),
          },
        });
      } else {
        const afterCancel = tryFinishDrain({
          ...state,
          requests: replace(req.id, { phase: "cancelled", primaryFailure: "cancel" }),
        });
        edges.push({
          label: `cancel_active(r${req.id})`,
          next: dispatchModel(afterCancel, faults),
        });
      }

      // Pre-dispatch primary failure -> fallback
      edges.push({
        label: `primary_pre_dispatch_fail(r${req.id})`,
        next: {
          ...state,
          requests: replace(req.id, {
            phase: "active_fallback",
            primaryFailure: "pre_dispatch",
          }),
        },
      });

      // Mid-stream primary failure -> MUST NOT fallback
      if (faults.fallbackOnMidStream) {
        edges.push({
          label: `primary_mid_stream_fail_buggy_fallback(r${req.id})`,
          next: {
            ...state,
            requests: replace(req.id, {
              phase: "active_fallback",
              primaryFailure: "mid_stream",
            }),
          },
        });
      } else {
        const afterFail = tryFinishDrain({
          ...state,
          requests: replace(req.id, { phase: "failed", primaryFailure: "mid_stream" }),
        });
        edges.push({
          label: `primary_mid_stream_fail(r${req.id})`,
          next: dispatchModel(afterFail, faults),
        });
      }

      // Watchdog loop stop
      const afterLoop = tryFinishDrain({
        ...state,
        requests: replace(req.id, { phase: "failed", watchdog: "stopped" }),
      });
      edges.push({
        label: `watchdog_loop_stop(r${req.id})`,
        next: dispatchModel(afterLoop, faults),
      });

      // Normal completion
      const afterComplete = tryFinishDrain({
        ...state,
        requests: replace(req.id, { phase: "completed", watchdog: "finished" }),
      });
      edges.push({
        label: `complete(r${req.id})`,
        next: dispatchModel(afterComplete, faults),
      });
    }

    // Transitions from active_fallback
    if (req.phase === "active_fallback") {
      const afterCancel = tryFinishDrain({
        ...state,
        requests: replace(req.id, { phase: "cancelled", primaryFailure: "cancel" }),
      });
      edges.push({
        label: `cancel_fallback(r${req.id})`,
        next: dispatchModel(afterCancel, faults),
      });
      const afterComplete = tryFinishDrain({
        ...state,
        requests: replace(req.id, { phase: "completed", watchdog: "finished" }),
      });
      edges.push({
        label: `complete_fallback(r${req.id})`,
        next: dispatchModel(afterComplete, faults),
      });
    }

    // Late idle watchdog tick after completion
    if (req.phase === "completed" && req.watchdog === "finished") {
      edges.push({
        label: `late_idle_tick(r${req.id})`,
        next: faults.phantomIdleAfterComplete
          ? { ...state, requests: replace(req.id, { watchdog: "stopped" }) }
          : state,
      });
    }
  }

  // Advance clock by one aging quantum (bounded to 1 step so state space stays finite)
  if (state.now < AGING_STEP && waitingRequests(state).length > 0) {
    edges.push({
      label: `advance_clock(+${AGING_STEP}ms)`,
      next: { ...state, now: state.now + AGING_STEP },
    });
  }

  // GPU exclusive pause lifecycle
  if (state.training === "idle") {
    const nextPhase: TrainingPhase = activeRequests(state).length === 0 ? "holding" : "draining";
    edges.push({
      label: "training_acquire_pause",
      next: { ...state, training: nextPhase },
    });
  } else {
    const hadInteractiveWaiting = waitingRequests(state).some((r) => r.purpose === "interactive");
    const resumed = dispatchModel({ ...state, training: "idle" }, faults);
    const stuck = hadInteractiveWaiting && activeRequests(resumed).length === 0;
    edges.push({
      label: "training_release_pause",
      next: { ...resumed, lastReleaseLeftInteractiveStuck: stuck },
    });
  }

  return edges;
}

/** Exhaustive BFS model checker returning the shortest counterexample trace if any invariant breaks. */
function exploreStateSpace(
  initial: ModelState,
  faults: FaultInjection = {},
  maxStates = 25_000,
): { readonly explored: number; readonly counterexample: Counterexample | undefined } {
  const visited = new Set<string>([serializeState(initial)]);
  const queue: Array<{ readonly state: ModelState; readonly trace: ReadonlyArray<string> }> = [
    { state: initial, trace: [] },
  ];
  let head = 0;

  while (head < queue.length && visited.size <= maxStates) {
    const current = queue[head++]!;
    const violation = checkInvariants(current.state);
    if (violation !== undefined) {
      return {
        explored: visited.size,
        counterexample: { invariant: violation, trace: current.trace, state: current.state },
      };
    }
    for (const edge of nextTransitions(current.state, faults)) {
      const key = serializeState(edge.next);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ state: edge.next, trace: [...current.trace, edge.label] });
    }
  }
  return { explored: visited.size, counterexample: undefined };
}

const makeInitialState = (purposes: ReadonlyArray<Purpose>, capacity = 1): ModelState => ({
  now: 0,
  nextSeq: 0,
  capacity,
  training: "idle",
  lastDispatchedRankViolation: false,
  lastReleaseLeftInteractiveStuck: false,
  requests: purposes.map((purpose, index) => ({
    id: index + 1,
    purpose,
    phase: "new",
    enqueuedAt: 0,
    seq: -1,
    retries: 0,
    primaryFailure: "none",
    watchdog: "ok",
  })),
});

describe("InferenceStateMachine formal verification", () => {
  describe("bug-first counterexample proofs (proves the checker catches real bugs)", () => {
    const base = makeInitialState(["background", "interactive"], 1);

    it("finds a minimal counterexample when retry-on-cancel bug is planted", () => {
      const result = exploreStateSpace(base, { retryOnCancel: true });
      expect(result.counterexample).toBeDefined();
      expect(result.counterexample?.invariant).toBe("no-retry-on-cancel");
      expect(result.counterexample?.trace.length).toBeLessThanOrEqual(3);
      expect(result.counterexample?.trace.at(-1)).toContain("cancel_active_buggy_retry");
    });

    it("finds a minimal counterexample when GPU mutual-exclusion check is missing", () => {
      const result = exploreStateSpace(base, { skipGpuLockCheck: true });
      expect(result.counterexample).toBeDefined();
      expect(result.counterexample?.invariant).toBe("gpu-mutual-exclusion");
      expect(result.counterexample?.trace).toContain("training_acquire_pause");
    });

    it("finds a minimal counterexample when mid-stream failure erroneously falls back", () => {
      const result = exploreStateSpace(base, { fallbackOnMidStream: true });
      expect(result.counterexample).toBeDefined();
      expect(result.counterexample?.invariant).toBe("pre-dispatch-only-fallback");
      expect(result.counterexample?.trace.at(-1)).toContain(
        "primary_mid_stream_fail_buggy_fallback",
      );
    });

    it("finds a minimal counterexample when late idle tick emits phantom stop after completion", () => {
      const result = exploreStateSpace(base, { phantomIdleAfterComplete: true });
      expect(result.counterexample).toBeDefined();
      expect(result.counterexample?.invariant).toBe("no-phantom-watchdog-after-complete");
      expect(result.counterexample?.trace.at(-1)).toContain("late_idle_tick");
    });

    it("finds a minimal counterexample when starvation-free aging is disabled", () => {
      const agingBase = makeInitialState(["interactive", "background", "interactive"], 1);
      const result = exploreStateSpace(agingBase, { skipAging: true });
      expect(result.counterexample).toBeDefined();
      expect(result.counterexample?.invariant).toBe("starvation-free-aging");
      expect(result.counterexample?.trace).toContain(`advance_clock(+${AGING_STEP}ms)`);
    });
  });

  describe("exhaustive bounded state-space verification of the clean model", () => {
    it("verifies all safety and liveness invariants across every reachable state (3 mixed-priority requests + GPU pause)", () => {
      const initial = makeInitialState(["interactive", "scheduled", "background"], 1);
      const result = exploreStateSpace(initial, {}, 30_000);
      expect(result.explored).toBeGreaterThan(500);
      expect(result.counterexample).toBeUndefined();
    });
  });

  describe("live implementation conformance against formal invariants (a)-(e)", () => {
    const server = InferenceServerId.make("mlx-local");

    it.effect(
      "(a)+(b)+(e) real InferenceAdmission upholds priority, aging, immediate cancel slot release, and GPU mutual exclusion across interleaved schedules",
      () =>
        Effect.gen(function* () {
          let activeCount = 0;
          let trainingHolding = false;
          const violations: Array<string> = [];
          const order: Array<string> = [];
          const admission = yield* InferenceAdmission.__testing.make({
            capacity: () => Effect.succeed(1),
            publish: () => Effect.void,
          });

          const spawnReq = (name: string, purpose: Purpose) =>
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const fiber = yield* Effect.scoped(
                admission
                  .admit({ serverId: server, purpose, threadId: ThreadId.make(`t-${name}`) })
                  .pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        activeCount += 1;
                        if (trainingHolding) violations.push(`active-during-training:${name}`);
                        if (activeCount > 1) violations.push(`capacity-exceeded:${name}`);
                        order.push(name);
                      }),
                    ),
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (order.includes(name)) activeCount -= 1;
                      }),
                    ),
                  ),
              ).pipe(Effect.forkChild({ startImmediately: true }));
              return { entered, release, fiber };
            });

          // 1. Holder enters; background + scheduled + interactive queue; cancel scheduled immediately.
          const holder = yield* spawnReq("holder", "interactive");
          yield* Deferred.await(holder.entered);
          const bg = yield* spawnReq("bg-aged", "background");
          const cancelledSched = yield* spawnReq("sched-cancelled", "scheduled");
          yield* Fiber.interrupt(cancelledSched.fiber);

          // 2. Age bg past AGING_MS, then enqueue a fresh interactive request: bg must win.
          yield* TestClock.adjust(InferenceAdmission.AGING_MS);
          const freshInteractive = yield* spawnReq("interactive-fresh", "interactive");

          // 3. Acquire exclusive GPU pause while holder is active -> must drain before holding.
          const gpuScope = yield* Scope.make();
          const gpuAcquired = yield* Deferred.make<void>();
          const gpuFiber = yield* admission
            .acquireExclusivePause({
              reason: "formal-conformance",
              serverIds: [server],
              drainTimeout: Duration.seconds(30),
            })
            .pipe(
              Scope.provide(gpuScope),
              Effect.andThen(
                Effect.sync(() => {
                  if (activeCount !== 0) violations.push("drained-with-active-nonzero");
                  trainingHolding = true;
                }),
              ),
              Effect.andThen(Deferred.succeed(gpuAcquired, undefined)),
              Effect.forkChild({ startImmediately: true }),
            );

          // While draining, new background requests fail fast with training_active.
          const bgRejected = yield* Effect.scoped(
            admission.admit({ serverId: server, purpose: "background" }),
          ).pipe(Effect.flip);
          expect(bgRejected.reason).toBe("training_active");

          // Complete holder -> GPU lease acquires with activeCount === 0, queued requests stay parked!
          yield* Deferred.succeed(holder.release, undefined);
          yield* Fiber.join(gpuFiber);
          expect(yield* Deferred.isDone(gpuAcquired)).toBe(true);
          expect(activeCount).toBe(0);
          expect(yield* Deferred.isDone(bg.entered)).toBe(false);
          expect(yield* Deferred.isDone(freshInteractive.entered)).toBe(false);

          // Release GPU lease -> aged bg enters first, then freshInteractive.
          trainingHolding = false;
          yield* Scope.close(gpuScope, Exit.void);
          yield* Deferred.await(bg.entered);
          yield* Deferred.succeed(bg.release, undefined);
          yield* Deferred.await(freshInteractive.entered);
          yield* Deferred.succeed(freshInteractive.release, undefined);
          yield* Fiber.join(freshInteractive.fiber);

          expect(violations).toEqual([]);
          expect(order).toEqual(["holder", "bg-aged", "interactive-fresh"]);
          expect(activeCount).toBe(0);
        }),
    );

    it("(c) real InferenceRouting.isPreDispatchFailure accepts only connection-phase failures and InferenceRetry guards non-object bodies", () => {
      for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]) {
        expect(InferenceRouting.isPreDispatchFailure({ cause: { code } })).toBe(true);
      }
      for (const nonPreDispatch of [
        { code: "ECONNRESET" },
        { code: "ETIMEDOUT" },
        { code: "ABORT_ERR" },
        new Error("mid-stream disconnect"),
        null,
      ]) {
        expect(InferenceRouting.isPreDispatchFailure(nonPreDispatch)).toBe(false);
      }
      // PR #9 guard: non-object request body never throws or retries
      expect(InferenceRetry.rejectedField({ error: { param: "seed" } }, null)).toBeUndefined();
      expect(
        InferenceRetry.rejectedField({ error: { param: "seed" } }, ["not-obj"]),
      ).toBeUndefined();
    });

    it("(d) real InferenceWatchdog terminates final-chunk repetition loops deterministically", () => {
      const watchdog = makeInferenceWatchdog();
      const unit = "The quick brown fox jumps over the lazy dog repeatedly in a loop! ".padEnd(
        96,
        "x",
      );
      let stopped: string | undefined;
      // Feed 1 KiB chunks; the loop must be caught once repeated >= 8 times over >= 4 KiB across two checks.
      const streamText = unit.repeat(80);
      for (let offset = 0; offset < streamText.length && stopped === undefined; offset += 1024) {
        stopped = watchdog.onDelta("answer", streamText.slice(offset, offset + 1024));
      }
      expect(stopped).toBe("loop");
    });
  });
});
