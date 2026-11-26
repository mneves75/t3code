import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeNoNameBaseUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

const readBoundedText = (
  response: HttpClientResponse.HttpClientResponse,
  path: string,
  root: string,
) => {
  let read = 0;
  return response.stream.pipe(
    Stream.takeWhile((chunk) => {
      read += chunk.length;
      return read <= MAX_RESPONSE_BYTES;
    }),
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(
      (cause) =>
        new NoNameRequestError({
          path,
          detail: `NoName at ${root} did not answer. Start it, or check its address in Settings.`,
          cause,
        }),
    ),
    Effect.filterOrFail(
      () => read <= MAX_RESPONSE_BYTES,
      () =>
        new NoNameRequestError({
          path,
          detail: `NoName at ${root} sent an oversized response.`,
        }),
    ),
  );
};

/**
 * NoName refuses a POST that carries neither an Origin nor this marker
 * ("this request did not come from the chat UI"); its browser page sends it.
 */
const NONAME_UI_HEADER = { "X-Simplex-UI": "1" } as const;

export class NoNameRequestError extends Schema.TaggedError<NoNameRequestError>()(
  "NoNameRequestError",
  {
    path: Schema.String,
    status: Schema.optional(Schema.Number),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const NoNameErrorBody = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    hint: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const decodeNoNameErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(NoNameErrorBody));

/** NoName's error text (and hint) from a failed response body. */
export function noNameErrorText(status: number, body: string): string {
  const decoded = Option.getOrUndefined(decodeNoNameErrorBody(body));
  if (decoded === undefined) return `NoName answered HTTP ${status}.`;
  const hint = decoded.error.hint?.trim();
  return hint ? `${decoded.error.message}. ${hint}` : decoded.error.message;
}

const NoNameProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  models: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  default_model: Schema.optional(Schema.NullOr(Schema.String)),
  off: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export const NoNameModels = Schema.Struct({
  providers: Schema.Array(NoNameProvider),
});
export type NoNameModels = typeof NoNameModels.Type;

export const NoNameHealth = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface NoNameModelChoice {
  /** `<provider id>/<model id>`; the provider id is NoName's and has no slash. */
  readonly value: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** Every model of every provider NoName has switched on, in NoName's order. */
export function noNameModelChoices(models: NoNameModels): ReadonlyArray<NoNameModelChoice> {
  const choices: Array<NoNameModelChoice> = [];
  const seen = new Set<string>();
  for (const provider of models.providers) {
    if (provider.off === true || provider.id.length === 0) continue;
    const listed = [...(provider.models ?? [])];
    if (provider.default_model && !listed.includes(provider.default_model)) {
      listed.unshift(provider.default_model);
    }
    for (const model of listed) {
      const value = `${provider.id}/${model}`;
      if (model.length === 0 || seen.has(value)) continue;
      seen.add(value);
      choices.push({
        value,
        name: `${model} · ${provider.name || provider.id}`,
        isDefault: choices.length === 0,
      });
    }
  }
  return choices;
}

export function splitNoNameModel(
  value: string,
): { readonly provider: string; readonly model: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

const ToolCallEvent = Schema.Struct({
  type: Schema.Literal("tool_call"),
  id: Schema.String,
  name: Schema.String,
  args: Schema.optional(Schema.Unknown),
  label: Schema.optional(Schema.NullOr(Schema.String)),
});
const ApprovalEvent = Schema.Struct({
  type: Schema.Literal("approval"),
  id: Schema.String,
  name: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.Unknown),
  side: Schema.optional(Schema.Unknown),
});
const QuestionEvent = Schema.Struct({
  type: Schema.Literal("question"),
  id: Schema.String,
  question: Schema.String,
  header: Schema.optional(Schema.NullOr(Schema.String)),
  options: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          label: Schema.String,
          description: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  side: Schema.optional(Schema.Unknown),
});
const ToolProgressEvent = Schema.Struct({
  type: Schema.Literal("tool_progress"),
  id: Schema.String,
  parts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Array(Schema.Unknown)))),
});
const ToolResultEvent = Schema.Struct({
  type: Schema.Literal("tool_result"),
  id: Schema.String,
  ok: Schema.Boolean,
  output: Schema.optional(Schema.NullOr(Schema.String)),
  effect: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        kind: Schema.optional(Schema.String),
        target: Schema.optional(Schema.NullOr(Schema.String)),
        diff: Schema.optional(Schema.NullOr(Schema.String)),
        shape: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const PlanEvent = Schema.Struct({
  type: Schema.Literal("plan"),
  items: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
});
const TokensEvent = Schema.Struct({
  type: Schema.Literal("tokens"),
  prompt: Schema.Number,
  generated: Schema.optional(Schema.Number),
});
const SessionEvent = Schema.Struct({
  type: Schema.Literal("session"),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  caps: Schema.optional(
    Schema.NullOr(Schema.Struct({ context_length: Schema.optional(Schema.NullOr(Schema.Number)) })),
  ),
});

export const NoNameEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("content"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), delta: Schema.String }),
  ToolCallEvent,
  ToolProgressEvent,
  ToolResultEvent,
  ApprovalEvent,
  QuestionEvent,
  PlanEvent,
  TokensEvent,
  SessionEvent,
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("done"),
    failed: Schema.optional(Schema.NullOr(Schema.Boolean)),
    cancelled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    error: Schema.optional(Schema.Unknown),
  }),
]);
export type NoNameEvent = typeof NoNameEvent.Type;
const decodeNoNameEvent = Schema.decodeUnknownOption(Schema.fromJsonString(NoNameEvent));

