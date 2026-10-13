import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/eval/compare.js";
import { evaluateGates } from "../src/eval/gates.js";
import { summarize } from "../src/eval/metrics.js";
import type { AttemptRecord } from "../src/eval/types.js";
import type { Category } from "../src/config.js";
import { config } from "./helpers.js";

function attempt(caseId: string, rep: number, pass: boolean, category: Category = "rules", extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    caseId,
    rep,
    category,
    difficulty: "easy",
    tags: [],
    status: "ok",
    conversationStatus: "ok",
    pass,
    checks: [{ id: "x", pass, detail: "" }],
    userTurns: ["q"],
    finalAnswer: "a",
    requestedModel: "claude-opus-5-5",
    model: "claude-opus-5-5",
    usage: { input: 10, output: 100, cacheWrite: 100, cacheRead: 800 },
    costUsd: 0.01,
    latencyMs: 1000 + rep * 100,
    modelCalls: 2,
    toolCalls: 1,
    retries: 0,
    fallbackUsed: false,
    provenance: "fake",
    ...extra,
  };
}

const reps = (id: string, results: boolean[], category?: Category): AttemptRecord[] => results.map((p, i) => attempt(id, i, p, category));

describe("summary", () => {
  const attempts = [...reps("rules-001", [true, true, true]), ...reps("rules-002", [true, false, true]), ...reps("adversarial-001", [true, true, true], "adversarial")];
  const s = summarize(config, attempts, [{ caseId: "rules-003", rep: 0, failureClass: "timeout", message: "t" }], 3);

  it("computes pass rate, flaky cases and pass^k from raw attempts", () => {
    expect(s.totals.passRate).toBeCloseTo(8 / 9);
    expect(s.consistency.flakyCases).toEqual(["rules-002"]);
    expect(s.consistency.passHatK).toBeCloseTo(2 / 3);
    expect(s.consistency.passAtK).toBe(1);
    expect(s.categories.find((c) => c.category === "rules")?.casesAllRepsPass).toBe(1);
  });

  it("keeps harness errors out of the pass rate but counts them", () => {
    expect(s.totals.attempts).toBe(9);
    expect(s.totals.errors).toBe(1);
    expect(s.totals.errorsByClass).toEqual({ timeout: 1 });
  });

  it("computes cost, cache hit ratio and latency percentiles", () => {
    expect(s.cost.assistantUsd).toBeCloseTo(0.09);
    expect(s.cost.perDatasetPassUsd).toBeCloseTo(0.03);
    expect(s.cacheHitRatio).toBeCloseTo(800 / 910);
    expect(s.latency.attemptP50Ms).toBe(1100);
  });

  it("leaves truncated attempts out of the means", () => {
    const t = summarize(config, [attempt("rules-001", 0, false, "rules", { status: "truncated" }), attempt("rules-001", 1, true)], [], 2);
    expect(t.totals.truncated).toBe(1);
    expect(t.totals.passRate).toBe(1);
  });
});

describe("gates", () => {
  it("fail on errors, adversarial failures in any rep, and budgets", () => {
    const attempts = [...reps("rules-001", [true, true, true]), ...reps("adversarial-001", [true, false, true], "adversarial")];
    const gates = evaluateGates(summarize(config, attempts, [{ caseId: "x", rep: 0, failureClass: "api_error", message: "" }], 3), config.gates);
    const failed = gates.filter((g) => !g.pass).map((g) => g.name);
    expect(failed).toContain("harness errors");
    expect(failed).toContain("adversarial: every rep of every case passes");
    expect(failed).toContain("adversarial pass rate");
    expect(failed).not.toContain("cost per run (all reps, judge included)");
  });
});

describe("comparison", () => {
  it("finds fixed and broken cases and tests significance on discordant cases only", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `rules-${String(i).padStart(3, "0")}`);
    const a = summarize(config, ids.flatMap((id, i) => reps(id, i < 6 ? [false, false, false] : [true, true, true])), [], 3);
    const b = summarize(config, ids.flatMap((id, i) => reps(id, i === 9 ? [false, false, false] : [true, true, true])), [], 3);
    const c = compareRuns(a, b);
    expect(c.fixed.map((x) => x.caseId)).toHaveLength(6);
    expect(c.broken.map((x) => x.caseId)).toEqual(["rules-009"]);
    expect(c.mcnemar.p).toBeCloseTo(0.125);
    expect(c.significant).toBe(false);
    expect(c.meanDelta).toBeCloseTo(0.5);
    expect(c.warnings.some((w) => w.includes("SYNTHETIC"))).toBe(true);
  });
});
