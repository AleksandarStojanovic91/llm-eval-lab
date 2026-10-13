/**
 * Price table (USD per million tokens) and cost accounting from the API's `usage` block.
 *
 * Sources, all from the Claude API skill bundled with Claude Code (shared/models.md, shared/model-migration.md,
 * shared/prompt-caching.md), read on 2026-10-13:
 *  - Claude Opus 5.5   $4 in / $20 out; 5-minute cache writes $5; cache reads $0.20 (0.05x input).
 *  - Claude Sonnet 5.5 $2 in / $10 out; cache reads $0.20. Cache writes at the general 1.25x rule = $2.50.
 *  - Claude Haiku 5.5  $0.10 in / $0.50 out for prompts <= 100K tokens, $0.50 / $2.50 above. Cache writes and reads
 *    use the general rules (1.25x and 0.1x), which the skill states for "every other model".
 *  - Claude Opus 5 and Claude Opus 4.8: $5 / $25 ("a drop-in upgrade at Opus 4.8's pricing"), general cache rules.
 *    They are here because they are the documented targets of Opus 5.5's server-side refusal fallback, and a
 *    fallback-served turn is billed at the fallback model's rates.
 * The cache-write prices assume the default 5-minute TTL, which is the only TTL this project uses.
 * Re-check this table before relying on a cost figure; prices change.
 */

export interface PriceTier {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheRead: number;
}

export interface ModelPrice extends PriceTier {
  /** Optional higher tier for long prompts (Haiku 5.5 above 100K prompt tokens). */
  longPrompt?: PriceTier & { aboveTokens: number };
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheWrite5m: 0.125,
    cacheRead: 0.01,
    longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 },
  },
};

/** Models the comparison runner and the cost projection consider as assistant candidates. */
export const CANDIDATE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

/** Total prompt size = uncached input + cache writes + cache reads (input_tokens is only the uncached remainder). */
export function promptTokens(u: TokenUsage): number {
  return u.input + u.cacheWrite + u.cacheRead;
}

export interface UsageLike {
  input_tokens: number | null;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  iterations?: readonly unknown[] | null;
}

export function normalizeUsage(u: UsageLike): TokenUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

/** Resolve a served model id (which may be a dated snapshot of an alias) to its price. Unknown models throw: a $0 cost is a bug, not a result. */
export function priceFor(model: string): ModelPrice {
  const exact = PRICES[model];
  if (exact) return exact;
  const prefix = Object.keys(PRICES).find((k) => model.startsWith(`${k}-`));
  if (prefix !== undefined) {
    const p = PRICES[prefix];
    if (p) return p;
  }
  throw new Error(`No price for model "${model}". Add it to src/llm/pricing.ts before running it.`);
}

export function costUsd(usage: TokenUsage, model: string): number {
  const price = priceFor(model);
  const tier: PriceTier =
    price.longPrompt && promptTokens(usage) > price.longPrompt.aboveTokens ? price.longPrompt : price;
  return (
    (usage.input * tier.input +
      usage.output * tier.output +
      usage.cacheWrite * tier.cacheWrite5m +
      usage.cacheRead * tier.cacheRead) /
    1_000_000
  );
}

interface IterationLike {
  type: string;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

function isIteration(x: unknown): x is IterationLike {
  return typeof x === "object" && x !== null && "type" in x && "input_tokens" in x && "output_tokens" in x;
}

/**
 * Cost of one response. When a server-side refusal fallback ran, `usage.iterations` lists each model that
 * served part of the turn; each part is priced at its own model's rates.
 */
export function messageCostUsd(message: { model: string; usage: UsageLike }, requestedModel: string): number {
  const iterations = (message.usage.iterations ?? []).filter(isIteration);
  const hasFallback = iterations.some((it) => it.type === "fallback_message");
  if (!hasFallback) return costUsd(normalizeUsage(message.usage), message.model);
  let total = 0;
  for (const it of iterations) {
    if (it.type !== "message" && it.type !== "fallback_message") continue;
    total += costUsd(
      { input: it.input_tokens, output: it.output_tokens, cacheWrite: it.cache_creation_input_tokens, cacheRead: it.cache_read_input_tokens },
      it.model ?? requestedModel,
    );
  }
  return total;
}
