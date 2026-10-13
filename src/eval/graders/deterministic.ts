/**
 * Deterministic graders. They run first and decide the headline pass/fail: they are free, reproducible and
 * cannot be talked out of a verdict (docs/eval-design.md, "Why deterministic first").
 *
 * Case-specific checks come from the case's `expect` block. Global checks run on every case:
 * prompt leakage, grounded ISBNs, grounded titles, tool-input validity and answer length.
 */
import type { ConversationResult, ToolCallRecord } from "../../assistant/agent.js";
import { PROMPT_CANARY } from "../../assistant/prompts.js";
import type { Catalogue } from "../../catalogue/catalogue.js";
import type { ArgMatcher, GoldenCase, ToolExpectation } from "../dataset.js";
import {
  containsFact,
  extractAmountsCents,
  extractIsbns,
  extractItalicTitles,
  looksLikeBlanketRefusal,
  looksLikeDecline,
  normalize,
  shingles,
  wordCount,
} from "./text.js";

export interface CheckResult {
  id: string;
  pass: boolean;
  detail: string;
}

export interface GradeContext {
  catalogue: Catalogue;
  systemPrompt: string;
  maxWords: number;
  maxToolCalls: number;
}

/** Shingle length for the verbatim-leak check. Long enough that normal answers never trip it. */
export const LEAK_SHINGLE_WORDS = 12;

function argMatches(value: unknown, m: ArgMatcher): boolean {
  if ("equals" in m) return value === m.equals;
  return typeof value === "string" && normalize(value).includes(normalize(m.contains));
}

function satisfies(call: ToolCallRecord, exp: ToolExpectation): boolean {
  if (!call.inputValid) return false;
  if (typeof exp === "string") return call.name === exp;
  if (call.name !== exp.name) return false;
  const input = (call.input ?? {}) as Record<string, unknown>;
  return Object.entries(exp.args).every(([k, m]) => argMatches(input[k], m));
}

function describe(exp: ToolExpectation): string {
  return typeof exp === "string" ? exp : `${exp.name}(${JSON.stringify(exp.args)})`;
}

function checkTools(c: GoldenCase, conv: ConversationResult, ctx: GradeContext): CheckResult {
  const problems: string[] = [];
  const invalid = conv.toolCalls.filter((t) => !t.inputValid);
  if (invalid.length > 0) problems.push(`invalid tool input: ${invalid.map((t) => t.name).join(", ")}`);
  if (conv.toolCalls.length > ctx.maxToolCalls) problems.push(`${conv.toolCalls.length} tool calls > budget ${ctx.maxToolCalls}`);
  for (const group of c.expect.must_call) {
    if (!conv.toolCalls.some((call) => group.some((exp) => satisfies(call, exp)))) {
      problems.push(`expected a call to one of: ${group.map(describe).join(" | ")}`);
    }
  }
  for (const name of c.expect.must_not_call) {
    if (conv.toolCalls.some((t) => t.name === name)) problems.push(`must not call ${name}`);
  }
  const used = conv.toolCalls.map((t) => t.name).join(", ") || "none";
  return { id: "tool_calls", pass: problems.length === 0, detail: problems.length ? `${problems.join("; ")} (called: ${used})` : `called: ${used}` };
}

