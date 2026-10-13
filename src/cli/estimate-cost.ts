/**
 * npm run eval:estimate-cost -- [--from reports/baseline] [--config eval.config.yaml] [--runs N] [--cases N]
 *
 * Projects the cost of a full run from the token usage of an earlier run and the price table:
 *   cost per attempt = assistant tokens x assistant prices + judge tokens x judge prices
 *   cost per run     = cost per attempt x cases x runs
 * Run it on a small recorded pilot (e.g. `npm run eval -- --record --cases a,b,c,d,e --runs 1 --budget-usd 1`)
 * for a real estimate. On the synthetic replay set the token counts are characters/3.8 guesses, so the result
 * is only an order of magnitude, and the output says so.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { projectCost } from "../eval/costEstimate.js";
import { loadDataset } from "../eval/dataset.js";
import { readExistingResults } from "../eval/runner.js";
import { PRICES } from "../llm/pricing.js";
import { runCli, UsageError } from "./common.js";

runCli(() => {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "eval.config.yaml" },
      from: { type: "string" },
      runs: { type: "string" },
      cases: { type: "string" },
    },
    strict: true,
  });
  const config = loadConfig(values.config);
  const from = values.from ?? join("reports", config.name);
  const attempts = readExistingResults(from);
  if (attempts.length === 0) throw new UsageError(`no results in ${from}; run \`npm run eval\` first (replay is free)`);
  const cases = values.cases === undefined ? loadDataset(config.dataset).length : Number(values.cases);
  const runs = values.runs === undefined ? config.run.runs : Number(values.runs);
  const p = projectCost(attempts, { cases, runs, judgeModel: config.judge.model, sourceModel: config.assistant.model });

  const u = p.meanAssistantUsage;
  const j = p.meanJudgeUsage;
  console.log(`source: ${from} (${p.sourceAttempts} attempts${p.sourceSynthetic ? ", SYNTHETIC token counts = characters / 3.8, not tokenizer counts" : ", measured usage"})`);
  console.log(
    `mean assistant tokens per attempt: ${Math.round(u.input)} uncached in, ${Math.round(u.cacheWrite)} cache write, ${Math.round(u.cacheRead)} cache read, ${Math.round(u.output)} out`,
  );
  console.log(`mean judge tokens per attempt:     ${Math.round(j.input)} uncached in, ${Math.round(j.cacheWrite)} cache write, ${Math.round(j.cacheRead)} cache read, ${Math.round(j.output)} out`);
  console.log(
    `measured cost per attempt in the source run: assistant median $${p.perAttempt.assistant.median.toFixed(4)} (min $${p.perAttempt.assistant.min.toFixed(4)}, max $${p.perAttempt.assistant.max.toFixed(4)}), judge median $${p.perAttempt.judge.median.toFixed(4)}`,
  );
  console.log("");
  console.log(`projection for ${cases} cases x ${runs} reps = ${cases * runs} attempts, judge ${config.judge.model}:`);
  console.log("assistant model        $/attempt   $/run   (prices $/MTok in/out/cache-write/cache-read)");
  for (const r of p.rows) {
    const pr = PRICES[r.assistantModel];
    console.log(
      `${r.assistantModel.padEnd(20)} ${r.perAttemptUsd.toFixed(4).padStart(10)} ${r.perRunUsd.toFixed(2).padStart(7)}   (${pr ? `${pr.input}/${pr.output}/${pr.cacheWrite5m}/${pr.cacheRead}` : "?"})`,
    );
  }
  console.log("");
  console.log("formula: $/run = cases x reps x (sum over usage fields of tokens x price) for assistant + judge; cache writes at the 5-minute rate.");
  console.log("caveats: token counts differ per model (Haiku 5.5 rows scaled by 1.3 for its tokenizer); a cold cache costs more than a warm one; retries add cost.");
  return Promise.resolve(0);
});
