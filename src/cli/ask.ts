/**
 * npm run ask -- --budget-usd 0.50 [--backend fake|http] [--config eval.config.yaml] "question" ["follow-up" ...]
 *
 * Talks to the assistant for real: live Claude API calls (needs ANTHROPIC_API_KEY), tools against the fixture
 * catalogue or, with --backend http, a running library-api (LIBRARY_API_URL, default http://localhost:8082).
 * Prints each answer, the tool calls, token usage, cache reads and cost. Same code path as the eval.
 */
import { parseArgs } from "node:util";
import { runConversation } from "../assistant/agent.js";
import { loadConfig } from "../config.js";
import { createClient, LiveAssistantTransport } from "../llm/live.js";
import { assistantSettings } from "../eval/runner.js";
import { buildBackend, loadFixtures, requireBudget, runCli, UsageError } from "./common.js";

runCli(async () => {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: "string", default: "eval.config.yaml" },
      backend: { type: "string", default: "fake" },
      "budget-usd": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length === 0) throw new UsageError('pass at least one question, e.g. npm run ask -- --budget-usd 0.5 "Is Clean Code available?"');
  const config = loadConfig(values.config);
  const spend = requireBudget("live", values["budget-usd"]);
  if (!spend) throw new UsageError("a budget is required");
  const backend = buildBackend(values.backend, loadFixtures(config));
  const conv = await runConversation(positionals, {
    transport: new LiveAssistantTransport(createClient(), spend),
    backend,
    settings: assistantSettings(config),
    ctx: { scope: "ask", caseId: "ask", rep: 0 },
  });
  conv.turns.forEach((turn, i) => {
    console.log(`\npatron: ${turn.user}`);
    for (const t of conv.toolCalls.filter((c) => c.turn === i)) console.log(`  [${backend.kind}] ${t.name} ${JSON.stringify(t.input)}${t.isError ? " (error)" : ""}`);
    console.log(`assistant: ${turn.answer}${turn.status === "ok" ? "" : `  [${turn.status}]`}`);
  });
  console.log("");
  for (const m of conv.modelCalls) {
    console.log(
      `call t${m.turn}r${m.round}: ${m.servedModel} stop=${m.stopReason} in=${m.usage.input} cache_write=${m.usage.cacheWrite} cache_read=${m.usage.cacheRead} out=${m.usage.output} ${Math.round(m.latencyMs)} ms $${m.costUsd.toFixed(4)}${m.fallbackUsed ? " (served by fallback)" : ""}`,
    );
  }
  console.log(`total spend $${spend.spentUsd.toFixed(4)}`);
  return 0;
});
