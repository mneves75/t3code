# Local coding eval

Runs `openai` (direct OpenAI-compatible `/v1/chat/completions` tool loop), `pi`, `opencode`, or `codex` against an explicitly selected local inference endpoint (`mlx_lm.server`, Ollama, llama.cpp, TensorFold, or T3's inference gateway) and grades the resulting Git diff and tests. Each sample has a fresh temporary repository, `HOME`, provider configuration, and session state. No user database is opened and no cloud fallback is configured.

```bash
pnpm local-coding --out runs/baseline --model served-model-id \
  --base-url http://127.0.0.1:8080/v1 --harness openai --samples 3
```

Options:

- `--out <dir>` (required): output directory for `results.ndjson` and `summary.json`.
- `--model <id>` (required): exact model ID served by the local endpoint.
- `--base-url <url>` (required): explicit `http://` or `https://` endpoint (trailing slashes are stripped; bare `http://host:port` normalizes to `http://host:port/v1`).
- `--harness <pi|opencode|codex|openai>`: harness to run (default `pi`). Use `openai` for direct `/v1/chat/completions` against `mlx_lm.server` or any OpenAI-compatible server without requiring an external CLI.
- `--case <id1,id2>`: comma-separated subset of case IDs.
- `--samples <n>`: samples per case (default `1`).
- `--reasoning <off|low|medium|high|...>`: reasoning effort (default `low` for CLI harnesses, omitted by default for `openai` unless set and not `off`).
- `--api <chat|responses>`: wire API for Codex (default `chat`).
- `--api-key <key>`: optional bearer token (falls back to `LOCAL_EVAL_API_KEY`; omitted by default for `openai` so keyless servers such as `mlx_lm.server` receive no `Authorization` header).
- `--max-steps <n>`: maximum model turns per sample for `--harness openai` (default `12`).
- `--timeout <ms>`: per-sample timeout in milliseconds (default `600000`).

Pi writes its isolated `models.json` inside the disposable `PI_CODING_AGENT_DIR` (and exports `EVAL_MODELS_JSON`) and never touches the user's Pi configuration.

The twelve deterministic fixtures cover focused bug fixes, tests, refactors, project instructions, multi-file edits, secret handling, and an unsupported-capability refusal. They are real edits in disposable Git repositories, not simulated model runs. All test fixtures use Python's standard library (`unittest`) only; no package manager or network is needed to grade them.

Results are appended per run to `results.ndjson`; `summary.json` records the Git revision, harness, harness version, model, base URL, case/sample/run/pass/failure counts, `passRate`, and `passedCases`. Records contain a bounded reply excerpt used for unsupported-capability grading, not raw private prompt/response/header logs.
