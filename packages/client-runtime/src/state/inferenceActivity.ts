import type { InferenceServerId, InferenceServerSnapshot, ThreadId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";

/** A thread's request held in T3's gateway queue for a busy inference server. */
export interface ThreadInferenceWait {
  readonly serverId: InferenceServerId;
  readonly serverName: string;
  /** Requests the gateway will start before this one. */
  readonly ahead: number;
  /** True while local GPU fine-tuning has paused this server's admission queue. */
  readonly pausedForTraining?: boolean;
}

/** The thread's queued request closest to running, or null when none is waiting. */
export function threadInferenceWait(
  servers: ReadonlyArray<InferenceServerSnapshot> | null | undefined,
  threadId: ThreadId,
): ThreadInferenceWait | null {
  let best: ThreadInferenceWait | null = null;
  for (const server of servers ?? []) {
    const pausedForTraining = server.gatewayQueue?.pausedForTraining === true;
    for (const entry of server.gatewayQueue?.waiting ?? []) {
      if (entry.threadId !== threadId) continue;
      const ahead = entry.position - 1;
      if (best === null || ahead < best.ahead) {
        best = {
          serverId: server.id,
          serverName: server.displayName,
          ahead,
          ...(pausedForTraining ? { pausedForTraining: true } : {}),
        };
      }
    }
  }
  return best;
}

export function sameThreadInferenceWait(
  a: ThreadInferenceWait | null,
  b: ThreadInferenceWait | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.serverId === b.serverId &&
      a.serverName === b.serverName &&
      a.ahead === b.ahead &&
      Boolean(a.pausedForTraining) === Boolean(b.pausedForTraining))
  );
}

/** "Waiting for rtx · 2 ahead"; "next" once nothing is ahead, or training pause notice. */
export function formatThreadInferenceWait(wait: ThreadInferenceWait): string {
  if (wait.pausedForTraining) {
    return mFallback(
      msg("Paused while fine-tuning is running ({serverName})", {
        serverName: wait.serverName,
      }),
    );
  }
  return wait.ahead === 0
    ? mFallback(msg("Waiting for {serverName} · next", { serverName: wait.serverName }))
    : mFallback(
        msg("Waiting for {serverName} · {ahead} ahead", {
          serverName: wait.serverName,
          ahead: wait.ahead,
        }),
      );
}
