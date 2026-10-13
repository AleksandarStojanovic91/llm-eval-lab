/**
 * npm run cassettes:synthesize
 *
 * Regenerates cassettes/synthetic/: the SYNTHETIC replay set used by CI. It runs the real agent loop, real tools
 * (fixture backend), real graders and the real judge request builder, but the "model" is FakeAssistantModel and
 * the "judge" is FakeJudge (src/synthetic/). No network call is made. The output is deterministic: running it
 * twice produces identical files.
 *
 * Use it after changing a prompt, a tool definition, the dataset or a scenario; otherwise replay reports
 * cassette misses (which is the point: stale cassettes must fail loudly).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FakeLibraryBackend } from "../backends/fake.js";
import { loadConfig } from "../config.js";
import { loadCalibration, runCalibration } from "../eval/calibration.js";
import { loadDataset } from "../eval/dataset.js";
import { evaluate } from "../eval/pipeline.js";
import { CassetteStore, RecordingTransport } from "../llm/cassettes.js";
import { FakeJudge } from "../synthetic/fakeJudge.js";
import { FakeAssistantModel } from "../synthetic/fakeModel.js";
import { calibrationJudgeIndex, evalJudgeIndex } from "../synthetic/judgeIndex.js";
import { loadFixtures, runCli } from "./common.js";

const CONFIGS = ["eval.config.yaml", "configs/prompt-v1.yaml"];
const FIXED_CLOCK = (): Date => new Date("2026-10-13T00:00:00.000Z");

runCli(async () => {
  const base = loadConfig(CONFIGS[0] ?? "eval.config.yaml");
  const root = base.cassettes;
  if (!root.includes("synthetic")) throw new Error(`refusing to overwrite ${root}: the synthesiser only writes synthetic cassette sets`);
  if (existsSync(root)) {
    for (const entry of ["baseline", "prompt-v1", "judge-calibration"]) rmSync(join(root, entry), { recursive: true, force: true });
  }
  const store = new CassetteStore(root);
  const cases = loadDataset(base.dataset);

  for (const path of CONFIGS) {
    const config = loadConfig(path);
    if (config.cassettes !== root) throw new Error(`${path} must use the same cassette root as the baseline`);
    const catalogue = loadFixtures(config);
    const result = await evaluate({
      config,
      cases,
      catalogue,
      backend: new FakeLibraryBackend(catalogue),
      assistant: new RecordingTransport(new FakeAssistantModel(cases), store, FIXED_CLOCK),
      judge: new RecordingTransport(new FakeJudge(evalJudgeIndex(cases)), store, FIXED_CLOCK),
      runs: config.run.runs,
      outDir: join("reports", "synthesize", config.name),
      mode: "synthesize",
      concurrency: 1, // the simulated prompt cache depends on call order; keep it deterministic
    });
    console.log(`${config.name}: ${result.attempts.length} attempts recorded, ${result.errors.length} errors`);
    if (result.errors.length) throw new Error(`synthesis produced errors: ${JSON.stringify(result.errors.slice(0, 3))}`);
  }

  const { items } = loadCalibration("datasets/judge-calibration/items.yaml");
  const catalogue = loadFixtures(base);
  const cal = await runCalibration(items, {
    transport: new RecordingTransport(new FakeJudge(calibrationJudgeIndex(items)), store, FIXED_CLOCK),
    settings: { model: base.judge.model, effort: base.judge.effort, maxTokens: base.judge.maxTokens },
    backend: new FakeLibraryBackend(catalogue),
    scope: "judge-calibration",
  });
  console.log(`judge-calibration: ${cal.rows.length} items recorded, ${cal.errors.length} errors`);
  console.log(`synthetic cassettes written to ${root}`);
  return cal.errors.length ? 2 : 0;
});
