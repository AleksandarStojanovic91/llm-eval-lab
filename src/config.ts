/**
 * Eval configuration: which assistant and judge to run, how many repetitions, and the regression gates.
 * A config file may `extends` another one (path relative to itself) and override any field.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PRICES } from "./llm/pricing.js";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/**
 * Which models accept the server-side refusal fallback, per the Claude API skill:
 * Opus 5.5 documents `fallbacks: "default"`; Haiku 5.5 states there is no server-side fallback;
 * the skill does not document it for Sonnet 5.5, so it stays off there until verified.
 */
export const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5"]);

export const CATEGORIES = [
  "lookup",
  "availability",
  "rules",
  "recommendation",
  "multi-turn",
  "out-of-scope",
  "adversarial",
] as const;
export type Category = (typeof CATEGORIES)[number];

const Gates = z.strictObject({
  /** Mean deterministic pass rate over all (case, rep) attempts. */
  minPassRate: z.number().min(0).max(1),
  /** Per-category minimum mean pass rate; `default` applies to categories not listed. */
  minCategoryPassRate: z.record(z.string(), z.number().min(0).max(1)),
  /** Categories where every repetition of every case must pass (pass^k = 1): high-stakes behaviour. */
  requireAllRepsPass: z.array(z.enum(CATEGORIES)),
  /** Minimum share of judged attempts where every judge criterion passed. Ignored when the judge is off. */
  minJudgePassRate: z.number().min(0).max(1),
  maxFlakyCases: z.number().int().min(0),
  /** Harness errors (API errors, timeouts, cassette misses) allowed before the run is invalid. */
  maxErrors: z.number().int().min(0),
  maxLatencyP95Ms: z.number().positive(),
  maxCostPerRunUsd: z.number().positive(),
  minCacheHitRatio: z.number().min(0).max(1),
  maxFallbackRate: z.number().min(0).max(1),
});

export const EvalConfig = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes (used as a cassette folder)"),
  description: z.string().default(""),
  dataset: z.string(),
  fixtures: z.string(),
  cassettes: z.string(),
  assistant: z.strictObject({
    model: z.string(),
    promptVersion: z.enum(["v1", "v2"]),
    effort: Effort,
    maxTokens: z.number().int().positive(),
    maxToolRounds: z.number().int().positive(),
    fallbacks: z.enum(["default", "off"]),
  }),
  judge: z.strictObject({
    enabled: z.boolean(),
    model: z.string(),
    effort: Effort,
    maxTokens: z.number().int().positive(),
  }),
  run: z.strictObject({
    runs: z.number().int().min(1),
    concurrency: z.number().int().min(1),
    caseTimeoutSeconds: z.number().positive(),
  }),
  grading: z.strictObject({
    maxWords: z.record(z.string(), z.number().int().positive()),
    maxToolCalls: z.number().int().positive(),
  }),
  gates: Gates,
});
export type EvalConfig = z.infer<typeof EvalConfig>;
export type GatesConfig = z.infer<typeof Gates>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

function loadRaw(path: string, seen: Set<string>): Record<string, unknown> {
  const abs = resolve(path);
  if (seen.has(abs)) throw new Error(`config extends cycle at ${abs}`);
  seen.add(abs);
  const raw = parseYaml(readFileSync(abs, "utf8")) as unknown;
  if (!isPlainObject(raw)) throw new Error(`${abs}: expected a YAML mapping`);
  const { extends: parent, ...rest } = raw;
  // Paths inside a config are relative to the repository root (the working directory), not to the file.
  if (typeof parent === "string") {
    return deepMerge(loadRaw(resolve(dirname(abs), parent), seen), rest) as Record<string, unknown>;
  }
  return rest;
}

export function loadConfig(path: string): EvalConfig {
  const config = EvalConfig.parse(loadRaw(path, new Set()));
  for (const model of [config.assistant.model, config.judge.model]) {
    if (!(model in PRICES)) throw new Error(`${path}: model ${model} has no entry in the price table (src/llm/pricing.ts)`);
  }
  if (config.assistant.fallbacks === "default" && !SERVER_FALLBACK_MODELS.has(config.assistant.model)) {
    throw new Error(
      `${path}: fallbacks "default" is only configured for ${[...SERVER_FALLBACK_MODELS].join(", ")}; set assistant.fallbacks: off for ${config.assistant.model}`,
    );
  }
  return config;
}
