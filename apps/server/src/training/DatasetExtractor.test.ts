import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  TrainingDatasetId,
  type RedactionOptions,
  type TrainingDatasetFilter,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as DatasetExtractor from "./DatasetExtractor.ts";
import * as SecretRedactor from "./SecretRedactor.ts";

const makeTestLayer = () =>
  DatasetExtractor.layer.pipe(
    Layer.provideMerge(SecretRedactor.layer),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(NodeServices.layer),
  );

const DEFAULT_FILTER: TrainingDatasetFilter = {
  settledOnly: false,
  includeArchived: false,
  includeSubagents: false,
  minCompletedRuns: 1,
  includeToolCalls: true,
  includeReasoning: true,
  includeCheckpointDiffs: false,
  maxToolOutputChars: 2000,
  split: { validRatio: 0, testRatio: 0, seed: 42 },
};

const DEFAULT_REDACTION: RedactionOptions = {
  redactEnvAssignments: true,
  redactHomePaths: true,
  redactEmails: true,
  redactHighEntropy: true,
};

const seedBasicThread = Effect.fn("seedBasicThread")(function* (input: {
  readonly threadId: string;
  readonly projectId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly settled?: boolean;
  readonly archivedAt?: string | null;
  readonly forkedFrom?: {
    readonly type: "run";
    readonly threadId: string;
    readonly runId: string;
  } | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const payload = {
    providerInstanceId: input.provider ?? "codex",
    modelSelection: { model: input.model ?? "qwen3-coder" },
    settledAt: input.settled ? "2026-11-24T19:00:00.000Z" : null,
    settledOverride: input.settled ? "settled" : null,
    lineage: { relationshipToParent: "root" },
    forkedFrom: input.forkedFrom ?? null,
    tags: ["coding"],
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, ${input.projectId ?? "proj-1"}, 'Test Thread', ${input.provider ?? "codex"},
      'full-access', 'default', NULL, '2026-11-24T18:00:00.000Z', '2026-11-24T19:00:00.000Z',
      ${input.archivedAt ?? null}, NULL, ${JSON.stringify(payload)}
    )
  `;
});

describe("DatasetExtractor", () => {
  it.effect(
    "extracts durable command_execution output omitted on wire, redacts secrets, drops secret_request, and writes manifest",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const extractor = yield* DatasetExtractor.DatasetExtractor;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* seedBasicThread({ threadId: "thread-sft-1", settled: true });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            'run-1', 'thread-sft-1', 1, 'codex', 'pt-1', 'completed',
            '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'
          )
        `;

        // Deduped user message body stored in orchestration_v2_projection_messages
        const syntheticSecret = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-");
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (
            'msg-user-1', 'thread-sft-1', 'run-1', 'node-1', 'user', 0,
            '2026-11-24T18:01:00.000Z', '2026-11-24T18:01:00.000Z',
            ${JSON.stringify({ text: `Fix tests using token ${syntheticSecret}` })}
          )
        `;

        const items = [
          {
            id: "item-1",
            ord: 1,
            type: "user_message",
            payload: { messageId: "msg-user-1", text: "", textOmitted: true },
          },
          {
            id: "item-2",
            ord: 2,
            type: "secret_request",
            payload: { secretName: "PROD_KEY", reason: "must be excluded" },
          },
          {
            id: "item-3",
            ord: 3,
            type: "reasoning",
            payload: { text: "Check pytest failure output first.", streaming: false },
          },
          {
            id: "item-4",
            ord: 4,
            type: "command_execution",
            payload: {
              input: "pytest tests/test_calc.py",
              output: "DURABLE_FULL_STDOUT_PASSED_42_CASES",
              exitCode: 0,
            },
          },
          {
            id: "item-5",
            ord: 5,
            type: "assistant_message",
            payload: { messageId: "msg-asst-1", text: "All 42 tests now pass.", streaming: false },
          },
        ];

        for (const item of items) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${item.id}, 'thread-sft-1', 'run-1', 'node-1', 'pt-1', 'turn-1',
              NULL, ${item.ord}, ${item.type}, 'completed', '2026-11-24T18:02:00.000Z',
              ${JSON.stringify(item.payload)}
            )
          `;
          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES ('thread-sft-1', ${item.id}, ${item.ord})
          `;
        }

        const preview = yield* extractor.preview({
          objective: "sft",
          filter: DEFAULT_FILTER,
          redactionOptions: DEFAULT_REDACTION,
        });

        expect(preview.matchedThreadCount).toBe(1);
        expect(preview.totalExamples).toBe(1);
        expect(preview.redactionAudit.totalRedactions).toBe(1);
        expect(preview.redactionAudit.countsByCategory.api_key_provider).toBe(1);

        const sample = preview.sampleSftRecords?.[0];
        expect(sample).toBeDefined();
        const serialized = JSON.stringify(sample);
        expect(serialized).not.toContain(syntheticSecret);
        expect(serialized).not.toContain("PROD_KEY");
        expect(serialized).toContain("[REDACTED:API_KEY_PROVIDER]");
        expect(serialized).toContain("DURABLE_FULL_STDOUT_PASSED_42_CASES");
        expect(serialized).toContain("<think>");

        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-training-ds-" });
        const summary = yield* extractor.materialize({
          datasetId: TrainingDatasetId.make("ds-sft-1"),
          name: "SFT Test",
          objective: "sft",
          filter: DEFAULT_FILTER,
          redactionOptions: DEFAULT_REDACTION,
          outputDir: tempDir,
        });

        expect(summary.trainCount).toBe(1);
        expect(summary.provenanceHash).toHaveLength(64);
        const diskJsonl = yield* fs.readFileString(path.join(tempDir, "train.jsonl"));
        expect(diskJsonl).not.toContain(syntheticSecret);
        expect(diskJsonl).toContain("DURABLE_FULL_STDOUT_PASSED_42_CASES");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "extracts DPO preference pairs from rollbacks and retry attempts, and converts DPO chosen to SFT",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const extractor = yield* DatasetExtractor.DatasetExtractor;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* seedBasicThread({ threadId: "thread-dpo-1", settled: true });

        // Run 1: rolled back; Run 2: replacement completed with matching prompt
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES
            ('run-rb', 'thread-dpo-1', 1, 'codex', 'pt-1', 'rolled_back', '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'),
            ('run-ok', 'thread-dpo-1', 2, 'codex', 'pt-1', 'completed', '2026-11-24T18:03:00.000Z', '2026-11-24T18:04:00.000Z', '{}'),
            ('run-retry', 'thread-dpo-1', 3, 'codex', 'pt-1', 'completed', '2026-11-24T18:05:00.000Z', '2026-11-24T18:06:00.000Z', '{}')
        `;

        yield* sql`
          INSERT INTO orchestration_v2_projection_run_attempts (
            attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, provider_turn_id, status, payload_json
          ) VALUES
            ('att-1', 'thread-dpo-1', 'run-retry', 1, 'node-att-1', 'codex', 'pt-1', 'pturn-1', 'superseded', ${JSON.stringify({ reason: "initial" })}),
            ('att-2', 'thread-dpo-1', 'run-retry', 2, 'node-att-2', 'codex', 'pt-1', 'pturn-2', 'completed', ${JSON.stringify({ reason: "steering_restart" })})
        `;

        const rows = [
          // Rolled back run
          {
            id: "rb-u",
            runId: "run-rb",
            nodeId: "n-rb",
            pturn: "t-rb",
            ord: 1,
            type: "user_message",
            payload: { messageId: "m1", text: "Implement binary search in Python" },
          },
          {
            id: "rb-a",
            runId: "run-rb",
            nodeId: "n-rb",
            pturn: "t-rb",
            ord: 2,
            type: "assistant_message",
            payload: { messageId: "m2", text: "Buggy linear scan answer", streaming: false },
          },
          // Replacement completed run
          {
            id: "ok-u",
            runId: "run-ok",
            nodeId: "n-ok",
            pturn: "t-ok",
            ord: 3,
            type: "user_message",
            payload: { messageId: "m3", text: "Implement binary search in Python" },
          },
          {
            id: "ok-a",
            runId: "run-ok",
            nodeId: "n-ok",
            pturn: "t-ok",
            ord: 4,
            type: "assistant_message",
            payload: {
              messageId: "m4",
              text: "Correct O(log n) binary search implementation",
              streaming: false,
            },
          },
          // Retry run with 2 attempts
          {
            id: "rt-u",
            runId: "run-retry",
            nodeId: "node-att-1",
            pturn: "pturn-1",
            ord: 5,
            type: "user_message",
            payload: { messageId: "m5", text: "Add unit tests" },
          },
          {
            id: "rt-a1",
            runId: "run-retry",
            nodeId: "node-att-1",
            pturn: "pturn-1",
            ord: 6,
            type: "assistant_message",
            payload: { messageId: "m6", text: "Incomplete test stub", streaming: false },
          },
          {
            id: "rt-a2",
            runId: "run-retry",
            nodeId: "node-att-2",
            pturn: "pturn-2",
            ord: 7,
            type: "assistant_message",
            payload: {
              messageId: "m7",
              text: "Comprehensive edge-case unit tests",
              streaming: false,
            },
          },
        ];

        for (const r of rows) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${r.id}, 'thread-dpo-1', ${r.runId}, ${r.nodeId}, 'pt-1', ${r.pturn},
              NULL, ${r.ord}, ${r.type}, 'completed', '2026-11-24T18:06:00.000Z',
              ${JSON.stringify(r.payload)}
            )
          `;
        }

        const dpoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dpo-ds-" });
        const dpoSummary = yield* extractor.materialize({
          datasetId: TrainingDatasetId.make("ds-dpo-1"),
          name: "DPO Pairs",
          objective: "dpo",
          filter: {
            ...DEFAULT_FILTER,
            dpoSources: { fromForks: true, fromRollbacks: true, fromRetryAttempts: true },
          },
          redactionOptions: DEFAULT_REDACTION,
          outputDir: dpoDir,
        });

        expect(dpoSummary.trainCount).toBe(2);
        const dpoLines = (yield* fs.readFileString(path.join(dpoDir, "train.jsonl")))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));

        const rollbackPair = dpoLines.find((p) => p.metadata.source === "rollback");
        const retryPair = dpoLines.find((p) => p.metadata.source === "retry_attempt");
        expect(rollbackPair?.chosen[0]?.content).toContain("Correct O(log n)");
        expect(rollbackPair?.rejected[0]?.content).toContain("Buggy linear scan");
        expect(retryPair?.chosen[0]?.content).toContain("Comprehensive edge-case");
        expect(retryPair?.rejected[0]?.content).toContain("Incomplete test stub");

        // One-click DPO chosen -> SFT conversion
        const sftDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dpo-to-sft-" });
        const converted = yield* extractor.materializeSftFromDpo({
          sourceDataset: dpoSummary,
          targetDatasetId: TrainingDatasetId.make("ds-sft-from-dpo"),
          targetName: "Converted SFT",
          outputDir: sftDir,
        });
        expect(converted.objective).toBe("sft");
        expect(converted.trainCount).toBe(2);
        const sftJsonl = yield* fs.readFileString(path.join(sftDir, "train.jsonl"));
        expect(sftJsonl).toContain("Correct O(log n)");
        expect(sftJsonl).not.toContain("Buggy linear scan");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "withholds webhook signing secrets and webhook URL tokens in dynamic_tool inputs (T3-01)",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const extractor = yield* DatasetExtractor.DatasetExtractor;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* seedBasicThread({ threadId: "thread-hook-secret", settled: true });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            'run-hook-1', 'thread-hook-secret', 1, 'codex', 'pt-hook', 'completed',
            '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'
          )
        `;

        const signingSecret = "whsec_live_super_secret_signing_value";
        const hookToken = "WebhookBearerToken_ABC123xyz";
        const items = [
          {
            id: "hook-item-1",
            ord: 1,
            type: "user_message",
            payload: { messageId: "m-hook-u", text: "Create a scheduled webhook task." },
          },
          {
            id: "hook-item-2",
            ord: 2,
            type: "dynamic_tool",
            payload: {
              tool: "create_scheduled_task",
              input: {
                name: "CI hook",
                schedule: {
                  type: "webhook",
                  signature: { header: "x-sig", secret: signingSecret },
                },
              },
              output: `Created https://relay.example.test/v1/hooks/0123456789abcdef/task-1/${hookToken}`,
            },
          },
          {
            id: "hook-item-3",
            ord: 3,
            type: "assistant_message",
            payload: { messageId: "m-hook-a", text: "Webhook task configured." },
          },
        ];

        for (const item of items) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${item.id}, 'thread-hook-secret', 'run-hook-1', 'node-1', 'pt-hook', 'turn-hook-1',
              NULL, ${item.ord}, ${item.type}, 'completed', '2026-11-24T18:02:00.000Z',
              ${JSON.stringify(item.payload)}
            )
          `;
          yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES ('thread-hook-secret', ${item.id}, ${item.ord})
          `;
        }

        const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ds-hook-" });
        yield* extractor.materialize({
          datasetId: TrainingDatasetId.make("ds-hook-1"),
          name: "Webhook Redaction Test",
          objective: "sft",
          filter: DEFAULT_FILTER,
          redactionOptions: {
            redactEnvAssignments: false,
            redactHomePaths: false,
            redactEmails: false,
            redactHighEntropy: false,
          },
          outputDir: outDir,
        });

        const trainJsonl = yield* fs.readFileString(path.join(outDir, "train.jsonl"));
        expect(trainJsonl).not.toContain(signingSecret);
        expect(trainJsonl).not.toContain(hookToken);
        expect(trainJsonl).toContain("[withheld]");
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "redacts multiline and double-quoted secrets before JSON escaping without leaking into audit snippets or double-counting",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const extractor = yield* DatasetExtractor.DatasetExtractor;

        yield* seedBasicThread({ threadId: "thread-json-escape", settled: true });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            'run-esc-1', 'thread-json-escape', 1, 'codex', 'pt-esc', 'completed',
            '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'
          )
        `;

        const quotedSecret = "quoted_super_secret_val_99";
        const line2Secret = "line2_database_pass_value";
        const oldStrSecret = "oldstr_secret_password_77";
        const bearerSecret = "BearerTokenSecretValue_987654";
        const dynamicKeySecret = "dyn_api_secret_value_55";

        const items = [
          {
            id: "esc-1",
            ord: 1,
            type: "user_message",
            payload: { messageId: "m-esc-u", text: "Inspect config files." },
          },
          {
            id: "esc-2",
            ord: 2,
            type: "command_execution",
            payload: {
              input: `echo 'API_KEY="${quotedSecret}"'`,
              output: `header line\nDB_PASSWORD="${line2Secret}"\nhttps://svc:${line2Secret}@db.internal/app`,
              exitCode: 0,
            },
          },
          {
            id: "esc-3",
            ord: 3,
            type: "file_change",
            payload: {
              fileName: "config.env",
              oldStr: `first=1\nCLIENT_SECRET="${oldStrSecret}"`,
              newStr: "first=1\nCLIENT_SECRET=ok",
            },
          },
          {
            id: "esc-4",
            ord: 4,
            type: "dynamic_tool",
            payload: {
              toolName: "http_request",
              input: {
                API_KEY: dynamicKeySecret,
                headers: { Authorization: `Bearer ${bearerSecret}` },
              },
              output: { ok: true, detail: `line1\nTOKEN="${quotedSecret}"` },
            },
          },
          {
            id: "esc-5",
            ord: 5,
            type: "assistant_message",
            payload: { messageId: "m-esc-a", text: "Done inspecting.", streaming: false },
          },
        ];

        for (const item of items) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${item.id}, 'thread-json-escape', 'run-esc-1', 'node-1', 'pt-esc', 'turn-esc-1',
              NULL, ${item.ord}, ${item.type}, 'completed', '2026-11-24T18:02:00.000Z',
              ${JSON.stringify(item.payload)}
            )
          `;
        }

        const preview = yield* extractor.preview({
          objective: "sft",
          filter: DEFAULT_FILTER,
          redactionOptions: { ...DEFAULT_REDACTION, redactHighEntropy: false },
        });

        const serializedSample = JSON.stringify(preview.sampleSftRecords);
        const serializedAudit = JSON.stringify(preview.redactionAudit);
        for (const secret of [
          quotedSecret,
          line2Secret,
          oldStrSecret,
          bearerSecret,
          dynamicKeySecret,
        ]) {
          expect(serializedSample).not.toContain(secret);
          expect(serializedAudit).not.toContain(secret);
        }
        // Exactly 7 findings (quoted command, line2 env, url cred, oldStr env, dynamic API_KEY, Authorization header, dynamic output TOKEN).
        expect(preview.redactionAudit.totalRedactions).toBe(7);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "redacts PEM keys, JWTs, and URL credentials before deterministicClip truncates across the 60%/40% boundary",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const extractor = yield* DatasetExtractor.DatasetExtractor;

        yield* seedBasicThread({ threadId: "thread-clip-redact", settled: true });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            'run-clip-1', 'thread-clip-redact', 1, 'codex', 'pt-clip', 'completed',
            '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'
          )
        `;

        // maxToolOutputChars = 400 -> head ~230 chars; place PEM, JWT, and URL credentials right across the clip boundary.
        const pemBody = "MIIEowIBAAKCAQEAclipBoundaryPemSecretPayload1234567890";
        const pemKey = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`;
        const jwtPayload = "eyJzdWIiOiJjbGlwX2JvdW5kYXJ5X3VzZXIifQ";
        const jwtToken = `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.signatureClipSecret1234567890`;
        const urlPass = "ClipBoundaryDbPass99";
        const urlCred = `postgres://clipuser:${urlPass}@db.internal:5432/prod`;

        const items = [
          {
            id: "clip-1",
            ord: 1,
            type: "user_message",
            payload: { messageId: "m-clip-u", text: "Dump logs." },
          },
          {
            id: "clip-2",
            ord: 2,
            type: "command_execution",
            payload: {
              input: "cat key.pem",
              output: `${"A".repeat(200)}\n${pemKey}\n${"B".repeat(400)}`,
              exitCode: 0,
            },
          },
          {
            id: "clip-3",
            ord: 3,
            type: "file_change",
            payload: {
              fileName: "auth.log",
              diffStr: `${"C".repeat(210)}\n${jwtToken}\n${urlCred}\n${"D".repeat(400)}`,
            },
          },
          {
            id: "clip-4",
            ord: 4,
            type: "assistant_message",
            payload: { messageId: "m-clip-a", text: "Logs dumped.", streaming: false },
          },
        ];

        for (const item of items) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${item.id}, 'thread-clip-redact', 'run-clip-1', 'node-1', 'pt-clip', 'turn-clip-1',
              NULL, ${item.ord}, ${item.type}, 'completed', '2026-11-24T18:02:00.000Z',
              ${JSON.stringify(item.payload)}
            )
          `;
        }

        const preview = yield* extractor.preview({
          objective: "sft",
          filter: { ...DEFAULT_FILTER, maxToolOutputChars: 400 },
          redactionOptions: DEFAULT_REDACTION,
        });

        const serializedSample = JSON.stringify(preview.sampleSftRecords);
        const serializedAudit = JSON.stringify(preview.redactionAudit);
        for (const leaked of [pemBody, "BEGIN RSA PRIVATE KEY", jwtPayload, urlPass]) {
          expect(serializedSample).not.toContain(leaked);
          expect(serializedAudit).not.toContain(leaked);
        }
        expect(preview.redactionAudit.countsByCategory.pem_private_key).toBe(1);
        expect(preview.redactionAudit.countsByCategory.jwt_bearer).toBe(1);
        expect(preview.redactionAudit.countsByCategory.url_credentials).toBe(1);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("redacts secrets and custom literals inside dynamic tool object keys", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const extractor = yield* DatasetExtractor.DatasetExtractor;

      yield* seedBasicThread({ threadId: "thread-key-redact", settled: true });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json
        ) VALUES (
          'run-key-1', 'thread-key-redact', 1, 'codex', 'pt-key', 'completed',
          '2026-11-24T18:01:00.000Z', '2026-11-24T18:02:00.000Z', '{}'
        )
      `;
      const customKeySecret = "SecretProjectCodenameKey99";
      const items = [
        {
          id: "key-1",
          ord: 1,
          type: "user_message",
          payload: { messageId: "m-key-u", text: "Check tool output keys." },
        },
        {
          id: "key-2",
          ord: 2,
          type: "dynamic_tool",
          payload: {
            toolName: "inspect",
            input: { [customKeySecret]: "val", "[REDACTED:CUSTOM]": "preserved" },
            output: { [`nested_${customKeySecret}`]: "ok" },
          },
        },
        {
          id: "key-3",
          ord: 3,
          type: "assistant_message",
          payload: { messageId: "m-key-a", text: "Checked." },
        },
      ];
      for (const item of items) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${item.id}, 'thread-key-redact', 'run-key-1', 'node-1', 'pt-key', 'turn-key-1',
            NULL, ${item.ord}, ${item.type}, 'completed', '2026-11-24T18:02:00.000Z',
            ${JSON.stringify(item.payload)}
          )
        `;
      }
      const preview = yield* extractor.preview({
        objective: "sft",
        filter: DEFAULT_FILTER,
        redactionOptions: { ...DEFAULT_REDACTION, customLiteralTerms: [customKeySecret] },
      });
      expect(preview.sampleSftRecords?.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(preview.sampleSftRecords);
      expect(serialized).not.toContain(customKeySecret);
      expect(serialized).toContain("[REDACTED:CUSTOM]");
      expect(serialized).toContain("preserved");
      expect(preview.redactionAudit.countsByCategory.high_entropy_secret).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
