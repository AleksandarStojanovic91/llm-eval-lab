/**
 * Run -> summarise -> gate -> write reports. Shared by `eval`, `eval:compare` and the cassette synthesiser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPTS } from "../assistant/prompts.js";
import type { LibraryBackend } from "../backends/types.js";
import type { Catalogue } from "../catalogue/catalogue.js";
import type { EvalConfig } from "../config.js";
import type { AssistantMessage, AssistantParams, JudgeMessage, JudgeParams, Transport } from "../llm/transport.js";
import { renderReport } from "../report/html.js";
import { renderJunit } from "../report/junit.js";
import type { ComparisonResult } from "./compare.js";
import type { GoldenCase } from "./dataset.js";
import { evaluateGates, type GateResult } from "./gates.js";
import { summarize, type RunSummary } from "./metrics.js";
import { runEval } from "./runner.js";
import type { AttemptError, AttemptRecord } from "./types.js";

export interface EvaluateOptions {
  config: EvalConfig;
  cases: GoldenCase[];
  catalogue: Catalogue;
  backend: LibraryBackend;
  assistant: Transport<AssistantParams, AssistantMessage>;
  judge?: Transport<JudgeParams, JudgeMessage>;
  runs: number;
  outDir: string;
  mode: string;
  resume?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface EvaluateResult {
  summary: RunSummary;
  gates: GateResult[];
  attempts: AttemptRecord[];
  errors: AttemptError[];
  aborted: boolean;
}

export async function evaluate(o: EvaluateOptions): Promise<EvaluateResult> {
  const run = await runEval({
    config: o.config,
    cases: o.cases,
    catalogue: o.catalogue,
    backend: o.backend,
    assistantTransport: o.assistant,
    ...(o.judge && o.config.judge.enabled ? { judgeTransport: o.judge } : {}),
    runs: o.runs,
    concurrency: o.concurrency ?? o.config.run.concurrency,
    outDir: o.outDir,
    resume: o.resume ?? false,
    ...(o.log ? { log: o.log } : {}),
  });
  const summary = summarize(o.config, run.attempts, run.errors, o.runs);
  const gates = evaluateGates(summary, o.config.gates);
  return { summary, gates, attempts: run.attempts, errors: run.errors, aborted: run.aborted };
}

export function writeReports(
  outDir: string,
  r: EvaluateResult,
  meta: { config: EvalConfig; mode: string; traces: Parameters<typeof renderReport>[0]["traces"]; comparison?: ComparisonResult; generatedAt: string },
): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify({ generatedAt: meta.generatedAt, mode: meta.mode, summary: r.summary, gates: r.gates, aborted: r.aborted }, null, 2)}\n`,
  );
  writeFileSync(join(outDir, "junit.xml"), renderJunit(r.summary, r.attempts));
  const thresholds: Record<string, number> = {};
  for (const c of r.summary.categories) {
    thresholds[c.category] = meta.config.gates.minCategoryPassRate[c.category] ?? meta.config.gates.minCategoryPassRate.default ?? 0;
  }
  writeFileSync(
    join(outDir, "report.html"),
    renderReport({
      summary: r.summary,
      gates: r.gates,
      attempts: r.attempts,
      errors: r.errors,
      traces: meta.traces,
      systemPrompt: SYSTEM_PROMPTS[meta.config.assistant.promptVersion],
      mode: meta.mode,
      generatedAt: meta.generatedAt,
      categoryThresholds: thresholds,
      ...(meta.comparison ? { comparison: meta.comparison } : {}),
      ...(r.aborted ? { notes: ["The run was aborted by a fatal error (credentials or budget). Results are partial."] } : {}),
    }),
  );
}

export function printSummary(r: EvaluateResult, outDir: string): void {
  const s = r.summary;
  const pct = (x: number | null): string => (x === null || Number.isNaN(x) ? "-" : `${(x * 100).toFixed(1)}%`);
  console.log("");
  if (s.provenance.synthetic) console.log("NOTE: SYNTHETIC replay data - these numbers exercise the pipeline, they are not model results.");
  console.log(`${s.configName}: ${s.assistantModel} prompt ${s.promptVersion}, ${s.totals.cases} cases x ${s.runs} reps`);
  console.log(
    `pass rate ${pct(s.totals.passRate)} (95% CI ${pct(s.totals.passRateCi.lo)}-${pct(s.totals.passRateCi.hi)}), pass^${s.consistency.k} ${pct(s.consistency.passHatK)}, flaky ${s.consistency.flakyCases.length}, judge ${pct(s.judge.allCriteriaPassRate)}`,
  );
  for (const c of s.categories) console.log(`  ${c.category.padEnd(15)} ${pct(c.passRate).padStart(6)}  (${c.passes}/${c.attempts})`);
  console.log(
    `cost $${s.cost.totalUsd.toFixed(4)} (assistant $${s.cost.assistantUsd.toFixed(4)}, judge $${s.cost.judgeUsd.toFixed(4)}), latency p50 ${Math.round(s.latency.attemptP50Ms)} ms / p95 ${Math.round(s.latency.attemptP95Ms)} ms, cache hit ${pct(s.cacheHitRatio)}, errors ${s.totals.errors}`,
  );
  const failed = r.gates.filter((g) => !g.pass);
  console.log(failed.length ? `GATE FAILED: ${failed.map((g) => `${g.name} (${g.actual}, needs ${g.threshold})`).join("; ")}` : "all gates pass");
  console.log(`report: ${join(outDir, "report.html")}`);
}
