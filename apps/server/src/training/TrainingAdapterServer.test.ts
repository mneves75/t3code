// @effect-diagnostics nodeBuiltinImport:off -- temp fake server script in live test
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  InferenceServerId,
  TrainingArtifactId,
  TrainingDatasetId,
  TrainingJobId,
  type TrainingArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as InferenceServerRegistry from "../inference/InferenceServerRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TrainingAdapterServer from "./TrainingAdapterServer.ts";

const sampleArtifact = (): TrainingArtifact => ({
  id: TrainingArtifactId.make("art-serve-1"),
  jobId: TrainingJobId.make("job-1"),
  datasetId: TrainingDatasetId.make("ds-1"),
  baseModel: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
  fineTuneType: "lora",
  adapterPath: "/tmp/adapters",
  fusedModelPath: null,
  ggufPath: null,
  provenanceHash: "a".repeat(64),
  sourceThreadIds: [],
  registeredInferenceServerId: null,
  servingPort: null,
  createdAt: "2026-11-24T20:00:00.000Z",
});

describe("TrainingAdapterServer", () => {
  it("builds loopback-only mlx_lm.server argv with optional adapter path", () => {
    expect(
      TrainingAdapterServer.buildMlxServerArgv({
        model: "org/model",
        adapterPath: "/tmp/adapters",
        port: 18080,
      }),
    ).toEqual([
      "--model",
      "org/model",
      "--host",
      "127.0.0.1",
      "--port",
      "18080",
      "--adapter-path",
      "/tmp/adapters",
    ]);

    expect(
      TrainingAdapterServer.buildMlxServerArgv({
        model: "/tmp/fused",
        adapterPath: null,
        port: 18081,
      }),
    ).toEqual(["--model", "/tmp/fused", "--host", "127.0.0.1", "--port", "18081"]);
  });

  it.live(
    "starts a loopback server, probes /health, registers in ServerSettings + refreshes InferenceServerRegistry, and stops cleanly",
    () =>
      Effect.gen(function* () {
        const tmpRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-adapter-srv-")),
        );
        const refreshedIds: Array<InferenceServerId | undefined> = [];
        try {
          const fakeServerScript = NodePath.join(tmpRoot, "fake-mlx-server.mjs");
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(
              fakeServerScript,
              [
                "#!/usr/bin/env node",
                "import http from 'node:http';",
                "const args = process.argv.slice(2);",
                "const port = Number(args[args.indexOf('--port') + 1]);",
                "const server = http.createServer((req, res) => {",
                "  if (req.url === '/health') {",
                "    res.writeHead(200, { 'content-type': 'application/json' });",
                "    res.end(JSON.stringify({ status: 'ok' }));",
                "    return;",
                "  }",
                "  res.writeHead(404); res.end();",
                "});",
                "server.listen(port, '127.0.0.1');",
                "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
              ].join("\n"),
              { mode: 0o755 },
            );
          });

          const registryLayer = Layer.succeed(
            InferenceServerRegistry.InferenceServerRegistry,
            InferenceServerRegistry.InferenceServerRegistry.of({
              current: Effect.succeed([]),
              streamChanges: Stream.empty,
              refresh: (id) =>
                Effect.sync(() => {
                  refreshedIds.push(id);
                  return [];
                }),
              publishGatewayQueue: () => Effect.void,
            }),
          );

          const serverLayer = Layer.effect(
            TrainingAdapterServer.TrainingAdapterServer,
            TrainingAdapterServer.makeWithOptions({
              resolveBinary: () => fakeServerScript,
              healthTimeoutMs: 10_000,
            }),
          ).pipe(Layer.provideMerge(ServerSettings.layerTest()), Layer.provideMerge(registryLayer));

          yield* Effect.scoped(
            Effect.gen(function* () {
              const adapterServer = yield* TrainingAdapterServer.TrainingAdapterServer;
              const settings = yield* ServerSettings.ServerSettingsService;
              const artifact = sampleArtifact();

              const started = yield* adapterServer.start({
                artifact,
                mode: "adapter",
                autoRegisterInInference: true,
                displayName: "MLX Fine-Tune: Smoke",
              });

              expect(started.port).toBeGreaterThan(0);
              expect(started.baseUrl).toBe(`http://127.0.0.1:${started.port}/v1`);
              expect(started.registeredServerId).not.toBeNull();

              const currentSettings = yield* settings.getSettings;
              const registered = currentSettings.inferenceServers[started.registeredServerId!];
              expect(registered?.baseUrl).toBe(started.baseUrl);
              expect(registered?.displayName).toBe("MLX Fine-Tune: Smoke");
              expect(refreshedIds).toContain(started.registeredServerId!);

              const active = yield* adapterServer.getActive(artifact.id);
              expect(active?.port).toBe(started.port);

              yield* adapterServer.stop({
                artifactId: artifact.id,
                removeInferenceServer: true,
                registeredServerId: started.registeredServerId,
              });
              expect(yield* adapterServer.getActive(artifact.id)).toBeNull();

              // SEC-04: refuse overwriting an unrelated existing inferenceServer entry
              const existingId = InferenceServerId.make("user-primary-vllm");
              yield* settings.updateSettings({
                inferenceServers: {
                  [existingId]: {
                    displayName: "Primary vLLM",
                    baseUrl: "http://10.0.0.5:8000/v1",
                    apiKey: "keep-secret",
                    enabled: true,
                  },
                },
              });
              const overwriteExit = yield* Effect.exit(
                adapterServer.registerInInference({
                  artifact,
                  baseUrl: "http://127.0.0.1:19999/v1",
                  serverId: existingId,
                }),
              );
              expect(Exit.isFailure(overwriteExit)).toBe(true);
              const afterSettings = yield* settings.getSettings;
              expect(afterSettings.inferenceServers[existingId]?.baseUrl).toBe(
                "http://10.0.0.5:8000/v1",
              );
            }).pipe(Effect.provide(serverLayer)),
          );
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tmpRoot, { recursive: true, force: true }));
        }
      }),
  );
});
