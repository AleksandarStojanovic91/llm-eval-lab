/**
 * npm run eval:audit-dataset -- [--config eval.config.yaml]
 * Prints dataset balance and tier-1 findings. Exit 1 on any error-level finding.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { auditDataset } from "../eval/audit.js";
import { loadDataset } from "../eval/dataset.js";
import { loadFixtures, runCli } from "./common.js";

runCli(() => {
  const { values } = parseArgs({ options: { config: { type: "string", default: "eval.config.yaml" } }, strict: true });
  const config = loadConfig(values.config);
  const r = auditDataset(loadDataset(config.dataset), loadFixtures(config));
  console.log(`${r.total} cases, ${r.decline} expect a decline`);
  console.log(`by category:   ${Object.entries(r.byCategory).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`by difficulty: ${Object.entries(r.byDifficulty).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const f of r.findings) console.log(`${f.severity.toUpperCase()} ${f.caseId}: ${f.message}`);
  if (r.findings.length === 0) console.log("no findings");
  return Promise.resolve(r.findings.some((f) => f.severity === "error") ? 1 : 0);
});
