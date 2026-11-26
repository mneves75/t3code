import { InferenceServerId, ThreadId, type InferenceServerSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatThreadInferenceWait, threadInferenceWait } from "./inferenceActivity.ts";

const thread = ThreadId.make("thread-1");
const other = ThreadId.make("thread-2");

function server(
  id: string,
  waiting: NonNullable<InferenceServerSnapshot["gatewayQueue"]>["waiting"],
  pausedForTraining = false,
): InferenceServerSnapshot {
  return {
    id: InferenceServerId.make(id),
    displayName: id,
    baseUrl: `http://${id}:8888/v1`,
    enabled: true,
    status: "ready",
    checkedAt: null,
    models: [],
    gatewayQueue: {
      capacity: 1,
      ...(pausedForTraining ? { pausedForTraining: true } : {}),
      active: [],
      waiting,
    },
  };
}

describe("threadInferenceWait", () => {
  it("finds the thread's queued request and ignores other threads and background work", () => {
    const servers = [
      server("rtx", [
        { threadId: other, purpose: "interactive", position: 1 },
        { purpose: "background", position: 2 },
        { threadId: thread, purpose: "interactive", position: 3 },
      ]),
    ];
    expect(threadInferenceWait(servers, thread)).toEqual({
      serverId: "rtx",
      serverName: "rtx",
      ahead: 2,
    });
    expect(threadInferenceWait(servers, ThreadId.make("thread-3"))).toBeNull();
    expect(threadInferenceWait(null, thread)).toBeNull();
  });

  it("treats the server's 1-based position 1 as next in line", () => {
    const servers = [server("rtx", [{ threadId: thread, purpose: "interactive", position: 1 }])];
    const wait = threadInferenceWait(servers, thread);
    expect(wait?.ahead).toBe(0);
    expect(wait && formatThreadInferenceWait(wait)).toBe("Waiting for rtx · next");
  });

  it("reports the request closest to running when the thread waits on several servers", () => {
    const servers = [
      server("rtx", [{ threadId: thread, purpose: "interactive", position: 3 }]),
      server("spark", [{ threadId: thread, purpose: "interactive", position: 1 }]),
    ];
    expect(threadInferenceWait(servers, thread)?.serverName).toBe("spark");
  });

  it("propagates pausedForTraining when the server's queue is paused for fine-tuning", () => {
    const servers = [
      server("mlx-local", [{ threadId: thread, purpose: "interactive", position: 1 }], true),
    ];
    expect(threadInferenceWait(servers, thread)).toEqual({
      serverId: "mlx-local",
      serverName: "mlx-local",
      ahead: 0,
      pausedForTraining: true,
    });
  });
});

describe("formatThreadInferenceWait", () => {
  it("says how many requests are ahead, next when none are, or training pause", () => {
    const wait = { serverId: InferenceServerId.make("rtx"), serverName: "rtx", ahead: 2 };
    expect(formatThreadInferenceWait(wait)).toBe("Waiting for rtx · 2 ahead");
    expect(formatThreadInferenceWait({ ...wait, ahead: 0 })).toBe("Waiting for rtx · next");
    expect(formatThreadInferenceWait({ ...wait, pausedForTraining: true })).toBe(
      "Paused while fine-tuning is running (rtx)",
    );
  });
});
