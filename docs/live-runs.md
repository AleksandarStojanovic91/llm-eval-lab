# Running live with a budget

Live runs call the Claude API and cost money. None has been made yet. This is the procedure for the first one.

## Before spending anything

1. Read the dataset (`datasets/golden/*.yaml`) and the judge rubric (`src/eval/judge.ts`) and approve them, or
   change them. This is the sign-off step of the method; numbers from an unreviewed dataset are not worth paying
   for.
2. Re-check the prices in `src/llm/pricing.ts`.
3. Decide the judge model (see `docs/eval-design.md`, "Self-preference").
4. Get a key with a spend limit set in the Claude Console, and export it: `export ANTHROPIC_API_KEY=...`.
   Never commit it; CI does not need it.

## Steps

```bash
# 1. Two requests (about $0.02-0.05): proves the key works and that prompt caching hits.
npm run cache:check -- --budget-usd 0.20

# 2. Pilot: 5 cases x 1 rep, recorded (about $0.10-0.30).
npm run eval -- --record --config configs/live.yaml --runs 1 --budget-usd 1 \
  --cases lookup-002,rules-004,availability-003,adversarial-002,multi-turn-003

# 3. Read the pilot report and the rows: every attempt should have a model, non-zero usage and a trace.
open reports/baseline/report.html

# 4. Re-estimate the full run from the pilot's measured usage.
npm run eval:estimate-cost -- --from reports/baseline

# 5. Full run: 55 cases x 3 reps, assistant + judge.
npm run eval -- --record --config configs/live.yaml --budget-usd 15

# 6. Judge calibration with the real judge (24 judge calls, about $0.20-0.60).
npm run eval:calibrate-judge -- --record --cassettes cassettes/live --budget-usd 1
```

`--budget-usd` is enforced in code: the run stops before the next request once measured spend reaches it, and
the stop is a fatal harness error, not a model failure. `--resume` continues an interrupted run without paying
again for finished (case, rep) pairs.

## Estimated cost

From the synthetic set's token counts (character estimates, so a ballpark only), one full run of 55 cases x 3
reps with Claude Opus 5.5 as assistant and judge costs about **$3.70**: roughly $0.014 per attempt for the
assistant (mostly output tokens; the shared prompt prefix is read from cache at $0.20 per million) and $0.008
for the judge. Adaptive thinking on real requests may produce several times the synthetic output tokens; at
three times the output, the run costs about **$10**. Hence the suggested $15 budget. With Sonnet 5.5 as the
assistant the projection is about $2.60, with Haiku 5.5 about $1.50 (judge unchanged).

The formula, so the assumption is inspectable:

```
$/run = cases x reps x [ assistant(in x $in + cache_write x $write + cache_read x $read + out x $out)
                       + judge(same fields at the judge's prices) ] / 1,000,000
```

Replace the estimate with the measured number from `reports/baseline/summary.json` after the run.

## After the run

- Re-set the gate thresholds in `eval.config.yaml` from the real numbers (they were set against the synthetic
  set) and keep the adversarial gate at fail-on-any.
- Read every failing transcript and every judge-vs-deterministic disagreement. If more than about one in ten
  failures is a grader mistake, fix the grader before drawing conclusions.
- Commit `cassettes/live/` after reviewing it, so CI can replay real results with `--config configs/live.yaml`.
- Comparisons against other models (`configs/sonnet-5-5.yaml`, `configs/haiku-5-5.yaml`) need their own
  recorded runs; each costs about the same as above or less.
