/**
 * Live transports that call the Claude API. Used only with --live or --record, never in CI.
 *
 *  - SDK retries are switched off (maxRetries: 0) and replaced by a visible retry loop with full jitter, so
 *    every retry is counted in the results (shared/evals/eval-audit.md, "Transient errors retried...").
 *  - Errors are classified with the SDK's typed classes, never by matching message strings.
 *  - A SpendTracker enforces the budget the owner approved: once the measured spend passes it, no further
 *    request is sent and the run stops with a budget_exceeded error.
 */
import Anthropic from "@anthropic-ai/sdk";
import { messageCostUsd } from "./pricing.js";
import {
  HarnessError,
  type AssistantMessage,
  type AssistantParams,
  type CallContext,
  type CallResult,
  type JudgeMessage,
  type JudgeParams,
  type Transport,
} from "./transport.js";

export class SpendTracker {
  private spent = 0;

  constructor(readonly limitUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  beforeCall(): void {
    if (this.spent >= this.limitUsd) {
      throw new HarnessError(
        "budget_exceeded",
        `Budget of $${this.limitUsd.toFixed(2)} reached ($${this.spent.toFixed(4)} spent). Stopping before the next request.`,
        true,
      );
    }
  }

  add(costUsd: number): void {
    this.spent += costUsd;
  }
}

export function createClient(): Anthropic {
  // Credentials resolve from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile).
  return new Anthropic({ maxRetries: 0, timeout: 10 * 60 * 1000 });
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true; // 5xx, including 529 overloaded
  if (err instanceof Anthropic.APIConnectionError) return true; // includes APIConnectionTimeoutError
  return false;
}

function isFatal(err: unknown): boolean {
  return err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError;
}

function retryAfterMs(err: unknown): number | undefined {
  const headers: unknown = err instanceof Anthropic.APIError ? err.headers : undefined;
  if (headers instanceof Headers) {
    const v = headers.get("retry-after");
    if (v !== null && !Number.isNaN(Number(v))) return Number(v) * 1000;
  }
  return undefined;
}

export interface BackoffOptions {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { maxAttempts: 4, baseMs: 1000, capMs: 20_000 };

/** Full-jitter exponential backoff; returns the result plus the number of attempts and the last attempt's latency. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions,
): Promise<{ value: T; attempts: number; latencyMs: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    try {
      const value = await fn();
      return { value, attempts: attempt, latencyMs: performance.now() - started };
    } catch (err) {
      if (isFatal(err)) {
        throw new HarnessError("api_error", `Authentication/permission error from the Claude API: ${String(err)}`, true, { cause: err });
      }
      if (!isRetryable(err) || attempt >= opts.maxAttempts) {
        const status = err instanceof Anthropic.APIError ? ` (status ${String(err.status)})` : "";
        throw new HarnessError("api_error", `Claude API call failed after ${attempt} attempt(s)${status}: ${String(err)}`, false, { cause: err });
      }
      const exp = Math.min(opts.capMs, opts.baseMs * 2 ** (attempt - 1));
      await sleep(retryAfterMs(err) ?? random() * exp);
    }
  }
}

export class LiveAssistantTransport implements Transport<AssistantParams, AssistantMessage> {
  constructor(
    private readonly client: Anthropic,
    private readonly spend: SpendTracker,
    private readonly backoff: BackoffOptions = DEFAULT_BACKOFF,
  ) {}

  async call(params: AssistantParams, _ctx: CallContext): Promise<CallResult<AssistantMessage>> {
    this.spend.beforeCall();
    const { value, attempts, latencyMs } = await withRetries(() => this.client.beta.messages.create(params), this.backoff);
    this.spend.add(messageCostUsd(value, params.model));
    return { message: value, attempts, latencyMs, source: "live" };
  }
}

export class LiveJudgeTransport implements Transport<JudgeParams, JudgeMessage> {
  constructor(
    private readonly client: Anthropic,
    private readonly spend: SpendTracker,
    private readonly backoff: BackoffOptions = DEFAULT_BACKOFF,
  ) {}

  async call(params: JudgeParams, _ctx: CallContext): Promise<CallResult<JudgeMessage>> {
    this.spend.beforeCall();
    // messages.parse validates the structured output against the zod schema carried in output_config.format.
    const { value, attempts, latencyMs } = await withRetries(() => this.client.messages.parse(params), this.backoff);
    const { parsed_output: _parsed, ...message } = value;
    this.spend.add(messageCostUsd(message, params.model));
    return { message, attempts, latencyMs, source: "live" };
  }
}
