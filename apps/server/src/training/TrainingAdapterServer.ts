// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- spawns detached loopback mlx_lm.server subprocesses and polls /health
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

import {
  InferenceServerId,
  type TrainingArtifact,
  type TrainingArtifactId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as InferenceServerRegistry from "../inference/InferenceServerRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildSanitizedChildEnv,
  resolveMlxBinary,
  terminateProcessGroup,
} from "./MlxLoraTrainer.ts";

export class TrainingAdapterServerError extends Schema.TaggedError<TrainingAdapterServerError>()(
  "TrainingAdapterServerError",
  {
    operation: Schema.String,
    artifactId: Schema.optional(Schema.String),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Training adapter server (${this.operation}) failed: ${this.reason}`;
  }
}

export interface ManagedServerProcess {
  readonly artifactId: TrainingArtifactId;
  readonly model: string;
  readonly adapterPath: string | null;
  readonly mode: "adapter" | "fused";
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number;
  readonly registeredServerId: InferenceServerId | null;
}

export interface StoppedServerSpec {
  readonly artifactId: TrainingArtifactId;
  readonly model: string;
  readonly adapterPath: string | null;
  readonly mode: "adapter" | "fused";
  readonly registeredServerId: InferenceServerId | null;
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine allocated TCP port.")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function buildMlxServerArgv(input: {
  readonly model: string;
  readonly adapterPath: string | null;
  readonly port: number;
}): ReadonlyArray<string> {
  return [
    "--model",
    input.model,
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    ...(input.adapterPath !== null && input.adapterPath.length > 0
      ? ["--adapter-path", input.adapterPath]
      : []),
  ];
}

async function waitForLoopbackHealth(
  port: number,
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<void> {
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitCode: number | null = null;
  const onClose = (code: number | null) => {
    exited = true;
    exitCode = code;
  };
  child.once("close", onClose);
  try {
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(`mlx_lm.server exited early with code ${exitCode ?? -1}`);
      }
      try {
        const response = await fetchFn(healthUrl, {
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok) return;
      } catch {
        // Server still loading weights
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for mlx_lm.server health at ${healthUrl}`);
  } finally {
    child.removeListener("close", onClose);
  }
}

function inferenceServerIdForArtifact(artifactId: TrainingArtifactId): InferenceServerId {
  const sanitized = artifactId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return InferenceServerId.make(`mlx_ft_${sanitized}`);
}

export class TrainingAdapterServer extends Context.Service<
  TrainingAdapterServer,
  {
    readonly start: (input: {
      readonly artifact: TrainingArtifact;
      readonly mode: "adapter" | "fused";
      readonly autoRegisterInInference: boolean;
      readonly displayName?: string;
    }) => Effect.Effect<
      {
        readonly port: number;
        readonly baseUrl: string;
        readonly registeredServerId: InferenceServerId | null;
      },
      TrainingAdapterServerError
    >;
    readonly stop: (input: {
      readonly artifactId: TrainingArtifactId;
      readonly removeInferenceServer: boolean;
      readonly registeredServerId?: InferenceServerId | null;
    }) => Effect.Effect<void, TrainingAdapterServerError>;
    readonly registerInInference: (input: {
      readonly artifact: TrainingArtifact;
      readonly baseUrl: string;
      readonly displayName?: string;
      readonly serverId?: InferenceServerId;
    }) => Effect.Effect<
      { readonly serverId: InferenceServerId; readonly baseUrl: string },
      TrainingAdapterServerError
    >;
    readonly getActive: (
      artifactId: TrainingArtifactId,
    ) => Effect.Effect<ManagedServerProcess | null>;
    readonly listActive: Effect.Effect<ReadonlyArray<ManagedServerProcess>>;
    readonly stopAllManaged: Effect.Effect<ReadonlyArray<StoppedServerSpec>>;
    readonly startTemporary: (input: {
      readonly model: string;
      readonly adapterPath: string | null;
    }) => Effect.Effect<
      { readonly port: number; readonly baseUrl: string; readonly stop: Effect.Effect<void> },
      TrainingAdapterServerError
    >;
  }
>()("t3/training/TrainingAdapterServer") {}

export interface TrainingAdapterServerOptions {
  readonly healthTimeoutMs?: number;
  readonly spawnProcess?: typeof NodeChildProcess.spawn;
  readonly fetchFn?: typeof fetch;
  readonly resolveBinary?: (
    binaryName: "mlx_lm.lora" | "mlx_lm.fuse" | "mlx_lm.server",
    binDir?: string,
  ) => string | null;
}

