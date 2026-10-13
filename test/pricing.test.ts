import { describe, expect, it } from "vitest";
import { costUsd, messageCostUsd, priceFor } from "../src/llm/pricing.js";
import { makeUsage } from "../src/synthetic/fakeModel.js";

const M = 1_000_000;

describe("cost math", () => {
  it("prices Opus 5.5 at $4 in / $20 out, $5 cache writes, $0.20 cache reads per MTok", () => {
    expect(costUsd({ input: M, output: 0, cacheWrite: 0, cacheRead: 0 }, "claude-opus-5-5")).toBeCloseTo(4);
    expect(costUsd({ input: 0, output: M, cacheWrite: 0, cacheRead: 0 }, "claude-opus-5-5")).toBeCloseTo(20);
    expect(costUsd({ input: 0, output: 0, cacheWrite: M, cacheRead: 0 }, "claude-opus-5-5")).toBeCloseTo(5);
    expect(costUsd({ input: 0, output: 0, cacheWrite: 0, cacheRead: M }, "claude-opus-5-5")).toBeCloseTo(0.2);
  });

  it("prices Sonnet 5.5 and Haiku 5.5", () => {
    expect(costUsd({ input: M, output: M, cacheWrite: 0, cacheRead: M }, "claude-sonnet-5-5")).toBeCloseTo(2 + 10 + 0.2);
    expect(costUsd({ input: M / 10, output: M / 10, cacheWrite: 0, cacheRead: 0 }, "claude-haiku-5-5")).toBeCloseTo(0.01 + 0.05);
  });

  it("switches Haiku 5.5 to the long-prompt tier above 100K prompt tokens", () => {
    const small = costUsd({ input: 100_000, output: 0, cacheWrite: 0, cacheRead: 0 }, "claude-haiku-5-5");
    const large = costUsd({ input: 100_001, output: 0, cacheWrite: 0, cacheRead: 0 }, "claude-haiku-5-5");
    expect(small).toBeCloseTo(0.01);
    expect(large).toBeCloseTo(0.0500005);
  });

  it("resolves dated snapshots and refuses unknown models instead of returning $0", () => {
    expect(priceFor("claude-opus-5-5-20261001").input).toBe(4);
    expect(() => priceFor("gpt-x")).toThrow(/No price/);
  });

  it("prices each part of a fallback-served turn at its own model's rates", () => {
    const usage = {
      ...makeUsage({ input: 2000, output: 2000, cacheWrite: 0, cacheRead: 0 }),
      iterations: [
        { type: "message" as const, model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
        { type: "fallback_message" as const, model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      ],
    };
    const expected = (1000 * 4 + 1000 * 20 + 1000 * 5 + 1000 * 25) / M;
    expect(messageCostUsd({ model: "claude-opus-4-8", usage }, "claude-opus-5-5")).toBeCloseTo(expected);
  });
});
