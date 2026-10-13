/**
 * Runs every (case, rep) through the real assistant entry point (runConversation), grades it, and writes
 * results as each attempt finishes. Properties from the Claude API skill's eval guidance (build-eval.md, step 3):
 *  - rows are appended as attempts complete, and --resume skips (case, rep) keys already in results.jsonl;
 *  - a hard wall-clock ceiling per attempt, independent of the API client's own timeouts;
 *  - harness failures (API errors, timeouts, cassette misses, grader errors) go to errors.jsonl with a failure
 *    class, never into results.jsonl, so plumbing is never scored as a model failure;
 *  - a fatal error (bad credentials, budget reached) stops scheduling new attempts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runConversation, type AssistantSettings, type ConversationResult } from "../assistant/agent.js";
import { SYSTEM_PROMPTS } from "../assistant/prompts.js";
import type { LibraryBackend } from "../backends/types.js";
import type { Catalogue } from "../catalogue/catalogue.js";
import type { EvalConfig } from "../config.js";
import { addUsage, ZERO_USAGE } from "../llm/pricing.js";
import {
  HarnessError,
  type AssistantMessage,
  type AssistantParams,
  type JudgeMessage,
  type JudgeParams,
  type Transport,
} from "../llm/transport.js";
import { finalReference, userTurns, type GoldenCase } from "./dataset.js";
import { gradeDeterministic } from "./graders/deterministic.js";
import { renderTranscript, runJudge } from "./judge.js";
import type { AttemptError, AttemptRecord } from "./types.js";

export interface RunnerDeps {
  config: EvalConfig;
  cases: GoldenCase[];
  catalogue: Catalogue;
  backend: LibraryBackend;
  assistantTransport: Transport<AssistantParams, AssistantMessage>;
  judgeTransport?: Transport<JudgeParams, JudgeMessage>;
  runs: number;
  concurrency: number;
  outDir: string;
  resume?: boolean;
  log?: (line: string) => void;
}

export interface RunOutput {
  attempts: AttemptRecord[];
  errors: AttemptError[];
  aborted: boolean;
}

export function assistantSettings(config: EvalConfig): AssistantSettings {
  return { ...config.assistant };
}

function provenanceOf(conv: ConversationResult): AttemptRecord["provenance"] {
  const sources = new Set(conv.modelCalls.map((c) => (c.source === "replay" ? `replay:${c.recordedFrom ?? "live"}` : c.source)));
  if (sources.size === 1) return [...sources][0] as AttemptRecord["provenance"];
  return sources.has("replay:synthetic") ? "replay:synthetic" : "replay:live";
}

/** Trace in the shape the skill's report tooling reads: system / user / tool_call / tool_result / assistant turns. */
export function traceOf(conv: ConversationResult, systemPrompt: string): unknown[] {
  const out: unknown[] = [{ role: "system", content: systemPrompt }];
  conv.turns.forEach((turn, i) => {
    out.push({ role: "user", content: turn.user });
    for (const call of conv.toolCalls.filter((t) => t.turn === i)) {
      out.push({ role: "tool_call", name: call.name, content: JSON.stringify(call.input, null, 2) });
      out.push({ role: "tool_result", name: call.name, content: call.output, ...(call.isError ? { is_error: true } : {}) });
    }
    out.push({ role: "assistant", content: turn.answer });
  });
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HarnessError("timeout", `attempt exceeded the ${Math.round(ms / 1000)} s wall-clock ceiling`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export async function gradeAttempt(
  c: GoldenCase,
  rep: number,
  conv: ConversationResult,
  deps: Pick<RunnerDeps, "config" | "catalogue" | "judgeTransport">,
): Promise<AttemptRecord> {
  const { config } = deps;
  const checks = gradeDeterministic(c, conv, {
    catalogue: deps.catalogue,
    systemPrompt: SYSTEM_PROMPTS[config.assistant.promptVersion],
    maxWords: config.grading.maxWords[c.category] ?? 150,
    maxToolCalls: config.grading.maxToolCalls,
  });
  const usage = conv.modelCalls.reduce((u, m) => addUsage(u, m.usage), ZERO_USAGE);
  const last = conv.modelCalls.at(-1);
  const record: AttemptRecord = {
    caseId: c.id,
    rep,
    category: c.category,
    difficulty: c.difficulty,
    tags: c.tags,
    status: conv.status === "truncated" ? "truncated" : "ok",
    conversationStatus: conv.status,
    pass: checks.every((ch) => ch.pass),
    checks,
    userTurns: userTurns(c),
    finalAnswer: conv.finalAnswer,
    requestedModel: config.assistant.model,
    model: last?.servedModel ?? config.assistant.model,
    usage,
    costUsd: conv.modelCalls.reduce((s, m) => s + m.costUsd, 0),
    latencyMs: conv.modelCalls.reduce((s, m) => s + m.latencyMs, 0),
    modelCalls: conv.modelCalls.length,
    toolCalls: conv.toolCalls.length,
    retries: conv.modelCalls.reduce((s, m) => s + (m.attempts - 1), 0),
    fallbackUsed: conv.modelCalls.some((m) => m.fallbackUsed),
    ...(conv.refusal ? { refusalCategory: conv.refusal.category } : {}),
    provenance: provenanceOf(conv),
  };
  if (config.judge.enabled && deps.judgeTransport && record.status === "ok") {
    const j = await runJudge(
      deps.judgeTransport,
      { model: config.judge.model, effort: config.judge.effort, maxTokens: config.judge.maxTokens },
      { scope: c.expect.scope, referenceAnswer: finalReference(c), transcript: renderTranscript(conv), finalAnswer: conv.finalAnswer },
      { scope: config.name, caseId: c.id, rep },
    );
    record.judge = { model: j.model, pass: j.pass, verdicts: j.verdicts, usage: j.usage, costUsd: j.costUsd, latencyMs: j.latencyMs };
  }
  return record;
}

/** Row for results.jsonl: the full record plus the field names the skill's report builders read. */
function toRow(r: AttemptRecord): Record<string, unknown> {
  return {
    prompt_id: r.caseId,
    prompt: r.userTurns.join("\n---\n"),
    tags: [r.category, r.difficulty, ...r.tags],
    status: r.status,
    stop_reason: r.conversationStatus,
    grade: { deterministic: r.pass ? 1 : 0, ...(r.judge ? { judge: r.judge.pass ? 1 : 0 } : {}) },
    model: r.model,
    usage: {
      input_tokens: r.usage.input,
      output_tokens: r.usage.output,
      cache_read_input_tokens: r.usage.cacheRead,
      cache_creation_input_tokens: r.usage.cacheWrite,
    },
    ...(r.judge ? { judge_model: r.judge.model } : {}),
    latency_s: Number((r.latencyMs / 1000).toFixed(3)),
    tool_calls: r.toolCalls,
    record: r,
  };
}

export function readExistingResults(outDir: string): AttemptRecord[] {
  const p = join(outDir, "results.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as { record: AttemptRecord }).record);
}

export async function runEval(deps: RunnerDeps): Promise<RunOutput> {
  const { config, cases, outDir } = deps;
  const log = deps.log ?? (() => undefined);
  mkdirSync(join(outDir, "traces"), { recursive: true });
  const resultsPath = join(outDir, "results.jsonl");
  const errorsPath = join(outDir, "errors.jsonl");

  const attempts: AttemptRecord[] = deps.resume ? readExistingResults(outDir) : [];
  if (!deps.resume) {
    writeFileSync(resultsPath, "");
    writeFileSync(errorsPath, "");
  }
  const done = new Set(attempts.map((a) => `${a.caseId}#${a.rep}`));
  const errors: AttemptError[] = [];

  const tasks: { c: GoldenCase; rep: number }[] = [];
  for (let rep = 0; rep < deps.runs; rep++) {
    for (const c of cases) if (!done.has(`${c.id}#${rep}`)) tasks.push({ c, rep });
  }
  if (done.size > 0) log(`resume: ${done.size} attempt(s) already in ${resultsPath}, ${tasks.length} to run`);

  let aborted = false;
  let next = 0;
  const settings = assistantSettings(config);
  const timeoutMs = config.run.caseTimeoutSeconds * 1000;

  const worker = async (): Promise<void> => {
    while (!aborted) {
      const task = tasks[next++];
      if (!task) return;
      const { c, rep } = task;
      try {
        const record = await withTimeout(
          (async () => {
            const conv = await runConversation(userTurns(c), {
              transport: deps.assistantTransport,
              backend: deps.backend,
              settings,
              ctx: { scope: config.name, caseId: c.id, rep },
            });
            writeFileSync(join(outDir, "traces", `${c.id}_rep${rep}.json`), `${JSON.stringify(traceOf(conv, SYSTEM_PROMPTS[settings.promptVersion]), null, 2)}\n`);
            return gradeAttempt(c, rep, conv, deps);
          })(),
          timeoutMs,
        );
        attempts.push(record);
        appendFileSync(resultsPath, `${JSON.stringify(toRow(record))}\n`);
        log(`${record.pass ? "PASS" : "FAIL"} ${c.id} rep ${rep}${record.judge ? ` judge:${record.judge.pass ? "pass" : "fail"}` : ""}`);
      } catch (err) {
        const he = err instanceof HarnessError ? err : new HarnessError("api_error", String(err), false, { cause: err });
        const e: AttemptError = { caseId: c.id, rep, failureClass: he.failureClass, message: he.message };
        errors.push(e);
        appendFileSync(errorsPath, `${JSON.stringify(e)}\n`);
        log(`ERROR ${c.id} rep ${rep} [${he.failureClass}] ${he.message}`);
        if (he.fatal) {
          aborted = true;
          log("fatal error: no new attempts will be started");
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency, tasks.length)) }, worker));
  attempts.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.rep - b.rep);
  return { attempts, errors, aborted };
}
