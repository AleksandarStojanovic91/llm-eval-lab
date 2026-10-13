/**
 * Regression gate: compares a run summary against the budgets in the config. Any failed gate makes the CLI
 * exit 1, so CI blocks the change. Gates are absolute thresholds, not "no worse than last run", because the
 * baseline is replayed from cassettes and a relative gate would need a second stored baseline to compare to.
 */
import type { GatesConfig } from "../config.js";
import type { RunSummary } from "./metrics.js";

export interface GateResult {
  name: string;
  pass: boolean;
  actual: string;
  threshold: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function evaluateGates(s: RunSummary, g: GatesConfig): GateResult[] {
  const out: GateResult[] = [];
  const add = (name: string, pass: boolean, actual: string, threshold: string): void => {
    out.push({ name, pass, actual, threshold });
  };

  add("harness errors", s.totals.errors <= g.maxErrors, String(s.totals.errors), `<= ${g.maxErrors}`);
  add("overall pass rate", s.totals.passRate >= g.minPassRate, pct(s.totals.passRate), `>= ${pct(g.minPassRate)}`);
  for (const c of s.categories) {
    const min = g.minCategoryPassRate[c.category] ?? g.minCategoryPassRate.default ?? 0;
    add(`${c.category} pass rate`, c.passRate >= min, pct(c.passRate), `>= ${pct(min)}`);
  }
  for (const cat of g.requireAllRepsPass) {
    const c = s.categories.find((x) => x.category === cat);
    if (c) add(`${cat}: every rep of every case passes`, c.casesAllRepsPass === c.cases, `${c.casesAllRepsPass}/${c.cases} cases`, `${c.cases}/${c.cases}`);
  }
  if (s.judge.enabled && s.judge.allCriteriaPassRate !== null) {
    add("judge pass rate", s.judge.allCriteriaPassRate >= g.minJudgePassRate, pct(s.judge.allCriteriaPassRate), `>= ${pct(g.minJudgePassRate)}`);
  }
  add("flaky cases", s.consistency.flakyCases.length <= g.maxFlakyCases, String(s.consistency.flakyCases.length), `<= ${g.maxFlakyCases}`);
  add("p95 latency per attempt", s.latency.attemptP95Ms <= g.maxLatencyP95Ms, `${Math.round(s.latency.attemptP95Ms)} ms`, `<= ${g.maxLatencyP95Ms} ms`);
  add("cost per run (all reps, judge included)", s.cost.totalUsd <= g.maxCostPerRunUsd, `$${s.cost.totalUsd.toFixed(3)}`, `<= $${g.maxCostPerRunUsd.toFixed(2)}`);
  add("cache hit ratio", s.cacheHitRatio >= g.minCacheHitRatio, pct(s.cacheHitRatio), `>= ${pct(g.minCacheHitRatio)}`);
  add("fallback rate", s.totals.fallbackRate <= g.maxFallbackRate, pct(s.totals.fallbackRate), `<= ${pct(g.maxFallbackRate)}`);
  return out;
}
