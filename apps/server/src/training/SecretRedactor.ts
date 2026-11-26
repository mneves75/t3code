// @effect-diagnostics nodeBuiltinImport:off -- pure synchronous SHA-256 digest helper for audit matchDigestPrefix
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  RedactionAuditFinding,
  RedactionAuditReport,
  RedactionAuditSourceKind,
  RedactionOptions,
  RedactionRuleCategory,
  ThreadId,
  TrainingChatMessage,
  TrainingDpoRecord,
  TrainingSftRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WEBHOOK_URL_TOKEN, WITHHELD } from "../scheduledTasks/webhookUrlToken.ts";

export const REDACTOR_VERSION = "1.0.0";
const MAX_SAMPLE_FINDINGS = 100;
const SNIPPET_CONTEXT_CHARS = 24;

const ALL_CATEGORIES: ReadonlyArray<RedactionRuleCategory> = [
  "api_key_provider",
  "jwt_bearer",
  "pem_private_key",
  "aws_gcp_cloud",
  "env_assignment",
  "url_credentials",
  "home_path_username",
  "email_address",
  "high_entropy_secret",
];

export interface RedactionContext {
  readonly threadId: ThreadId;
  readonly sourceKind: RedactionAuditSourceKind;
}

export interface RedactionAuditCollector {
  readonly recordMatch: (input: {
    readonly category: RedactionRuleCategory;
    readonly ruleId: string;
    readonly rawMatch: string;
    readonly placeholder: string;
    readonly redactedSnippet: string;
    readonly context: RedactionContext;
  }) => void;
  readonly toReport: () => RedactionAuditReport;
}

export function createRedactionAuditCollector(): RedactionAuditCollector {
  const counts: Record<RedactionRuleCategory, number> = {
    api_key_provider: 0,
    jwt_bearer: 0,
    pem_private_key: 0,
    aws_gcp_cloud: 0,
    env_assignment: 0,
    url_credentials: 0,
    home_path_username: 0,
    email_address: 0,
    high_entropy_secret: 0,
  };
  let totalRedactions = 0;
  const affectedThreads = new Set<ThreadId>();
  const sampleFindings: Array<RedactionAuditFinding> = [];
  let findingsTruncated = false;

  return {
    recordMatch(input) {
      totalRedactions += 1;
      counts[input.category] += 1;
      affectedThreads.add(input.context.threadId);
      if (sampleFindings.length < MAX_SAMPLE_FINDINGS) {
        const digest = NodeCrypto.createHash("sha256")
          .update(input.rawMatch)
          .digest("hex")
          .slice(0, 8);
        const snippet = input.redactedSnippet.trim() || input.placeholder;
        sampleFindings.push({
          category: input.category,
          ruleId: input.ruleId,
          threadId: input.context.threadId,
          sourceKind: input.context.sourceKind,
          redactedSnippet: snippet,
          matchDigestPrefix: digest,
        });
      } else {
        findingsTruncated = true;
      }
    },
    toReport(): RedactionAuditReport {
      const countsByCategory = Object.fromEntries(
        ALL_CATEGORIES.map((category) => [category, counts[category]]),
      ) as Record<RedactionRuleCategory, number>;
      return {
        redactorVersion: REDACTOR_VERSION,
        totalRedactions,
        countsByCategory,
        affectedThreadCount: affectedThreads.size,
        sampleFindings,
        findingsTruncated,
      };
    },
  };
}

interface PatternRule {
  readonly id: string;
  readonly category: RedactionRuleCategory;
  readonly pattern: RegExp;
  readonly placeholder: string;
}

const PEM_RULE: PatternRule = {
  id: "pem_private_key",
  category: "pem_private_key",
  pattern:
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,16384}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
  placeholder: "[REDACTED:PEM_PRIVATE_KEY]",
};

