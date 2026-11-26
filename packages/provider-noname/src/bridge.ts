/**
 * `t3 noname-acp`: speaks ACP on stdio and drives a NoName server over HTTP.
 *
 * @module provider-noname/bridge
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as EffectAcpAgent from "effect-acp/agent";

import { makeNoNameClient } from "./server/api.ts";
import { registerNoNameAcpBridge } from "./server/bridge.ts";
import { NONAME_DEFAULT_SERVER_URL } from "./settings.ts";

export const NONAME_URL_ENV = "T3_NONAME_URL";

const program = Effect.gen(function* () {
  const url = yield* Config.String(NONAME_URL_ENV).pipe(
    Config.withDefault(NONAME_DEFAULT_SERVER_URL),
  );
  const client = yield* makeNoNameClient(url.trim() || NONAME_DEFAULT_SERVER_URL);
  yield* registerNoNameAcpBridge({ client, version: "1" });
  return yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(EffectAcpAgent.layerStdio(), FetchHttpClient.layer).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

export function runNoNameAcpBridgeCli(): void {
  NodeRuntime.runMain(program);
}
