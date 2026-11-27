import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import type {
  InferenceApiProtocol,
  InferenceDiscoveredServer,
  InferenceDiscoveryInput,
  InferenceDiscoveryResult,
  InferenceServerId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import {
  PROTOCOL_PATHS,
  detectMlxEngine,
  parseBaseUrl as parseRegistryBaseUrl,
  readModelList,
} from "./InferenceServerRegistry.ts";

const PROC_TCP_LISTEN = "0A";

/** Each 32-bit word of the hex address in `/proc/net/tcp{,6}` is little-endian. */
const procLocalAddress = (hex: string): boolean => {
  if (hex.length === 8) return hex === "00000000" || hex === "0100007F";
  if (hex.length !== 32) return false;
  if (hex === "0".repeat(32) || hex === `${"0".repeat(24)}01000000`) return true;
  return hex.startsWith(`${"0".repeat(16)}FFFF0000`) && procLocalAddress(hex.slice(24));
};

const parseProcNetTcp = (
  raw: string,
): ReadonlyArray<{ readonly port: number; readonly inode: string }> => {
  const listeners: Array<{ port: number; inode: string }> = [];
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, portHex] = fields[1]?.split(":") ?? [];
    if (fields[3] !== PROC_TCP_LISTEN || !address || !portHex) continue;
    if (!procLocalAddress(address.toUpperCase())) continue;
    const port = Number.parseInt(portHex, 16);
    const inode = fields[9];
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !inode) continue;
    listeners.push({ port, inode });
  }
  return listeners;
};

export class InferenceDiscovery extends Context.Service<
  InferenceDiscovery,
  {
    /** Model servers answering on this machine or a registered host. Probes never carry a saved key. */
    readonly discover: (input: InferenceDiscoveryInput) => Effect.Effect<InferenceDiscoveryResult>;
  }
>()("t3/inference/InferenceDiscovery") {}

// Ollama, LM Studio, llama.cpp / mlx_lm.server, vLLM, SGLang.
export const WELL_KNOWN_PORTS: ReadonlyArray<number> = [11434, 1234, 8080, 8000, 30000];
const PROBE_TIMEOUT = Duration.millis(1500);
const LSOF_TIMEOUT = Duration.seconds(2);
const SEARCH_DEADLINE = Duration.seconds(8);
const MAX_LISTENERS = 48;
const MAX_CANDIDATES = 80;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const AGENT_PROTOCOLS: ReadonlyArray<InferenceApiProtocol> = ["chat-completions", "responses"];
const PROC_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LSOF_LOCAL_LISTENER =
  /\bTCP\s+(?:\*|127\.0\.0\.1|localhost|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)\s+\(LISTEN\)/;
const BARE_HOSTNAME_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

const LINK_LOCAL_V4 = new NodeNet.BlockList();
LINK_LOCAL_V4.addSubnet("169.254.0.0", 16, "ipv4");

const LINK_LOCAL_V6 = new NodeNet.BlockList();
LINK_LOCAL_V6.addSubnet("fe80::", 10, "ipv6");
LINK_LOCAL_V6.addSubnet("::ffff:169.254.0.0", 112, "ipv6");
LINK_LOCAL_V6.addAddress("fd00:ec2::254", "ipv6");

function isLinkLocalHost(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = NodeNet.isIP(bare);
  if (family === 4) return LINK_LOCAL_V4.check(bare, "ipv4");
  if (family === 6) return LINK_LOCAL_V6.check(bare, "ipv6");
  return false;
}

/** Validates a bare hostname or IP literal (supporting bracketed IPv6) and rejects link-local IPs. */
export function parseBareHost(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > 255 || /\s/.test(raw)) return undefined;
  let formatted: string;
  if (raw.startsWith("[") || raw.endsWith("]")) {
    if (!raw.startsWith("[") || !raw.endsWith("]")) return undefined;
    if (!NodeNet.isIPv6(raw.slice(1, -1))) return undefined;
    formatted = raw;
  } else if (NodeNet.isIPv6(raw)) {
    formatted = `[${raw}]`;
  } else if (BARE_HOSTNAME_PATTERN.test(raw)) {
    formatted = raw;
  } else {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(`http://${formatted}/`);
  } catch {
    return undefined;
  }
  if (
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    isLinkLocalHost(url.hostname)
  ) {
    return undefined;
  }
  return url.hostname;
}

