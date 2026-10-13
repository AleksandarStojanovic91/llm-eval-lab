/**
 * npm run eval:compare -- [--a configs/prompt-v1.yaml] [--b eval.config.yaml] [--replay|--record|--live]
 *                         [--runs N] [--budget-usd X] [--out reports/compare]
 *
 * Runs both configs on the same cases and reports paired deltas: per-case pass-rate change with a bootstrap CI,
 * an exact McNemar test on cases whose majority outcome flipped, per-category deltas, and absolute cost,
 * latency and token numbers for both arms. Writes B's report with a comparison section, plus comparison.json.
 * Exit 0 unless a run was aborted (2): a comparison informs a decision; the gate lives in `npm run eval`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { compareRuns } from "../eval/compare.js";
import { loadDataset } from "../eval/dataset.js";
import { evaluate, printSummary, writeReports } from "../eval/pipeline.js";
import { buildBackend, buildTransports, loadFixtures, loadTraces, modeFrom, requireBudget, runCli, UsageError } from "./common.js";

runCli(async () => {
  const { values } = parseArgs({
    options: {
      a: { type: "string", default: "configs/prompt-v1.yaml" },
      b: { type: "string", default: "eval.config.yaml" },
      replay: { type: "boolean" },
      record: { type: "boolean" },
      live: { type: "boolean" },
      runs: { type: "string" },
      "budget-usd": { type: "string" },
      out: { type: "string", default: join("reports", "compare") },
      quiet: { type: "boolean" },
    },
    strict: true,
  });
  const mode = modeFrom(values);
  const configA = loadConfig(values.a);
  const configB = loadConfig(values.b);
  if (configA.name === configB.name) throw new UsageError(`both configs are named "${configA.name}"; give them different names`);
  if (configA.dataset !== configB.dataset) throw new UsageError("both configs must use the same dataset for a paired comparison");
  const runs = values.runs === undefined ? Math.min(configA.run.runs, configB.run.runs) : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new UsageError("--runs must be a positive integer");
  const spend = requireBudget(mode, values["budget-usd"]);
  const cases = loadDataset(configA.dataset);

  const results = [];
  for (const config of [configA, configB]) {
    const transports = buildTransports(mode, config.cassettes, spend);
    const catalogue = loadFixtures(config);
    const outDir = join(values.out, config.name);
    console.log(`${mode}: ${config.name} (${config.assistant.model}, prompt ${config.assistant.promptVersion}) -> ${outDir}`);
    const r = await evaluate({
      config,
      cases,
      catalogue,
      backend: buildBackend("fake", catalogue),
      assistant: transports.assistant,
      judge: transports.judge,
      runs,
      outDir,
      mode,
      log: (line) => {
        if (values.quiet !== true || line.startsWith("ERROR")) console.log(line);
      },
    });
    writeReports(outDir, r, { config, mode, traces: loadTraces(outDir), generatedAt: new Date().toISOString() });
    printSummary(r, outDir);
    if (r.aborted) return 2;
    results.push({ config, r, outDir });
  }
  const [A, B] = results;
  if (!A || !B) throw new Error("unreachable");
  const cmp = compareRuns(A.r.summary, B.r.summary);
  const out = values.out;
  writeReports(out, B.r, { config: B.config, mode, traces: loadTraces(B.outDir), comparison: cmp, generatedAt: new Date().toISOString() });
  const { a: _a, b: _b, ...rest } = cmp;
  writeFileSync(join(out, "comparison.json"), `${JSON.stringify({ a: A.config.name, b: B.config.name, ...rest }, null, 2)}\n`);

  console.log("");
  console.log(`comparison ${A.config.name} (A) -> ${B.config.name} (B), ${cmp.pairedCases} paired cases x ${runs} reps`);
  for (const w of cmp.warnings) console.log(`note: ${w}`);
  console.log(
    `mean per-case pass-rate change: ${(cmp.meanDelta * 100).toFixed(1)} points, 95% bootstrap CI [${(cmp.ci.lo * 100).toFixed(1)}, ${(cmp.ci.hi * 100).toFixed(1)}]`,
  );
  console.log(
    `cases fixed by B: ${cmp.fixed.map((c) => c.caseId).join(", ") || "none"}; broken by B: ${cmp.broken.map((c) => c.caseId).join(", ") || "none"}; exact McNemar p = ${cmp.mcnemar.p.toFixed(3)} -> ${cmp.significant ? "significant" : "not significant"} at 0.05`,
  );
  console.log(`cost per run: A $${A.r.summary.cost.totalUsd.toFixed(3)}, B $${B.r.summary.cost.totalUsd.toFixed(3)}`);
  console.log(`report: ${join(out, "report.html")}`);
  return 0;
});