/**
 * One SSE line as a NoName event. Comments, blank lines, and events this
 * bridge has no use for (step, prompt, criteria, …) are dropped.
 */
export function parseNoNameSseLine(line: string): NoNameEvent | undefined {
  if (!line.startsWith("data:")) return undefined;
  return Option.getOrUndefined(decodeNoNameEvent(line.slice(5).trim()));
}

/** The text NoName's `done.error` carries, which is a string or an `{message}` object. */
export function noNameDoneError(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    return typeof message === "string" ? message.trim() || undefined : undefined;
  }
  return undefined;
}

export type NoNameToolKind = "read" | "edit" | "search" | "execute" | "think" | "fetch" | "other";

const TOOL_KINDS: Readonly<Record<string, NoNameToolKind>> = {
  list_dir: "read",
  read_file: "read",
  view_image: "read",
  skill_view: "read",
  load_skill: "read",
  find_files: "search",
  search_text: "search",
  write_file: "edit",
  edit_file: "edit",
  save_skill: "edit",
  run_command: "execute",
  run_python: "execute",
  job_output: "execute",
  job_kill: "execute",
  check_page: "execute",
  web_search: "fetch",
  web_fetch: "fetch",
  update_plan: "think",
  update_criteria: "think",
};

export function noNameToolKind(name: string): NoNameToolKind {
  return TOOL_KINDS[name] ?? "other";
}

export interface NoNameChatInput {
  readonly sessionId: string;
  readonly workspace: string;
  readonly content: string | ReadonlyArray<NoNameContentPart>;
  readonly model: string | undefined;
}

export type NoNameContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export function noNameChatBody(input: NoNameChatInput): Record<string, unknown> {
  const selected = input.model === undefined ? undefined : splitNoNameModel(input.model);
  return {
    session_id: input.sessionId,
    mode: "agent",
    workspace: input.workspace,
    content: input.content,
    ...(selected === undefined ? {} : { provider: selected.provider, model: selected.model }),
  };
}

