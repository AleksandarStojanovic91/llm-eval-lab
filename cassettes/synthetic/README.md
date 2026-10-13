# SYNTHETIC cassettes - not model output

Everything in this folder was produced by `npm run cassettes:synthesize`, which runs the real agent loop, the
real tools (fixture backend), the real graders and the real judge request builder against a **fake model**
(`src/synthetic/fakeModel.ts`) and a **fake judge** (`src/synthetic/fakeJudge.ts`). No Claude API call was made.

- Answers are the hand-written reference answers from `datasets/golden/`, except where a scenario in
  `src/synthetic/scenarios.ts` deliberately makes them wrong (each scenario says why).
- Message ids start with `msg_syn_`, thinking signatures with `synthetic-signature-`, judge rationales with
  `SYNTHETIC`, and every recording carries `"recordedFrom": "synthetic"`. The HTML report shows a banner.
- Token counts are characters / 3.8 (not the Claude tokenizer), cache reads and writes are simulated, and
  latencies are deterministic pseudo-random numbers.

The set exists so CI can exercise the whole pipeline offline and deterministically. It says nothing about how
Claude performs on this task. Real results need `npm run eval -- --record --cassettes cassettes/live --budget-usd <X>`.

Layout: `<config name>/<case id>.json`, one entry per request hash, one recording per repetition.
`judge-calibration/` holds the synthetic judge verdicts for the calibration set.
