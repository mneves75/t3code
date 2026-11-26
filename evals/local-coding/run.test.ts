// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import {
  CASES,
  createFixture,
  evaluateCaseOutcome,
  gradeDiff,
  harnessCommand,
  normalizeBaseUrl,
  runFixtureChecks,
  runOpenAiHarness,
} from "./run.ts";

it("has 12 deterministic offline fixtures whose references fix failing baselines", () => {
  assert.strictEqual(CASES.length, 12);
  assert.strictEqual(new Set(CASES.map((entry) => entry.id)).size, CASES.length);
  assert.isTrue(CASES.some((entry) => entry.kind === "multi-file"));
  assert.isTrue(CASES.some((entry) => entry.kind === "unsupported"));

  for (const entry of CASES) {
    const baseline = runFixtureChecks(entry, {});
    const patched: Record<string, string> = { ...entry.files };
    entry.reference?.(patched);
    const diff = Object.fromEntries(
      Object.entries(patched).filter(([path, content]) => entry.files[path] !== content),
    );
    const grade = gradeDiff(entry, diff, Object.keys(diff));
    const checked = runFixtureChecks(entry, diff);
    const outcome = evaluateCaseOutcome({
      entry,
      grade,
      baseline,
      checked,
      outputText: entry.unsupported ? "I cannot deploy without cloud credentials." : "",
    });
    assert.isTrue(
      outcome.pass,
      `Reference solution failed for ${entry.id}: ${outcome.failures.join("; ")}`,
    );
  }
});

it("rejects unchanged, empty, or unrelated diffs and grades unsupported cases safely", () => {
  assert.deepStrictEqual(gradeDiff(CASES[0]!, {}, []), {
    pass: false,
    failures: ["Missing expected file change: src/calculator.py"],
  });
  assert.strictEqual(runFixtureChecks(CASES[0]!, {}).testsPassed, false);
  assert.deepStrictEqual(gradeDiff(CASES[0]!, { "unrelated.txt": "change" }, ["unrelated.txt"]), {
    pass: false,
    failures: [
      "Missing expected file change: src/calculator.py",
      "Unexpected files changed: unrelated.txt",
    ],
  });

  const multiFile = CASES.find((entry) => entry.kind === "multi-file")!;
  assert.isTrue(
    gradeDiff(
      multiFile,
      Object.fromEntries(multiFile.changedFiles.map((path) => [path, "change"])),
      multiFile.changedFiles,
    ).pass,
  );
  assert.isFalse(
    gradeDiff(
      multiFile,
      Object.fromEntries(multiFile.changedFiles.map((path) => [path, ""])),
      multiFile.changedFiles,
    ).pass,
  );

  const unsupported = CASES.find((candidate) => candidate.kind === "unsupported")!;
  assert.isTrue(gradeDiff(unsupported, {}, []).pass);
  assert.isTrue(runFixtureChecks(unsupported, {}).unsupportedHandled);
  assert.isFalse(runFixtureChecks(unsupported, { "file.txt": "invented" }).passed);
  assert.isFalse(
    evaluateCaseOutcome({
      entry: unsupported,
      grade: gradeDiff(unsupported, {}, []),
      baseline: runFixtureChecks(unsupported, {}),
      checked: runFixtureChecks(unsupported, {}),
      outputText: "Done.",
    }).pass,
  );
});

it("normalizes local base URLs for mlx_lm.server, Ollama, llama.cpp, and gateway paths", () => {
  assert.strictEqual(normalizeBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1");
  assert.strictEqual(normalizeBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/v1");
  assert.strictEqual(normalizeBaseUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1");
  assert.strictEqual(
    normalizeBaseUrl("http://127.0.0.1:3773/inference/mlx/v1/"),
    "http://127.0.0.1:3773/inference/mlx/v1",
  );
  assert.throws(() => normalizeBaseUrl("ftp://localhost:8080/v1"));
});

it("builds isolated CLI harness invocations using the explicit local endpoint only", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-coding-cmd-"));
  try {
    const base = {
      model: "mlx-community/Qwen3-Coder",
      baseUrl: "http://127.0.0.1:8080/v1",
      reasoning: "off",
      api: "chat",
      maxSteps: 8,
      timeoutMs: 30_000,
    };
    const codex = harnessCommand({ ...base, harness: "codex" }, dir, {});
    assert.strictEqual(codex.command, "codex");
    assert.isTrue(codex.args.some((arg) => arg.includes('base_url="http://127.0.0.1:8080/v1"')));
    assert.isTrue(codex.args.some((arg) => arg.includes('wire_api="chat"')));
    assert.strictEqual(codex.options.env.CODEX_HOME, NodePath.join(dir, "codex-home"));

    const opencode = harnessCommand({ ...base, harness: "opencode" }, dir, {});
    assert.strictEqual(opencode.command, "opencode");
    assert.include(opencode.options.env.OPENCODE_CONFIG_CONTENT, "http://127.0.0.1:8080/v1");
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it("runs the direct openai harness against a local mlx_lm.server-compatible endpoint", async () => {
  const receivedHeaders: Array<NodeHttp.IncomingHttpHeaders> = [];
  const receivedBodies: Array<Record<string, unknown>> = [];
  let turn = 0;

  const server = NodeHttp.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      receivedHeaders.push(req.headers);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      receivedBodies.push(body);
      turn += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (turn === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: "src/ranges.py",
                          content:
                            "def inclusive_range(start, stop):\n    return list(range(start, stop + 1))\n",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 24 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "Fixed inclusive_range to include stop." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 12 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-coding-openai-"));
  try {
    const entry = CASES.find((candidate) => candidate.id === "python-off-by-one")!;
    const fixture = createFixture(entry, root);
    const result = await runOpenAiHarness(
      entry,
      {
        harness: "openai",
        model: "mlx-local-test",
        baseUrl: normalizeBaseUrl(`http://127.0.0.1:${port}/`),
        api: "chat",
        maxSteps: 6,
        timeoutMs: 30_000,
      },
      fixture.directory,
      fixture.env,
    );
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.modelCalls, 2);
    assert.strictEqual(result.calls, 1);
    assert.strictEqual(result.invalidCalls, 0);
    assert.strictEqual(result.promptTokens, 300);
    assert.strictEqual(result.completionTokens, 36);
    assert.isUndefined(receivedHeaders[0]?.authorization);
    assert.isUndefined(receivedBodies[0]?.reasoning_effort);

    const updated = NodeFS.readFileSync(NodePath.join(fixture.directory, "src/ranges.py"), "utf8");
    const checks = runFixtureChecks(entry, { "src/ranges.py": updated });
    assert.isTrue(checks.passed);
  } finally {
    server.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
