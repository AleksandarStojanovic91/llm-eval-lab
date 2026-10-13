import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationResult } from "../src/assistant/agent.js";
import { FakeLibraryBackend } from "../src/backends/fake.js";
import { loadCatalogue } from "../src/catalogue/catalogue.js";
import { loadConfig } from "../src/config.js";
import { loadDataset, type GoldenCase } from "../src/eval/dataset.js";
import type { AssistantMessage, AssistantParams, CallContext, CallResult, Transport } from "../src/llm/transport.js";
import { makeMessage, makeUsage } from "../src/synthetic/fakeModel.js";

export const catalogue = loadCatalogue("fixtures/catalogue.json");
export const backend = new FakeLibraryBackend(catalogue);
export const cases = loadDataset("datasets/golden");
export const config = loadConfig("eval.config.yaml");

export function caseById(id: string): GoldenCase {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

/** A conversation result with a final answer and optional tool calls, for grader tests. */
export function conversation(answer: string, opts: Partial<ConversationResult> & { user?: string } = {}): ConversationResult {
  return {
    turns: [{ user: opts.user ?? "question", answer, status: opts.status ?? "ok" }],
    finalAnswer: answer,
    status: opts.status ?? "ok",
    toolCalls: opts.toolCalls ?? [],
    modelCalls: opts.modelCalls ?? [],
    messages: [],
    ...(opts.refusal ? { refusal: opts.refusal } : {}),
  };
}

type Block = Anthropic.Beta.Messages.BetaContentBlock;

export function textBlock(text: string): Block {
  return { type: "text", text, citations: null };
}

export function toolUse(id: string, name: string, input: unknown): Block {
  return { type: "tool_use", id, name, input };
}

export function reply(content: Block[], stopReason: Anthropic.Beta.Messages.BetaStopReason, model = "claude-opus-5-5", extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { ...makeMessage({ id: "msg_test", model, content, stopReason, usage: makeUsage({ input: 10, output: 20, cacheWrite: 0, cacheRead: 100 }) }), ...extra };
}

/** Transport that returns scripted messages in order and records the requests it saw. */
export class ScriptedTransport implements Transport<AssistantParams, AssistantMessage> {
  readonly requests: AssistantParams[] = [];
  private i = 0;

  constructor(private readonly script: AssistantMessage[]) {}

  call(params: AssistantParams, _ctx: CallContext): Promise<CallResult<AssistantMessage>> {
    this.requests.push(structuredClone(params));
    const message = this.script[this.i++];
    if (!message) return Promise.reject(new Error("script exhausted"));
    return Promise.resolve({ message, latencyMs: 100, attempts: 1, source: "fake" });
  }
}