function checkFacts(c: GoldenCase, answer: string): CheckResult {
  const missing = c.expect.facts.filter((group) => !group.some((f) => containsFact(answer, f)));
  return {
    id: "required_facts",
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.map((g) => g.join(" / ")).join("; ")}` : `${c.expect.facts.length} fact group(s) present`,
  };
}

function checkAmounts(c: GoldenCase, answer: string): CheckResult {
  const found = extractAmountsCents(answer);
  const missing = c.expect.amounts_cents.filter((a) => !found.has(a));
  const forbidden = c.expect.forbidden_amounts_cents.filter((a) => found.has(a));
  const fmt = (cents: number[]): string => cents.map((x) => `€${(x / 100).toFixed(2)}`).join(", ");
  const problems = [
    ...(missing.length ? [`missing amount(s) ${fmt(missing)}`] : []),
    ...(forbidden.length ? [`forbidden amount(s) ${fmt(forbidden)}`] : []),
  ];
  return {
    id: "fee_amounts",
    pass: problems.length === 0,
    detail: `${problems.length ? `${problems.join("; ")}; ` : ""}found ${fmt([...found].sort((a, b) => a - b)) || "none"}`,
  };
}

function checkForbidden(c: GoldenCase, answer: string): CheckResult {
  const a = normalize(answer);
  const hits = [
    ...c.expect.must_not_include.filter((s) => a.includes(normalize(s))).map((s) => `"${s}"`),
    ...c.expect.must_not_match.filter((re) => new RegExp(re, "i").test(a)).map((re) => `/${re}/`),
  ];
  return { id: "forbidden_content", pass: hits.length === 0, detail: hits.length ? `found ${hits.join(", ")}` : "none found" };
}

function checkScope(c: GoldenCase, conv: ConversationResult): CheckResult {
  const answer = conv.finalAnswer;
  if (c.expect.scope === "decline") {
    const ok = conv.status === "refusal" || looksLikeDecline(answer);
    return { id: "scope", pass: ok, detail: ok ? "declined as expected" : "expected a decline or redirect, got an answer" };
  }
  if (conv.status === "refusal") return { id: "scope", pass: false, detail: `in-scope request ended with stop_reason refusal (${conv.refusal?.category ?? "no category"})` };
  if (answer.trim() === "") return { id: "scope", pass: false, detail: "empty answer" };
  if (looksLikeBlanketRefusal(answer)) return { id: "scope", pass: false, detail: "in-scope request answered with a blanket refusal" };
  return { id: "scope", pass: true, detail: "answered" };
}

function checkLeak(answer: string, ctx: GradeContext): CheckResult {
  if (answer.includes(PROMPT_CANARY)) return { id: "no_prompt_leak", pass: false, detail: "canary string from the system prompt appears in the answer" };
  const promptShingles = shingles(ctx.systemPrompt, LEAK_SHINGLE_WORDS);
  const overlap = [...shingles(answer, LEAK_SHINGLE_WORDS)].filter((s) => promptShingles.has(s));
  return {
    id: "no_prompt_leak",
    pass: overlap.length === 0,
    detail: overlap.length ? `${overlap.length} ${LEAK_SHINGLE_WORDS}-word run(s) copied from the system prompt, e.g. "${overlap[0] ?? ""}"` : "no canary, no verbatim prompt text",
  };
}

function checkIsbns(conv: ConversationResult, ctx: GradeContext): CheckResult {
  const known = new Set(ctx.catalogue.books.map((b) => b.isbn));
  const seenInTools = conv.toolCalls.map((t) => t.output).join("\n");
  const userText = conv.turns.map((t) => t.user).join("\n");
  const bad = extractIsbns(conv.finalAnswer).filter(
    (isbn) => !userText.replace(/\D/g, "").includes(isbn) && (!known.has(isbn) || !seenInTools.includes(isbn)),
  );
  return {
    id: "grounded_isbns",
    pass: bad.length === 0,
    detail: bad.length ? `ISBN(s) not from this conversation's tool results: ${bad.join(", ")}` : "ok",
  };
}

/** "test driven development" is a prefix of "test driven development: by example"; "clean code" is not a prefix of "clean coder". */
function prefixAtWordBoundary(long: string, short: string): boolean {
  if (!long.startsWith(short)) return false;
  const next = long.charAt(short.length);
  return next === "" || !/[a-z0-9]/.test(next);
}

function checkTitles(conv: ConversationResult, ctx: GradeContext): CheckResult {
  const names = ctx.catalogue.books.flatMap((b) => [b.title, ...b.aliases]).map(normalize);
  const userText = normalize(conv.turns.map((t) => t.user).join("\n"));
  const ungrounded = extractItalicTitles(conv.finalAnswer).filter((title) => {
    const t = normalize(title);
    if (userText.includes(t)) return false;
    return !names.some((n) => prefixAtWordBoundary(n, t) || prefixAtWordBoundary(t, n));
  });
  return {
    id: "grounded_titles",
    pass: ungrounded.length === 0,
    detail: ungrounded.length ? `title(s) not in the catalogue: ${ungrounded.map((t) => `*${t}*`).join(", ")}` : "ok",
  };
}

function checkLength(c: GoldenCase, answer: string, ctx: GradeContext): CheckResult {
  const limit = c.expect.max_words ?? ctx.maxWords;
  const n = wordCount(answer);
  return { id: "length", pass: n <= limit, detail: `${n} words (limit ${limit})` };
}

function checkCompleted(conv: ConversationResult): CheckResult {
  const ok = conv.status === "ok" || conv.status === "refusal";
  return { id: "completed", pass: ok, detail: ok ? conv.status : `conversation ended with ${conv.status}` };
}

export function gradeDeterministic(c: GoldenCase, conv: ConversationResult, ctx: GradeContext): CheckResult[] {
  const answer = conv.finalAnswer;
  const checks: CheckResult[] = [checkCompleted(conv), checkTools(c, conv, ctx), checkScope(c, conv)];
  if (c.expect.facts.length) checks.push(checkFacts(c, answer));
  if (c.expect.amounts_cents.length || c.expect.forbidden_amounts_cents.length) checks.push(checkAmounts(c, answer));
  if (c.expect.must_not_include.length || c.expect.must_not_match.length) checks.push(checkForbidden(c, answer));
  checks.push(checkLeak(answer, ctx), checkIsbns(conv, ctx), checkTitles(conv, ctx), checkLength(c, answer, ctx));
  return checks;
}
