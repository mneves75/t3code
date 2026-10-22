import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceConfig, ProviderInstanceMutation } from "./providerInstance.ts";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);
const decodeProviderInstanceMutation = Schema.decodeUnknownSync(ProviderInstanceMutation);

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
