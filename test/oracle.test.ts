/**
 * Harness sanity checks from the skill's eval-audit checklist ("Harness tested on known-good and known-bad"):
 *  - oracle: every case's hand-written reference (tool calls + answer), run through the real agent loop and
 *    graders, passes every deterministic check;
 *  - null baselines: an empty answer and "I don't know." fail every case.
 */
import { describe, expect, it } from "vitest";
import { runConversation } from "../src/assistant/agent.js";
import { SYSTEM_PROMPTS } from "../src/assistant/prompts.js";
import { auditDataset } from "../src/eval/audit.js";
import { gradeDeterministic } from "../src/eval/graders/deterministic.js";
import { assistantSettings } from "../src/eval/runner.js";
import { FakeAssistantModel } from "../src/synthetic/fakeModel.js";
import { backend, cases, catalogue, config, conversation } from "./helpers.js";

const gradeCtx = (category: string) => ({
  catalogue,
  systemPrompt: SYSTEM_PROMPTS.v2,
  maxWords: config.grading.maxWords[category] ?? 150,
  maxToolCalls: config.grading.maxToolCalls,
});

describe("dataset", () => {
  it("has 40-60 cases across all seven categories, with no audit errors", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.length).toBeLessThanOrEqual(60);
    const report = auditDataset(cases, catalogue);
    expect(Object.keys(report.byCategory).sort()).toEqual(["adversarial", "availability", "lookup", "multi-turn", "out-of-scope", "recommendation", "rules"]);
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("oracle: reference answers pass every deterministic check", () => {
  const model = new FakeAssistantModel(cases, undefined, []); // no scenarios: pure references
  for (const c of cases) {
    it(c.id, async () => {
      const conv = await runConversation(
        c.turns.map((t) => t.user),
        { transport: model, backend, settings: assistantSettings(config), ctx: { scope: "oracle", caseId: c.id, rep: 0 } },
      );
      const failed = gradeDeterministic(c, conv, gradeCtx(c.category)).filter((ch) => !ch.pass);
      expect(failed).toEqual([]);
    });
  }
});

describe("null baselines fail every case", () => {
  for (const answer of ["", "I don't know."]) {
    it(JSON.stringify(answer), () => {
      const passing = cases.filter((c) => gradeDeterministic(c, conversation(answer, { user: c.turns.at(-1)?.user ?? "" }), gradeCtx(c.category)).every((ch) => ch.pass));
      expect(passing.map((c) => c.id)).toEqual([]);
    });
  }
});
