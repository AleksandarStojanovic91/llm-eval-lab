import { describe, expect, it } from "vitest";
import { runConversation, type AssistantSettings } from "../src/assistant/agent.js";
import { HarnessError } from "../src/llm/transport.js";
import { backend, reply, ScriptedTransport, textBlock, toolUse } from "./helpers.js";

const settings: AssistantSettings = {
  model: "claude-opus-5-5",
  promptVersion: "v2",
  effort: "medium",
  maxTokens: 16000,
  fallbacks: "default",
  maxToolRounds: 4,
};
const ctx = { scope: "test", caseId: "t", rep: 0 };
const CLEAN_CODE = "20000000-0000-4000-8000-000000000001";

describe("agent loop", () => {
  it("runs tools, returns every parallel tool_result in one user message, then answers", async () => {
    const thinking = { type: "thinking" as const, thinking: "", signature: "sig-1" };
    const t = new ScriptedTransport([
      reply([thinking, toolUse("tu_1", "list_copies", { bookId: CLEAN_CODE }), toolUse("tu_2", "get_loan_rules", {})], "tool_use"),
      reply([textBlock("One copy is available.")], "end_turn"),
    ]);
    const conv = await runConversation(["Can I borrow Clean Code?"], { transport: t, backend, settings, ctx });
    expect(conv.status).toBe("ok");
    expect(conv.finalAnswer).toBe("One copy is available.");
    expect(conv.toolCalls.map((c) => c.name)).toEqual(["list_copies", "get_loan_rules"]);

    const second = t.requests[1];
    expect(second?.messages).toHaveLength(3);
    const results = second?.messages[2];
    expect(results?.role).toBe("user");
    expect(Array.isArray(results?.content) && results.content.map((b) => (b.type === "tool_result" ? b.tool_use_id : b.type))).toEqual(["tu_1", "tu_2"]);
    // thinking blocks are passed back unchanged
    const assistantTurn = second?.messages[1];
    expect(Array.isArray(assistantTurn?.content) && assistantTurn.content[0]).toEqual(thinking);
  });

  it("never runs tools on a refusal", async () => {
    const t = new ScriptedTransport([
      reply([toolUse("tu_1", "get_loan_rules", {})], "refusal", "claude-opus-5-5", { stop_details: { type: "refusal", category: "cyber", explanation: "x" } as never }),
    ]);
    const conv = await runConversation(["?"], { transport: t, backend, settings, ctx });
    expect(conv.status).toBe("refusal");
    expect(conv.toolCalls).toHaveLength(0);
    expect(conv.refusal?.category).toBe("cyber");
  });

  it("never runs a tool_use cut off by max_tokens", async () => {
    const t = new ScriptedTransport([reply([toolUse("tu_1", "search_books", { q: "Clean" })], "max_tokens")]);
    const conv = await runConversation(["?"], { transport: t, backend, settings, ctx });
    expect(conv.status).toBe("truncated");
    expect(conv.toolCalls).toHaveLength(0);
    expect(t.requests).toHaveLength(1);
  });

  it("returns invalid tool input to the model as an is_error result and continues", async () => {
    const t = new ScriptedTransport([
      reply([toolUse("tu_1", "get_book", { bookId: "not-a-uuid" })], "tool_use"),
      reply([textBlock("Sorry, let me search instead.")], "end_turn"),
    ]);
    const conv = await runConversation(["?"], { transport: t, backend, settings, ctx });
    expect(conv.toolCalls[0]?.inputValid).toBe(false);
    const sent = t.requests[1]?.messages[2]?.content;
    expect(Array.isArray(sent) && sent[0]?.type === "tool_result" && sent[0].is_error).toBe(true);
  });

  it("resumes pause_turn by re-sending the assistant turn", async () => {
    const t = new ScriptedTransport([reply([textBlock("partial")], "pause_turn"), reply([textBlock("done")], "end_turn")]);
    const conv = await runConversation(["?"], { transport: t, backend, settings, ctx });
    expect(conv.finalAnswer).toBe("done");
    expect(t.requests[1]?.messages.at(-1)?.role).toBe("assistant");
  });

  it("stops at the tool-round limit", async () => {
    const loop = Array.from({ length: 5 }, (_, i) => reply([toolUse(`tu_${String(i)}`, "get_loan_rules", {})], "tool_use"));
    const conv = await runConversation(["?"], { transport: new ScriptedTransport(loop), backend, settings, ctx });
    expect(conv.status).toBe("tool_loop_limit");
    expect(conv.toolCalls).toHaveLength(4);
  });

  it("fails loudly when another model answered without a fallback block", async () => {
    const t = new ScriptedTransport([reply([textBlock("hi")], "end_turn", "claude-sonnet-5-5")]);
    await expect(runConversation(["?"], { transport: t, backend, settings, ctx })).rejects.toMatchObject({ failureClass: "model_mismatch" });
    await expect(runConversation(["?"], { transport: new ScriptedTransport([reply([textBlock("hi")], "end_turn", "claude-sonnet-5-5")]), backend, settings, ctx })).rejects.toBeInstanceOf(HarnessError);
  });

  it("accepts a dated snapshot of the requested model", async () => {
    const t = new ScriptedTransport([reply([textBlock("hi")], "end_turn", "claude-opus-5-5-20261001")]);
    const conv = await runConversation(["?"], { transport: t, backend, settings, ctx });
    expect(conv.modelCalls[0]?.fallbackUsed).toBe(false);
  });

  it("flags a turn served by the server-side refusal fallback", async () => {
    const fallbackBlock = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } } as never;
    const t = new ScriptedTransport([reply([fallbackBlock, textBlock("answer")], "end_turn", "claude-opus-4-8")]);
    const conv = await runConversation(["?"], { transport: t, backend, settings, ctx });
    expect(conv.modelCalls[0]?.fallbackUsed).toBe(true);
  });

  it("keeps the history across turns of a multi-turn conversation", async () => {
    const t = new ScriptedTransport([reply([textBlock("first")], "end_turn"), reply([textBlock("second")], "end_turn")]);
    const conv = await runConversation(["one", "two"], { transport: t, backend, settings, ctx });
    expect(conv.turns.map((x) => x.answer)).toEqual(["first", "second"]);
    expect(t.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
