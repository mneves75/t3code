import { assert, describe, it } from "@effect/vitest";
import { agentPaths } from "./adapter.ts";

describe("OpenCode v2 agentPaths", () => {
  const workspace = "/work/project";
  const home = "/Users/alice";
  const env = {};

  it("preserves OpenCode internal directory rules under the current user's home and concrete plan paths", () => {
    const rules = [
      { action: "*", resource: "*", effect: "allow" },
      {
        action: "external_directory",
        resource: `${home}/.local/share/opencode/tool-output/*`,
        effect: "allow",
      },
      {
        action: "external_directory",
        resource: `${home}/.local/share/opencode/plans/*`,
        effect: "allow",
      },
      {
        action: "edit",
        resource: `${home}/.local/share/opencode/plans/design.md`,
        effect: "allow",
      },
      {
        action: "edit",
        resource: ".opencode/plans/design.md",
        effect: "allow",
      },
      {
        action: "edit",
        resource: `${workspace}/.opencode/plans/design.md`,
        effect: "allow",
      },
    ] as const;

    assert.deepEqual(
      agentPaths(rules, workspace, home, env).map((entry) => [entry.action, entry.resource]),
      [
        ["external_directory", `${home}/.local/share/opencode/tool-output/*`],
        ["external_directory", `${home}/.local/share/opencode/plans/*`],
        ["edit", `${home}/.local/share/opencode/plans/design.md`],
        ["edit", ".opencode/plans/design.md"],
        ["edit", `${workspace}/.opencode/plans/design.md`],
      ],
    );
  });

  it("rejects glob wildcards, traversal, arbitrary prefixes matching opencode dir names, and workspace or host paths", () => {
    const rejected = [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "edit", resource: "**", effect: "allow" },
      { action: "edit", resource: "/*", effect: "allow" },
      { action: "edit", resource: "**/*", effect: "allow" },
      { action: "edit", resource: "src/*", effect: "allow" },
      { action: "edit", resource: "src/?.ts", effect: "allow" },
      { action: "edit", resource: "src/index.ts", effect: "allow" },
      { action: "edit", resource: `${workspace}/src/index.ts`, effect: "allow" },
      { action: "edit", resource: ".opencode/plans/*.md", effect: "allow" },
      { action: "edit", resource: ".opencode/plans/*", effect: "allow" },
      { action: "edit", resource: "/etc/passwd", effect: "allow" },
      { action: "edit", resource: `${home}/.config/opencode/opencode.json`, effect: "allow" },
      { action: "edit", resource: `${home}/.local/share/opencode/tool-output/*`, effect: "allow" },
      {
        action: "edit",
        resource: "/tmp/attacker/.local/share/opencode/plans/design.md",
        effect: "allow",
      },
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "**", effect: "allow" },
      { action: "external_directory", resource: "/*", effect: "allow" },
      { action: "external_directory", resource: "**/*", effect: "allow" },
      { action: "external_directory", resource: "/etc/*", effect: "allow" },
      { action: "external_directory", resource: "/tmp/evil", effect: "allow" },
      {
        action: "external_directory",
        resource: "/tmp/attacker/.local/share/opencode/tool-output/*",
        effect: "allow",
      },
      {
        action: "external_directory",
        resource: `${home}/.local/share/opencode/tool-output/**`,
        effect: "allow",
      },
      {
        action: "external_directory",
        resource: `${home}/.local/share/opencode/tool-output/../../etc/*`,
        effect: "allow",
      },
      {
        action: "external_directory",
        resource: `${workspace}/.local/share/opencode/tool-output/*`,
        effect: "allow",
      },
      {
        action: "external_directory",
        resource: `${home}/.local/share/opencode/tool-output/a\0b`,
        effect: "allow",
      },
      {
        action: "external_directory",
        resource: `${home}/.local/share/opencode/tool-output/*`,
        effect: "deny",
      },
    ] as const;

    assert.deepEqual(agentPaths(rejected, workspace, home, env), []);
  });
});
