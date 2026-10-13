/**
 * Aggregates attempts into the run summary: pass rates with Wilson intervals, consistency across repetitions,
 * latency percentiles, tokens, cost and cache hit ratio. Every number here is recomputed from the per-attempt
 * records, so the headline can always be re-derived from results.jsonl (eval-audit.md section 5).
 */
import { CATEGORIES, type Category, type EvalConfig } from "../config.js";
import { addUsage, promptTokens, ZERO_USAGE, type TokenUsage } from "../llm/pricing.js";
import { JUDGE_CRITERIA, type JudgeCriterion } from "./judge.js";
import { mean, noiseFloor, passAtK, passHatK, percentile, variance, wilson, type Interval } from "./stats.js";
import type { AttemptError, AttemptRecord } from "./types.js";

export interface CaseStats {
  caseId: string;
  category: Category;
  difficulty: string;
  tags: string[];
  reps: number;
  passes: number;
  passRate: number;
  flaky: boolean;
  judgePasses: number;
  judged: number;
  failingChecks: string[];
}

export interface CategoryStats {
  category: Category;
  cases: number;
  attempts: number;
  passes: number;
  passRate: number;
  ci: Interval;
  casesAllRepsPass: number;
  judgePassRate: number | null;
}

export interface RunSummary {
  configName: string;
  description: string;
  assistantModel: string;
  promptVersion: string;
  judgeModel: string | null;
  runs: number;
  provenance: { synthetic: boolean; live: boolean; sources: string[] };
  totals: {
    cases: number;
    attempts: number;
    scored: number;
    truncated: number;
    passes: number;
    passRate: number;
    passRateCi: Interval;
    noiseFloor: number;
    errors: number;
    errorsByClass: Record<string, number>;
    refusals: number;
    fallbackRate: number;
    retries: number;
  };
  consistency: {
    k: number;
    passAt1: number;
    passAtK: number;
    passHatK: number;
    meanCaseVariance: number;
    flakyCases: string[];
  };
  categories: CategoryStats[];
  cases: CaseStats[];
  judge: {
    enabled: boolean;
    judged: number;
    allCriteriaPassRate: number | null;
    criteria: Record<JudgeCriterion, number | null>;
    /** Attempts where the judge and the deterministic graders disagree on overall pass/fail. */
    disagreements: { caseId: string; rep: number; deterministic: boolean; judge: boolean }[];
  };
  latency: { attemptP50Ms: number; attemptP95Ms: number; attemptMeanMs: number };
  tokens: { assistant: TokenUsage; judge: TokenUsage; meanPerAttempt: TokenUsage };
  cost: {
    assistantUsd: number;
    judgeUsd: number;
    totalUsd: number;
    perAttemptUsd: number;
    /** Average cost of one pass over the whole dataset (all cases once), assistant + judge. */
    perDatasetPassUsd: number;
  };
  cacheHitRatio: number;
}

function sumUsage(us: TokenUsage[]): TokenUsage {
  return us.reduce((a, b) => addUsage(a, b), ZERO_USAGE);
}

