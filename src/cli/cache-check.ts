/**
 * npm run cache:check -- --budget-usd 0.20 [--config eval.config.yaml]
 *
 * Live check that prompt caching works for the assistant's real request shape: sends the same first request
 * twice and asserts the second response reports cache_read_input_tokens > 0. If it does not, something in the
 * prefix (system prompt, tools, model, effort) changes between requests - see shared/prompt-caching.md,
 * "Silent invalidators". Costs a few cents with Opus 5.5. The offline equivalent is test/request.test.ts,
 * which asserts that the rendered prefix is byte-identical across cases.
 */
import { parseArgs } from "node:util";
import { buildRequest } from "../assistant/agent.js";
import { loadConfig } from "../config.js";
import { assistantSettings } from "../eval/runner.js";
import { createClient, LiveAssistantTransport } from "../llm/live.js";
import { normalizeUsage } from "../llm/pricing.js";
import { requireBudget, runCli, UsageError } from "./common.js";

runCli(async () => {
  const { values } = parseArgs({ options: { config: { type: "string", default: "eval.config.yaml" }, "budget-usd": { type: "string" } }, strict: true });
  const config = loadConfig(values.config);
  const spend = requireBudget("live", values["budget-usd"]);
  if (!spend) throw new UsageError("a budget is required");
  const transport = new LiveAssistantTransport(createClient(), spend);
  const params = buildRequest(assistantSettings(config), [{ role: "user", content: "How long can I keep a book?" }]);
  const results = [];
  for (const rep of [0, 1]) {
    const r = await transport.call(params, { scope: "cache-check", caseId: "cache-check", rep, kind: "assistant" });
    const u = normalizeUsage(r.message.usage);
    console.log(`request ${String(rep + 1)}: input=${String(u.input)} cache_write=${String(u.cacheWrite)} cache_read=${String(u.cacheRead)} output=${String(u.output)}`);
    results.push(u);
  }
  const second = results[1];
  const ok = second !== undefined && second.cacheRead > 0;
  console.log(ok ? "prompt cache hit on the second request" : "NO cache read on the second request: look for a silent invalidator");
  console.log(`spend $${spend.spentUsd.toFixed(4)}`);
  return ok ? 0 : 1;
});
