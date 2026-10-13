# Statistical approach

Small evals produce confident-looking numbers that are mostly noise. Every number in the report comes with an
interval or a test, and the README states the noise floor next to the headline.

## Pass rates: Wilson score intervals

Per category and overall, the pass rate is `passes / attempts` with a 95% Wilson interval
(`src/eval/stats.ts`). The usual normal approximation breaks exactly where eval categories live: small n and
rates near 0% or 100% (it can produce intervals like 95% ± 12%, i.e. above 100%). Wilson stays inside [0, 1] and
is well behaved at 0/n and n/n.

Attempts within one case are not independent (the same question three times), so a per-attempt interval is
somewhat too narrow. The case-level numbers (pass^k, flaky cases) and the case-paired comparison below do not
have that problem.

## Noise floor

For a pass rate, the half-width of a 95% interval on a difference you can resolve is roughly `1 / sqrt(n x reps)`
(the skill's eval-audit rule of thumb). With 55 cases and 3 reps that is about **±8 points** overall. Per
category it is much wider: 7 recommendation cases x 3 reps gives a Wilson interval of 60%-92% around 81%.
So: a 3-point change in the overall pass rate is not a finding, and a category moving from 90% to 80% may not
be one either. More cases help more than more reps, because reps of the same case are correlated.

## Consistency across repetitions

For each case with `n` reps and `c` passes:

- **pass@1** = c / n, the expected pass rate of a single try;
- **pass@k** = 1 - C(n-c, k) / C(n, k), the chance that at least one of k tries passes (unbiased estimator from
  Chen et al., 2021). Here k = n = 3, so it is "passed at least once";
- **pass^k** = C(c, k) / C(n, k), the chance that all k tries pass. With k = n this is "passed every time".

pass^k is the number to watch for a user-facing assistant: a patron gets one answer, and a case that passes
two times out of three is wrong one time in three. Cases with 0 < c < n are listed as flaky; the report shows
per-case variance and the gate caps the flaky count.

## Comparing two configurations

`npm run eval:compare` runs both configurations on the same cases (paired design: every case acts as its own
control, which removes case difficulty from the comparison).

- **Effect size:** the mean over cases of (B's per-case pass rate - A's per-case pass rate), with a 95%
  percentile bootstrap interval that resamples cases (10,000 resamples, fixed seed for reproducibility).
- **Significance:** an exact McNemar test on the cases whose majority outcome differs (passes in a strict
  majority of reps in one arm and not in the other). Cases that pass or fail in both arms carry no information
  about the difference; under "no difference" each discordant case is a fair coin, so
  p = 2 x P(X <= min(b, c)) with X ~ Binomial(b + c, 0.5). It is exact, needs no normality assumption, and suits
  a few dozen binary cases.

The bootstrap interval and the McNemar test can disagree on borderline data; the report shows both and calls a
result significant only on the McNemar test (p < 0.05). On the synthetic set, prompt v2 fixes four cases and
breaks one: mean change +4.8 points, bootstrap interval [-2.4, 12.7], McNemar p = 0.375. The honest conclusion
is "consistent with an improvement, not demonstrated". Six fixes and no breaks would be needed for p < 0.05
(p = 0.031); five and none gives p = 0.0625.

That is also why safety behaviour is not left to statistics: the adversarial gate is fail-on-any, so prompt v1
is rejected because two injection cases fail, whatever the p-value says.

Comparing several variants at once (prompt x model x effort) multiplies the chance of a false positive. Decide
the comparison before running it, or correct for multiple tests (Holm) if several are run together.

## Latency and cost

- Latency is the sum of model-call durations in an attempt, timing only the successful attempt of each call
  (retries and backoff excluded, as the skill's checklist asks). The report shows p50 and p95 with linear
  interpolation; with 165 attempts, p95 rests on about 8 observations, so treat it as approximate.
- Cost is computed per call from the response's `usage` block and the served model's prices, never from a flat
  rate. Cache writes and reads are priced separately, and fallback-served turns are priced per model from
  `usage.iterations`. Cost differences between variants are reported as absolute numbers first, and the
  comparison warns when the cache hit ratios differ, because a warm cache makes a variant look cheaper.
