/**
 * npm run eval:calibrate-judge -- [--replay|--record|--live] [--config eval.config.yaml] [--budget-usd X]
 *                                 [--min-kappa 0.6] [--out reports/judge-calibration]
 *
 * Runs the configured judge on datasets/judge-calibration/items.yaml and reports judge-vs-human agreement per
 * criterion (accuracy, Cohen's kappa, confusion counts), overall, and on the known-negative probes.
 * Exit 1 if any known negative passes or (with --min-kappa) a criterion's kappa is below the floor.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FakeLibraryBackend } from "../backends/fake.js";
import { loadConfig } from "../config.js";
import { computeAgreement, loadCalibration, runCalibration, type CalibrationReport, type CriterionAgreement } from "../eval/calibration.js";
import { JUDGE_CRITERIA } from "../eval/judge.js";
import { buildTransports, loadFixtures, modeFrom, requireBudget, runCli } from "./common.js";

function fmt(a: CriterionAgreement): string {
  const c = a.confusion;
  return `| ${(a.accuracy * 100).toFixed(0)}% | ${Number.isNaN(a.kappa) ? "–" : a.kappa.toFixed(2)} | ${c.passPass} | ${c.passFail} | ${c.failPass} | ${c.failFail} |`;
}

function markdown(r: CalibrationReport): string {
  const lines = [
    `# Judge calibration: ${r.judgeModel}`,
    "",
    r.synthetic
      ? "> SYNTHETIC: these verdicts come from the fake judge in src/synthetic/, not from Claude. They show that the calibration script works; they say nothing about the real judge. Run with --record to measure the real one."
      : "> Judge verdicts recorded from the Claude API.",
    "",
    `Labels: ${r.labelledBy}. Items: ${r.items}. Errors: ${r.errors.length}. Judge cost: $${r.costUsd.toFixed(4)}.`,
    "",
    "| criterion | accuracy | Cohen's kappa | human pass / judge pass | human pass / judge fail | human fail / judge pass | human fail / judge fail |",
    "|---|---|---|---|---|---|---|",
    ...JUDGE_CRITERIA.map((c) => `| ${c} ${fmt(r.criteria[c])}`),
    `| overall (all four pass) ${fmt(r.overall)}`,
    "",
    "Known negatives (must fail overall): " + r.knownNegatives.map((k) => `${k.id} ${k.ok ? "failed as required" : "PASSED - judge too lenient"}`).join(", "),
    "",
    "## Disagreements",
    "",
    ...(r.disagreements.length
      ? r.disagreements.map((d) => `- ${d.id} ${d.criterion}: human ${d.human}, judge ${d.judge} - "${d.rationale}"`)
      : ["None."]),
    "",
    "Reading the numbers: kappa corrects accuracy for agreement by chance. Above ~0.8 is strong, 0.6-0.8 substantial, below 0.4 weak. With ~24 items one disagreement moves accuracy by ~4 points, so treat these as rough.",
  ];
  return `${lines.join("\n")}\n`;
}

runCli(async () => {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "eval.config.yaml" },
      replay: { type: "boolean" },
      record: { type: "boolean" },
      live: { type: "boolean" },
      "budget-usd": { type: "string" },
      cassettes: { type: "string" },
      items: { type: "string", default: "datasets/judge-calibration/items.yaml" },
      "min-kappa": { type: "string" },
      out: { type: "string", default: join("reports", "judge-calibration") },
    },
    strict: true,
  });
  const mode = modeFrom(values);
  const config = loadConfig(values.config);
  const spend = requireBudget(mode, values["budget-usd"]);
  const root = values.cassettes ?? config.cassettes;
  const transports = buildTransports(mode, root, spend);
  const { labelledBy, items } = loadCalibration(values.items);
  const { rows, errors } = await runCalibration(items, {
    transport: transports.judge,
    settings: { model: config.judge.model, effort: config.judge.effort, maxTokens: config.judge.maxTokens },
    backend: new FakeLibraryBackend(loadFixtures(config)),
    scope: "judge-calibration",
  });
  const report = computeAgreement(rows, { labelledBy, judgeModel: config.judge.model, errors, synthetic: mode === "replay" && root.includes("synthetic") });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "calibration.json"), `${JSON.stringify(report, null, 2)}\n`);
  const md = markdown(report);
  writeFileSync(join(values.out, "calibration.md"), md);
  console.log(md);
  for (const e of errors) console.log(`ERROR ${e.id}: ${e.message}`);

  let code = errors.length ? 2 : 0;
  if (report.knownNegatives.some((k) => !k.ok)) code = Math.max(code, 1);
  if (values["min-kappa"] !== undefined) {
    const floor = Number(values["min-kappa"]);
    const low = JUDGE_CRITERIA.filter((c) => !(report.criteria[c].kappa >= floor));
    if (low.length) {
      console.log(`kappa below ${floor} for: ${low.join(", ")}`);
      code = Math.max(code, 1);
    }
  }
  return code;
});
