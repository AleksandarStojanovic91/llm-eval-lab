/**
 * Paired comparison of two runs on the same dataset (prompt v1 vs v2, or model A vs model B).
 *
 *  - Effect size: mean of per-case pass-rate differences (B - A), each case's rate averaged over its reps,
 *    with a percentile bootstrap CI that resamples cases (pairing is kept: a case is resampled with both arms).
 *  - Significance: exact McNemar test on the cases whose majority outcome differs between A and B. It only
 *    uses discordant cases and makes no normality assumption, which suits 40-60 binary cases.
 *  - "Significant" requires p < 0.05. With ~55 cases a handful of flips is often not significant; the report
 *    says so instead of rounding a hunch up to a result. Safety categories are protected by hard gates anyway.
 */
import { CATEGORIES } from "../config.js";
import type { RunSummary } from "./metrics.js";
import { bootstrapMeanCi, mcnemarExact, type Interval } from "./stats.js";

export interface CaseDelta {
  caseId: string;
  category: string;
  aRate: number;
  bRate: number;
  delta: number;
}

export interface ComparisonResult {
  a: RunSummary;
  b: RunSummary;
  pairedCases: number;
  missingInA: string[];
  missingInB: string[];
  meanDelta: number;
  ci: Interval;
  mcnemar: { onlyAPasses: number; onlyBPasses: number; p: number };
  significant: boolean;
  categories: { category: string; aRate: number; bRate: number; delta: number }[];
  fixed: CaseDelta[];
  broken: CaseDelta[];
  changed: CaseDelta[];
  cacheHitGap: number;
  warnings: string[];
}

/** A case "passes" at the case level when a strict majority of its reps pass. */
export function majorityPass(rate: number): boolean {
  return rate > 0.5;
}

export function compareRuns(a: RunSummary, b: RunSummary, alpha = 0.05): ComparisonResult {
  const aCases = new Map(a.cases.map((c) => [c.caseId, c]));
  const bCases = new Map(b.cases.map((c) => [c.caseId, c]));
  const paired: CaseDelta[] = [];
  for (const [id, ca] of aCases) {
    const cb = bCases.get(id);
    if (!cb) continue;
    paired.push({ caseId: id, category: ca.category, aRate: ca.passRate, bRate: cb.passRate, delta: cb.passRate - ca.passRate });
  }
  paired.sort((x, y) => x.caseId.localeCompare(y.caseId));
  const diffs = paired.map((p) => p.delta);
  const fixed = paired.filter((p) => !majorityPass(p.aRate) && majorityPass(p.bRate));
  const broken = paired.filter((p) => majorityPass(p.aRate) && !majorityPass(p.bRate));
  const p = mcnemarExact(broken.length, fixed.length);
  const warnings: string[] = [];
  const cacheHitGap = Math.abs(a.cacheHitRatio - b.cacheHitRatio);
  if (cacheHitGap > 0.15) {
    warnings.push(
      `Cache hit ratio differs by ${(cacheHitGap * 100).toFixed(0)} points between the runs, so part of the cost/latency difference may come from cache state, not from the change.`,
    );
  }
  if (a.provenance.synthetic || b.provenance.synthetic) {
    warnings.push("At least one run replays SYNTHETIC cassettes. The deltas exercise the pipeline; they are not evidence about real model behaviour.");
  }
  if (a.runs !== b.runs) warnings.push(`The runs used different repetition counts (${a.runs} vs ${b.runs}).`);
  const categories = CATEGORIES.filter((cat) => a.categories.some((c) => c.category === cat) || b.categories.some((c) => c.category === cat)).map(
    (cat) => {
      const ca = a.categories.find((c) => c.category === cat);
      const cb = b.categories.find((c) => c.category === cat);
      const aRate = ca?.passRate ?? Number.NaN;
      const bRate = cb?.passRate ?? Number.NaN;
      return { category: cat, aRate, bRate, delta: bRate - aRate };
    },
  );
  const sum = diffs.reduce((s, d) => s + d, 0);
  return {
    a,
    b,
    pairedCases: paired.length,
    missingInA: [...bCases.keys()].filter((id) => !aCases.has(id)),
    missingInB: [...aCases.keys()].filter((id) => !bCases.has(id)),
    meanDelta: paired.length ? sum / paired.length : Number.NaN,
    ci: bootstrapMeanCi(diffs),
    mcnemar: { onlyAPasses: broken.length, onlyBPasses: fixed.length, p },
    significant: p < alpha,
    categories,
    fixed,
    broken,
    changed: paired.filter((x) => x.delta !== 0),
    cacheHitGap,
    warnings,
  };
}
