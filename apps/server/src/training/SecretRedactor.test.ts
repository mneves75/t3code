import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type RedactionOptions } from "@t3tools/contracts";

import {
  REDACTOR_VERSION,
  createRedactionAuditCollector,
  redactSftRecord,
  redactText,
} from "./SecretRedactor.ts";

const ALL_ON: RedactionOptions = {
  redactEnvAssignments: true,
  redactHomePaths: true,
  redactEmails: true,
  redactHighEntropy: true,
};

const ALL_OPTIONAL_OFF: RedactionOptions = {
  redactEnvAssignments: false,
  redactHomePaths: false,
  redactEmails: false,
  redactHighEntropy: false,
};

const THREAD_ID = ThreadId.make("thread-redaction-1");

describe("SecretRedactor", () => {
  it("redacts golden secret corpus across all 9 passes and never leaks raw secrets into report or output", () => {
    const pemKey = [
      ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7Mhg",
      ["-----END", "RSA PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const openAiKey = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-");
    const anthropicKey = ["sk", "ant", "api03", "ZxYwVuTsRqPoNmLkJiHgFeDcBa9876543210"].join("-");
    const githubToken = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyzABCD"].join("_");
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const gcpKey = ["AIza", "SyD4fakeKeyValue1234567890abcdefghijk"].join("");
    const stripeKey = ["sk", "live", "51FakeStripeSecretKeyValue1234567890"].join("_");
    const slackToken = ["xoxb", "123456789012", "1234567890123", "FakeSlackTokenValue"].join("-");
    const hfToken = ["hf", "FakeHuggingFaceTokenValue123456789"].join("_");
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const bearerSecret = "BearerTopSecretValue9876543210";
    const dbPassword = "s3cr3tDbPassword!";
    const envSecret = "super_secret_webhook_998877";
    const email = "alice.engineer@example-corp.io";
    const highEntropy = "K9mP2xQ7vL4nR8wT1zB6cF3hJ5dG0yN4";
    const customSecret = "ProjectHyperionInternalCodename";

    const corpus = [
      `Key:\n${pemKey}`,
      `OpenAI: ${openAiKey}`,
      `Anthropic: ${anthropicKey}`,
      `GitHub: ${githubToken}`,
      `AWS: ${awsKey}`,
      `GCP: ${gcpKey}`,
      `Stripe: ${stripeKey}`,
      `Slack: ${slackToken}`,
      `HF: ${hfToken}`,
      `JWT: ${jwt}`,
      `Authorization: Bearer ${bearerSecret}`,
      `postgres://dbadmin:${dbPassword}@db.internal.local:5432/prod`,
      `STRIPE_WEBHOOK_SECRET="${envSecret}"`,
      `Path: /Users/jdoe/dev/repo/main.ts and /home/deploy/app`,
      `Contact: ${email}`,
      `Opaque value: ${highEntropy}`,
      `Internal: ${customSecret}`,
    ].join("\n");

    const collector = createRedactionAuditCollector();
    const redacted = redactText(
      corpus,
      { ...ALL_ON, customLiteralTerms: [customSecret] },
      collector,
      { threadId: THREAD_ID, sourceKind: "tool_output" },
      "/Users/jdoe",
    );
    const report = collector.toReport();
    const reportJson = JSON.stringify(report);

    const rawSecrets = [
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn",
      openAiKey,
      anthropicKey,
      githubToken,
      awsKey,
      gcpKey,
      stripeKey,
      slackToken,
      hfToken,
      jwt,
      bearerSecret,
      dbPassword,
      envSecret,
      "jdoe",
      "deploy",
      email,
      highEntropy,
      customSecret,
    ];

    for (const secret of rawSecrets) {
      expect(redacted).not.toContain(secret);
      expect(reportJson).not.toContain(secret);
    }

    expect(report.redactorVersion).toBe(REDACTOR_VERSION);
    expect(report.affectedThreadCount).toBe(1);
    expect(report.countsByCategory.pem_private_key).toBe(1);
    expect(report.countsByCategory.api_key_provider).toBeGreaterThanOrEqual(6);
    expect(report.countsByCategory.aws_gcp_cloud).toBe(2);
    expect(report.countsByCategory.jwt_bearer).toBe(2);
    expect(report.countsByCategory.url_credentials).toBe(1);
    expect(report.countsByCategory.env_assignment).toBe(1);
    expect(report.countsByCategory.home_path_username).toBeGreaterThanOrEqual(2);
    expect(report.countsByCategory.email_address).toBe(1);
    expect(report.countsByCategory.high_entropy_secret).toBeGreaterThanOrEqual(2);
    expect(report.totalRedactions).toBeGreaterThanOrEqual(17);
    expect(redacted).toContain("/Users/<user>/dev/repo/main.ts");
    expect(redacted).toContain("/home/<user>/app");
    expect(redacted).toContain("[REDACTED:CUSTOM]");
  });

  it("enforces always-on categories even when optional redaction flags are disabled", () => {
    const openAiKey = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-");
    const input = `Token ${openAiKey} url https://user:secretpass@host.test/api`;
    const collector = createRedactionAuditCollector();
    const redacted = redactText(input, ALL_OPTIONAL_OFF, collector, {
      threadId: THREAD_ID,
      sourceKind: "user_message",
    });

    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("secretpass");
    expect(redacted).toContain("[REDACTED:API_KEY_PROVIDER]");
    expect(redacted).toContain("[REDACTED:USER]:[REDACTED:PASSWORD]@");
    expect(collector.toReport().totalRedactions).toBe(2);
  });

  it("preserves git SHAs, UUIDs, SRI hashes, camelCase identifiers, scoped packages, and noreply emails", () => {
    const gitSha40 = "5d02075446abcdef1234567890abcdef12345678";
    const gitSha64 = "a3f5c8e1d9b24076f1c3e5a7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const sri = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
    const camel = "OrchestrationV2ProviderSessionBindingsController";
    const noreply = "noreply@anthropic.com";
    const ghNoreply = "12345+octocat@users.noreply.github.com";

    const code = [
      `commit ${gitSha40}`,
      `tree ${gitSha64}`,
      `id = "${uuid}"`,
      `integrity: "${sri}"`,
      `export class ${camel} {}`,
      `import "@t3tools/contracts";`,
      `Author: ${noreply} and ${ghNoreply}`,
    ].join("\n");

    const collector = createRedactionAuditCollector();
    const redacted = redactText(code, ALL_ON, collector, {
      threadId: THREAD_ID,
      sourceKind: "assistant_message",
    });

    expect(redacted).toBe(code);
    expect(collector.toReport().totalRedactions).toBe(0);
  });

  it("caps sampleFindings at 100 and sets findingsTruncated without losing total counts", () => {
    const lines = Array.from(
      { length: 120 },
      (_, index) => `email_${index}@company-internal.test`,
    ).join("\n");
    const collector = createRedactionAuditCollector();
    const redacted = redactText(lines, ALL_ON, collector, {
      threadId: THREAD_ID,
      sourceKind: "tool_output",
    });
    const report = collector.toReport();

    expect(redacted).not.toContain("company-internal.test");
    expect(report.totalRedactions).toBe(120);
    expect(report.sampleFindings).toHaveLength(100);
    expect(report.findingsTruncated).toBe(true);
  });

  it("redacts tool call arguments as well as message content in SFT records", () => {
    const collector = createRedactionAuditCollector();
    const record = redactSftRecord(
      {
        messages: [
          {
            role: "user",
            content: `Deploy using ${["hf", "SecretTokenValue1234567890abcd"].join("_")}`,
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({
                    command: "API_KEY=secret_value_123456789 curl https://u:p12345@api.test",
                  }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", name: "shell", content: "ok" },
        ],
      },
      ALL_ON,
      collector,
      THREAD_ID,
    );

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("hf_SecretTokenValue");
    expect(serialized).not.toContain("secret_value_123456789");
    expect(serialized).not.toContain("p12345");
    expect(collector.toReport().totalRedactions).toBe(3);
  });

  it("cannot be bypassed by attacker-supplied [REDACTED: ... ] framing (SEC-03a)", () => {
    const openAiKey = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-");
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const pem = [
      ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7Mhg",
      ["-----END", "RSA PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const input = `[REDACTED: note ${openAiKey} and ${awsKey} and\n${pem}\n]`;
    const collector = createRedactionAuditCollector();
    const redacted = redactText(input, ALL_ON, collector, {
      threadId: THREAD_ID,
      sourceKind: "tool_output",
    });
    const report = collector.toReport();

    expect(redacted).not.toContain(openAiKey);
    expect(redacted).not.toContain(awsKey);
    expect(redacted).not.toContain("MIIEpAIBAAKCAQEA");
    expect(report.totalRedactions).toBeGreaterThanOrEqual(3);
  });

  it("never leaks raw fragments of adjacent secrets into sampleFindings (SEC-03b)", () => {
    const pem = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7Mhg",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const ghToken = ["ghp", "AbCdEf1234567890GhIjKlMnOpQrStUvWxYz12"].join("_");
    const openAiKey = ["sk", "proj", "ZxYwVuTsRqPoNmLkJiHgFeDcBa9876543210"].join("-");
    const input = `${pem} tok: ${ghToken} and ${openAiKey}`;
    const collector = createRedactionAuditCollector();
    const redacted = redactText(input, ALL_ON, collector, {
      threadId: THREAD_ID,
      sourceKind: "tool_output",
    });
    const report = collector.toReport();
    const reportJson = JSON.stringify(report.sampleFindings);

    expect(redacted).not.toContain("ghp_");
    expect(redacted).not.toContain("AbCdEf12345678");
    expect(reportJson).not.toContain("ghp_");
    expect(reportJson).not.toContain("AbCdEf12345678");
    expect(reportJson).not.toContain("MnOpQrStUvWxYz");
    expect(reportJson).not.toContain("sk-proj-");
    expect(reportJson).not.toContain("MIIEpAIBAAKCAQEA");
    expect(report.totalRedactions).toBe(3);
  });

  it("redacts JSON-quoted credentials and PGP private key blocks (SEC-03c)", () => {
    const pgp = [
      ["-----BEGIN", "PGP PRIVATE KEY BLOCK-----"].join(" "),
      "lQOYBGX1234567890abcdefghijklmnopqrstuvwxyzABCDEF",
      ["-----END", "PGP PRIVATE KEY BLOCK-----"].join(" "),
    ].join("\n");
    const jsonPayload = JSON.stringify({
      api_key: "super_secret_json_api_key_9988",
      password: "super_secret_json_password_77",
      Authorization: "Bearer opaque_json_bearer_token_123456",
    });
    const input = `${jsonPayload}\n${pgp}`;
    const collector = createRedactionAuditCollector();
    const redacted = redactText(input, ALL_ON, collector, {
      threadId: THREAD_ID,
      sourceKind: "tool_input",
    });
    const report = collector.toReport();

    expect(redacted).not.toContain("super_secret_json_api_key_9988");
    expect(redacted).not.toContain("super_secret_json_password_77");
    expect(redacted).not.toContain("opaque_json_bearer_token_123456");
    expect(redacted).not.toContain("lQOYBGX1234567890");
    expect(report.totalRedactions).toBe(4);
  });
});
