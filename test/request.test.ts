import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildRequest, FALLBACK_BETA, type AssistantSettings } from "../src/assistant/agent.js";
import { SYSTEM_PROMPTS } from "../src/assistant/prompts.js";
import { executeTool, TOOLS } from "../src/assistant/tools.js";
import { loadConfig } from "../src/config.js";
import { canonicalJson } from "../src/llm/cassettes.js";
import { backend } from "./helpers.js";

const settings: AssistantSettings = { model: "claude-opus-5-5", promptVersion: "v2", effort: "medium", maxTokens: 16000, fallbacks: "default", maxToolRounds: 6 };

describe("assistant request shape (Claude API skill rules for Opus 5.5)", () => {
  const req = buildRequest(settings, [{ role: "user", content: "hi" }]);

  it("omits thinking (adaptive by default) and tool_choice (forced choice is a 400 on Opus 5.5)", () => {
    expect(req).not.toHaveProperty("thinking");
    expect(req).not.toHaveProperty("tool_choice");
  });

  it("sets effort explicitly", () => {
    expect(req.output_config?.effort).toBe("medium");
  });

  it("opts into the server-side refusal fallback with the default form and its beta header", () => {
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual([FALLBACK_BETA]);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
    const off = buildRequest({ ...settings, fallbacks: "off" }, []);
    expect(off).not.toHaveProperty("fallbacks");
    expect(off).not.toHaveProperty("betas");
  });

  it("caches the frozen system prompt explicitly and the conversation tail automatically", () => {
    expect(Array.isArray(req.system) && req.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.cache_control).toEqual({ type: "ephemeral" });
  });

  it("renders a byte-identical prefix (tools + system) for different conversations", () => {
    const a = buildRequest(settings, [{ role: "user", content: "Is Clean Code available?" }]);
    const b = buildRequest(settings, [{ role: "user", content: "How long can I keep a book?" }, { role: "assistant", content: "14 days" }]);
    expect(canonicalJson({ tools: a.tools, system: a.system })).toBe(canonicalJson({ tools: b.tools, system: b.system }));
  });

  it("keeps silent cache invalidators out of the system prompts", () => {
    for (const p of Object.values(SYSTEM_PROMPTS)) {
      expect(p).not.toMatch(/\b20\d\d-\d\d-\d\d\b/); // dates
      expect(p).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/); // uuids
    }
  });
});

describe("tool definitions", () => {
  it("are sorted by name, strict, closed, and free of keywords strict mode does not support", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["get_book", "get_loan_rules", "list_copies", "search_books"]);
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(JSON.stringify(t.input_schema)).not.toMatch(/minLength|maxLength|minimum|maximum|pattern/);
      expect(t.description?.length).toBeGreaterThan(80);
    }
  });

  it("validates inputs before running anything", async () => {
    expect((await executeTool("get_book", { bookId: "x" }, backend)).isError).toBe(true);
    expect((await executeTool("get_loan_rules", { extra: 1 }, backend)).inputValid).toBe(false);
    expect((await executeTool("delete_book", {}, backend)).content).toContain("Unknown tool");
    expect((await executeTool("search_books", { q: "a".repeat(201) }, backend)).inputValid).toBe(false);
    const ok = await executeTool("search_books", { q: "Clean Code" }, backend);
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content)).toMatchObject({ results: [{ title: "Clean Code", availableCopies: 1, totalCopies: 2 }] });
  });
});

describe("config", () => {
  it("loads the baseline and the variants", () => {
    expect(loadConfig("eval.config.yaml").assistant.model).toBe("claude-opus-5-5");
    expect(loadConfig("configs/prompt-v1.yaml").assistant.promptVersion).toBe("v1");
    expect(loadConfig("configs/sonnet-5-5.yaml").assistant.fallbacks).toBe("off");
    expect(loadConfig("configs/haiku-5-5.yaml").assistant.model).toBe("claude-haiku-5-5");
  });

  it("refuses fallbacks on a model without a documented server-side fallback", () => {
    const p = join(tmpdir(), `cfg-${String(process.pid)}.yaml`);
    writeFileSync(p, `extends: ${join(process.cwd(), "eval.config.yaml")}\nname: bad\nassistant:\n  model: claude-haiku-5-5\n`);
    expect(() => loadConfig(p)).toThrow(/fallbacks/);
  });
});
