/**
 * Projected cost of a run, computed from the token usage of an earlier run (a pilot) and the price table.
 * The skill's guidance is to estimate only from measured usage; when the source run is the synthetic replay
 * set the token counts are themselves estimates (characters / 3.8), and the output says so.
 */
import { CANDIDATE_MODELS, costUsd, type TokenUsage } from "../llm/pricing.js";
import { mean, percentile } from "./stats.js";
import type { AttemptRecord } from "./types.js";

export interface CostProjection {
  sourceAttempts: number;
  sourceSynthetic: boolean;
  cases: number;
  runs: number;
  perAttempt: { assistant: { median: number; min: number; max: number }; judge: { median: number; min: number; max: number } };
  meanAssistantUsage: TokenUsage;
  meanJudgeUsage: TokenUsage;
  rows: { assistantModel: string; judgeModel: string; perAttemptUsd: number; perRunUsd: number }[];
}

function meanUsage(us: TokenUsage[]): TokenUsage {
  return {
    input: mean(us.map((u) => u.input)) || 0,
    output: mean(us.map((u) => u.output)) || 0,
    cacheWrite: mean(us.map((u) => u.cacheWrite)) || 0,
    cacheRead: mean(us.map((u) => u.cacheRead)) || 0,
  };
}

/**
 * Token counts are model-specific (Haiku 5.5's tokenizer counts about 30% more tokens for the same text,
 * per the skill), so projecting one model's usage onto another is approximate. Haiku rows apply that factor.
 */
const TOKENIZER_FACTOR: Record<string, number> = { "claude-haiku-5-5": 1.3 };

export function projectCost(attempts: AttemptRecord[], opts: { cases: number; runs: number; judgeModel: string; sourceModel: string }): CostProjection {
  const a = attempts.map((x) => x.usage);
  const j = attempts.flatMap((x) => (x.judge ? [x.judge.usage] : []));
  const aCost = attempts.map((x) => x.costUsd);
  const jCost = attempts.flatMap((x) => (x.judge ? [x.judge.costUsd] : []));
  const spread = (xs: number[]): { median: number; min: number; max: number } => ({
    median: percentile(xs, 50) || 0,
    min: xs.length ? Math.min(...xs) : 0,
    max: xs.length ? Math.max(...xs) : 0,
  });
  const ma = meanUsage(a);
  const mj = meanUsage(j);
  const scale = (u: TokenUsage, f: number): TokenUsage => ({ input: u.input * f, output: u.output * f, cacheWrite: u.cacheWrite * f, cacheRead: u.cacheRead * f });
  const rows = CANDIDATE_MODELS.map((model) => {
    const f = (TOKENIZER_FACTOR[model] ?? 1) / (TOKENIZER_FACTOR[opts.sourceModel] ?? 1);
    const perAttempt = costUsd(scale(ma, f), model) + (j.length ? costUsd(mj, opts.judgeModel) : 0);
    return { assistantModel: model, judgeModel: opts.judgeModel, perAttemptUsd: perAttempt, perRunUsd: perAttempt * opts.cases * opts.runs };
  });
  return {
    sourceAttempts: attempts.length,
    sourceSynthetic: attempts.some((x) => x.provenance === "replay:synthetic" || x.provenance === "fake"),
    cases: opts.cases,
    runs: opts.runs,
    perAttempt: { assistant: spread(aCost), judge: spread(jCost) },
    meanAssistantUsage: ma,
    meanJudgeUsage: mj,
    rows,
  };
}
