import { describe, expect, it } from "@effect/vitest";
import { InferenceServerId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InferenceDiscovery from "./InferenceDiscovery.ts";

const rtx = InferenceServerId.make("rtx");
const spark1 = InferenceServerId.make("spark1");

// Listeners on 8030 (any address), 22 (below 1024), 5432 (loopback), 5000 (any address) and
// the OS-assigned 49497 (loopback).
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F5E 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 100 0 0 10 0
   3: 00000000:1388 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 5004 1 0000000000000000 100 0 0 10 0
   4: 0100007F:C159 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 5005 1 0000000000000000 100 0 0 10 0
`;

const glm = {
  object: "list",
  data: [{ id: "GLM-5.3-Flash", owned_by: "tensorfold", context_length: 702464 }],
};

function discover(
  input: Parameters<InferenceDiscovery.InferenceDiscovery["Service"]["discover"]>[0],
  routes: Readonly<Record<string, unknown>>,
  inferenceServers: Record<string, { baseUrl: string; apiKey: string; enabled: boolean }>,
) {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        seen.push({ url: request.url, auth: request.headers["authorization"] });
        const route = routes[request.url];
        if (route === undefined) {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new TypeError("fetch failed"),
              }),
            }),
          );
        }
        const response =
          typeof route === "function"
            ? (route as () => Response)()
            : typeof route === "number"
              ? new Response("", { status: route })
              : Response.json(route, { status: 200 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );
  const missing = FileSystem.makeNoop({});
  return Effect.gen(function* () {
    const discovery = yield* InferenceDiscovery.make;
    const result = yield* discovery.discover(input);
    return { result, seen };
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({ inferenceServers }),
      FileSystem.layerNoop({
        readFileString: (path) =>
          path === "/proc/net/tcp" ? Effect.succeed(PROC_NET_TCP) : missing.readFileString(path),
      }),
      http,
    ]),
  );
}

describe("InferenceDiscovery", () => {
  it.effect("finds a server that moved to an unlisted port, without sending the saved key", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* discover(
        {},
        {
          "http://localhost:8030/v1/models": glm,
          "http://localhost:8030/v1/chat/completions": 400,
          "http://localhost:8030/v1/responses": 404,
        },
        { [rtx]: { baseUrl: "http://localhost:8888/v1", apiKey: "secret", enabled: true } },
      );
      expect(result).toEqual({
        servers: [
          {
            baseUrl: "http://localhost:8030/v1",
            status: "ready",
            engine: "TensorFold",
            models: [{ id: "GLM-5.3-Flash", servedContextWindow: 702464 }],
            apiProtocols: ["chat-completions"],
          },
        ],
        searchedListeningPorts: true,
      });
      expect(seen.some((request) => request.url.includes(":22/"))).toBe(false);
      expect(seen.some((request) => request.url === "http://localhost:5432/v1/models")).toBe(true);
      expect(seen.every((request) => request.auth === undefined)).toBe(true);
    }),
  );

  it.effect("reports a server that wants a key, and marks one already registered", () =>
    Effect.gen(function* () {
      const { result } = yield* discover(
        {},
        {
          "http://localhost:11434/v1/models": () =>
            Response.json({ error: "Unauthorized" }, { status: 401 }),
          "http://127.0.0.1:1234/v1/models": glm,
        },
        { [rtx]: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "", enabled: true } },
      );
      expect(
        result.servers.map(({ baseUrl, status, registeredServerId }) => ({
          baseUrl,
          status,
          registeredServerId,
        })),
      ).toEqual([
        { baseUrl: "http://127.0.0.1:1234/v1", status: "ready", registeredServerId: rtx },
        {
          baseUrl: "http://localhost:11434/v1",
          status: "needs-key",
          registeredServerId: undefined,
        },
      ]);
    }),
  );

  it.effect(
    "does not take AirPlay or a token-guarded helper for a model server wanting a key",
    () =>
      Effect.gen(function* () {
        const routes = {
          // macOS AirPlay Receiver answers every path on 5000 and 7000 with an empty 403.
          "http://localhost:5000/v1/models": 403,
          "http://localhost:49497/v1/models": () =>
            Response.json({ error: "Missing or invalid Authorization header." }, { status: 401 }),
          "http://localhost:8000/v1/models": () =>
            Response.json(
              { error: { message: "API key required", type: "authentication_error" } },
              { status: 401 },
            ),
        };
        const scanned = yield* discover({}, routes, {});
        expect(scanned.result.servers.map(({ baseUrl, status }) => ({ baseUrl, status }))).toEqual([
          { baseUrl: "http://localhost:8000/v1", status: "needs-key" },
        ]);

        const typed = yield* discover({ baseUrl: "http://localhost:49497/v1" }, routes, {});
        expect(typed.result.servers.map(({ baseUrl, status }) => ({ baseUrl, status }))).toEqual([
          { baseUrl: "http://localhost:8000/v1", status: "needs-key" },
          { baseUrl: "http://localhost:49497/v1", status: "needs-key" },
        ]);
      }),
  );

  it.effect("takes a FastAPI-style refusal for a server wanting a key", () =>
    Effect.gen(function* () {
      const routes = {
        // TabbyAPI and other FastAPI servers refuse with {"detail": ...}.
        "http://localhost:5001/v1/models": () =>
          Response.json({ detail: "Invalid API key" }, { status: 401 }),
        "http://localhost:5000/v1/models": 403,
      };
      const tabby = yield* discover({ baseUrl: "http://localhost:5001/v1" }, routes, {});
      expect(tabby.result.servers.map(({ baseUrl, status }) => ({ baseUrl, status }))).toEqual([
        { baseUrl: "http://localhost:5001/v1", status: "needs-key" },
      ]);
      const airPlay = yield* discover({ baseUrl: "http://localhost:5000/v1" }, routes, {});
      expect(airPlay.result.servers).toEqual([]);
    }),
  );
});

describe("discoveryCandidates", () => {
  const registered = [
    [rtx, "http://rtx:8888/v1"],
    [spark1, "http://spark1:8888/v1"],
  ] as const;

  it("searches a remote host by its saved and well-known ports only", () => {
    expect(
      InferenceDiscovery.discoveryCandidates({
        host: "spark1",
        registered,
        listeningPorts: [8030],
        hostname: "rtx",
      }).map((candidate) => candidate.base),
    ).toEqual([
      "http://spark1:8888/v1",
      ...InferenceDiscovery.WELL_KNOWN_PORTS.map((port) => `http://spark1:${port}/v1`),
    ]);
  });

  it("treats every name of this machine as one, keeping the name a repair used", () => {
    const bases = InferenceDiscovery.discoveryCandidates({
      host: "rtx",
      registered,
      listeningPorts: [8030],
      hostname: "rtx",
    });
    expect(bases).toContainEqual({ base: "http://rtx:8888/v1", registeredServerId: rtx });
    expect(bases).toContainEqual({ base: "http://rtx:8030/v1" });
    expect(bases.some((candidate) => candidate.base.includes("spark1"))).toBe(false);
  });
});

