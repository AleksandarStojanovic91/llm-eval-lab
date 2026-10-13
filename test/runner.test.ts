import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CassetteStore, ReplayTransport } from "../src/llm/cassettes.js";
import type { AssistantMessage, AssistantParams, CallResult, Transport } from "../src/llm/transport.js";
import { evaluate } from "../src/eval/pipeline.js";
import { readExistingResults, runEval } from "../src/eval/runner.js";
import { renderReport } from "../src/report/html.js";
import { renderJunit } from "../src/report/junit.js";
import { FakeJudge } from "../src/synthetic/fakeJudge.js";
import { FakeAssistantModel } from "../src/synthetic/fakeModel.js";
import { evalJudgeIndex } from "../src/synthetic/judgeIndex.js";
import { backend, caseById, cases, catalogue, config } from "./helpers.js";

const subset = ["lookup-001", "rules-004", "adversarial-002"].map(caseById);
const out = (): string => mkdtempSync(join(tmpdir(), "run-"));

describe("runner", () => {
  it("writes one row per (case, rep) as it goes, plus traces, and grades with the judge", async () => {
    const dir = out();
    const r = await evaluate({
      config,
      cases: subset,
      catalogue,
      backend,
      assistant: new FakeAssistantModel(cases),
      judge: new FakeJudge(evalJudgeIndex(cases)),
      runs: 2,
      outDir: dir,
      mode: "test",
    });
    expect(r.attempts).toHaveLength(6);
    expect(readExistingResults(dir)).toHaveLength(6);
    expect(JSON.parse(readFileSync(join(dir, "traces", "rules-004_rep0.json"), "utf8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool_call", name: "get_loan_rules" })]),
    );
    expect(r.attempts.find((a) => a.caseId === "lookup-001")?.pass).toBe(false); // scenario: answered from memory
    expect(r.attempts.find((a) => a.caseId === "adversarial-002")?.judge?.pass).toBe(true);
    expect(r.summary.provenance.synthetic).toBe(true);
  });

  it("puts cassette misses in errors.jsonl, never in results.jsonl", async () => {
    const dir = out();
    const replay = new ReplayTransport<AssistantParams, AssistantMessage>(new CassetteStore(join(dir, "empty")));
    const r = await runEval({ config, cases: subset.slice(0, 1), catalogue, backend, assistantTransport: replay, runs: 1, concurrency: 1, outDir: dir });
    expect(r.attempts).toHaveLength(0);
    expect(r.errors[0]?.failureClass).toBe("cassette_miss");
    expect(readFileSync(join(dir, "results.jsonl"), "utf8")).toBe("");
    expect(readFileSync(join(dir, "errors.jsonl"), "utf8")).toContain("cassette_miss");
  });

  it("enforces the per-attempt wall-clock ceiling", async () => {
    const hang: Transport<AssistantParams, AssistantMessage> = { call: () => new Promise<CallResult<AssistantMessage>>(() => undefined) };
    const fast = { ...config, run: { ...config.run, caseTimeoutSeconds: 0.05 } };
    const r = await runEval({ config: fast, cases: subset.slice(0, 1), catalogue, backend, assistantTransport: hang, runs: 1, concurrency: 1, outDir: out() });
    expect(r.errors[0]?.failureClass).toBe("timeout");
  });

  it("resumes without re-running finished (case, rep) keys", async () => {
    const dir = out();
    const model = new FakeAssistantModel(cases);
    await runEval({ config, cases: subset, catalogue, backend, assistantTransport: model, runs: 1, concurrency: 2, outDir: dir });
    const repsCalled = new Set<number>();
    const counting: Transport<AssistantParams, AssistantMessage> = { call: (p, c) => (repsCalled.add(c.rep), model.call(p, c)) };
    const r = await runEval({ config, cases: subset, catalogue, backend, assistantTransport: counting, runs: 2, concurrency: 2, outDir: dir, resume: true });
    expect(r.attempts).toHaveLength(6);
    expect([...repsCalled]).toEqual([1]); // rep 0 came from results.jsonl
    expect(new Set(r.attempts.map((a) => `${a.caseId}#${String(a.rep)}`)).size).toBe(6);
  });
});

describe("reports", () => {
  it("escapes untrusted text and renders JUnit", async () => {
    const dir = out();
    const r = await evaluate({ config, cases: subset, catalogue, backend, assistant: new FakeAssistantModel(cases), runs: 1, outDir: dir, mode: "test" });
    const first = r.attempts[0];
    if (!first) throw new Error("no attempts");
    first.finalAnswer = "<script>alert(1)</script>";
    const traces = new Map([[`${first.caseId}#0`, [{ role: "assistant", content: "<img src=x onerror=alert(1)>" }]]]);
    const html = renderReport({ summary: r.summary, gates: r.gates, attempts: r.attempts, errors: r.errors, traces, systemPrompt: "p", mode: "test", generatedAt: "now" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("SYNTHETIC REPLAY DATA");
    const junit = renderJunit(r.summary, r.attempts);
    expect(junit).toMatch(/^<\?xml/);
    expect(junit).toContain('name="lookup-001"');
    expect(junit).toContain("<failure");
  });
});