const DNS_LOOKUP_TIMEOUT = Duration.seconds(2);

function hostnameOfUrl(raw: string): string | undefined {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Resolves non-loopback hostnames, rejects any address in link-local/metadata ranges (fail-closed
 * on resolution errors), and returns a validated address to pin on HTTP probes against DNS rebinding.
 */
export const resolveAllowedProbeHost = (
  hostname: string,
  lookup: (host: string) => Promise<ReadonlyArray<{ readonly address: string }>> = (host) =>
    NodeDnsPromises.lookup(host, { all: true }),
): Effect.Effect<string | undefined> => {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (NodeNet.isIP(bare) !== 0) {
    return Effect.succeed(isLinkLocalHost(bare) ? undefined : bare);
  }
  if (LOOPBACK_HOSTS.has(bare.toLowerCase())) {
    return Effect.succeed(bare);
  }
  return Effect.tryPromise({
    try: () => lookup(bare),
    catch: () => "dns_failed" as const,
  }).pipe(
    Effect.timeoutOption(DNS_LOOKUP_TIMEOUT),
    Effect.map((result) => {
      if (Option.isNone(result) || result.value.length === 0) return undefined;
      if (!result.value.every((entry) => !isLinkLocalHost(entry.address))) return undefined;
      return result.value[0]!.address;
    }),
    Effect.orElseSucceed(() => undefined),
  );
};

function pinHttpUrlToResolvedIp(
  rawUrl: string,
  resolvedIp: string,
): { readonly url: string; readonly hostHeader?: string } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" || NodeNet.isIP(resolvedIp) === 0) {
      return { url: rawUrl };
    }
    const bare =
      parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    if (NodeNet.isIP(bare) !== 0 || LOOPBACK_HOSTS.has(bare.toLowerCase())) {
      return { url: rawUrl };
    }
    const originalHost = parsed.host;
    parsed.hostname = NodeNet.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
    return { url: parsed.toString(), hostHeader: originalHost };
  } catch {
    return { url: rawUrl };
  }
}

function parseBaseUrl(raw: string) {
  const endpoint = parseRegistryBaseUrl(raw);
  if ("error" in endpoint) return endpoint;
  try {
    if (isLinkLocalHost(new URL(endpoint.base).hostname)) {
      return {
        error: "Link-local and cloud metadata addresses are not allowed.",
        display: endpoint.display,
      };
    }
  } catch {
    return { error: "The base URL is not a valid URL.", display: endpoint.display };
  }
  return endpoint;
}