describe("macOS lsof listening port discovery", () => {
  const LSOF_SAMPLE = [
    "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "Python  12345 mneves    4u  IPv4 0x1234      0t0  TCP 127.0.0.1:8095 (LISTEN)",
    "mlx_lm  12346 mneves    5u  IPv6 0x1235      0t0  TCP [::1]:8096 (LISTEN)",
    "ollama  12347 mneves    3u  IPv4 0x1236      0t0  TCP *:11434 (LISTEN)",
    "sshd      999   root    3u  IPv4 0x1237      0t0  TCP *:22 (LISTEN)",
    "remote  12348 mneves    6u  IPv4 0x1238      0t0  TCP 192.168.1.50:9090 (LISTEN)",
  ].join("\n");

  it("parses local TCP listening ports from lsof output", () => {
    expect(InferenceDiscovery.parseLsofListeningPorts(LSOF_SAMPLE)).toEqual([
      8095, 8096, 11434, 22,
    ]);
  });

  it.effect("discovers a custom-port mlx_lm.server on macOS via lsof", () =>
    Effect.gen(function* () {
      const discovery = yield* InferenceDiscovery.make;
      const result = yield* discovery.discover({});
      expect(result).toEqual({
        servers: [
          {
            baseUrl: "http://localhost:8095/v1",
            status: "ready",
            engine: "MLX",
            models: [{ id: "mlx-community/Qwen3-Coder-30B-A3B-4bit" }],
            apiProtocols: ["chat-completions"],
          },
        ],
        searchedListeningPorts: true,
      });
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({ inferenceServers: {} }),
        FileSystem.layerNoop({}),
        Layer.succeed(HostProcess.Platform, "darwin"),
        Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () =>
              Effect.succeed({
                code: ChildProcessSpawner.ExitCode(0),
                stdout: LSOF_SAMPLE,
                stderr: "",
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            if (request.url === "http://localhost:8095/v1/models") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    {
                      object: "list",
                      data: [{ id: "mlx-community/Qwen3-Coder-30B-A3B-4bit", object: "model" }],
                    },
                    { status: 200, headers: { server: "BaseHTTP/0.6 Python/3.12.7" } },
                  ),
                ),
              );
            }
            if (request.url === "http://localhost:8095/health") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    { status: "ok" },
                    { status: 200, headers: { server: "BaseHTTP/0.6 Python/3.12.7" } },
                  ),
                ),
              );
            }
            if (request.url === "http://localhost:8095/v1/chat/completions") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("", { status: 400 })),
              );
            }
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new TypeError("fetch failed"),
                }),
              }),
            );
          }),
        ),
      ]),
    ),
  );

  it.effect("gracefully degrades to well-known ports when lsof is unavailable on macOS", () =>
    Effect.gen(function* () {
      const discovery = yield* InferenceDiscovery.make;
      const result = yield* discovery.discover({});
      expect(result.searchedListeningPorts).toBe(false);
      expect(result.servers.map((s) => s.baseUrl)).toEqual(["http://localhost:8080/v1"]);
    }).pipe(
      Effect.provide([
        ServerSettings.layerTest({ inferenceServers: {} }),
        FileSystem.layerNoop({}),
        Layer.succeed(HostProcess.Platform, "darwin"),
        Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () =>
              Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command: "lsof",
                  argumentCount: 3,
                  cause: new Error("ENOENT"),
                }),
              ),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            request.url === "http://localhost:8080/v1/models"
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(request, Response.json(glm, { status: 200 })),
                )
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new TypeError("fetch failed"),
                    }),
                  }),
                ),
          ),
        ),
      ]),
    ),
  );
});
