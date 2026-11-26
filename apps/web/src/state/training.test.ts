import { EnvironmentId, type TrainingJobSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import {
  EMPTY_TRAINING_LIVE_STATE,
  type TrainingLiveState,
} from "../components/settings/TrainingSettings.logic";

const runtime = vi.hoisted(() => ({
  artifactFetches: 0,
  stream: null as Atom.Writable<AsyncResult.AsyncResult<TrainingLiveState>> | null,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async () => {
  const reactivity = await import("effect/reactivity");
  const logic = await import("../components/settings/TrainingSettings.logic");
  runtime.stream = reactivity.Atom.make<AsyncResult.AsyncResult<TrainingLiveState>>(
    reactivity.AsyncResult.success(logic.EMPTY_TRAINING_LIVE_STATE),
  );
  const stream = runtime.stream;
  return {
    createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
    createEnvironmentSubscriptionAtomFamily: () => () => stream,
    environmentSessionGenerationAtom: () => reactivity.Atom.make(0),
    runAtomCommand: async (_registry: unknown, command: string) => {
      if (command === "training.listArtifacts") runtime.artifactFetches += 1;
      return { _tag: "Success", value: { artifacts: [] } };
    },
  } as never;
});
vi.mock(import("../connection/runtime"), () => ({ connectionAtomRuntime: {} }) as never);

import { trainingArtifactsValueAtom } from "./training";

const environmentId = EnvironmentId.make("environment-training");
const job = (status: TrainingJobSnapshot["status"], step: number) =>
  ({ id: "job-1", status, latestMetric: { step } }) as unknown as TrainingJobSnapshot;

it("refetches artifacts when a job completes, since the artifact is stored before completion", async () => {
  const registry = AtomRegistry.make();
  const stream = runtime.stream!;
  const live = (jobs: ReadonlyArray<TrainingJobSnapshot>) =>
    registry.set(stream, AsyncResult.success({ ...EMPTY_TRAINING_LIVE_STATE, loaded: true, jobs }));
  const unmount = registry.mount(trainingArtifactsValueAtom(environmentId));

  live([job("training", 10)]);
  await vi.waitFor(() => expect(runtime.artifactFetches).toBe(1));

  live([job("completed", 20)]);
  await vi.waitFor(() => expect(runtime.artifactFetches).toBe(2));

  live([job("completed", 21)]);
  await Promise.resolve();
  expect(runtime.artifactFetches).toBe(2);
  unmount();
});
