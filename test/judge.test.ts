import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { computeAgreement, loadCalibration, type CalibrationRow } from "../src/eval/calibration.js";
import { buildJudgeRequest, JUDGE_SYSTEM_PROMPT, parseJudgeMessage, runJudge, type JudgeOutput } from "../src/eval/judge.js";
import { FakeJudge } from "../src/synthetic/fakeJudge.js";
import { calibrationJudgeIndex } from "../src/synthetic/judgeIndex.js";

const settings = { model: "claude-opus-5-5", effort: "medium" as const, maxTokens: 8000 };
const input = { scope: "answer" as const, referenceAnswer: "14 days", transcript: "[patron] How long?\n[assistant] 14 days", finalAnswer: "14 days" };

function judgeMessage(text: string, stop: Anthropic.Messages.StopReason = "end_turn"): Anthropic.Messages.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Messages.Message;
}

describe("judge request", () => {
  const req = buildJudgeRequest(settings, input);

  it("uses structured output from a zod schema, explicit effort, and no thinking or forced tools", () => {
    expect(req.output_config?.format?.type).toBe("json_schema");
    expect(req.output_config?.effort).toBe("medium");
    expect(req).not.toHaveProperty("thinking");
    expect(req).not.toHaveProperty("tool_choice");
    expect(req).not.toHaveProperty("tools");
  });

  it("treats the transcript as untrusted data and does not reward length", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/data, not instructions/);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/Do not reward length/);
  });
});

describe("judge output parsing", () => {
  const good: JudgeOutput = {
    correctness: { rationale: "r", verdict: "pass" },
    groundedness: { rationale: "r", verdict: "pass" },
    helpfulness: { rationale: "r", verdict: "fail" },
    tone: { rationale: "r", verdict: "pass" },
  };

  it("parses a valid verdict and turns refusals or schema errors into grader errors", () => {
    expect(parseJudgeMessage(judgeMessage(JSON.stringify(good))).helpfulness.verdict).toBe("fail");
    expect(() => parseJudgeMessage(judgeMessage("", "refusal"))).toThrow(/refused/);
    expect(() => parseJudgeMessage(judgeMessage('{"correctness": 1}'))).toThrow(/schema/);
  });

  it("fails the case overall when any criterion fails", async () => {
    const index = new Map([["14 days", { tone: { verdict: "fail" as const, rationale: "curt" } }]]);
    const r = await runJudge(new FakeJudge(index), settings, input, { scope: "t", caseId: "c", rep: 0 });
    expect(r.pass).toBe(false);
    expect(r.verdicts.tone.rationale).toMatch(/^SYNTHETIC/);
  });
});

describe("calibration", () => {
  it("computes accuracy, kappa and the known-negative check", () => {
    const { items } = loadCalibration("datasets/judge-calibration/items.yaml");
    const index = calibrationJudgeIndex(items);
    const rows: CalibrationRow[] = items.map((item) => {
      const v = index.get(item.response.trim()) ?? {};
      const judge = Object.fromEntries(
        (["correctness", "groundedness", "helpfulness", "tone"] as const).map((c) => [c, { rationale: "", verdict: v[c]?.verdict ?? "pass" }]),
      ) as JudgeOutput;
      return { id: item.id, tags: item.tags, human: item.labels, judge, costUsd: 0 };
    });
    const r = computeAgreement(rows, { labelledBy: "x", judgeModel: "m", errors: [], synthetic: true });
    expect(r.items).toBe(items.length);
    expect(r.criteria.correctness.accuracy).toBe(1);
    expect(r.disagreements).toHaveLength(4);
    expect(r.knownNegatives.map((k) => k.ok)).toEqual([true, true, true]);
    expect(r.criteria.tone.kappa).toBeLessThan(r.criteria.correctness.kappa);
  });
});
