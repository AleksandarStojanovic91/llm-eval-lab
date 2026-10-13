/**
 * Golden dataset schema and loader. One YAML file per category under datasets/golden/.
 *
 * Each case carries:
 *  - the patron's turns (multi-turn cases have several), each with a hand-written reference: the tool calls a
 *    careful assistant would make and an answer that passes every deterministic check (the "oracle", used by
 *    test/oracle.test.ts and as the default script for the synthetic replay set);
 *  - `expect`: what the deterministic graders check. Expectations describe outcomes (facts, numbers, scope,
 *    forbidden content) and only require tools where grounding matters; they do not dictate a call sequence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CATEGORIES } from "../config.js";

const ArgMatcher = z.union([
  z.strictObject({ equals: z.union([z.string(), z.number(), z.boolean()]) }),
  z.strictObject({ contains: z.string() }),
]);

const ToolExpectation = z.union([
  z.string(),
  z.strictObject({ name: z.string(), args: z.record(z.string(), ArgMatcher) }),
]);

const ToolStep = z.strictObject({ name: z.string(), input: z.record(z.string(), z.unknown()) });
/** A reference round: one tool call, or several issued in parallel in the same assistant turn. */
const ReferenceRound = z.union([ToolStep, z.array(ToolStep).min(2)]);

const Turn = z.strictObject({
  user: z.string().min(1),
  reference: z.strictObject({
    tool_calls: z.array(ReferenceRound).default([]),
    answer: z.string().min(1),
  }),
});

const Expect = z.strictObject({
  /** Each group must be satisfied by at least one tool call (any of the listed tools, with matching args). */
  must_call: z.array(z.array(ToolExpectation).min(1)).default([]),
  must_not_call: z.array(z.string()).default([]),
  /** Each group must appear in the final answer; alternatives inside a group are synonyms. Case/diacritics-insensitive. */
  facts: z.array(z.array(z.string().min(1)).min(1)).default([]),
  /** Money amounts (in euro cents) that must appear in the final answer. */
  amounts_cents: z.array(z.number().int().min(0)).default([]),
  forbidden_amounts_cents: z.array(z.number().int().min(0)).default([]),
  must_not_include: z.array(z.string().min(1)).default([]),
  /** Regular expressions (case-insensitive) that must not match the final answer. */
  must_not_match: z.array(z.string().min(1)).default([]),
  /** "decline": the right behaviour is to refuse or redirect. "answer": a refusal is a failure. */
  scope: z.enum(["answer", "decline"]).default("answer"),
  max_words: z.number().int().positive().optional(),
});

export const GoldenCase = z.strictObject({
  id: z.string().regex(/^[a-z]+(-[a-z]+)*-\d{3}$/),
  category: z.enum(CATEGORIES),
  difficulty: z.enum(["easy", "medium", "hard"]),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  turns: z.array(Turn).min(1),
  expect: Expect,
});

export type GoldenCase = z.infer<typeof GoldenCase>;
export type ToolStep = z.infer<typeof ToolStep>;
export type ReferenceRound = z.infer<typeof ReferenceRound>;
export type ToolExpectation = z.infer<typeof ToolExpectation>;
export type ArgMatcher = z.infer<typeof ArgMatcher>;

const DatasetFile = z.strictObject({ cases: z.array(GoldenCase) });

export function loadDataset(dir: string): GoldenCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const cases: GoldenCase[] = [];
  for (const f of files) {
    const parsed = DatasetFile.safeParse(parseYaml(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${join(dir, f)}: ${z.prettifyError(parsed.error)}`);
    cases.push(...parsed.data.cases);
  }
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}

export function userTurns(c: GoldenCase): string[] {
  return c.turns.map((t) => t.user);
}

export function finalReference(c: GoldenCase): string {
  const last = c.turns.at(-1);
  if (!last) throw new Error(`case ${c.id} has no turns`);
  return last.reference.answer;
}
