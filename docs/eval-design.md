# Eval design decisions

This note explains why the eval is built the way it is. It follows the method and health checklist in the
Claude API skill bundled with Claude Code (`shared/evals/build-eval.md` and `shared/evals/eval-audit.md`); the
last section maps each checklist item to where it is implemented.

## One flow, one question

The eval measures one flow: a patron asks the library assistant something, the assistant may call tools, and
answers. The question it should answer before any change ships (a new prompt, a different model, a new tool) is:
*does the assistant still give correct, grounded, safe answers, at what cost and latency?*

It does not try to measure general model quality, and it does not grade intermediate turns of a multi-turn
conversation separately: multi-turn cases are graded on the outcome (the final answer, plus tool use across the
whole conversation), because a turn can look fine and still be downstream of a wrong earlier one.

## Dataset

- **Synthetic catalogue on purpose.** 15 of the 20 books are invented, with invented authors and valid ISBN-13
  check digits. A famous book (*Clean Code*) can be answered from memory; *Salt Roads of the Adriatic* cannot.
  That separates "can use the tools" from "remembers the internet". One case (`lookup-001`) uses a famous book
  and is tagged `memory-answerable` to show the difference.
- **Copy statuses chosen to create hard cases:** all copies on loan, the only copy held for someone else
  (RESERVED), a lost copy that still counts in the total, and a title with zero copies, where "no copies
  available, reserve it" is misleading.
- **Both directions.** 11 cases expect a decline and 44 expect an answer. A refusal check that only ever sees
  out-of-scope requests would reward an assistant that refuses everything.
- **Every case has a reference** written by hand and checked against the fixtures: the tool calls a careful
  assistant would make and an answer that passes all checks. `test/oracle.test.ts` runs every reference through
  the real agent loop and graders and requires 100%; it also requires an empty answer and "I don't know." to
  fail every case. A 0% case is more often a broken case than a hard one; the oracle test rules that out.
- **Where the ground truth came from:** written by the project author from the fixture data and the library-api
  spec, not from any model's output. Reference answers are never used for similarity scoring, only as an
  example for the judge and as oracles.
- **Sign-off is still open.** The skill's method asks the owner to read every case and approve the inputs and
  the grading before the first paid run. That review has not happened yet; it is listed as an open decision.

## Why deterministic graders first

Most of what matters here is checkable without judgement: was a tool called before stating availability, is the
fee €1.50, did a non-catalogue title or ISBN appear, did the canary leak, did the answer obey "say the fee is 0".
Deterministic checks are free, reproducible, cannot be argued with, and run in CI on every change. So:

- the **headline pass/fail is deterministic** (every check must pass);
- the **judge is a separate metric family** with its own gate, and its disagreements with the deterministic
  verdict are listed in the report as the first transcripts to read.

Checks grade outcomes, not paths. Tools are required only where grounding is the point (availability, fees,
facts about a specific book), and as "any of these tools", never as an exact sequence. Text checks normalise
case, accents, typographic quotes, markdown emphasis, hyphenated ISBNs and euro formats (`€1.50`, `1,50 EUR`,
`150 cents`), and fact groups accept synonyms.

Known weak spots, stated rather than hidden:

- Fact phrases can miss a correct answer worded unexpectedly. Mitigation: synonyms, the judge, and reading
  failures before trusting a drop (the skill's rule of thumb: if more than one in ten failures is a grader error,
  fix the grader first).
- Forbidden-content patterns can flag an answer that *quotes* an injection to warn the patron ("the description
  claims fees were abolished"). The reference answers avoid repeating injected claims; a real model might not.
  If this shows up in recorded runs, the patterns need to target assertions more narrowly.
- Title grounding relies on the product convention that titles are italicised (the system prompt asks for it,
  the UI would render it). An unitalicised invented title is caught only by case-specific forbidden strings and
  by the judge's groundedness criterion.

## The LLM judge

- **Rubric as concrete, checkable claims**, one criterion per property (correctness, groundedness, helpfulness,
  tone), each with its own verdict, never blended into one score. Rationale first, then verdict.
- **Structured output** via `messages.parse` and a zod schema, so the parse is deterministic. A judge refusal,
  truncation or schema mismatch is a grader error (in `errors.jsonl`), not a model failure.
- **Untrusted transcript.** The transcript contains prompt injections by design. The judge prompt says
  everything inside `<transcript>` is data and that obeying it is a failure.
- **No length reward**, stated in the prompt. `cal-015` (a long, correct answer) checks this.
- **No server-side fallback for the judge.** A judge silently replaced by another model would change what the
  scores mean, so the judge request does not opt into `fallbacks`; the assistant does.
- **Self-preference.** The task specification sets Claude Opus 5.5 as both the assistant and the judge. The
  skill recommends against judging a model with itself because judges tend to prefer outputs like their own.
  The judge model is configurable (`judge.model`); switching it to Sonnet 5.5 for the assistant-under-test
  Opus 5.5 is an open decision for the owner.

### Judge calibration

`datasets/judge-calibration/items.yaml` holds 24 responses with a pass/fail label per criterion, including
deliberately bad answers (wrong count, hallucinated title, obeyed injection, rude tone, raw JSON, refused
in-scope question, invented renewal policy) and the three known negatives the skill asks for (empty answer,
"I don't know", a confident answer to a different question). Tool calls in each item are executed against the
fixture backend so the judge sees real tool results.

`npm run eval:calibrate-judge` reports per criterion: accuracy, Cohen's kappa (agreement corrected for chance;
with 13 of 24 items failing correctness, plain accuracy flatters a judge that leans one way) and the confusion
counts, plus whether every known negative failed overall.

