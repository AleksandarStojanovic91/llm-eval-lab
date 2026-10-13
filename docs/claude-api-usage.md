# How the project uses the Claude API

Every rule below comes from the Claude API skill bundled with Claude Code (version 2.1.296), read while building
this project: `typescript/claude-api/README.md`, `tool-use.md`, `streaming.md`, and `shared/tool-use-concepts.md`,
`prompt-caching.md`, `token-counting.md`, `models.md`, `model-migration.md`, `evals/build-eval.md`,
`evals/eval-audit.md`. SDK: `@anthropic-ai/sdk` 0.133.0 (latest at the time).

| rule | implementation |
|---|---|
| Default model `claude-opus-5-5`, configurable | `assistant.model` and `judge.model` in `eval.config.yaml`; `configs/sonnet-5-5.yaml`, `configs/haiku-5-5.yaml` |
| Opus 5.5 thinking is always on: omit `thinking` (adaptive); `disabled` or `budget_tokens` return 400 | no `thinking` field in any request (`buildRequest`, `buildJudgeRequest`); asserted in `test/request.test.ts` |
| Set `output_config.effort` explicitly (Opus 5.5 defaults to medium, Sonnet 5.5 to high) | `effort: medium` for assistant and judge |
| `max_tokens` must leave room for thinking | 16,000 for the assistant, 8,000 for the judge; truncation surfaces as `status: truncated` |
| Forced `tool_choice` (`any` / `tool`) returns 400 on Opus 5.5 and Sonnet 5.5 | `tool_choice` omitted (auto); tool descriptions say when to call each tool; the eval measures whether the model called them |
| `strict: true` with `additionalProperties: false`; strict schemas avoid unsupported keywords | `src/assistant/tools.ts`; length limits and UUID format checks live in zod instead |
| Validate tool inputs before running them | zod `safeParse`; invalid input returns an `is_error` tool result with the raw input |
| Check `stop_reason` before running tools: never run tools after `refusal` or `max_tokens` | `runConversation`; tested with a fake transport |
| Return all parallel `tool_result` blocks in one user message, matched by `tool_use_id` | `runConversation`; tested |
| Append the full `response.content`, thinking blocks unchanged | `runConversation`; tested |
| Resume `pause_turn`; cap the loop | handled; `maxToolRounds` |
| Prompt caching: frozen system prompt, deterministic tool order, explicit breakpoint on the system prompt plus top-level automatic caching for the tail | `buildRequest`; tools sorted by name; no dates or ids in the prompt; `test/request.test.ts` asserts a byte-identical prefix across cases |
| Verify `cache_read_input_tokens`, don't assume | cache hit ratio per run in the report and a gate (`minCacheHitRatio`); `npm run cache:check` sends two identical requests live and fails if the second reads nothing |
| Structured outputs for extraction: `messages.parse` + `zodOutputFormat` | the judge (`src/llm/live.ts`, `src/eval/judge.ts`); replay re-validates with the same zod schema |
| Typed SDK errors, never string matching | `isRetryable` / `isFatal` use `Anthropic.RateLimitError`, `InternalServerError`, `APIConnectionError`, `AuthenticationError`, `PermissionDeniedError` |
| Server-side refusal fallback for Opus 5.5: `fallbacks: "default"` with beta header `server-side-fallback-2026-07-01` (the array form uses `-2026-06-01`; mixing them is a 400) | `buildRequest` adds both when `assistant.fallbacks: default`; the config refuses it for Haiku 5.5 (no server-side fallback) and leaves it off for Sonnet 5.5 (not documented in the skill) |
| Branch on `stop_reason`, treat `stop_details` as informational | refusals are recorded with their category, graded by `stop_reason` |
| Detect fallback-served turns (fallback blocks, `usage.iterations` entries of type `fallback_message`) | `usedFallback`; such turns are allowed past the served-model assertion, flagged, priced per model, and gated (`maxFallbackRate: 0`) |
| Cost from `usage` with the current price table; cache writes 1.25x, reads per model (0.05x on Opus 5.5) | `src/llm/pricing.ts`, `test/pricing.test.ts` |
| Token counting uses the API, never `tiktoken` | live runs use `usage` from responses. The synthetic set's counts are labelled character estimates. `client.messages.countTokens` would give exact prompt sizes before a run; not wired in because it needs a key |
| Use SDK types (`Anthropic.Beta.Messages.*`) rather than redefining them; don't mix beta and non-beta | the assistant uses the beta namespace throughout (needed for `fallbacks`); the judge uses the regular namespace |

## Choices that deviate from the skill's defaults, and why

- **Manual tool loop instead of the SDK tool runner.** The skill recommends the tool runner by default and lists
  "a custom transport" as the reason to own the loop. This project needs exactly that: a seam below the SDK call
  for record/replay and for a fake model, plus per-call instrumentation. The loop applies the stop-reason rules
  the runner would leave to the caller anyway.
- **No streaming.** The eval measures the non-streaming path, and `ask` uses the same path so the eval measures
  what runs. If the product streams, set `eager_input_streaming: true` on the tools (the skill's default rule for
  streamed requests with client tools), keep the zod validation, and record a new run; the change alters the tool
  definitions and therefore the cache prefix and the cassette hashes.
- **SDK retries off.** `maxRetries: 0` and a visible retry loop with full jitter, so retries are counted per
  attempt instead of hidden inside the client.
- **Judge on the same model as the assistant.** Specified by the task; the skill advises against it
  (self-preference). Configurable, and listed as an open decision.

## Things to re-check before a live run

- Prices in `src/llm/pricing.ts` (they change).
- That `claude-opus-5-5` still accepts `fallbacks: "default"` with the 2026-07-01 header, and which models it
  falls back to (the skill says to read `allowed_fallback_models` from the model's `/v1/models` entry; expect
  Claude Opus 5 / Opus 4.8, both priced in the table).
- Account age: for accounts created on or after 2026-08-31, Opus 5.5 enforces that replayed thinking blocks sit
  on an unchanged prefix. The loop never edits history, so this should hold; a 400 mentioning the thinking
  binding would mean something rewrote the transcript.
