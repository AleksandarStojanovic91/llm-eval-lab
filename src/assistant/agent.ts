/**
 * The library assistant: a manual tool-use loop over the Claude Messages API.
 *
 * Why a manual loop instead of the SDK's beta tool runner (which the skill recommends by default):
 * the eval needs a seam *below* the SDK call for record/replay and for a fake model, plus per-call
 * instrumentation (latency, usage, retries, served model) and explicit stop-reason handling. The skill lists
 * "a custom transport" as the reason to own the loop; this is that case. The loop follows the skill's rules:
 *  - check stop_reason before running any tool: `refusal` and `max_tokens` never execute that turn's tools;
 *  - append the full `response.content` (thinking blocks included, unchanged) to the history;
 *  - validate every tool input (zod) before running it; invalid input becomes an is_error tool_result;
 *  - return all tool_results of a turn in ONE user message, matched by tool_use_id;
 *  - resume `pause_turn` by re-sending the assistant turn; cap the number of rounds.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { LibraryBackend } from "../backends/types.js";
import { messageCostUsd, normalizeUsage, type TokenUsage } from "../llm/pricing.js";
import {
  HarnessError,
  servedModelMatches,
  type AssistantMessage,
  type AssistantParams,
  type CallContext,
  type Transport,
} from "../llm/transport.js";
import { SYSTEM_PROMPTS, type PromptVersion } from "./prompts.js";
import { executeTool, TOOLS } from "./tools.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResultParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AssistantSettings {
  model: string;
  promptVersion: PromptVersion;
  /** Set explicitly: Opus 5.5 defaults to medium, Sonnet 5.5 to high; an explicit value keeps runs comparable. */
  effort: Effort;
  /** Thinking counts toward max_tokens on adaptive-thinking models, so leave room for it. */
  maxTokens: number;
  /** "default" opts into the server-side refusal fallback (beta server-side-fallback-2026-07-01). */
  fallbacks: "default" | "off";
  maxToolRounds: number;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Build one request. Prompt-cache layout (shared/prompt-caching.md, "robust combination for agent loops"):
 * an explicit breakpoint on the frozen system prompt (which also covers the tools, rendered before it) plus
 * top-level automatic caching for the growing conversation tail. `thinking` is omitted: on Opus 5.5 that means
 * adaptive thinking, and `disabled` / `budget_tokens` would be a 400. tool_choice is omitted (auto).
 */
export function buildRequest(settings: AssistantSettings, messages: MessageParam[]): AssistantParams {
  const params: AssistantParams = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPTS[settings.promptVersion], cache_control: { type: "ephemeral" } }],
    tools: [...TOOLS],
    cache_control: { type: "ephemeral" },
    output_config: { effort: settings.effort },
    messages: [...messages],
  };
  if (settings.fallbacks === "default") {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return params;
}

export interface ToolCallRecord {
  turn: number;
  round: number;
  id: string;
  name: string;
  input: unknown;
  inputValid: boolean;
  output: string;
  isError: boolean;
}

export interface ModelCallRecord {
  turn: number;
  round: number;
  requestedModel: string;
  servedModel: string;
  stopReason: string | null;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  fallbackUsed: boolean;
  source: "live" | "replay" | "fake";
  recordedFrom?: "live" | "synthetic";
}

export type ConversationStatus = "ok" | "truncated" | "refusal" | "tool_loop_limit";

export interface TurnRecord {
  user: string;
  answer: string;
  status: ConversationStatus;
}

export interface ConversationResult {
  turns: TurnRecord[];
  finalAnswer: string;
  status: ConversationStatus;
  refusal?: { category: string | null; explanation: string | null };
  toolCalls: ToolCallRecord[];
  modelCalls: ModelCallRecord[];
  /** Full message history as sent on the last request, thinking blocks included. */
  messages: MessageParam[];
}