export const makeWithOptions = Effect.fn("TrainingAdapterServer.make")(function* (
  options: TrainingAdapterServerOptions = {},
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const inferenceRegistry = yield* InferenceServerRegistry.InferenceServerRegistry;
  const activeRef = yield* Ref.make(new Map<TrainingArtifactId, ManagedServerProcess>());

  const spawnFn = options.spawnProcess ?? NodeChildProcess.spawn;
  const fetchFn = options.fetchFn ?? fetch;
  const resolveBin = options.resolveBinary ?? resolveMlxBinary;
  const healthTimeoutMs = options.healthTimeoutMs ?? 90_000;

  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(activeRef, new Map()).pipe(
      Effect.flatMap((running) =>
        Effect.forEach(
          [...running.values()],
          (proc) => Effect.promise(() => terminateProcessGroup(proc.pid)),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );

  const resolveServerBinary = Effect.fn("TrainingAdapterServer.resolveServerBinary")(function* () {
    const binDir = yield* settings.getSettings.pipe(
      Effect.map((current) => current.training.mlxBinDir || undefined),
      Effect.orElseSucceed(() => undefined),
    );
    const bin = resolveBin("mlx_lm.server", binDir);
    if (bin === null) {
      return yield* new TrainingAdapterServerError({
        operation: "resolveServerBinary",
        reason: "mlx_lm.server binary was not found on PATH or in configured mlxBinDir.",
      });
    }
    return bin;
  });

  const spawnLoopbackServer = Effect.fn("TrainingAdapterServer.spawnLoopbackServer")(
    function* (input: {
      readonly model: string;
      readonly adapterPath: string | null;
      readonly artifactId?: TrainingArtifactId;
    }) {
      const serverBin = yield* resolveServerBinary();
      const port = yield* Effect.tryPromise({
        try: () => allocateLoopbackPort(),
        catch: (cause) =>
          new TrainingAdapterServerError({
            operation: "allocateLoopbackPort",
            ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
            reason: "Failed to allocate a free loopback port for mlx_lm.server.",
            cause,
          }),
      });
      const argv = buildMlxServerArgv({
        model: input.model,
        adapterPath: input.adapterPath,
        port,
      });

      const child = spawnFn(serverBin, [...argv], {
        env: buildSanitizedChildEnv(),
        shell: false,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const pid = child.pid;
      if (pid === undefined) {
        return yield* new TrainingAdapterServerError({
          operation: "spawnLoopbackServer",
          ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
          reason: "mlx_lm.server spawned without a PID.",
        });
      }

      yield* Effect.tryPromise({
        try: () => waitForLoopbackHealth(port, child, healthTimeoutMs, fetchFn),
        catch: (cause) =>
          new TrainingAdapterServerError({
            operation: "waitForLoopbackHealth",
            ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
            reason: "mlx_lm.server did not become healthy on 127.0.0.1.",
            cause,
          }),
      }).pipe(Effect.onError(() => Effect.promise(() => terminateProcessGroup(pid))));

      return {
        pid,
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      };
    },
  );

  const registerInInference = Effect.fn("TrainingAdapterServer.registerInInference")(
    function* (input: {
      readonly artifact: TrainingArtifact;
      readonly baseUrl: string;
      readonly displayName?: string;
      readonly serverId?: InferenceServerId;
    }) {
      const expectedServerId = inferenceServerIdForArtifact(input.artifact.id);
      const serverId =
        input.serverId ?? input.artifact.registeredInferenceServerId ?? expectedServerId;
      const displayName = input.displayName ?? `MLX Fine-Tune: ${input.artifact.baseModel}`;
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TrainingAdapterServerError({
              operation: "registerInInference",
              artifactId: input.artifact.id,
              reason: "Failed to read server settings.",
              cause,
            }),
        ),
      );
      if (Object.hasOwn(current.inferenceServers, serverId) && serverId !== expectedServerId) {
        return yield* new TrainingAdapterServerError({
          operation: "registerInInference",
          artifactId: input.artifact.id,
          reason: `Inference server '${serverId}' already exists and is not owned by artifact '${input.artifact.id}'.`,
        });
      }

      yield* settings
        .updateSettings({
          inferenceServers: {
            [serverId]: {
              displayName,
              baseUrl: input.baseUrl,
              apiKey: "",
              enabled: true,
            },
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TrainingAdapterServerError({
                operation: "registerInInference",
                artifactId: input.artifact.id,
                reason: "Failed to save inference server entry in settings.",
                cause,
              }),
          ),
        );

      yield* inferenceRegistry.refresh(serverId);
      return { serverId, baseUrl: input.baseUrl };
    },
  );

  const stop = Effect.fn("TrainingAdapterServer.stop")(function* (input: {
    readonly artifactId: TrainingArtifactId;
    readonly removeInferenceServer: boolean;
    readonly registeredServerId?: InferenceServerId | null;
  }) {
    const removed = yield* Ref.modify(activeRef, (map) => {
      const existing = map.get(input.artifactId);
      if (existing === undefined) return [undefined, map] as const;
      const next = new Map(map);
      next.delete(input.artifactId);
      return [existing, next] as const;
    });

    if (removed !== undefined) {
      yield* Effect.promise(() => terminateProcessGroup(removed.pid));
    }

    const serverIdToRemove = input.registeredServerId ?? removed?.registeredServerId ?? null;
    if (input.removeInferenceServer && serverIdToRemove !== null) {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TrainingAdapterServerError({
              operation: "stop",
              artifactId: input.artifactId,
              reason: "Failed to read settings while removing inference server.",
              cause,
            }),
        ),
      );
      if (Object.hasOwn(current.inferenceServers, serverIdToRemove)) {
        yield* settings
          .updateSettings({
            inferenceServers: {
              [serverIdToRemove]: null,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TrainingAdapterServerError({
                  operation: "stop",
                  artifactId: input.artifactId,
                  reason: "Failed to update inference server settings.",
                  cause,
                }),
            ),
          );
        yield* inferenceRegistry.refresh();
      }
    }
  });

  const start = Effect.fn("TrainingAdapterServer.start")(function* (input: {
    readonly artifact: TrainingArtifact;
    readonly mode: "adapter" | "fused";
    readonly autoRegisterInInference: boolean;
    readonly displayName?: string;
  }) {
    const existing = (yield* Ref.get(activeRef)).get(input.artifact.id);
    if (existing !== undefined) {
      yield* stop({
        artifactId: input.artifact.id,
        removeInferenceServer: false,
      });
    }

    const model = input.mode === "fused" ? input.artifact.fusedModelPath : input.artifact.baseModel;
    if (model === null) {
      return yield* new TrainingAdapterServerError({
        operation: "start",
        artifactId: input.artifact.id,
        reason: "Artifact has no fused model path; fuse the artifact before serving in fused mode.",
      });
    }
    const adapterPath = input.mode === "adapter" ? input.artifact.adapterPath : null;

    const launched = yield* spawnLoopbackServer({
      model,
      adapterPath,
      artifactId: input.artifact.id,
    });

    let registeredServerId: InferenceServerId | null = input.artifact.registeredInferenceServerId;
    if (input.autoRegisterInInference) {
      const reg = yield* registerInInference({
        artifact: input.artifact,
        baseUrl: launched.baseUrl,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      });
      registeredServerId = reg.serverId;
    }

    const entry: ManagedServerProcess = {
      artifactId: input.artifact.id,
      model,
      adapterPath,
      mode: input.mode,
      port: launched.port,
      baseUrl: launched.baseUrl,
      pid: launched.pid,
      registeredServerId,
    };
    yield* Ref.update(activeRef, (map) => new Map(map).set(input.artifact.id, entry));

    return {
      port: launched.port,
      baseUrl: launched.baseUrl,
      registeredServerId,
    };
  });

  return TrainingAdapterServer.of({
    start,
    stop,
    registerInInference,
    getActive: Effect.fn("TrainingAdapterServer.getActive")(function* (artifactId) {
      return (yield* Ref.get(activeRef)).get(artifactId) ?? null;
    }),
    listActive: Ref.get(activeRef).pipe(Effect.map((map) => [...map.values()])),
    stopAllManaged: Effect.gen(function* () {
      const running = yield* Ref.getAndSet(activeRef, new Map());
      const stopped: Array<StoppedServerSpec> = [];
      for (const proc of running.values()) {
        yield* Effect.promise(() => terminateProcessGroup(proc.pid));
        stopped.push({
          artifactId: proc.artifactId,
          model: proc.model,
          adapterPath: proc.adapterPath,
          mode: proc.mode,
          registeredServerId: proc.registeredServerId,
        });
      }
      return stopped;
    }).pipe(Effect.withSpan("TrainingAdapterServer.stopAllManaged")),
    startTemporary: Effect.fn("TrainingAdapterServer.startTemporary")(function* (input) {
      const launched = yield* spawnLoopbackServer({
        model: input.model,
        adapterPath: input.adapterPath,
      });
      return {
        port: launched.port,
        baseUrl: launched.baseUrl,
        stop: Effect.promise(() => terminateProcessGroup(launched.pid)),
      };
    }),
  });
});

export const layer = Layer.effect(TrainingAdapterServer, makeWithOptions());
