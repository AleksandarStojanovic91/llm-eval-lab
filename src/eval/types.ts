import type { ConversationStatus } from "../assistant/agent.js";
import type { Category } from "../config.js";
import type { TokenUsage } from "../llm/pricing.js";
import type { FailureClass } from "../llm/transport.js";
import type { CheckResult } from "./graders/deterministic.js";
import type { JudgeOutput } from "./judge.js";

/** One graded (case, rep) attempt. Written as one line of results.jsonl as soon as it finishes. */
export interface AttemptRecord {
  caseId: string;
  rep: number;
  category: Category;
  difficulty: "easy" | "medium" | "hard";
  tags: string[];
  /** "truncated" rows (max_tokens) are counted and shown but left out of pass-rate means. */
  status: "ok" | "truncated";
  conversationStatus: ConversationStatus;
  /** Headline result: every deterministic check passed. */
  pass: boolean;
  checks: CheckResult[];
  judge?: {
    model: string;
    pass: boolean;
    verdicts: JudgeOutput;
    usage: TokenUsage;
    costUsd: number;
    latencyMs: number;
  };
  userTurns: string[];
  finalAnswer: string;
  requestedModel: string;
  /** Served model of the last call, taken from the response, not from the config. */
  model: string;
  usage: TokenUsage;
  costUsd: number;
  /** Sum of model-call latencies in this attempt (tool time and retry backoff excluded). */
  latencyMs: number;
  modelCalls: number;
  toolCalls: number;
  /** Extra attempts caused by retries across all model calls (0 = no retry). */
  retries: number;
  fallbackUsed: boolean;
  refusalCategory?: string | null;
  /** Where the responses came from: the live API, or a recorded cassette (live or synthetic). */
  provenance: "live" | "replay:live" | "replay:synthetic" | "fake";
}

/** An attempt that produced no scorable output. Never scored; written to errors.jsonl. */
export interface AttemptError {
  caseId: string;
  rep: number;
  failureClass: FailureClass;
  message: string;
}
