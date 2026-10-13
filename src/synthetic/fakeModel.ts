/**
 * A fake Claude used ONLY to produce the clearly labelled synthetic cassette set and in unit tests.
 * It never claims to be a model: every message id starts with msg_syn_ and every cassette it produces is
 * recorded with recordedFrom: "synthetic", which the report shows as a banner.
 *
 * Behaviour: for each (case, turn) it replays the dataset's reference tool calls one round at a time and then
 * the reference answer, unless a scenario (scenarios.ts) overrides them. Tool calls go through the real agent
 * loop and the real backend, so tool results in the transcripts are genuine fixture data.
 *
 * Token counts are ESTIMATES (characters / 3.8, not the Claude tokenizer) and cache reads/writes are simulated
 * from prefix reuse. Latencies are deterministic pseudo-random numbers. None of these are measurements.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPTS, type PromptVersion } from "../assistant/prompts.js";
import type { GoldenCase, ReferenceRound, ToolStep } from "../eval/dataset.js";
import { canonicalJson } from "../llm/cassettes.js";
import type { AssistantMessage, AssistantParams, CallContext, CallResult, Transport } from "../llm/transport.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.8));
}

export function shortHash(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/** Deterministic number in [0, 1) from a key. */
export function unit(...parts: (string | number)[]): number {
  return Number.parseInt(shortHash(...parts).slice(0, 8), 16) / 2 ** 32;
}

export function promptVersionOf(system: AssistantParams["system"]): PromptVersion {
  const text = typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("");
  const found = (Object.keys(SYSTEM_PROMPTS) as PromptVersion[]).find((v) => SYSTEM_PROMPTS[v] === text);
  if (!found) throw new Error("fake model: unknown system prompt");
  return found;
}

export interface TurnScript {
  rounds: ToolStep[][];
  answer: string;
  scenario?: Scenario;
}

function toRounds(calls: ReferenceRound[]): ToolStep[][] {
  return calls.map((r) => (Array.isArray(r) ? r : [r]));
}

export function resolveTurn(c: GoldenCase, turn: number, version: PromptVersion, rep: number, scenarios: Scenario[] = SCENARIOS): TurnScript {
  const ref = c.turns[turn];
  if (!ref) throw new Error(`fake model: case ${c.id} has no turn ${turn}`);
  const lastTurn = c.turns.length - 1;
  const scenario = scenarios.find(
    (s) => s.caseId === c.id && s.versions.includes(version) && (s.reps === undefined || s.reps.includes(rep)) && (s.turn ?? lastTurn) === turn,
  );
  return {
    rounds: toRounds(scenario?.toolCalls ?? ref.reference.tool_calls),
    answer: (scenario?.answer ?? ref.reference.answer).trim(),
    ...(scenario ? { scenario } : {}),
  };
}

type Usage = Anthropic.Beta.Messages.BetaUsage;

export function makeUsage(u: { input: number; output: number; cacheWrite: number; cacheRead: number }): Usage {
  return {
    input_tokens: u.input,
    output_tokens: u.output,
    cache_creation_input_tokens: u.cacheWrite,
    cache_read_input_tokens: u.cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
    fallback_credit: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
  };
}

export function makeMessage(fields: {
  id: string;
  model: string;
  content: Anthropic.Beta.Messages.BetaContentBlock[];
  stopReason: Anthropic.Beta.Messages.BetaStopReason;
  usage: Usage;
}): AssistantMessage {
  return {
    id: fields.id,
    type: "message",
    role: "assistant",
    model: fields.model,
    content: fields.content,
    stop_reason: fields.stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: fields.usage,
  };
}

/** Simulated prompt cache: remembers which prompt prefixes were written, per model. */
export class SimulatedCache {
  private readonly written = new Set<string>();

  /** Returns cache read/write split for a prompt made of a fixed prefix and a list of message segments. */
  account(model: string, prefix: string, segments: string[]): { read: number; write: number; input: number } {
    const prefixTokens = estimateTokens(prefix);
    const segTokens = segments.map(estimateTokens);
    const total = prefixTokens + segTokens.reduce((a, b) => a + b, 0);
    let read = 0;
    const key = (n: number): string => shortHash(model, prefix, ...segments.slice(0, n));
    for (let n = segments.length; n >= 0; n--) {
      if (this.written.has(key(n))) {
        read = prefixTokens + segTokens.slice(0, n).reduce((a, b) => a + b, 0);
        break;
      }
    }
    for (let n = 0; n <= segments.length; n++) this.written.add(key(n));
    const input = Math.min(3, total - read);
    return { read, write: total - read - input, input };
  }
}

export class FakeAssistantModel implements Transport<AssistantParams, AssistantMessage> {
  private readonly byId: Map<string, GoldenCase>;

  constructor(
    cases: GoldenCase[],
    private readonly cache = new SimulatedCache(),
    private readonly scenarios: Scenario[] = SCENARIOS,
  ) {
    this.byId = new Map(cases.map((c) => [c.id, c]));
  }

  call(params: AssistantParams, ctx: CallContext): Promise<CallResult<AssistantMessage>> {
    const c = this.byId.get(ctx.caseId);
    if (!c) return Promise.reject(new Error(`fake model: unknown case ${ctx.caseId}`));
    const version = promptVersionOf(params.system);
    const userIdx = params.messages.flatMap((m, i) => (m.role === "user" && typeof m.content === "string" ? [i] : []));
    const turn = userIdx.length - 1;
    const round = params.messages.slice((userIdx.at(-1) ?? 0) + 1).filter((m) => m.role === "assistant").length;
    const script = resolveTurn(c, turn, version, ctx.rep, this.scenarios);
    const seed = [ctx.caseId, ctx.rep, version, turn, round] as const;

    const thinkingTokens = 60 + Math.floor(unit("think", ...seed) * 340);
    const content: Anthropic.Beta.Messages.BetaContentBlock[] = [
      { type: "thinking", thinking: "", signature: `synthetic-signature-${shortHash("sig", ...seed)}` },
    ];
    let stopReason: Anthropic.Beta.Messages.BetaStopReason;
    let visible: string;
    const step = script.rounds[round];
    if (step) {
      step.forEach((call, i) => {
        content.push({ type: "tool_use", id: `toolu_syn_${shortHash(...seed, i)}`, name: call.name, input: call.input });
      });
      stopReason = "tool_use";
      visible = JSON.stringify(step);
    } else {
      content.push({ type: "text", text: script.answer, citations: null });
      stopReason = "end_turn";
      visible = script.answer;
    }

    const prefix = canonicalJson({ tools: params.tools, system: params.system });
    const cache = this.cache.account(params.model, prefix, params.messages.map((m) => canonicalJson(m)));
    const output = thinkingTokens + estimateTokens(visible);
    const latencyMs = Math.round(600 + output * 12 + unit("lat", ...seed) * 900);
    return Promise.resolve({
      message: makeMessage({
        id: `msg_syn_${shortHash("msg", ...seed)}`,
        model: params.model,
        content,
        stopReason,
        usage: makeUsage({ input: cache.input, output, cacheWrite: cache.write, cacheRead: cache.read }),
      }),
      latencyMs,
      attempts: 1,
      source: "fake",
    });
  }
}
