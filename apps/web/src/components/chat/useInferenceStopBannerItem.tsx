import type { EnvironmentId, InferenceStopReason, ThreadId } from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";
import { msg, T, useGT, useMessages } from "gt-react";
import { OctagonPauseIcon } from "lucide-react";

import { hasInferenceServersAtom, threadInferenceStopAtom } from "../../state/inference";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NO_STOP = Atom.make(AsyncResult.initial<{ readonly stop: null }>());

const TITLES: Record<InferenceStopReason, string> = {
  loop: msg("Stopped a looping reply"),
  "reasoning-limit": msg("Stopped a reply that only reasoned"),
  idle: msg("Stopped a reply that went silent"),
};

// A run that is still going may yet recover; the notice waits for it to end.
const SETTLED_RUN: ReadonlySet<ThreadRunSummary["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

function stopDescription(
  gt: ReturnType<typeof useGT>,
  reason: InferenceStopReason,
  model: string,
  serverId: string,
): string {
  switch (reason) {
    case "loop":
      return gt(
        "{model} on {serverId} kept repeating the same text, so T3 Code stopped it and freed the server.",
        { model, serverId },
      );
    case "reasoning-limit":
      return gt(
        "{model} on {serverId} reasoned at length without answering, so T3 Code stopped it and freed the server.",
        { model, serverId },
      );
    case "idle":
      return gt(
        "{model} on {serverId} stopped sending anything, so T3 Code stopped it and freed the server.",
        { model, serverId },
      );
  }
}

/** After T3's gateway stopped a runaway reply in the thread's latest run: why, and what next. */
export function useInferenceStopBannerItem(
  environmentId: EnvironmentId,
  threadId: ThreadId | undefined,
  latestRun: ThreadRunSummary | null | undefined,
  onContinue: () => void,
  onChooseModel: () => void,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const messages = useMessages();
  const hasServers = useAtomValue(hasInferenceServersAtom(environmentId));
  const canRead = useAtomValue(
    serverEnvironment.getThreadInferenceStop.permissionAtom(environmentId),
  );
  const canQuery =
    hasServers &&
    canRead &&
    threadId !== undefined &&
    latestRun != null &&
    SETTLED_RUN.has(latestRun.status);
  const result = useAtomValue(
    canQuery ? threadInferenceStopAtom({ environmentId, threadId }) : NO_STOP,
  );
  const stop = AsyncResult.getOrElse(result, () => null)?.stop ?? null;
  if (
    !canQuery ||
    stop === null ||
    latestRun.startedAt === null ||
    Date.parse(stop.at) < Date.parse(latestRun.startedAt)
  ) {
    return null;
  }
  return {
    id: `inference-stop:${latestRun.runId}`,
    group: "attention",
    variant: "warning",
    icon: <OctagonPauseIcon />,
    title: messages(TITLES[stop.reason]),
    description: stopDescription(gt, stop.reason, stop.model, stop.serverId),
    actions: (
      <>
        <Button size="xs" variant="ghost" onClick={onContinue}>
          <T>Continue</T>
        </Button>
        <Button size="xs" variant="ghost" onClick={onChooseModel}>
          <T>Choose model</T>
        </Button>
      </>
    ),
  };
}