export function summarize(config: EvalConfig, attempts: AttemptRecord[], errors: AttemptError[], runs: number): RunSummary {
  const scored = attempts.filter((a) => a.status === "ok");
  const passes = scored.filter((a) => a.pass).length;
  const byCase = new Map<string, AttemptRecord[]>();
  for (const a of scored) byCase.set(a.caseId, [...(byCase.get(a.caseId) ?? []), a]);

  const cases: CaseStats[] = [...byCase.entries()]
    .map(([caseId, list]) => {
      const first = list[0];
      if (!first) throw new Error("unreachable: empty case group");
      const p = list.filter((a) => a.pass).length;
      const judged = list.filter((a) => a.judge);
      return {
        caseId,
        category: first.category,
        difficulty: first.difficulty,
        tags: first.tags,
        reps: list.length,
        passes: p,
        passRate: p / list.length,
        flaky: p > 0 && p < list.length,
        judgePasses: judged.filter((a) => a.judge?.pass).length,
        judged: judged.length,
        failingChecks: [...new Set(list.flatMap((a) => a.checks.filter((c) => !c.pass).map((c) => c.id)))],
      };
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));

  const k = Math.min(runs, ...cases.map((c) => c.reps));
  const categories: CategoryStats[] = CATEGORIES.filter((cat) => cases.some((c) => c.category === cat)).map((cat) => {
    const list = scored.filter((a) => a.category === cat);
    const p = list.filter((a) => a.pass).length;
    const catCases = cases.filter((c) => c.category === cat);
    const judged = list.filter((a) => a.judge);
    return {
      category: cat,
      cases: catCases.length,
      attempts: list.length,
      passes: p,
      passRate: list.length ? p / list.length : Number.NaN,
      ci: wilson(p, list.length),
      casesAllRepsPass: catCases.filter((c) => c.passes === c.reps).length,
      judgePassRate: judged.length ? judged.filter((a) => a.judge?.pass).length / judged.length : null,
    };
  });

  const judged = scored.filter((a) => a.judge);
  const criteria = Object.fromEntries(
    JUDGE_CRITERIA.map((c) => [c, judged.length ? judged.filter((a) => a.judge?.verdicts[c].verdict === "pass").length / judged.length : null]),
  ) as Record<JudgeCriterion, number | null>;

  const assistantUsage = sumUsage(attempts.map((a) => a.usage));
  const judgeUsage = sumUsage(attempts.flatMap((a) => (a.judge ? [a.judge.usage] : [])));
  const assistantUsd = attempts.reduce((s, a) => s + a.costUsd, 0);
  const judgeUsd = attempts.reduce((s, a) => s + (a.judge?.costUsd ?? 0), 0);
  const latencies = attempts.map((a) => a.latencyMs);
  const errorsByClass: Record<string, number> = {};
  for (const e of errors) errorsByClass[e.failureClass] = (errorsByClass[e.failureClass] ?? 0) + 1;
  const sources = [...new Set(attempts.map((a) => a.provenance))].sort();
  const repsCompleted = runs > 0 ? attempts.length / Math.max(1, cases.length) : 0;

  return {
    configName: config.name,
    description: config.description,
    assistantModel: config.assistant.model,
    promptVersion: config.assistant.promptVersion,
    judgeModel: config.judge.enabled ? config.judge.model : null,
    runs,
    provenance: { synthetic: sources.includes("replay:synthetic") || sources.includes("fake"), live: sources.some((s) => s === "live" || s === "replay:live"), sources },
    totals: {
      cases: cases.length,
      attempts: attempts.length,
      scored: scored.length,
      truncated: attempts.length - scored.length,
      passes,
      passRate: scored.length ? passes / scored.length : Number.NaN,
      passRateCi: wilson(passes, scored.length),
      noiseFloor: noiseFloor(cases.length, k),
      errors: errors.length,
      errorsByClass,
      refusals: attempts.filter((a) => a.conversationStatus === "refusal").length,
      fallbackRate: attempts.length ? attempts.filter((a) => a.fallbackUsed).length / attempts.length : 0,
      retries: attempts.reduce((s, a) => s + a.retries, 0),
    },
    consistency: {
      k,
      passAt1: mean(cases.map((c) => c.passRate)),
      passAtK: mean(cases.map((c) => passAtK(c.reps, c.passes, k))),
      passHatK: mean(cases.map((c) => passHatK(c.reps, c.passes, k))),
      meanCaseVariance: mean(cases.map((c) => variance(Array.from({ length: c.reps }, (_, i) => (i < c.passes ? 1 : 0))))),
      flakyCases: cases.filter((c) => c.flaky).map((c) => c.caseId),
    },
    categories,
    cases,
    judge: {
      enabled: config.judge.enabled,
      judged: judged.length,
      allCriteriaPassRate: judged.length ? judged.filter((a) => a.judge?.pass).length / judged.length : null,
      criteria,
      disagreements: judged
        .filter((a) => a.judge?.pass !== a.pass)
        .map((a) => ({ caseId: a.caseId, rep: a.rep, deterministic: a.pass, judge: a.judge?.pass ?? false })),
    },
    latency: {
      attemptP50Ms: percentile(latencies, 50),
      attemptP95Ms: percentile(latencies, 95),
      attemptMeanMs: mean(latencies),
    },
    tokens: {
      assistant: assistantUsage,
      judge: judgeUsage,
      meanPerAttempt: {
        input: attempts.length ? assistantUsage.input / attempts.length : 0,
        output: attempts.length ? assistantUsage.output / attempts.length : 0,
        cacheWrite: attempts.length ? assistantUsage.cacheWrite / attempts.length : 0,
        cacheRead: attempts.length ? assistantUsage.cacheRead / attempts.length : 0,
      },
    },
    cost: {
      assistantUsd,
      judgeUsd,
      totalUsd: assistantUsd + judgeUsd,
      perAttemptUsd: attempts.length ? (assistantUsd + judgeUsd) / attempts.length : 0,
      perDatasetPassUsd: repsCompleted > 0 ? (assistantUsd + judgeUsd) / repsCompleted : 0,
    },
    cacheHitRatio: promptTokens(assistantUsage) ? assistantUsage.cacheRead / promptTokens(assistantUsage) : 0,
  };
}
