import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  isLocalProviderInstance,
  ProviderInstanceEnvironmentVariable,
} from "./providerInstance.ts";
import { InferenceServerId } from "./inference.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);

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

describe("isLocalProviderInstance", () => {
  it("tracks linked server enabled state and falls back to explicit local mark when unlinked", () => {
    const mlx = InferenceServerId.make("mlx");
    expect(isLocalProviderInstance({ inferenceServerId: mlx }, { [mlx]: { enabled: true } })).toBe(
      true,
    );
    expect(
      isLocalProviderInstance(
        { inference: "local", inferenceServerId: mlx },
        { [mlx]: { enabled: false } },
      ),
    ).toBe(false);
    expect(isLocalProviderInstance({ inference: "local", inferenceServerId: mlx }, {})).toBe(false);
    expect(isLocalProviderInstance({ inference: "local" }, {})).toBe(true);
    expect(isLocalProviderInstance({ inference: "cloud" }, {})).toBe(false);
    expect(isLocalProviderInstance(undefined, {})).toBe(false);
  });
});