export interface NoNameClient {
  readonly models: Effect.Effect<NoNameModels, NoNameRequestError>;
  readonly health: Effect.Effect<typeof NoNameHealth.Type, NoNameRequestError>;
  /** The turn's events; the stream ends when NoName closes it after `done`. */
  readonly chat: (input: NoNameChatInput) => Stream.Stream<NoNameEvent, NoNameRequestError>;
  readonly approve: (
    sessionId: string,
    callId: string,
    decision: "allow" | "deny",
  ) => Effect.Effect<void, NoNameRequestError>;
  readonly answer: (
    sessionId: string,
    callId: string,
    text: string,
  ) => Effect.Effect<void, NoNameRequestError>;
  readonly cancel: (sessionId: string) => Effect.Effect<void, NoNameRequestError>;
}

export const makeNoNameClient = Effect.fn("NoNameApi.makeClient")(function* (baseUrl: string) {
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );
  const validatedRoot = normalizeNoNameBaseUrl(baseUrl);
  const root = validatedRoot ?? baseUrl.replace(/\/+$/, "");

  const requireValidUrl = (path: string): Effect.Effect<string, NoNameRequestError> =>
    validatedRoot !== undefined
      ? Effect.succeed(validatedRoot)
      : Effect.fail(
          new NoNameRequestError({
            path,
            detail: "NoName server URL must start with http:// or https://.",
          }),
        );

  const failure = (path: string) => (cause: unknown) =>
    new NoNameRequestError({
      path,
      detail: `NoName at ${root} did not answer. Start it, or check its address in Settings.`,
      cause,
    });

  const checkStatus = (path: string) => (response: HttpClientResponse.HttpClientResponse) =>
    response.status >= 200 && response.status < 300
      ? Effect.succeed(response)
      : readBoundedText(response, path, root).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) =>
            Effect.fail(
              new NoNameRequestError({
                path,
                status: response.status,
                detail: noNameErrorText(response.status, body),
              }),
            ),
          ),
        );

  const getJson = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
    requireValidUrl(path).pipe(
      Effect.flatMap((base) =>
        http.execute(HttpClientRequest.get(`${base}${path}`)).pipe(Effect.mapError(failure(path))),
      ),
      Effect.flatMap(checkStatus(path)),
      Effect.flatMap((response) => readBoundedText(response, path, root)),
      Effect.flatMap((body) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
          Effect.mapError(
            (cause) =>
              new NoNameRequestError({
                path,
                detail: `NoName at ${root} sent an answer this version does not read.`,
                cause,
              }),
          ),
        ),
      ),
    );

  const post = (path: string, body: Record<string, unknown>) =>
    requireValidUrl(path).pipe(
      Effect.flatMap((base) =>
        http
          .execute(
            HttpClientRequest.post(`${base}${path}`).pipe(
              HttpClientRequest.setHeaders(NONAME_UI_HEADER),
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
          )
          .pipe(Effect.mapError(failure(path))),
      ),
      Effect.flatMap(checkStatus(path)),
    );

  const postOk = (path: string, body: Record<string, unknown>) =>
    post(path, body).pipe(
      Effect.flatMap((response) =>
        readBoundedText(response, path, root).pipe(Effect.orElseSucceed(() => "")),
      ),
      Effect.asVoid,
    );

  return {
    models: getJson("/ui/models", NoNameModels),
    health: getJson("/ui/health", NoNameHealth),
    chat: (input) =>
      Stream.unwrap(
        post("/ui/chat", noNameChatBody(input)).pipe(
          Effect.map((response) =>
            response.stream.pipe(
              Stream.mapError(failure("/ui/chat")),
              Stream.decodeText(),
              Stream.splitLines,
              Stream.map(parseNoNameSseLine),
              Stream.filter((event): event is NoNameEvent => event !== undefined),
            ),
          ),
        ),
      ),
    approve: (sessionId, callId, decision) =>
      postOk("/ui/approve", { session_id: sessionId, id: callId, decision }),
    answer: (sessionId, callId, text) =>
      postOk("/ui/answer", { session_id: sessionId, id: callId, text }),
    cancel: (sessionId) => postOk("/ui/cancel", { session_id: sessionId }),
  } satisfies NoNameClient;
});
