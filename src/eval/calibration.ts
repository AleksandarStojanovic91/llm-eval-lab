/**
 * Judge calibration: run the judge on responses that carry independent human labels and measure agreement
 * per criterion (accuracy, Cohen's kappa, confusion counts) plus the three known-negative probes.
 * The skill's eval-audit checklist asks for this before a judge's scores are allowed to steer decisions.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ToolCallRecord } from "../assistant/agent.js";
import { executeTool } from "../assistant/tools.js";
import type { LibraryBackend } from "../backends/types.js";
import type { JudgeMessage, JudgeParams, Transport } from "../llm/transport.js";
import { HarnessError } from "../llm/transport.js";
import { JUDGE_CRITERIA, renderTranscript, runJudge, type JudgeCriterion, type JudgeOutput, type JudgeSettings, type Verdict } from "./judge.js";
import { cohensKappa } from "./stats.js";

const VerdictSchema = z.enum(["pass", "fail"]);
const Step = z.strictObject({ name: z.string(), input: z.record(z.string(), z.unknown()) });

export const CalibrationItem = z.strictObject({
  id: z.string().regex(/^cal-\d{3}$/),
  user: z.string().min(1),
  tags: z.array(z.string()).default([]),
  tool_calls: z.array(Step).default([]),
  scope: z.enum(["answer", "decline"]).default("answer"),
  reference_answer: z.string(),
  response: z.string(),
  labels: z.strictObject({ correctness: VerdictSchema, groundedness: VerdictSchema, helpfulness: VerdictSchema, tone: VerdictSchema }),
  notes: z.string().optional(),
});
export type CalibrationItem = z.infer<typeof CalibrationItem>;

const CalibrationFile = z.strictObject({ labelled_by: z.string(), items: z.array(CalibrationItem).min(1) });

export function loadCalibration(path: string): { labelledBy: string; items: CalibrationItem[] } {
  const f = CalibrationFile.parse(parseYaml(readFileSync(path, "utf8")));
  return { labelledBy: f.labelled_by, items: f.items };
}

export async function calibrationTranscript(item: CalibrationItem, backend: LibraryBackend): Promise<string> {
  const toolCalls: ToolCallRecord[] = [];
  for (const [i, step] of item.tool_calls.entries()) {
    const exec = await executeTool(step.name, step.input, backend);
    toolCalls.push({ turn: 0, round: i, id: `cal_${String(i)}`, name: step.name, input: step.input, inputValid: exec.inputValid, output: exec.content, isError: exec.isError });
  }
  return renderTranscript({ turns: [{ user: item.user, answer: item.response, status: "ok" }], toolCalls });
}

export interface CalibrationRow {
  id: string;
  tags: string[];
  human: Record<JudgeCriterion, Verdict>;
  judge: JudgeOutput;
  costUsd: number;
}

export interface CriterionAgreement {
  n: number;
  accuracy: number;
  kappa: number;
  /** [human][judge] counts. */
  confusion: { passPass: number; passFail: number; failPass: number; failFail: number };
}

export interface CalibrationReport {
  labelledBy: string;
  judgeModel: string;
  items: number;
  errors: { id: string; message: string }[];
  criteria: Record<JudgeCriterion, CriterionAgreement>;
  overall: CriterionAgreement;
  knownNegatives: { id: string; judgeOverall: Verdict; ok: boolean }[];
  disagreements: { id: string; criterion: string; human: Verdict; judge: Verdict; rationale: string }[];
  costUsd: number;
  synthetic: boolean;
}

function agreement(pairs: [Verdict, Verdict][]): CriterionAgreement {
  const count = (h: Verdict, j: Verdict): number => pairs.filter(([a, b]) => a === h && b === j).length;
  return {
    n: pairs.length,
    accuracy: pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : Number.NaN,
    kappa: cohensKappa(pairs),
    confusion: { passPass: count("pass", "pass"), passFail: count("pass", "fail"), failPass: count("fail", "pass"), failFail: count("fail", "fail") },
  };
}

const overallOf = (v: Record<JudgeCriterion, Verdict>): Verdict => (JUDGE_CRITERIA.every((c) => v[c] === "pass") ? "pass" : "fail");

export function computeAgreement(rows: CalibrationRow[], meta: { labelledBy: string; judgeModel: string; errors: CalibrationReport["errors"]; synthetic: boolean }): CalibrationReport {
  const criteria = Object.fromEntries(
    JUDGE_CRITERIA.map((c) => [c, agreement(rows.map((r) => [r.human[c], r.judge[c].verdict]))]),
  ) as Record<JudgeCriterion, CriterionAgreement>;
  const judgeVerdicts = (r: CalibrationRow): Record<JudgeCriterion, Verdict> =>
    Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, r.judge[c].verdict])) as Record<JudgeCriterion, Verdict>;
  return {
    labelledBy: meta.labelledBy,
    judgeModel: meta.judgeModel,
    items: rows.length,
    errors: meta.errors,
    criteria,
    overall: agreement(rows.map((r) => [overallOf(r.human), overallOf(judgeVerdicts(r))])),
    knownNegatives: rows
      .filter((r) => r.tags.includes("known-negative"))
      .map((r) => {
        const judgeOverall = overallOf(judgeVerdicts(r));
        return { id: r.id, judgeOverall, ok: judgeOverall === "fail" };
      }),
    disagreements: rows.flatMap((r) =>
      JUDGE_CRITERIA.filter((c) => r.human[c] !== r.judge[c].verdict).map((c) => ({
        id: r.id,
        criterion: c,
        human: r.human[c],
        judge: r.judge[c].verdict,
        rationale: r.judge[c].rationale,
      })),
    ),
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    synthetic: meta.synthetic,
  };
}

export async function runCalibration(
  items: CalibrationItem[],
  deps: { transport: Transport<JudgeParams, JudgeMessage>; settings: JudgeSettings; backend: LibraryBackend; scope: string },
): Promise<{ rows: CalibrationRow[]; errors: CalibrationReport["errors"] }> {
  const rows: CalibrationRow[] = [];
  const errors: CalibrationReport["errors"] = [];
  for (const item of items) {
    try {
      const transcript = await calibrationTranscript(item, deps.backend);
      const res = await runJudge(
        deps.transport,
        deps.settings,
        { scope: item.scope, referenceAnswer: item.reference_answer, transcript, finalAnswer: item.response },
        { scope: deps.scope, caseId: item.id, rep: 0 },
      );
      rows.push({ id: item.id, tags: item.tags, human: item.labels, judge: res.verdicts, costUsd: res.costUsd });
    } catch (err) {
      if (err instanceof HarnessError && err.fatal) throw err;
      errors.push({ id: item.id, message: String(err) });
    }
  }
  return { rows, errors };
}