/** Parses local TCP LISTEN ports from `lsof -nP -iTCP -sTCP:LISTEN` output on macOS. */
export function parseLsofListeningPorts(raw: string): ReadonlyArray<number> {
  const ports = new Set<number>();
  for (const line of raw.split("\n")) {
    const match = LSOF_LOCAL_LISTENER.exec(line);
    if (match === null) continue;
    const port = Number.parseInt(match[1]!, 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports];
}

/** Whether `host` names the machine this server runs on. */
function isThisMachine(host: string, hostname: string = NodeOS.hostname()): boolean {
  const lower = host.toLowerCase();
  const own = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(lower) || lower === own || lower === own.split(".")[0];
}

/** One key per endpoint, whichever name of this machine an address uses. */
function endpointKey(base: string, hostname: string): string | undefined {
  try {
    const url = new URL(base);
    const host = isThisMachine(url.hostname, hostname) ? "localhost" : url.hostname.toLowerCase();
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${host}:${port}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

interface Candidate {
  readonly base: string;
  readonly registeredServerId?: InferenceServerId;
  /** Found only as a listener on a port the OS hands out, never typed or registered. */
  readonly osAssigned?: true;
}

/**
 * Where to look: an address the user typed, registered servers, well-known ports and (on Linux
 * and macOS) listening ports of this machine, and well-known ports of registered hosts. `host`
 * narrows the search to one machine.
 */
export function discoveryCandidates(input: {
  readonly host?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly registered: ReadonlyArray<readonly [InferenceServerId, string]>;
  readonly listeningPorts: ReadonlyArray<number>;
  readonly hostname: string;
}): ReadonlyArray<Candidate> {
  const target = input.host === undefined ? undefined : parseBareHost(input.host);
  if (input.host !== undefined && target === undefined) return [];
  const candidates = new Map<string, Candidate>();
  const add = (rawBase: string, registeredServerId?: InferenceServerId, osAssigned = false) => {
    const endpoint = parseBaseUrl(rawBase);
    if (!("base" in endpoint)) return;
    const base = endpoint.base;
    const key = endpointKey(base, input.hostname);
    if (key === undefined) return;
    const existing = candidates.get(key);
    if (existing !== undefined) {
      if (registeredServerId !== undefined && existing.registeredServerId === undefined) {
        candidates.set(key, { ...existing, registeredServerId });
      }
      return;
    }
    if (candidates.size >= MAX_CANDIDATES) return;
    candidates.set(key, {
      base,
      ...(registeredServerId === undefined ? {} : { registeredServerId }),
      ...(osAssigned ? { osAssigned: true } : {}),
    });
  };
  const sameHost = (host: string) =>
    target === undefined ||
    host.toLowerCase() === target ||
    (isThisMachine(host, input.hostname) && isThisMachine(target, input.hostname));
  const searchesThisMachine = target === undefined || isThisMachine(target, input.hostname);
  // The server reaches its own machine by loopback, unless a repair names it another way.
  const localHost =
    target !== undefined && !LOOPBACK_HOSTS.has(target) && searchesThisMachine
      ? target
      : "localhost";

  if (input.baseUrl !== undefined) {
    const typed = parseBaseUrl(input.baseUrl);
    if ("base" in typed) add(typed.base);
  }
  const remoteHosts = new Set<string>();
  for (const [id, baseUrl] of input.registered) {
    const endpoint = parseBaseUrl(baseUrl);
    if (!("base" in endpoint)) continue;
    const { hostname } = new URL(endpoint.base);
    if (!sameHost(hostname)) continue;
    add(endpoint.base, id);
    if (!isThisMachine(hostname, input.hostname)) remoteHosts.add(hostname);
  }
  if (target !== undefined && !searchesThisMachine) remoteHosts.add(target);
  if (searchesThisMachine) {
    for (const port of [...WELL_KNOWN_PORTS, ...input.listeningPorts]) {
      add(`http://${localHost}:${port}/v1`, undefined, port >= EPHEMERAL_PORT_FLOOR);
    }
  }
  for (const host of remoteHosts) {
    for (const port of WELL_KNOWN_PORTS) add(`http://${host}:${port}/v1`);
  }
  return [...candidates.values()];
}

// Ports this high are usually handed out by the OS to helpers, not chosen for a model server.
const EPHEMERAL_PORT_FLOOR = 32768;

const rankAndCapPorts = (ports: ReadonlyArray<number>): ReadonlyArray<number> => {
  // Chosen ports first, so a busy machine's OS-assigned ones cannot crowd them out of the cap.
  const rankPort = (port: number) => (port >= EPHEMERAL_PORT_FLOOR ? port + 65536 : port);
  return [...new Set(ports)]
    .filter((port) => port >= 1024)
    .toSorted((left, right) => rankPort(left) - rankPort(right))
    .slice(0, MAX_LISTENERS);
};

const isJsonError = (body: string | undefined) => {
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    // OpenAI-style servers send `error`; FastAPI ones (TabbyAPI) send `detail`.
    return (
      typeof parsed === "object" && parsed !== null && ("error" in parsed || "detail" in parsed)
    );
  } catch {
    return false;
  }
};

const portOf = (baseUrl: string) => {
  try {
    return Number(new URL(baseUrl).port) || 0;
  } catch {
    return 0;
  }
};

/** Ready before needing a key, then servers on chosen ports, then ones not yet registered. */
const rank = (server: InferenceDiscoveredServer) =>
  (server.status === "ready" ? 0 : 4) +
  (portOf(server.baseUrl) >= EPHEMERAL_PORT_FLOOR ? 2 : 0) +
  (server.registeredServerId === undefined ? 0 : 1);

export const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const settingsService = yield* Settings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const processRunner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
  const childProcessSpawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);

  const darwinListeningPorts = Effect.gen(function* () {
    const readLsof = Option.isSome(processRunner)
      ? processRunner.value
          .run({
            command: "lsof",
            args: ["-nP", "-iTCP", "-sTCP:LISTEN"],
            timeout: LSOF_TIMEOUT,
            maxOutputBytes: 2 * 1024 * 1024,
          })
          .pipe(
            Effect.map((output) =>
              output.code === 0 || output.stdout.length > 0 ? output.stdout : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          )
      : Option.isSome(childProcessSpawner)
        ? childProcessSpawner.value
            .string(ChildProcess.make("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]))
            .pipe(
              Effect.scoped,
              Effect.orElseSucceed(() => undefined),
            )
        : Effect.undefined;
    const raw = yield* readLsof.pipe(
      Effect.timeoutOption(LSOF_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (raw === undefined) return { searched: false, ports: [] as ReadonlyArray<number> };
    return { searched: true, ports: rankAndCapPorts(parseLsofListeningPorts(raw)) };
  });

  const listeningPorts = Effect.gen(function* () {
    const tables = yield* Effect.forEach(PROC_TABLES, (path) =>
      fileSystem.readFileString(path).pipe(Effect.option),
    );
    const read = tables.flatMap((table) => (Option.isSome(table) ? [table.value] : []));
    if (read.length > 0) {
      const ports = read.flatMap((table) => parseProcNetTcp(table).map((l) => l.port));
      return { searched: true, ports: rankAndCapPorts(ports) };
    }
    if (platform === "darwin") return yield* darwinListeningPorts;
    return { searched: false, ports: [] as ReadonlyArray<number> };
  });

  // Untraced: one per candidate port; the discover span covers them. Reading stops at the cap,
  // so an unrelated service answering with a large body cannot fill memory.
  const get = Effect.fnUntraced(function* (url: string, resolvedIp?: string) {
    const target = resolvedIp === undefined ? { url } : pinHttpUrlToResolvedIp(url, resolvedIp);
    const req =
      target.hostHeader === undefined
        ? HttpClientRequest.get(target.url)
        : HttpClientRequest.get(target.url).pipe(
            HttpClientRequest.setHeader("host", target.hostHeader),
          );
    return yield* client.execute(req).pipe(
      Effect.flatMap((response) => {
        let read = 0;
        return response.stream.pipe(
          Stream.takeWhile((chunk) => {
            read += chunk.length;
            return read <= MAX_BODY_BYTES;
          }),
          Stream.decodeText(),
          Stream.mkString,
          Effect.map((body) => ({
            status: response.status,
            body: read > MAX_BODY_BYTES ? undefined : body,
            serverHeader: response.headers["server"],
          })),
        );
      }),
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  });

  // An empty POST costs no generation: a served route rejects it as invalid.
  const served = Effect.fnUntraced(function* (url: string, resolvedIp?: string) {
    const target = resolvedIp === undefined ? { url } : pinHttpUrlToResolvedIp(url, resolvedIp);
    const baseReq = HttpClientRequest.post(target.url).pipe(
      HttpClientRequest.bodyText("{}", "application/json"),
    );
    const req =
      target.hostHeader === undefined
        ? baseReq
        : HttpClientRequest.setHeader(baseReq, "host", target.hostHeader);
    return yield* client.execute(req).pipe(
      Effect.map(
        (response) =>
          response.status === 400 ||
          response.status === 422 ||
          (response.status >= 200 && response.status < 300),
      ),
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map((result) => Option.getOrElse(result, () => false)),
      Effect.orElseSucceed(() => false),
    );
  });

  const probe = Effect.fnUntraced(function* (
    candidate: Candidate,
    resolvedHosts: ReadonlyMap<string, string | undefined>,
  ) {
    const candidateHost = hostnameOfUrl(candidate.base);
    const resolvedIp = candidateHost === undefined ? undefined : resolvedHosts.get(candidateHost);
    if (resolvedIp === undefined) return undefined;
    const listed = yield* get(`${candidate.base}/models`, resolvedIp);
    if (listed === undefined) return undefined;
    const common = {
      baseUrl: candidate.base,
      ...(candidate.registeredServerId === undefined
        ? {}
        : { registeredServerId: candidate.registeredServerId }),
    };
    if (listed.status === 401 || listed.status === 403) {
      // Only an API's JSON error body means it wants a key. macOS AirPlay (5000, 7000) answers an
      // empty 403, and token-guarded helpers on OS-assigned ports refuse with JSON too.
      if (candidate.osAssigned === true || !isJsonError(listed.body)) return undefined;
      return { ...common, status: "needs-key", models: [] } satisfies InferenceDiscoveredServer;
    }
    if (listed.status < 200 || listed.status >= 300 || listed.body === undefined) return undefined;
    const list = readModelList(listed.body);
    if (list === undefined || list.models.length === 0) return undefined;
    const origin = parseBaseUrl(candidate.base);
    const [protocols, health] = yield* Effect.all(
      [
        Effect.forEach(
          PROTOCOL_PATHS.filter(([protocol]) => AGENT_PROTOCOLS.includes(protocol)),
          ([protocol, path]) =>
            served(`${candidate.base}/${path}`, resolvedIp).pipe(
              Effect.map((ok) => (ok ? [protocol] : [])),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((found) => found.flat())),
        list.engine === undefined && "origin" in origin
          ? get(`${origin.origin}/health`, resolvedIp)
          : Effect.undefined,
      ],
      { concurrency: "unbounded" },
    );
    const engine =
      list.engine ??
      (health !== undefined &&
      detectMlxEngine({
        healthStatus: health.status,
        ...(health.body === undefined ? {} : { healthBody: health.body }),
        ...(health.serverHeader === undefined ? {} : { healthServerHeader: health.serverHeader }),
        ...(listed.serverHeader === undefined ? {} : { modelsServerHeader: listed.serverHeader }),
        models: list.models,
      })
        ? "MLX"
        : undefined);
    return {
      ...common,
      status: "ready",
      models: list.models,
      ...(engine === undefined ? {} : { engine }),
      ...(protocols.length === 0 ? {} : { apiProtocols: protocols }),
    } satisfies InferenceDiscoveredServer;
  });

  const discover = Effect.fn("InferenceDiscovery.discover")(function* (
    input: InferenceDiscoveryInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    const registered = Option.isSome(settings)
      ? Object.entries(settings.value.inferenceServers).map(
          ([id, config]) => [id as InferenceServerId, config.baseUrl] as const,
        )
      : [];
    const targetHost = input.host === undefined ? undefined : parseBareHost(input.host);
    if (input.host !== undefined && targetHost === undefined) {
      return { servers: [], searchedListeningPorts: false };
    }
    const hostname = NodeOS.hostname();
    const searchesThisMachine = targetHost === undefined || isThisMachine(targetHost, hostname);
    const listeners = searchesThisMachine
      ? yield* listeningPorts
      : { searched: false, ports: [] as ReadonlyArray<number> };
    const candidates = discoveryCandidates({
      host: input.host,
      baseUrl: input.baseUrl,
      registered,
      listeningPorts: listeners.ports,
      hostname,
    });
    const uniqueHosts = new Set<string>();
    for (const candidate of candidates) {
      const host = hostnameOfUrl(candidate.base);
      if (host !== undefined) uniqueHosts.add(host);
    }
    const resolvedHosts = new Map<string, string | undefined>(
      yield* Effect.forEach(
        [...uniqueHosts],
        (host) => resolveAllowedProbeHost(host).pipe(Effect.map((ip) => [host, ip] as const)),
        { concurrency: 8 },
      ),
    );
    const found = yield* Ref.make<ReadonlyArray<InferenceDiscoveredServer>>([]);
    // A slow host cannot hold the answer back; whatever answered by the deadline is shown.
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        probe(candidate, resolvedHosts).pipe(
          Effect.flatMap((server) =>
            server === undefined ? Effect.void : Ref.update(found, (all) => [...all, server]),
          ),
        ),
      { concurrency: 16, discard: true },
    ).pipe(Effect.timeoutOption(SEARCH_DEADLINE));
    const servers = (yield* Ref.get(found)).toSorted(
      (left, right) => rank(left) - rank(right) || left.baseUrl.localeCompare(right.baseUrl),
    );
    return { servers, searchedListeningPorts: listeners.searched };
  });

  return InferenceDiscovery.of({ discover });
});

export const layer = Layer.effect(InferenceDiscovery, make);
