import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { SpendTracker, withRetries } from "../src/llm/live.js";
import { HarnessError } from "../src/llm/transport.js";

const noSleep = { maxAttempts: 4, baseMs: 1000, capMs: 20_000, sleep: () => Promise.resolve(), random: () => 0.5 };
const rateLimit = (): Error => new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
const overloaded = (): Error => new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers());

describe("retries (typed SDK errors, no string matching)", () => {
  it("retries rate limits and overload with backoff and reports the attempt count", async () => {
    let n = 0;
    const r = await withRetries(() => (++n < 3 ? Promise.reject(n === 1 ? rateLimit() : overloaded()) : Promise.resolve("ok")), noSleep);
    expect(r.value).toBe("ok");
    expect(r.attempts).toBe(3);
  });

  it("does not retry a bad request", async () => {
    let n = 0;
    const bad = withRetries(() => {
      n++;
      return Promise.reject(new Anthropic.BadRequestError(400, undefined, "bad", new Headers()));
    }, noSleep);
    await expect(bad).rejects.toMatchObject({ failureClass: "api_error", fatal: false });
    expect(n).toBe(1);
  });

  it("treats authentication errors as fatal", async () => {
    const auth = withRetries(() => Promise.reject(new Anthropic.AuthenticationError(401, undefined, "no key", new Headers())), noSleep);
    await expect(auth).rejects.toMatchObject({ fatal: true });
  });

  it("gives up after maxAttempts", async () => {
    let n = 0;
    await expect(withRetries(() => (n++, Promise.reject(rateLimit())), noSleep)).rejects.toBeInstanceOf(HarnessError);
    expect(n).toBe(4);
  });

  it("honours retry-after", async () => {
    const waits: number[] = [];
    let n = 0;
    await withRetries(
      () => (++n === 1 ? Promise.reject(new Anthropic.RateLimitError(429, undefined, "x", new Headers({ "retry-after": "7" }))) : Promise.resolve(1)),
      { ...noSleep, sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    );
    expect(waits).toEqual([7000]);
  });
});

describe("budget", () => {
  it("stops before the next request once the measured spend reaches the budget", () => {
    const s = new SpendTracker(0.05);
    s.beforeCall();
    s.add(0.06);
    expect(() => {
      s.beforeCall();
    }).toThrow(/Budget/);
  });
});
