/**
 * Shared wiring for the CLIs: modes, transports, backends and output files.
 *
 * Modes:
 *   --replay (default)  read responses from cassettes; no network, no key, no cost. What CI runs.
 *   --record            call the Claude API and write/refresh cassettes. Needs a key and --budget-usd.
 *   --live              call the Claude API without writing cassettes. Needs a key and --budget-usd.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpLibraryBackend } from "../backends/http.js";
import { FakeLibraryBackend } from "../backends/fake.js";
import type { LibraryBackend } from "../backends/types.js";
import { loadCatalogue, type Catalogue } from "../catalogue/catalogue.js";
import type { EvalConfig } from "../config.js";
import { CassetteStore, RecordingTransport, ReplayTransport } from "../llm/cassettes.js";
import { createClient, LiveAssistantTransport, LiveJudgeTransport, SpendTracker } from "../llm/live.js";
import type { AssistantMessage, AssistantParams, JudgeMessage, JudgeParams, Transport } from "../llm/transport.js";

export type Mode = "replay" | "record" | "live";

export function modeFrom(values: { replay?: boolean; record?: boolean; live?: boolean }): Mode {
  const chosen = (["replay", "record", "live"] as const).filter((m) => values[m] === true);
  if (chosen.length > 1) throw new UsageError(`choose one of --replay, --record, --live (got ${chosen.join(", ")})`);
  return chosen[0] ?? "replay";
}

export class UsageError extends Error {}

export function requireBudget(mode: Mode, budget: string | undefined): SpendTracker | undefined {
  if (mode === "replay") return undefined;
  if (budget === undefined) {
    throw new UsageError(`--${mode} calls the Claude API and costs money: pass --budget-usd <amount> (the run stops when it is reached). Estimate first with npm run eval:estimate-cost.`);
  }
  const limit = Number(budget);
  if (!Number.isFinite(limit) || limit <= 0) throw new UsageError(`--budget-usd must be a positive number (got ${budget})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("warning: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set; the SDK will try an `ant auth login` profile.");
  }
  return new SpendTracker(limit);
}

export interface Transports {
  assistant: Transport<AssistantParams, AssistantMessage>;
  judge: Transport<JudgeParams, JudgeMessage>;
  spend?: SpendTracker;
}

export function buildTransports(mode: Mode, cassetteRoot: string, spend: SpendTracker | undefined): Transports {
  const store = new CassetteStore(cassetteRoot);
  if (mode === "replay") return { assistant: new ReplayTransport(store), judge: new ReplayTransport(store) };
  if (!spend) throw new UsageError("a budget is required for live calls");
  const client = createClient();
  const assistant = new LiveAssistantTransport(client, spend);
  const judge = new LiveJudgeTransport(client, spend);
  if (mode === "record") return { assistant: new RecordingTransport(assistant, store), judge: new RecordingTransport(judge, store), spend };
  return { assistant, judge, spend };
}

export function buildBackend(kind: string | undefined, catalogue: Catalogue): LibraryBackend {
  if (kind === undefined || kind === "fake") return new FakeLibraryBackend(catalogue);
  if (kind === "http") {
    const url = process.env.LIBRARY_API_URL ?? "http://localhost:8082";
    return new HttpLibraryBackend({ baseUrl: url });
  }
  throw new UsageError(`--backend must be fake or http (got ${kind})`);
}

export function loadFixtures(config: EvalConfig): Catalogue {
  return loadCatalogue(config.fixtures);
}

export function writeText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

export function loadTraces(outDir: string): Map<string, { role: string; content: string; name?: string; is_error?: boolean }[]> {
  const dir = join(outDir, "traces");
  const out = new Map<string, { role: string; content: string; name?: string; is_error?: boolean }[]>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = /^(.+)_rep(\d+)\.json$/.exec(f);
    if (!m?.[1] || m[2] === undefined) continue;
    out.set(`${m[1]}#${m[2]}`, JSON.parse(readFileSync(join(dir, f), "utf8")) as { role: string; content: string }[]);
  }
  return out;
}

export function runCli(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof UsageError) {
        console.error(`usage error: ${err.message}`);
        process.exitCode = 64;
        return;
      }
      console.error(err);
      process.exitCode = 2;
    },
  );
}
