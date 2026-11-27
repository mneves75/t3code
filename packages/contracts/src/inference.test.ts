import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { InferenceDiscoveryInput } from "./inference.ts";

const decodeDiscoveryInput = Schema.decodeUnknownExit(InferenceDiscoveryInput);

describe("InferenceDiscoveryInput", () => {
  it("accepts bare hostnames, IPv4 literals, and bracketed or unbracketed IPv6 literals", () => {
    for (const host of ["localhost", "spark1.local", "192.168.1.50", "[::1]", "::1", "[fd00::1]"]) {
      expect(Exit.isSuccess(decodeDiscoveryInput({ host }))).toBe(true);
    }
  });

  it("rejects hosts with schemes, ports, paths, userinfo, queries, fragments, or whitespace", () => {
    for (const host of [
      "http://169.254.169.254",
      "169.254.169.254:80",
      "169.254.169.254/latest/meta-data",
      "169.254.169.254/latest#frag",
      "user@spark1",
      "spark1?foo=bar",
      "spark1#frag",
      "spark1 evil.com",
      "[::1]:8080",
    ]) {
      expect(Exit.isFailure(decodeDiscoveryInput({ host }))).toBe(true);
    }
  });
});
