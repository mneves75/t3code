import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceMutation,
} from "./providerInstance.ts";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const decodeProviderInstanceMutation = Schema.decodeUnknownSync(ProviderInstanceMutation);
const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);

describe("ProviderInstanceConfig", () => {
  it("keeps an account's rotation mark through an upsert and adds none by itself", () => {
    const upsert = decodeProviderInstanceMutation({
      operation: "upsert",
      instanceId: "claudeAgent_work",
      instance: { driver: "claudeAgent", rotate: true },
    });
    expect(upsert.operation === "upsert" && upsert.instance.rotate).toBe(true);
    expect("rotate" in decodeProviderInstanceConfig({ driver: "claudeAgent" })).toBe(false);
  });
});

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });
});
