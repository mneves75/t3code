import { expect, it } from "@effect/vitest";
import {
  type InferenceGatewayQueue,
  type InferenceRequestPurpose,
  InferenceServerId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as InferenceAdmission from "./InferenceAdmission.ts";

const server = InferenceServerId.make("rtx");

const setup = (capacity = 1) =>
  Effect.gen(function* () {
    const published = yield* Ref.make<ReadonlyArray<InferenceGatewayQueue | undefined>>([]);
    const admission = yield* InferenceAdmission.__testing.make({
      capacity: () => Effect.succeed(capacity),
      publish: (_serverId, queue) => Ref.update(published, (all) => [...all, queue]),
    });
    const order: Array<string> = [];
    /** Starts a request that holds its permit until `done` completes. */
    const request = (name: string, purpose: InferenceRequestPurpose) =>
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const fiber = yield* Effect.scoped(
          admission
            .admit({ serverId: server, purpose, threadId: ThreadId.make(`thread-${name}`) })
            .pipe(
              Effect.andThen(Effect.sync(() => order.push(name))),
              Effect.andThen(Deferred.succeed(admitted, undefined)),
              Effect.andThen(Deferred.await(done)),
            ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        return { admitted, done, fiber };
      });
    const lastQueue = Ref.get(published).pipe(Effect.map((all) => all.at(-1)));
    return { admission, request, order, lastQueue };
  });

it.effect("serves interactive before scheduled before background, FIFO within a class", () =>
  Effect.gen(function* () {
    const { request, order, lastQueue } = yield* setup(1);
    const holder = yield* request("holder", "background");
    yield* Deferred.await(holder.admitted);
    const background = yield* request("background", "background");
    const scheduled = yield* request("scheduled", "scheduled");
    const first = yield* request("first", "interactive");
    const second = yield* request("second", "interactive");
    expect(yield* lastQueue).toEqual({
      capacity: 1,
      active: [{ threadId: "thread-holder", purpose: "background" }],
      waiting: [
        { threadId: "thread-first", purpose: "interactive", position: 1 },
        { threadId: "thread-second", purpose: "interactive", position: 2 },
        { threadId: "thread-scheduled", purpose: "scheduled", position: 3 },
        { threadId: "thread-background", purpose: "background", position: 4 },
      ],
    });
    for (const [releasing, next] of [
      [holder, first],
      [first, second],
      [second, scheduled],
      [scheduled, background],
    ] as const) {
      yield* Deferred.succeed(releasing.done, undefined);
      yield* Deferred.await(next.admitted);
    }
    yield* Deferred.succeed(background.done, undefined);
    yield* Fiber.join(background.fiber);
    expect(order).toEqual(["holder", "first", "second", "scheduled", "background"]);
    expect(yield* lastQueue).toEqual({ capacity: 1, active: [], waiting: [] });
  }),
);

it.effect("promotes background work that has waited past the aging threshold", () =>
  Effect.gen(function* () {
    const { request, order } = yield* setup(1);
    const holder = yield* request("holder", "interactive");
    yield* Deferred.await(holder.admitted);
    const background = yield* request("background", "background");
    yield* TestClock.adjust(InferenceAdmission.AGING_MS);
    const interactive = yield* request("interactive", "interactive");
    yield* Deferred.succeed(holder.done, undefined);
    yield* Deferred.await(background.admitted);
    yield* Deferred.succeed(background.done, undefined);
    yield* Deferred.await(interactive.admitted);
    expect(order).toEqual(["holder", "background", "interactive"]);
  }),
);

it.effect("frees a queued slot on cancel and a held permit when its scope closes", () =>
  Effect.gen(function* () {
    const { admission, request, lastQueue } = yield* setup(1);
    const scope = yield* Scope.make();
    yield* admission.admit({ serverId: server, purpose: "interactive" }).pipe(Scope.provide(scope));
    expect((yield* lastQueue)?.active).toHaveLength(1);
    const cancelled = yield* request("cancelled", "interactive");
    expect((yield* lastQueue)?.waiting).toHaveLength(1);
    yield* Fiber.interrupt(cancelled.fiber);
    expect((yield* lastQueue)?.waiting).toEqual([]);

    const next = yield* request("next", "background");
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(next.admitted);
  }),
);

it.effect("refuses beyond the queue bound and gives up after the max wait", () =>
  Effect.gen(function* () {
    const { admission, request, lastQueue } = yield* setup(1);
    const holder = yield* request("holder", "interactive");
    yield* Deferred.await(holder.admitted);
    const waiters = yield* Effect.forEach(
      Array.from({ length: InferenceAdmission.MAX_WAITING }, (_, index) => index),
      (index) => request(`waiter-${index}`, "background"),
    );
    const full = yield* Effect.scoped(
      admission.admit({ serverId: server, purpose: "interactive" }),
    ).pipe(Effect.flip);
    expect(full.reason).toBe("queue_full");

    yield* TestClock.adjust(InferenceAdmission.MAX_WAIT_MS);
    const timedOut = yield* Fiber.await(waiters[0]!.fiber);
    expect(Exit.isFailure(timedOut)).toBe(true);
    expect((yield* lastQueue)?.waiting).toEqual([]);
  }),
);

it.effect(
  "acquireExclusivePause drains active requests, fails background/scheduled fast, queues interactive with pausedForTraining, and resumes on release",
  () =>
    Effect.gen(function* () {
      const { admission, request, order, lastQueue } = yield* setup(1);
      const active = yield* request("active", "interactive");
      yield* Deferred.await(active.admitted);

      const pauseScope = yield* Scope.make();
      const paused = yield* Deferred.make<void>();
      const pauseFiber = yield* admission
        .acquireExclusivePause({
          reason: "mlx-lora-job-1",
          serverIds: [server],
          drainTimeout: Duration.seconds(30),
        })
        .pipe(
          Scope.provide(pauseScope),
          Effect.andThen(Deferred.succeed(paused, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );

      // Pause is active immediately while waiting for `active` to drain.
      expect((yield* lastQueue)?.pausedForTraining).toBe(true);
      expect(yield* Deferred.isDone(paused)).toBe(false);

      // Background and scheduled fail fast with training_active.
      for (const purpose of ["background", "scheduled"] as const) {
        const err = yield* Effect.scoped(admission.admit({ serverId: server, purpose })).pipe(
          Effect.flip,
        );
        expect(err.reason).toBe("training_active");
      }

      // Interactive queues while paused and does not run until pause releases.
      const queuedInteractive = yield* request("queued-interactive", "interactive");
      expect(yield* lastQueue).toEqual({
        capacity: 1,
        pausedForTraining: true,
        active: [{ threadId: "thread-active", purpose: "interactive" }],
        waiting: [{ threadId: "thread-queued-interactive", purpose: "interactive", position: 1 }],
      });

      // Completing the active request drains the server and resolves acquireExclusivePause.
      yield* Deferred.succeed(active.done, undefined);
      yield* Fiber.join(pauseFiber);
      expect(yield* Deferred.isDone(paused)).toBe(true);
      expect(yield* Deferred.isDone(queuedInteractive.admitted)).toBe(false);
      expect(yield* lastQueue).toEqual({
        capacity: 1,
        pausedForTraining: true,
        active: [],
        waiting: [{ threadId: "thread-queued-interactive", purpose: "interactive", position: 1 }],
      });

      // Releasing the pause scope dispatches the queued interactive request and clears pausedForTraining.
      yield* Scope.close(pauseScope, Exit.void);
      yield* Deferred.await(queuedInteractive.admitted);
      expect((yield* lastQueue)?.pausedForTraining).toBeUndefined();
      expect((yield* lastQueue)?.active).toEqual([
        { threadId: "thread-queued-interactive", purpose: "interactive" },
      ]);
      yield* Deferred.succeed(queuedInteractive.done, undefined);
      yield* Fiber.join(queuedInteractive.fiber);
      expect(order).toEqual(["active", "queued-interactive"]);
    }),
);

it.effect(
  "acquireExclusivePause fails with InferenceDrainTimeoutError on timeout and unpauses queued interactive waiters",
  () =>
    Effect.gen(function* () {
      const { admission, request, lastQueue } = yield* setup(1);
      const active = yield* request("active", "interactive");
      yield* Deferred.await(active.admitted);

      const outerScope = yield* Scope.make();
      const pauseFiber = yield* admission
        .acquireExclusivePause({
          reason: "mlx-lora-timeout",
          serverIds: [server],
          drainTimeout: Duration.seconds(10),
        })
        .pipe(Scope.provide(outerScope), Effect.flip, Effect.forkChild({ startImmediately: true }));

      const queued = yield* request("queued", "interactive");
      expect((yield* lastQueue)?.pausedForTraining).toBe(true);

      yield* TestClock.adjust(Duration.seconds(10));
      const error = yield* Fiber.join(pauseFiber);
      expect(error._tag).toBe("InferenceDrainTimeoutError");
      expect(error.serverIds).toEqual([server]);
      // Even before outerScope closes, timeout released the pause.
      expect((yield* lastQueue)?.pausedForTraining).toBeUndefined();

      yield* Deferred.succeed(active.done, undefined);
      yield* Deferred.await(queued.admitted);
      yield* Deferred.succeed(queued.done, undefined);
      yield* Fiber.join(queued.fiber);
      yield* Scope.close(outerScope, Exit.void);
    }),
);
