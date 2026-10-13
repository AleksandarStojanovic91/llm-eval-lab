import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_FORMAT } from "../src/eval/judge.js";
import { canonicalJson, CassetteStore, RecordingTransport, ReplayTransport, requestHash } from "../src/llm/cassettes.js";
import type { CallContext, CallResult, Transport } from "../src/llm/transport.js";

class Echo implements Transport<{ q: string }, { answer: string }> {
  calls = 0;
  call(params: { q: string }, ctx: CallContext): Promise<CallResult<{ answer: string }>> {
    this.calls++;
    return Promise.resolve({ message: { answer: `${params.q}#${String(ctx.rep)}` }, latencyMs: 1234.4, attempts: 1, source: "live" });
  }
}

const ctx = (rep: number): CallContext => ({ scope: "s", caseId: "case-001", rep, kind: "assistant" });

describe("request hashing", () => {
  it("ignores key order but not values", () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
    expect(requestHash({ m: [1, 2] })).not.toBe(requestHash({ m: [2, 1] }));
  });

  it("drops undefined values and functions (the zod output format carries a parse function)", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ f: JUDGE_FORMAT })).not.toContain("parse");
    expect(canonicalJson({ f: JUDGE_FORMAT })).toContain("json_schema");
  });
});

describe("record / replay", () => {
  it("replays what was recorded, per repetition, without calling the inner transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassettes-"));
    const inner = new Echo();
    const rec = new RecordingTransport(inner, new CassetteStore(root), () => new Date("2026-10-13T00:00:00Z"));
    await rec.call({ q: "hello" }, ctx(0));
    await rec.call({ q: "hello" }, ctx(1));
    expect(inner.calls).toBe(2);

    const replay = new ReplayTransport<{ q: string }, { answer: string }>(new CassetteStore(root));
    const r0 = await replay.call({ q: "hello" }, ctx(0));
    const r1 = await replay.call({ q: "hello" }, ctx(1));
    expect(r0.message.answer).toBe("hello#0");
    expect(r1.message.answer).toBe("hello#1");
    expect(r0.latencyMs).toBe(1234);
    expect(r0.recordedFrom).toBe("live");
  });

  it("fails loudly with cassette_miss when the request changed or the rep was never recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassettes-"));
    await new RecordingTransport(new Echo(), new CassetteStore(root)).call({ q: "hello" }, ctx(0));
    const replay = new ReplayTransport<{ q: string }, { answer: string }>(new CassetteStore(root));
    await expect(replay.call({ q: "hello!" }, ctx(0))).rejects.toMatchObject({ failureClass: "cassette_miss" });
    await expect(replay.call({ q: "hello" }, ctx(5))).rejects.toMatchObject({ failureClass: "cassette_miss" });
  });
});
