import {
  type InferenceServerConfig,
  type InferenceServerId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { routineSpan } from "@t3tools/shared/observability";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
  /** Also mint a gateway credential bound to this server, revoked with the MCP one. */
  readonly inferenceServer?: PinnedInferenceServer;
}

/** A server's settings when a credential was issued; the gateway keeps routing it there. */
export interface PinnedInferenceServer {
  readonly id: InferenceServerId;
  readonly config: InferenceServerConfig;
}

/**
 * Who holds an inference gateway credential. No thread means T3's own background work, unless an
 * instance holds it for a harness process that serves many threads.
 */
export interface InferenceCaller {
  readonly serverId: InferenceServerId;
  /** Edits, relinks, and disabling never move a live credential; new sessions get new ones. */
  readonly pinned: InferenceServerConfig;
  readonly threadId?: ThreadId;
  readonly providerSessionId?: string;
  readonly providerInstanceId?: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /** Only inference credentials resolve here; MCP, OAuth, and session tokens never do. */
  readonly resolveInference: (rawToken: string) => Effect.Effect<InferenceCaller | undefined>;
  /**
   * For discovery and text generation processes; revoked when the scope closes. With an instance
   * it is for that instance's long-lived harness process and does not expire on its own.
   */
  readonly issueBackgroundInference: (
    server: PinnedInferenceServer,
    providerInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<McpProviderSession.InferenceGatewayCredential, never, Scope.Scope>;
  /** See `InferenceGatewayAccess.attributeSessions`. */
  readonly attributeHarnessSessions: (
    providerInstanceId: ProviderInstanceId,
    threadOf: (harnessSessionId: string) => ThreadId | undefined,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Only the instance's own harness answers, so a session id never crosses instances. */
  readonly harnessSessionThread: (
    providerInstanceId: ProviderInstanceId,
    harnessSessionId: string,
  ) => Effect.Effect<ThreadId | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface AliveMark {
  readonly wallMs: number;
  readonly monotonicMs: number;
}

type CredentialRecord =
  | {
      readonly kind: "mcp";
      readonly tokenHash: string;
      readonly scope: McpInvocationContext.McpThreadInvocationScope;
      readonly lastAlive: AliveMark;
      /** Set when a request finds the token idle; only `touch` clears it, whatever the clocks do. */
      readonly expired: boolean;
    }
  | {
      readonly kind: "inference";
      readonly tokenHash: string;
      readonly caller: InferenceCaller;
      readonly lastAlive: AliveMark;
      readonly expired: boolean;
      readonly expiresAt?: number;
    };

const threadOf = (record: CredentialRecord) =>
  record.kind === "mcp" ? record.scope.thread.threadId : record.caller.threadId;
const providerSessionOf = (record: CredentialRecord) =>
  record.kind === "mcp" ? record.scope.thread.providerSessionId : record.caller.providerSessionId;

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  /** Drives both the wall and monotonic readings. */
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Discovery and text generation finish well inside this; their scope usually revokes sooner. */
export const BACKGROUND_INFERENCE_TTL_MS = 15 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// The larger elapsed reading wins: stepping the wall clock back cannot extend a token,
// and wall time that passes while the host sleeps still counts.
const idleMs = (since: AliveMark, now: AliveMark): number =>
  Math.max(now.wallMs - since.wallMs, now.monotonicMs - since.monotonicMs);

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const { now } = options;
  const currentAliveMark: Effect.Effect<AliveMark> = now
    ? Effect.sync(() => {
        const timestamp = now();
        return { wallMs: timestamp, monotonicMs: timestamp };
      })
    : Effect.all({
        wallMs: Clock.currentTimeMillis,
        monotonicMs: Clock.monotonicTimeNanos.pipe(
          Effect.map((nanos) => Number(nanos / 1_000_000n)),
        ),
      });
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";
  const gatewayBaseUrl = (serverId: InferenceServerId) =>
    `${endpoint.slice(0, -"/mcp".length)}/inference/${encodeURIComponent(serverId)}/v1`;

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const mintToken = Effect.gen(function* () {
    const rawToken = yield* random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    return { rawToken, tokenHash: yield* hashToken(rawToken) };
  });

  const store = (record: CredentialRecord) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(records).set(record.tokenHash, record),
    }));

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAlive = yield* currentAliveMark;
      const providerSessionId = yield* random.uuidV4();
      const { rawToken, tokenHash } = yield* mintToken;
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          "issues",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
        ]),
        issuedAt: issuedAlive.wallMs,
      };
      yield* store({ kind: "mcp", tokenHash, scope, lastAlive: issuedAlive, expired: false });
      let inferenceGateway: McpProviderSession.InferenceGatewayCredential | undefined;
      const server = request.inferenceServer;
      if (server !== undefined) {
        const minted = yield* mintToken;
        yield* store({
          kind: "inference",
          tokenHash: minted.tokenHash,
          caller: {
            serverId: server.id,
            pinned: server.config,
            threadId: scope.thread.threadId,
            providerSessionId,
            providerInstanceId: scope.thread.providerInstanceId,
          },
          lastAlive: issuedAlive,
          expired: false,
        });
        inferenceGateway = {
          serverId: server.id,
          baseUrl: gatewayBaseUrl(server.id),
          token: minted.rawToken,
        };
      }
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
          ...(inferenceGateway === undefined ? {} : { inferenceGateway }),
        },
      };
    },
  );

  const resolveRecord = Effect.fnUntraced(function* <K extends CredentialRecord["kind"]>(
    rawToken: string,
    kind: K,
  ) {
    if (rawToken.length === 0) return undefined;
    const tokenHash = yield* hashToken(rawToken);
    const alive = yield* currentAliveMark;
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const record = records.get(tokenHash);
      if (!record || record.kind !== kind || record.expired)
        return [undefined, { records }] as const;
      const absoluteExpired =
        record.kind === "inference" &&
        record.expiresAt !== undefined &&
        alive.wallMs > record.expiresAt;
      if (idleMs(record.lastAlive, alive) > livenessWindowMs || absoluteExpired) {
        if (absoluteExpired) return [undefined, { records }] as const;
        const next = new Map(records);
        next.set(tokenHash, { ...record, expired: true });
        return [undefined, { records: next }] as const;
      }
      const next = new Map(records);
      next.set(tokenHash, { ...record, lastAlive: alive });
      return [record as Extract<CredentialRecord, { kind: K }>, { records: next }] as const;
    });
  });

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve", {
    attributes: routineSpan,
  })(function* (rawToken) {
    return (yield* resolveRecord(rawToken, "mcp"))?.scope;
  });

  const resolveInference: McpSessionRegistryShape["resolveInference"] = Effect.fn(
    "McpSessionRegistry.resolveInference",
  )(function* (rawToken) {
    return (yield* resolveRecord(rawToken, "inference"))?.caller;
  });

  const issueBackgroundInference: McpSessionRegistryShape["issueBackgroundInference"] = Effect.fn(
    "McpSessionRegistry.issueBackgroundInference",
  )(function* ({ id: serverId, config: pinned }, providerInstanceId) {
    const issuedAlive = yield* currentAliveMark;
    const minted = yield* Effect.acquireRelease(mintToken, ({ tokenHash }) =>
      SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.delete(tokenHash);
        return { records: next };
      }),
    );
    yield* store({
      kind: "inference",
      tokenHash: minted.tokenHash,
      lastAlive: issuedAlive,
      expired: false,
      ...(providerInstanceId === undefined
        ? {
            caller: { serverId, pinned },
            expiresAt: issuedAlive.wallMs + BACKGROUND_INFERENCE_TTL_MS,
          }
        : { caller: { serverId, pinned, providerInstanceId } }),
    });
    return { serverId, baseUrl: gatewayBaseUrl(serverId), token: minted.rawToken };
  });

  const harnessSessions = new Map<
    ProviderInstanceId,
    Set<(harnessSessionId: string) => ThreadId | undefined>
  >();
  const attributeHarnessSessions: McpSessionRegistryShape["attributeHarnessSessions"] = (
    providerInstanceId,
    threadOf,
  ) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const held = harnessSessions.get(providerInstanceId) ?? new Set();
        held.add(threadOf);
        harnessSessions.set(providerInstanceId, held);
      }),
      () =>
        Effect.sync(() => {
          const held = harnessSessions.get(providerInstanceId);
          held?.delete(threadOf);
          if (held?.size === 0) harnessSessions.delete(providerInstanceId);
        }),
    );
  const harnessSessionThread: McpSessionRegistryShape["harnessSessionThread"] = (
    providerInstanceId,
    harnessSessionId,
  ) =>
    Effect.sync(() => {
      for (const threadOf of harnessSessions.get(providerInstanceId) ?? []) {
        const threadId = threadOf(harnessSessionId);
        if (threadId !== undefined) return threadId;
      }
      return undefined;
    });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const alive = yield* currentAliveMark;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (threadOf(record) === threadId) {
            next.set(tokenHash, { ...record, lastAlive: alive, expired: false });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    resolveInference,
    issueBackgroundInference,
    attributeHarnessSessions,
    harnessSessionThread,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => providerSessionOf(record) === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => threadOf(record) === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
