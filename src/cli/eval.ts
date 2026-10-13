/**
 * npm run eval -- [--replay | --record | --live] [--config eval.config.yaml] [--runs N] [--cases id,id]
 *                 [--category name] [--out dir] [--cassettes dir] [--budget-usd X] [--backend fake|http]
 *                 [--no-judge] [--resume] [--concurrency N] [--quiet]
 * Exit codes: 0 all gates pass, 1 a gate failed, 2 the run was aborted or crashed, 64 usage error.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { loadDataset } from "../eval/dataset.js";
import { evaluate, printSummary, writeReports } from "../eval/pipeline.js";
import { buildBackend, buildTransports, loadFixtures, loadTraces, modeFrom, requireBudget, runCli, UsageError } from "./common.js";

runCli(async () => {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "eval.config.yaml" },
      replay: { type: "boolean" },
      record: { type: "boolean" },
      live: { type: "boolean" },
      runs: { type: "string" },
      cases: { type: "string" },
      category: { type: "string" },
      out: { type: "string" },
      cassettes: { type: "string" },
      "budget-usd": { type: "string" },
      backend: { type: "string" },
      "no-judge": { type: "boolean" },
      resume: { type: "boolean" },
      concurrency: { type: "string" },
      quiet: { type: "boolean" },
    },
    strict: true,
  });
  const mode = modeFrom(values);
  const config = loadConfig(values.config);
  if (values["no-judge"]) config.judge.enabled = false;
  const runs = values.runs === undefined ? config.run.runs : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new UsageError("--runs must be a positive integer");
  let cases = loadDataset(config.dataset);
  if (values.cases) {
    const ids = new Set(values.cases.split(",").map((s) => s.trim()));
    cases = cases.filter((c) => ids.has(c.id));
    const missing = [...ids].filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) throw new UsageError(`unknown case id(s): ${missing.join(", ")}`);
  }
  if (values.category) cases = cases.filter((c) => c.category === values.category);
  if (cases.length === 0) throw new UsageError("no cases selected");
  if (values.backend === "http") {
    console.warn("warning: the golden expectations are pinned to fixtures/catalogue.json; against a live library-api, availability cases will differ.");
  }

  const spend = requireBudget(mode, values["budget-usd"]);
  const transports = buildTransports(mode, values.cassettes ?? config.cassettes, spend);
  const catalogue = loadFixtures(config);
  const outDir = values.out ?? join("reports", config.name);
  const quiet = values.quiet === true;
  console.log(`${mode}: ${cases.length} cases x ${runs} reps, config ${config.name}, cassettes ${values.cassettes ?? config.cassettes}, out ${outDir}`);

  const result = await evaluate({
    config,
    cases,
    catalogue,
    backend: buildBackend(values.backend, catalogue),
    assistant: transports.assistant,
    judge: transports.judge,
    runs,
    outDir,
    mode,
    resume: values.resume ?? false,
    ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
    log: (line) => {
      if (!quiet || line.startsWith("ERROR") || line.startsWith("fatal")) console.log(line);
    },
  });
  writeReports(outDir, result, { config, mode, traces: loadTraces(outDir), generatedAt: new Date().toISOString() });
  printSummary(result, outDir);
  if (transports.spend) console.log(`measured spend: $${transports.spend.spentUsd.toFixed(4)} of $${transports.spend.limitUsd.toFixed(2)} budget`);
  if (result.aborted) return 2;
  return result.gates.every((g) => g.pass) ? 0 : 1;
});
