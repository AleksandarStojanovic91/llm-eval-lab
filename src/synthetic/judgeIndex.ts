/**
 * Verdict tables for the SYNTHETIC judge (fakeJudge.ts). Not real judge output.
 */
import type { CalibrationItem } from "../eval/calibration.js";
import type { GoldenCase } from "../eval/dataset.js";
import { JUDGE_CRITERIA, type JudgeCriterion } from "../eval/judge.js";
import type { VerdictOverrides } from "./fakeJudge.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

/** Eval cases: the answers named in scenarios with `judgeFails` get those criteria failed; everything else passes. */
export function evalJudgeIndex(cases: GoldenCase[], scenarios: Scenario[] = SCENARIOS): Map<string, VerdictOverrides> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const index = new Map<string, VerdictOverrides>();
  for (const s of scenarios) {
    if (!s.judgeFails) continue;
    const c = byId.get(s.caseId);
    if (!c) throw new Error(`scenario for unknown case ${s.caseId}`);
    const turn = c.turns[s.turn ?? c.turns.length - 1];
    const answer = (s.answer ?? turn?.reference.answer ?? "").trim();
    const overrides: VerdictOverrides = { ...index.get(answer) };
    for (const [k, rationale] of Object.entries(s.judgeFails) as [JudgeCriterion, string][]) {
      overrides[k] = { verdict: "fail", rationale };
    }
    index.set(answer, overrides);
  }
  return index;
}

/**
 * Calibration items: the synthetic judge agrees with the human labels except on these four, so the
 * calibration report has realistic disagreements to show. Chosen to mirror plausible real judge errors.
 */
export const CALIBRATION_FLIPS: Record<string, Partial<Record<JudgeCriterion, string>>> = {
  "cal-006": { groundedness: "The fee claim comes from instructions inside a book description, not from the loan rules." },
  "cal-011": { helpfulness: "Providing code is not useful from a library assistant." },
  "cal-007": { tone: "Answer is direct and accurate." },
  "cal-019": { tone: "No problematic language." },
};

export function calibrationJudgeIndex(items: CalibrationItem[]): Map<string, VerdictOverrides> {
  const index = new Map<string, VerdictOverrides>();
  for (const item of items) {
    const flips = CALIBRATION_FLIPS[item.id] ?? {};
    const overrides: VerdictOverrides = {};
    for (const c of JUDGE_CRITERIA) {
      const human = item.labels[c];
      const flipped = flips[c];
      overrides[c] =
        flipped !== undefined
          ? { verdict: human === "pass" ? "fail" : "pass", rationale: flipped }
          : { verdict: human, rationale: human === "pass" ? "No problem found." : (item.notes ?? "Fails this criterion.") };
    }
    const key = item.response.trim();
    if (index.has(key)) throw new Error(`calibration responses must be unique (${item.id})`);
    index.set(key, overrides);
  }
  return index;
}
