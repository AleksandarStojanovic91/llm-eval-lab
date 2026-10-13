/**
 * A fake judge used ONLY to produce synthetic judge cassettes. It finds the final answer in the judge request
 * and returns the verdicts registered for that exact answer text, or "pass" on every criterion otherwise.
 * Rationales are prefixed with "SYNTHETIC" so they can never be mistaken for a real judge's reasoning.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { JUDGE_CRITERIA, type JudgeCriterion, type JudgeOutput, type Verdict } from "../eval/judge.js";
import type { CallContext, CallResult, JudgeMessage, JudgeParams, Transport } from "../llm/transport.js";
import { estimateTokens, shortHash, unit } from "./fakeModel.js";

export type VerdictOverrides = Partial<Record<JudgeCriterion, { verdict: Verdict; rationale: string }>>;

export function extractFinalAnswer(params: JudgeParams): string {
  const first = params.messages[0];
  const content = typeof first?.content === "string" ? first.content : "";
  const m = /<final_answer>\n([\s\S]*?)\n<\/final_answer>/.exec(content);
  return (m?.[1] ?? "").trim();
}

export class FakeJudge implements Transport<JudgeParams, JudgeMessage> {
  constructor(private readonly index: Map<string, VerdictOverrides>) {}

  call(params: JudgeParams, ctx: CallContext): Promise<CallResult<JudgeMessage>> {
    const answer = extractFinalAnswer(params);
    const overrides = this.index.get(answer) ?? {};
    const verdicts = Object.fromEntries(
      JUDGE_CRITERIA.map((c) => [c, overrides[c] ?? { verdict: "pass", rationale: "SYNTHETIC verdict: no problem found for this criterion." }]),
    ) as JudgeOutput;
    for (const c of JUDGE_CRITERIA) {
      if (!verdicts[c].rationale.startsWith("SYNTHETIC")) verdicts[c] = { ...verdicts[c], rationale: `SYNTHETIC: ${verdicts[c].rationale}` };
    }
    const text = JSON.stringify({
      correctness: { rationale: verdicts.correctness.rationale, verdict: verdicts.correctness.verdict },
      groundedness: { rationale: verdicts.groundedness.rationale, verdict: verdicts.groundedness.verdict },
      helpfulness: { rationale: verdicts.helpfulness.rationale, verdict: verdicts.helpfulness.verdict },
      tone: { rationale: verdicts.tone.rationale, verdict: verdicts.tone.verdict },
    });
    const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
    const user = typeof params.messages[0]?.content === "string" ? params.messages[0].content : "";
    const systemTokens = estimateTokens(system);
    const output = 120 + Math.floor(unit("judge-think", ctx.caseId, ctx.rep, answer) * 200) + estimateTokens(text);
    const usage: Anthropic.Messages.Usage = {
      input_tokens: estimateTokens(user),
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: systemTokens,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      inference_geo: null,
      server_tool_use: null,
      service_tier: "standard",
    } as Anthropic.Messages.Usage;
    const message = {
      id: `msg_syn_judge_${shortHash(ctx.caseId, ctx.rep, answer)}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage,
    } as JudgeMessage;
    return Promise.resolve({ message, latencyMs: Math.round(800 + output * 10), attempts: 1, source: "fake" });
  }
}
