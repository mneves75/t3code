import {
  type InferenceGatewayQueue,
  type InferenceRequestPurpose,
  InferenceServerId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Settings from "../serverSettings.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";

/** Scheduled and background requests waiting this long rank with interactive ones, so none starve. */
export const AGING_MS = 30_000;
/** Per server; past this the gateway refuses instead of queueing. */
export const MAX_WAITING = 64;
/** Local generations can run for minutes, so the wait bound is generous. */
export const MAX_WAIT_MS = 10 * 60_000;

export class InferenceAdmissionError extends Schema.TaggedError<InferenceAdmissionError>()(
  "InferenceAdmissionError",
  {
    reason: Schema.Literals(["queue_full", "timed_out", "training_active"]),
    message: Schema.String,
  },
) {}

export class InferenceDrainTimeoutError extends Schema.TaggedError<InferenceDrainTimeoutError>()(
  "InferenceDrainTimeoutError",
  {
    message: Schema.String,
    serverIds: Schema.Array(InferenceServerId),
  },
) {}

export interface AdmissionTicket {
  readonly serverId: InferenceServerId;
  readonly purpose: InferenceRequestPurpose;
  readonly threadId?: ThreadId | undefined;
}

export class InferenceAdmission extends Context.Service<
  InferenceAdmission,
  {
    /** Waits for a generation slot on the ticket's server; the slot is held until the scope closes. */
    readonly admit: (
      ticket: AdmissionTicket,
    ) => Effect.Effect<void, InferenceAdmissionError, Scope.Scope>;
    /**
     * Pauses local admissions for `serverIds` and waits until active requests drain.
     * Its scope finalizer unpauses and dispatches queued interactive waiters.
     */
    readonly acquireExclusivePause: (input: {
      readonly reason: string;
      readonly serverIds: ReadonlyArray<InferenceServerId>;
      readonly drainTimeout: Duration.Duration;
    }) => Effect.Effect<void, InferenceDrainTimeoutError, Scope.Scope>;
  }
>()("t3/inference/InferenceAdmission") {}

interface Entry {
  readonly seq: number;
  readonly ticket: AdmissionTicket;
  readonly enqueuedAt: number;
  readonly granted: Deferred.Deferred<void>;
}

interface ServerQueue {
  readonly active: ReadonlyArray<Entry>;
  readonly waiting: ReadonlyArray<Entry>;
  readonly pauseLeases: ReadonlySet<symbol>;
  readonly drainWaiters: ReadonlyArray<Deferred.Deferred<void>>;
}

const EMPTY_QUEUE: ServerQueue = {
  active: [],
  waiting: [],
  pauseLeases: new Set(),
  drainWaiters: [],
};

const RANK: Record<InferenceRequestPurpose, number> = {
  interactive: 0,
  scheduled: 1,
  background: 2,
};

const orderWaiting = (waiting: ReadonlyArray<Entry>, now: number): ReadonlyArray<Entry> => {
  const rank = (entry: Entry) =>
    now - entry.enqueuedAt >= AGING_MS ? RANK.interactive : RANK[entry.ticket.purpose];
  return waiting.toSorted((a, b) => rank(a) - rank(b) || a.seq - b.seq);
};

/** Moves waiters into free slots when unpaused, best first; wakes drain waiters once active hits 0. */
const dispatch = (queue: ServerQueue, capacity: number, now: number) => {
  const ordered = orderWaiting(queue.waiting, now);
  const paused = queue.pauseLeases.size > 0;
  const free = paused ? 0 : Math.max(0, capacity - queue.active.length);
  const granted = ordered.slice(0, free);
  const active = [...queue.active, ...granted];
  const drained = active.length === 0 ? queue.drainWaiters : [];
  return {
    queue: {
      active,
      waiting: ordered.slice(free),
      pauseLeases: queue.pauseLeases,
      drainWaiters: active.length === 0 ? [] : queue.drainWaiters,
    },
    granted,
    drained,
  };
};

const toSnapshot = (capacity: number, queue: ServerQueue, now: number): InferenceGatewayQueue => ({
  capacity,
  ...(queue.pauseLeases.size > 0 ? { pausedForTraining: true } : {}),
  active: queue.active.map(({ ticket }) => ({
    ...(ticket.threadId === undefined ? {} : { threadId: ticket.threadId }),
    purpose: ticket.purpose,
  })),
  waiting: orderWaiting(queue.waiting, now).map(({ ticket }, index) => ({
    ...(ticket.threadId === undefined ? {} : { threadId: ticket.threadId }),
    purpose: ticket.purpose,
    position: index + 1,
  })),
});

export interface InferenceAdmissionOptions {
  readonly capacity: (serverId: InferenceServerId) => Effect.Effect<number>;
  readonly publish: (
    serverId: InferenceServerId,
    queue: InferenceGatewayQueue,
  ) => Effect.Effect<void>;
}

const makeWithOptions = Effect.fn("InferenceAdmission.make")(function* (
  options: InferenceAdmissionOptions,
) {
  const queues = yield* Ref.make(new Map<InferenceServerId, ServerQueue>());
  const nextSeq = yield* Ref.make(0);

  const notify = (
    serverId: InferenceServerId,
    capacity: number,
    now: number,
    result: ReturnType<typeof dispatch>,
  ) =>
    Effect.forEach(result.granted, (entry) => Deferred.succeed(entry.granted, undefined), {
      discard: true,
    }).pipe(
      Effect.andThen(
        Effect.forEach(result.drained, (waiter) => Deferred.succeed(waiter, undefined), {
          discard: true,
        }),
      ),
      Effect.andThen(options.publish(serverId, toSnapshot(capacity, result.queue, now))),
    );

  /** Applies `change`, fills free slots, wakes whoever got one, and publishes the result. */
  const update = Effect.fn("InferenceAdmission.update")(function* (
    serverId: InferenceServerId,
    change: (queue: ServerQueue) => ServerQueue,
  ) {
    const capacity = yield* options.capacity(serverId);
    const now = yield* Clock.currentTimeMillis;
    const result = yield* Ref.modify(queues, (all) => {
      const next = dispatch(change(all.get(serverId) ?? EMPTY_QUEUE), capacity, now);
      return [next, new Map(all).set(serverId, next.queue)] as const;
    });
    yield* notify(serverId, capacity, now, result);
  });

  const remove = (entry: Entry) =>
    update(entry.ticket.serverId, (queue) => ({
      ...queue,
      active: queue.active.filter((candidate) => candidate !== entry),
      waiting: queue.waiting.filter((candidate) => candidate !== entry),
    }));

  const admit = Effect.fn("InferenceAdmission.admit")(function* (ticket: AdmissionTicket) {
    type AdmitDecision =
      | { readonly _tag: "training_active" }
      | { readonly _tag: "queue_full" }
      | {
          readonly _tag: "enqueued";
          readonly queued: Entry;
          readonly result: ReturnType<typeof dispatch>;
        };
    const acquired = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const capacity = yield* options.capacity(ticket.serverId);
        const now = yield* Clock.currentTimeMillis;
        const seq = yield* Ref.getAndUpdate(nextSeq, (value) => value + 1);
        const queued: Entry = {
          seq,
          ticket,
          enqueuedAt: now,
          granted: yield* Deferred.make<void>(),
        };
        const decision = yield* Ref.modify(
          queues,
          (all): readonly [AdmitDecision, Map<InferenceServerId, ServerQueue>] => {
            const current = all.get(ticket.serverId) ?? EMPTY_QUEUE;
            if (current.pauseLeases.size > 0 && ticket.purpose !== "interactive") {
              return [{ _tag: "training_active" }, all];
            }
            if (current.waiting.length >= MAX_WAITING) {
              return [{ _tag: "queue_full" }, all];
            }
            const result = dispatch(
              { ...current, waiting: [...current.waiting, queued] },
              capacity,
              now,
            );
            return [
              { _tag: "enqueued", queued, result },
              new Map(all).set(ticket.serverId, result.queue),
            ];
          },
        );
        if (decision._tag === "enqueued") {
          yield* notify(ticket.serverId, capacity, now, decision.result);
        }
        return decision;
      }),
      (decision) => (decision._tag === "enqueued" ? remove(decision.queued) : Effect.void),
    );
    if (acquired._tag === "training_active") {
      return yield* new InferenceAdmissionError({
        reason: "training_active",
        message: "Local inference is paused while training is running.",
      });
    }
    if (acquired._tag === "queue_full") {
      return yield* new InferenceAdmissionError({
        reason: "queue_full",
        message: `${MAX_WAITING} requests are already waiting for this inference server.`,
      });
    }
    yield* Deferred.await(acquired.queued.granted).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(MAX_WAIT_MS),
        orElse: () =>
          remove(acquired.queued).pipe(
            Effect.andThen(
              Effect.fail(
                new InferenceAdmissionError({
                  reason: "timed_out",
                  message: "No inference slot freed up within 10 minutes.",
                }),
              ),
            ),
          ),
      }),
    );
  });

  const acquireExclusivePause = Effect.fn("InferenceAdmission.acquireExclusivePause")(
    function* (input: {
      readonly reason: string;
      readonly serverIds: ReadonlyArray<InferenceServerId>;
      readonly drainTimeout: Duration.Duration;
    }) {
      const uniqueIds = [...new Set(input.serverIds)];
      if (uniqueIds.length === 0) return;

      const lease = Symbol(input.reason);
      const released = yield* Ref.make(false);

      const releaseLease = Effect.fnUntraced(function* () {
        if (yield* Ref.getAndSet(released, true)) return;
        yield* Effect.forEach(
          uniqueIds,
          (serverId) =>
            update(serverId, (queue) => {
              const nextLeases = new Set(queue.pauseLeases);
              nextLeases.delete(lease);
              return { ...queue, pauseLeases: nextLeases };
            }),
          { discard: true },
        );
      }, Effect.uninterruptible);

      const scope = yield* Scope.Scope;
      yield* Effect.uninterruptible(
        Effect.forEach(
          uniqueIds,
          (serverId) =>
            update(serverId, (queue) => {
              const nextLeases = new Set(queue.pauseLeases);
              nextLeases.add(lease);
              return { ...queue, pauseLeases: nextLeases };
            }),
          { discard: true },
        ).pipe(Effect.andThen(Scope.addFinalizer(scope, releaseLease()))),
      );

      const waiters: Array<{
        readonly serverId: InferenceServerId;
        readonly deferred: Deferred.Deferred<void>;
      }> = [];
      for (const serverId of uniqueIds) {
        const deferred = yield* Deferred.make<void>();
        const needsWait = yield* Ref.modify(queues, (all) => {
          const current = all.get(serverId) ?? EMPTY_QUEUE;
          if (current.active.length === 0) return [false, all] as const;
          return [
            true,
            new Map(all).set(serverId, {
              ...current,
              drainWaiters: [...current.drainWaiters, deferred],
            }),
          ] as const;
        });
        if (needsWait) waiters.push({ serverId, deferred });
      }

      if (waiters.length === 0) return;

      const cleanupWaiters = Ref.update(queues, (all) => {
        const next = new Map(all);
        for (const { serverId, deferred } of waiters) {
          const current = next.get(serverId);
          if (current === undefined) continue;
          next.set(serverId, {
            ...current,
            drainWaiters: current.drainWaiters.filter((candidate) => candidate !== deferred),
          });
        }
        return next;
      });

      const drained = yield* Effect.forEach(waiters, ({ deferred }) => Deferred.await(deferred), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.timeoutOption(input.drainTimeout),
        Effect.ensuring(cleanupWaiters),
        Effect.onInterrupt(() => releaseLease()),
      );

      if (Option.isNone(drained)) {
        const currentQueues = yield* Ref.get(queues);
        const stillActive = uniqueIds.filter(
          (serverId) => (currentQueues.get(serverId)?.active.length ?? 0) > 0,
        );
        yield* releaseLease();
        return yield* new InferenceDrainTimeoutError({
          message: `Timed out waiting for active inference requests to drain (${input.reason}).`,
          serverIds: stillActive.length > 0 ? stillActive : uniqueIds,
        });
      }
    },
  );

  return InferenceAdmission.of({ admit, acquireExclusivePause });
});

/**
 * Capacity is the configured maxConcurrency, else what the probe verified for the engine, else 1.
 * Queue state rides on the server's snapshot.
 */
export const layer = Layer.effect(
  InferenceAdmission,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const registry = yield* InferenceServerRegistry.InferenceServerRegistry;
    return yield* makeWithOptions({
      capacity: Effect.fn("InferenceAdmission.capacity")(function* (serverId) {
        const configured = yield* settings.getSettings.pipe(
          Effect.map((current) => current.inferenceServers[serverId]?.maxConcurrency),
          Effect.orElseSucceed(() => undefined),
        );
        if (configured !== undefined) return configured;
        const snapshot = (yield* registry.current).find((candidate) => candidate.id === serverId);
        return snapshot?.maxConcurrentRequests ?? 1;
      }),
      publish: registry.publishGatewayQueue,
    });
  }),
);

export const __testing = { make: makeWithOptions };