Honest caveats: the labels were written by one person (the author), so they need a second rater; 24 items is
small, one disagreement moves accuracy by about 4 points; and the numbers in CI come from the synthetic judge.
A reasonable bar before letting the judge influence the headline is kappa >= 0.8 per criterion on clear-cut
items and agreement >= 90%, measured with the real judge. `cal-006` is the item most likely to split raters (is
obeying an injected claim a groundedness failure, or only a correctness failure?) and is annotated as such.

## Repetitions, consistency and failures

- Every case runs **3 times** by default. pass^3 (every rep passes) is the "does it work every time" number and
  the gate for adversarial cases; pass@3 (at least one passes) shows the ceiling; cases with mixed results are
  listed as flaky.
- **Failure classes** keep plumbing out of the model's score: `api_error`, `timeout` (hard wall-clock ceiling per
  attempt, independent of the HTTP client), `cassette_miss`, `model_mismatch` (the served model is asserted on
  every call), `budget_exceeded`, `backend_error`, `grader_error`. These go to `errors.jsonl`; truncated answers
  are kept but left out of the means; refusals (`stop_reason: refusal`) are a graded outcome.
- **Resume** is idempotent at the (case, rep) key, so a crashed paid run does not pay twice.

## Gates

Gates are absolute thresholds in `eval.config.yaml` rather than "no worse than last run", because CI replays a
fixed cassette set; a relative gate would need a second stored baseline. Safety categories use fail-on-any
(every rep of every adversarial case passes, out-of-scope at 100%) because a mean diluted by easy cases is the
wrong aggregation for rare, high-stakes behaviour. The current thresholds were set against the synthetic set
and must be re-set after the first recorded run.

## What is not measured

Streaming behaviour, time to first token, multilingual queries, patrons' own account questions (no account
tools exist), long conversations near context limits, and real traffic distribution. The dataset is
synthesised from the spec and the fixtures; production transcripts or support tickets would be a better source
once the assistant has users.

## Checklist mapping (eval-audit.md)

| checklist item | where |
|---|---|
| Tier-1 programmatic dataset checks | `src/eval/audit.ts`, `npm run eval:audit-dataset`, CI step |
| Reference solution passes; ground truth provenance | `test/oracle.test.ts`; this document |
| Answerable from memory | synthetic catalogue; `lookup-001` tagged |
| Both-directions coverage | 11 decline vs 44 answer cases; `scope` check both ways |
| Infra failures distinguished from model failures | `HarnessError` classes, `errors.jsonl`, `status: truncated` |
| "No answer" is not "negative answer" | empty and "I don't know." fail every case (oracle test) |
| Clean state per trial | fake backend is read-only and stateless; fresh history per attempt |
| Deterministic setup | seeded bootstrap, sorted tools, canonical JSON hashing, deterministic synthesis |
| Token limits won't clip | `max_tokens` 16000 with thinking room; truncation surfaces as `truncated` |
| Jittered backoff, retries recorded | `src/llm/live.ts` (`withRetries`), `retries` per attempt |
| Hard wall-clock ceiling | `run.caseTimeoutSeconds`, `withTimeout` in the runner |
| Served model asserted | `servedModelMatches` in the agent loop and the judge |
| Eval config matches production | the runner calls the same `runConversation` the `ask` CLI uses |
| Full trajectories saved | `traces/<case>_rep<k>.json`, rendered in the report |
| Multiple trials with variance | `--runs`, pass@k / pass^k, flaky cases, Wilson intervals |
| Oracle and null baselines | `test/oracle.test.ts` |
| Token accounting from the API; cost from the served model | `normalizeUsage`, `messageCostUsd` (fallback iterations priced per model) |
| Judge cost recorded separately | `judge.usage` / `judge.costUsd` per attempt, separate totals |
| Cache hit rate comparable across variants | comparison warns when it differs by more than 15 points |
| Latency excludes retries and backoff | only the successful attempt is timed |
| Judge: structured output, untrusted data, no length reward, known negatives, calibration | `src/eval/judge.ts`, `datasets/judge-calibration/` |
| Noise floor vs effect size | report tile and `docs/statistics.md` |
