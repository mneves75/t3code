import { describe, expect, it } from "@effect/vitest";
import { recoverField, rejectedField } from "./InferenceRetry.ts";

const body = {
  model: "local",
  stream_options: { include_usage: true },
  metadata: { retained: true },
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (result: Uint8Array | undefined) =>
  result && JSON.parse(Buffer.from(result).toString("utf8"));

describe("InferenceRetry", () => {
  it("removes only the exact optional field named by the server", () => {
    expect(decode(rejectedField({ error: { param: "stream_options" } }, body))).toEqual({
      model: "local",
      metadata: { retained: true },
    });
    expect(rejectedField({ error: { param: "messages" } }, body)).toBeUndefined();
    expect(rejectedField({ error: { param: "unknown" } }, body)).toBeUndefined();
    expect(rejectedField("unsupported field", body)).toBeUndefined();
    expect(rejectedField({ error: { param: "metadata" } }, { model: "local" })).toBeUndefined();
    expect(rejectedField({ error: { param: "stream_options" } }, null)).toBeUndefined();
    expect(
      rejectedField({ error: { param: "stream_options" } }, ["stream_options"]),
    ).toBeUndefined();
    expect(
      recoverField(encode({ error: { param: "stream_options" } }), encode(null)),
    ).toBeUndefined();
  });
});
