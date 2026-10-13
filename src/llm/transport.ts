import type Anthropic from "@anthropic-ai/sdk";

/** The assistant uses the beta namespace because `fallbacks` (server-side refusal fallback) is a beta parameter. */
export type AssistantParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type AssistantMessage = Anthropic.Beta.Messages.BetaMessage;

/** The judge uses the regular namespace and `messages.parse` with a zod output format. */
export type JudgeParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
export type JudgeMessage = Anthropic.Messages.Message;

export interface CallContext {
  /** Cassette folder, e.g. the config name ("baseline") or "judge-calibration". */
  scope: string;
  caseId: string;
  rep: number;
  kind: "assistant" | "judge";
}

export interface CallResult<M> {
  message: M;
  /** Duration of the final, successful attempt only (retries and backoff excluded). */
  latencyMs: number;
  /** Attempts made, including the successful one. 1 means no retry. */
  attempts: number;
  source: "live" | "replay" | "fake";
  /** Present in replay mode: whether the cassette was recorded from the real API or synthesised. */
  recordedFrom?: "live" | "synthetic";
}

export interface Transport<P, M> {
  call(params: P, ctx: CallContext): Promise<CallResult<M>>;
}

export type FailureClass =
  | "api_error"
  | "timeout"
  | "cassette_miss"
  | "model_mismatch"
  | "budget_exceeded"
  | "backend_error"
  | "grader_error";

/**
 * An attempt that produced no scorable output. These go to errors.jsonl, never into results.jsonl,
 * so plumbing failures are never scored as model failures (shared/evals/eval-audit.md section 2).
 */
export class HarnessError extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
    readonly fatal = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HarnessError";
  }
}

/** Served model must be the requested one, allowing alias -> dated snapshot resolution. */
export function servedModelMatches(requested: string, served: string): boolean {
  return served === requested || served.startsWith(`${requested}-`);
}