export interface AgentDeps {
  transport: Transport<AssistantParams, AssistantMessage>;
  backend: LibraryBackend;
  settings: AssistantSettings;
  ctx: Omit<CallContext, "kind">;
}

export function textOf(message: AssistantMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

export function usedFallback(message: AssistantMessage): boolean {
  return (
    message.content.some((b) => b.type === "fallback") ||
    (message.usage.iterations ?? []).some((it) => it.type === "fallback_message")
  );
}

export async function runConversation(userTurns: string[], deps: AgentDeps): Promise<ConversationResult> {
  const { transport, backend, settings, ctx } = deps;
  const messages: MessageParam[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const modelCalls: ModelCallRecord[] = [];
  const turns: TurnRecord[] = [];
  let refusal: ConversationResult["refusal"];

  for (const [turnIndex, userText] of userTurns.entries()) {
    messages.push({ role: "user", content: userText });
    let status: ConversationStatus = "ok";
    let answer = "";

    for (let round = 0; ; round++) {
      if (round >= settings.maxToolRounds) {
        status = "tool_loop_limit";
        break;
      }
      const params = buildRequest(settings, messages);
      const res = await transport.call(params, { ...ctx, kind: "assistant" });
      const msg = res.message;
      const fallbackUsed = usedFallback(msg);
      if (!servedModelMatches(settings.model, msg.model) && !fallbackUsed) {
        throw new HarnessError("model_mismatch", `Requested ${settings.model} but ${msg.model} answered, with no fallback block.`);
      }
      modelCalls.push({
        turn: turnIndex,
        round,
        requestedModel: settings.model,
        servedModel: msg.model,
        stopReason: msg.stop_reason,
        usage: normalizeUsage(msg.usage),
        costUsd: messageCostUsd(msg, settings.model),
        latencyMs: res.latencyMs,
        attempts: res.attempts,
        fallbackUsed,
        source: res.source,
        ...(res.recordedFrom ? { recordedFrom: res.recordedFrom } : {}),
      });

      // Stop reasons first: a refusal or a max_tokens cut can leave a half-written tool_use; never run it.
      if (msg.stop_reason === "refusal") {
        messages.push({ role: "assistant", content: msg.content });
        status = "refusal";
        answer = textOf(msg);
        refusal = { category: msg.stop_details?.category ?? null, explanation: msg.stop_details?.explanation ?? null };
        break;
      }
      if (msg.stop_reason === "max_tokens") {
        status = "truncated";
        answer = textOf(msg);
        break;
      }
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }

      const toolUses = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason === "tool_use" && toolUses.length > 0) {
        messages.push({ role: "assistant", content: msg.content });
        const results: ToolResultParam[] = [];
        for (const tu of toolUses) {
          let exec;
          try {
            exec = await executeTool(tu.name, tu.input, backend);
          } catch (err) {
            throw new HarnessError("backend_error", `Tool ${tu.name} failed in the ${backend.kind} backend: ${String(err)}`, false, { cause: err });
          }
          toolCalls.push({
            turn: turnIndex,
            round,
            id: tu.id,
            name: tu.name,
            input: tu.input,
            inputValid: exec.inputValid,
            output: exec.content,
            isError: exec.isError,
          });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: exec.content,
            ...(exec.isError ? { is_error: true } : {}),
          });
        }
        // Every result of this turn goes back in a single user message.
        messages.push({ role: "user", content: results });
        continue;
      }

      // end_turn, stop_sequence or any other terminal stop: this is the answer for the turn.
      messages.push({ role: "assistant", content: msg.content });
      answer = textOf(msg);
      break;
    }

    turns.push({ user: userText, answer, status });
    if (status !== "ok") break;
  }

  const last = turns.at(-1);
  return {
    turns,
    finalAnswer: last?.answer ?? "",
    status: last?.status ?? "ok",
    ...(refusal ? { refusal } : {}),
    toolCalls,
    modelCalls,
    messages,
  };
}