const PROVIDER_AND_CLOUD_RULES: ReadonlyArray<PatternRule> = [
  {
    id: "anthropic_api_key",
    category: "api_key_provider",
    pattern: /\bsk-ant-(?:api\d{2}-|admin\d{2}-)?[A-Za-z0-9_-]{20,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "openai_api_key",
    category: "api_key_provider",
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "github_token",
    category: "api_key_provider",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "aws_access_key_id",
    category: "aws_gcp_cloud",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    placeholder: "[REDACTED:AWS_GCP_CLOUD]",
  },
  {
    id: "gcp_api_key",
    category: "aws_gcp_cloud",
    pattern: /\bAIza[0-9A-Za-z_-]{35,40}\b/g,
    placeholder: "[REDACTED:AWS_GCP_CLOUD]",
  },
  {
    id: "stripe_key",
    category: "api_key_provider",
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "slack_token",
    category: "api_key_provider",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "huggingface_token",
    category: "api_key_provider",
    pattern: /\bhf_[A-Za-z0-9]{20,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "npm_token",
    category: "api_key_provider",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "pypi_token",
    category: "api_key_provider",
    pattern: /\bpypi-[A-Za-z0-9_-]{40,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "linear_api_key",
    category: "api_key_provider",
    pattern: /\blin_api_[A-Za-z0-9]{30,}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
  {
    id: "telegram_bot_token",
    category: "api_key_provider",
    pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
    placeholder: "[REDACTED:API_KEY_PROVIDER]",
  },
];

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g;
const AUTH_HEADER_PATTERN =
  /((?:["']Authorization["']|\bAuthorization)\s*:\s*["']?(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const URL_CREDENTIAL_PATTERN =
  /\b((?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|s?ftp):\/\/)([^:\s/@]{1,64}):([^@\s/]{4,128})@/gi;
const ENV_ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_])(["']?)([A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|CLIENT_?SECRET|WEBHOOK_?SECRET|DATABASE_?URL|SIGNING_?KEY)[A-Z0-9_]*)\1(\s*[=:]\s*)(["']?)([^\s"'`]{8,})\4/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HIGH_ENTROPY_CANDIDATE_PATTERN = /[A-Za-z0-9+/=_-]{24,256}/g;

const UNIX_HOME_PATTERN = /(\/(?:Users|home)\/)([A-Za-z0-9._-]+)/g;
const WIN_HOME_PATTERN = /(C:\\Users\\)([A-Za-z0-9._-]+)/gi;

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMEL_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const SECRET_CONTEXT_HINT = /(?:secret|token|key|password|passwd|auth|bearer|credential)/i;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRedactedSnippet(
  postRedactionText: string,
  placeholderOffset: number,
  placeholderLength: number,
): string {
  const start = Math.max(0, placeholderOffset - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(
    postRedactionText.length,
    placeholderOffset + placeholderLength + SNIPPET_CONTEXT_CHARS,
  );
  const prefix = start > 0 ? "..." : "";
  const suffix = end < postRedactionText.length ? "..." : "";
  return `${prefix}${postRedactionText.slice(start, end).replace(/\s+/g, " ")}${suffix}`;
}

interface EmittedRedaction {
  readonly id: number;
  readonly category: RedactionRuleCategory;
  readonly ruleId: string;
  readonly rawMatch: string;
  readonly placeholder: string;
}

interface RedactionSession {
  readonly sentinelOpen: string;
  readonly sentinelClose: string;
  readonly emitted: ReadonlyArray<EmittedRedaction>;
  readonly emit: (entry: Omit<EmittedRedaction, "id">) => string;
  readonly containsSentinel: (slice: string) => boolean;
  readonly overlapsSentinel: (text: string, start: number, length: number) => boolean;
}

function createRedactionSession(input: string): RedactionSession {
  let nonce = "0";
  while (input.includes(`\uE000${nonce}#`)) {
    nonce = NodeCrypto.randomBytes(6).toString("hex");
  }
  const sentinelOpen = `\uE000${nonce}#`;
  const sentinelClose = "\uE001";
  const emitted: Array<EmittedRedaction> = [];

  const containsSentinel = (slice: string): boolean => slice.includes(sentinelOpen);

  const overlapsSentinel = (text: string, start: number, length: number): boolean => {
    if (length > 0 && text.slice(start, start + length).includes(sentinelOpen)) {
      return true;
    }
    const open = text.lastIndexOf(sentinelOpen, start);
    if (open === -1) return false;
    const close = text.indexOf(sentinelClose, open + sentinelOpen.length);
    return close !== -1 && start <= close;
  };

  return {
    sentinelOpen,
    sentinelClose,
    emitted,
    emit(entry) {
      const id = emitted.length;
      emitted.push({ id, ...entry });
      return `${sentinelOpen}${id}${sentinelClose}`;
    },
    containsSentinel,
    overlapsSentinel,
  };
}

function finalizeRedactedText(
  textWithSentinels: string,
  session: RedactionSession,
  collector: RedactionAuditCollector | undefined,
  context: RedactionContext | undefined,
): string {
  if (session.emitted.length === 0) return textWithSentinels;

  const { sentinelOpen, sentinelClose, emitted } = session;
  const finalPositions = new Map<number, { readonly offset: number; readonly length: number }>();
  let finalText = "";
  let cursor = 0;

  while (cursor < textWithSentinels.length) {
    const open = textWithSentinels.indexOf(sentinelOpen, cursor);
    if (open === -1) {
      finalText += textWithSentinels.slice(cursor);
      break;
    }
    const close = textWithSentinels.indexOf(sentinelClose, open + sentinelOpen.length);
    if (close === -1) {
      finalText += textWithSentinels.slice(cursor);
      break;
    }
    finalText += textWithSentinels.slice(cursor, open);
    const idStr = textWithSentinels.slice(open + sentinelOpen.length, close);
    const id = Number.parseInt(idStr, 10);
    const entry = Number.isInteger(id) ? emitted[id] : undefined;
    if (entry !== undefined) {
      const offset = finalText.length;
      finalText += entry.placeholder;
      finalPositions.set(entry.id, { offset, length: entry.placeholder.length });
    } else {
      finalText += textWithSentinels.slice(open, close + sentinelClose.length);
    }
    cursor = close + sentinelClose.length;
  }

  if (collector !== undefined && context !== undefined) {
    for (const entry of emitted) {
      const pos = finalPositions.get(entry.id);
      const redactedSnippet =
        pos !== undefined
          ? buildRedactedSnippet(finalText, pos.offset, pos.length)
          : entry.placeholder;
      collector.recordMatch({
        category: entry.category,
        ruleId: entry.ruleId,
        rawMatch: entry.rawMatch,
        placeholder: entry.placeholder,
        redactedSnippet,
        context,
      });
    }
  }

  return finalText;
}

function applySimpleRule(text: string, rule: PatternRule, session: RedactionSession): string {
  const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
  let result = "";
  let lastIndex = 0;
  let matched = false;

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const raw = match[0];
    if (session.overlapsSentinel(text, index, raw.length)) continue;
    matched = true;
    result += text.slice(lastIndex, index);
    result += session.emit({
      category: rule.category,
      ruleId: rule.id,
      rawMatch: raw,
      placeholder: rule.placeholder,
    });
    lastIndex = index + raw.length;
  }

  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasMixedCharacterClasses(value: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[+/=_-]/.test(value)) classes += 1;
  return classes >= 3;
}

function isLikelyCodeIdentifier(token: string): boolean {
  if (!CAMEL_IDENTIFIER_PATTERN.test(token)) return false;
  if (/[0-9]/.test(token)) return false;
  // Pure alphabetic camelCase/PascalCase identifiers (e.g. handleUpdateProviderInstanceSettings)
  return /[a-z][A-Z]/.test(token);
}

function shouldIgnoreHighEntropyCandidate(
  text: string,
  index: number,
  token: string,
  session: RedactionSession,
): boolean {
  if (session.overlapsSentinel(text, index, token.length)) return true;
  if (UUID_PATTERN.test(token)) return true;
  if (isLikelyCodeIdentifier(token)) return true;
  const before = text.slice(Math.max(0, index - 24), index);
  const after = text.slice(index + token.length, index + token.length + 12);
  if (/(?:sha256|sha384|sha512|integrity)[-:="'\s]*$/i.test(before)) return true;
  if (/https?:\/\/[^\s]*$/i.test(before) && after.startsWith("/")) return true;
  if (GIT_SHA_PATTERN.test(token) && !SECRET_CONTEXT_HINT.test(before)) return true;
  return false;
}

export function redactText(
  input: string,
  options: RedactionOptions,
  collector?: RedactionAuditCollector,
  context?: RedactionContext,
  hostHomeDir: string = NodeOS.homedir(),
): string {
  if (input.length === 0) return input;
  const session = createRedactionSession(input);
  const redactedWithSentinels = redactTextPassPipeline(input, options, session, hostHomeDir);
  return finalizeRedactedText(redactedWithSentinels, session, collector, context);
}

function redactAuthHeaders(text: string, session: RedactionSession): string {
  const regex = new RegExp(AUTH_HEADER_PATTERN.source, AUTH_HEADER_PATTERN.flags);
  let result = "";
  let lastIndex = 0;
  let matched = false;
  const placeholder = "[REDACTED:JWT_BEARER]";

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const prefix = match[1] ?? "";
    const secret = match[2] ?? "";
    if (
      session.overlapsSentinel(text, index, match[0].length) ||
      session.containsSentinel(secret)
    ) {
      continue;
    }
    matched = true;
    result += text.slice(lastIndex, index);
    result += prefix;
    result += session.emit({
      category: "jwt_bearer",
      ruleId: "authorization_header",
      rawMatch: secret,
      placeholder,
    });
    lastIndex = index + match[0].length;
  }
  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function redactWebhookUrlTokens(text: string, session: RedactionSession): string {
  const regex = new RegExp(WEBHOOK_URL_TOKEN.source, WEBHOOK_URL_TOKEN.flags);
  let result = "";
  let lastIndex = 0;
  let matched = false;

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (
      token.length === 0 ||
      token === WITHHELD ||
      session.overlapsSentinel(text, index, match[0].length) ||
      session.containsSentinel(token)
    ) {
      continue;
    }
    matched = true;
    result += text.slice(lastIndex, index);
    result += prefix;
    result += session.emit({
      category: "url_credentials",
      ruleId: "webhook_url_token",
      rawMatch: token,
      placeholder: WITHHELD,
    });
    lastIndex = index + match[0].length;
  }
  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function redactUrlCredentials(text: string, session: RedactionSession): string {
  const regex = new RegExp(URL_CREDENTIAL_PATTERN.source, URL_CREDENTIAL_PATTERN.flags);
  let result = "";
  let lastIndex = 0;
  let matched = false;
  const placeholder = "[REDACTED:USER]:[REDACTED:PASSWORD]";

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const scheme = match[1] ?? "";
    const user = match[2] ?? "";
    const pass = match[3] ?? "";
    if (
      session.overlapsSentinel(text, index, match[0].length) ||
      session.containsSentinel(user) ||
      session.containsSentinel(pass)
    ) {
      continue;
    }
    matched = true;
    result += text.slice(lastIndex, index);
    result += scheme;
    result += session.emit({
      category: "url_credentials",
      ruleId: "url_credentials",
      rawMatch: `${user}:${pass}`,
      placeholder,
    });
    result += "@";
    lastIndex = index + match[0].length;
  }
  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function redactEnvAssignments(text: string, session: RedactionSession): string {
  const regex = new RegExp(ENV_ASSIGNMENT_PATTERN.source, ENV_ASSIGNMENT_PATTERN.flags);
  let result = "";
  let lastIndex = 0;
  let matched = false;
  const placeholder = "[REDACTED:ENV_SECRET]";

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const keyQuote = match[1] ?? "";
    const key = match[2] ?? "";
    const sep = match[3] ?? "=";
    const valQuote = match[4] ?? "";
    const value = match[5] ?? "";
    if (
      session.overlapsSentinel(text, index, match[0].length) ||
      session.containsSentinel(value) ||
      value.startsWith("$") ||
      value === "undefined"
    ) {
      continue;
    }
    matched = true;
    result += text.slice(lastIndex, index);
    result += `${keyQuote}${key}${keyQuote}${sep}${valQuote}`;
    result += session.emit({
      category: "env_assignment",
      ruleId: "env_secret_assignment",
      rawMatch: value,
      placeholder,
    });
    result += valQuote;
    lastIndex = index + match[0].length;
  }
  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function redactHomePaths(
  inputText: string,
  hostHomeDir: string,
  session: RedactionSession,
): string {
  let text = inputText;
  const normalizedHome = hostHomeDir.replace(/\/+$/, "");
  if (
    normalizedHome.length > 1 &&
    !normalizedHome.endsWith("/<user>") &&
    normalizedHome !== "/Users/<user>" &&
    normalizedHome !== "/home/<user>"
  ) {
    const homePlaceholder = normalizedHome.startsWith("/home/")
      ? "/home/<user>"
      : normalizedHome.startsWith("/Users/")
        ? "/Users/<user>"
        : normalizedHome.includes("\\")
          ? "C:\\Users\\<user>"
          : "/home/<user>";
    text = applySimpleRule(
      text,
      {
        id: "host_homedir",
        category: "home_path_username",
        pattern: new RegExp(escapeRegExp(normalizedHome), "g"),
        placeholder: homePlaceholder,
      },
      session,
    );
  }

  for (const [ruleId, pattern, replacement] of [
    ["unix_home_path", UNIX_HOME_PATTERN, "<user>"],
    ["windows_home_path", WIN_HOME_PATTERN, "<user>"],
  ] as const) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let result = "";
    let lastIndex = 0;
    let matched = false;

    for (const match of text.matchAll(regex)) {
      const index = match.index;
      const prefix = match[1] ?? "";
      const username = match[2] ?? "";
      if (
        username === "<user>" ||
        username === "user" ||
        username === "Shared" ||
        session.overlapsSentinel(text, index, match[0].length)
      ) {
        continue;
      }
      matched = true;
      result += text.slice(lastIndex, index);
      const fullReplacement = `${prefix}${replacement}`;
      result += session.emit({
        category: "home_path_username",
        ruleId,
        rawMatch: match[0],
        placeholder: fullReplacement,
      });
      lastIndex = index + match[0].length;
    }
    if (matched) {
      result += text.slice(lastIndex);
      text = result;
    }
  }
  return text;
}

function redactEmails(text: string, session: RedactionSession): string {
  const regex = new RegExp(EMAIL_PATTERN.source, EMAIL_PATTERN.flags);
  let result = "";
  let lastIndex = 0;
  let matched = false;
  const placeholder = "[REDACTED:EMAIL]";

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const email = match[0];
    const lower = email.toLowerCase();
    if (
      session.overlapsSentinel(text, index, email.length) ||
      lower.startsWith("noreply@") ||
      lower.endsWith("@users.noreply.github.com") ||
      lower.endsWith(".noreply.github.com") ||
      text.slice(Math.max(0, index - 10), index + 10).includes("@t3tools/")
    ) {
      continue;
    }
    matched = true;
    result += text.slice(lastIndex, index);
    result += session.emit({
      category: "email_address",
      ruleId: "email_address",
      rawMatch: email,
      placeholder,
    });
    lastIndex = index + email.length;
  }
  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function redactHighEntropyTokens(text: string, session: RedactionSession): string {
  const regex = new RegExp(
    HIGH_ENTROPY_CANDIDATE_PATTERN.source,
    HIGH_ENTROPY_CANDIDATE_PATTERN.flags,
  );
  let result = "";
  let lastIndex = 0;
  let matched = false;
  const placeholder = "[REDACTED:HIGH_ENTROPY_SECRET]";

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const token = match[0];
    if (shouldIgnoreHighEntropyCandidate(text, index, token, session)) continue;
    if (!hasMixedCharacterClasses(token)) continue;
    if (shannonEntropy(token) < 4.5) continue;
    matched = true;
    result += text.slice(lastIndex, index);
    result += session.emit({
      category: "high_entropy_secret",
      ruleId: "high_entropy_token",
      rawMatch: token,
      placeholder,
    });
    lastIndex = index + token.length;
  }
  if (!matched) return text;
  result += text.slice(lastIndex);
  return result;
}

function redactCustomLiterals(
  inputText: string,
  terms: ReadonlyArray<string>,
  session: RedactionSession,
): string {
  let text = inputText;
  const sortedTerms = [...new Set(terms)]
    .filter((term) => term.length > 0)
    .toSorted((a, b) => b.length - a.length);
  for (const term of sortedTerms) {
    text = applySimpleRule(
      text,
      {
        id: "custom_literal",
        category: "high_entropy_secret",
        pattern: new RegExp(escapeRegExp(term), "g"),
        placeholder: "[REDACTED:CUSTOM]",
      },
      session,
    );
  }
  return text;
}

function redactTextPassPipeline(
  input: string,
  options: RedactionOptions,
  session: RedactionSession,
  hostHomeDir: string = NodeOS.homedir(),
): string {
  if (input.length === 0) return input;
  let text = applySimpleRule(input, PEM_RULE, session);

  for (const rule of PROVIDER_AND_CLOUD_RULES) {
    text = applySimpleRule(text, rule, session);
  }

  text = applySimpleRule(
    text,
    {
      id: "jwt_token",
      category: "jwt_bearer",
      pattern: JWT_PATTERN,
      placeholder: "[REDACTED:JWT_BEARER]",
    },
    session,
  );
  text = redactAuthHeaders(text, session);
  text = redactUrlCredentials(text, session);
  text = redactWebhookUrlTokens(text, session);

  if (options.redactEnvAssignments) {
    text = redactEnvAssignments(text, session);
  }
  if (options.redactHomePaths) {
    text = redactHomePaths(text, hostHomeDir, session);
  }
  if (options.redactEmails) {
    text = redactEmails(text, session);
  }
  if (options.redactHighEntropy) {
    text = redactHighEntropyTokens(text, session);
  }
  if (options.customLiteralTerms !== undefined && options.customLiteralTerms.length > 0) {
    text = redactCustomLiterals(text, options.customLiteralTerms, session);
  }

  return text;
}

function sourceKindForMessage(message: TrainingChatMessage): RedactionAuditSourceKind {
  if (message.role === "user") return "user_message";
  if (message.role === "tool") return "tool_output";
  return "assistant_message";
}

function redactChatMessage(
  message: TrainingChatMessage,
  options: RedactionOptions,
  collector: RedactionAuditCollector,
  threadId: ThreadId,
  hostHomeDir?: string,
): TrainingChatMessage {
  const sourceKind = sourceKindForMessage(message);
  const redactedContent =
    message.content === null
      ? null
      : redactText(message.content, options, collector, { threadId, sourceKind }, hostHomeDir);

  const redactedToolCalls = message.tool_calls?.map((call) => ({
    ...call,
    function: {
      ...call.function,
      arguments: redactText(
        call.function.arguments,
        options,
        collector,
        { threadId, sourceKind: "tool_input" },
        hostHomeDir,
      ),
    },
  }));

  return {
    ...message,
    content: redactedContent,
    ...(redactedToolCalls === undefined ? {} : { tool_calls: redactedToolCalls }),
  };
}

export function redactSftRecord(
  record: TrainingSftRecord,
  options: RedactionOptions,
  collector: RedactionAuditCollector,
  threadId: ThreadId,
  hostHomeDir?: string,
): TrainingSftRecord {
  return {
    ...record,
    messages: record.messages.map((message) =>
      redactChatMessage(message, options, collector, threadId, hostHomeDir),
    ),
  };
}

function redactDpoRecord(
  record: TrainingDpoRecord,
  options: RedactionOptions,
  collector: RedactionAuditCollector,
  hostHomeDir?: string,
): TrainingDpoRecord {
  const threadId = record.metadata.sourceThreadId;
  return {
    ...record,
    prompt: record.prompt.map((message) =>
      redactChatMessage(message, options, collector, threadId, hostHomeDir),
    ),
    chosen: record.chosen.map((message) =>
      redactChatMessage(message, options, collector, record.metadata.chosenThreadId, hostHomeDir),
    ),
    rejected: record.rejected.map((message) =>
      redactChatMessage(message, options, collector, record.metadata.rejectedThreadId, hostHomeDir),
    ),
  };
}

export class SecretRedactor extends Context.Service<
  SecretRedactor,
  {
    readonly version: string;
    readonly createCollector: () => RedactionAuditCollector;
    readonly redactText: (input: {
      readonly text: string;
      readonly options: RedactionOptions;
      readonly collector?: RedactionAuditCollector;
      readonly context?: RedactionContext;
    }) => Effect.Effect<string>;
    readonly redactSftRecord: (input: {
      readonly record: TrainingSftRecord;
      readonly options: RedactionOptions;
      readonly collector: RedactionAuditCollector;
      readonly threadId: ThreadId;
    }) => Effect.Effect<TrainingSftRecord>;
    readonly redactDpoRecord: (input: {
      readonly record: TrainingDpoRecord;
      readonly options: RedactionOptions;
      readonly collector: RedactionAuditCollector;
    }) => Effect.Effect<TrainingDpoRecord>;
  }
>()("t3/training/SecretRedactor") {}

export const layer = Layer.succeed(
  SecretRedactor,
  SecretRedactor.of({
    version: REDACTOR_VERSION,
    createCollector: createRedactionAuditCollector,
    redactText: Effect.fn("SecretRedactor.redactText")((input) =>
      Effect.sync(() => redactText(input.text, input.options, input.collector, input.context)),
    ),
    redactSftRecord: Effect.fn("SecretRedactor.redactSftRecord")((input) =>
      Effect.sync(() =>
        redactSftRecord(input.record, input.options, input.collector, input.threadId),
      ),
    ),
    redactDpoRecord: Effect.fn("SecretRedactor.redactDpoRecord")((input) =>
      Effect.sync(() => redactDpoRecord(input.record, input.options, input.collector)),
    ),
  }),
);
