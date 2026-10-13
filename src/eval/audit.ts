/**
 * Tier-1 programmatic checks over the whole dataset (eval-audit.md section 1): balance, duplicates,
 * label leakage, references to books that do not exist, and expectations that the case's own reference answer
 * does not satisfy. Cheap, exhaustive, run in CI as a unit test and via `npm run eval:audit-dataset`.
 */
import type { Catalogue } from "../catalogue/catalogue.js";
import type { GoldenCase } from "./dataset.js";
import { containsFact, normalize, shingles } from "./graders/text.js";

export interface AuditFinding {
  severity: "error" | "warning";
  caseId: string;
  message: string;
}

export interface AuditReport {
  total: number;
  byCategory: Record<string, number>;
  byDifficulty: Record<string, number>;
  decline: number;
  findings: AuditFinding[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function auditDataset(cases: GoldenCase[], catalogue: Catalogue): AuditReport {
  const findings: AuditFinding[] = [];
  const byCategory: Record<string, number> = {};
  const byDifficulty: Record<string, number> = {};
  for (const c of cases) {
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
    byDifficulty[c.difficulty] = (byDifficulty[c.difficulty] ?? 0) + 1;
  }

  const grams = cases.map((c) => ({ id: c.id, g: shingles(c.turns.map((t) => t.user).join(" "), 2) }));
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      const a = grams[i];
      const b = grams[j];
      if (a && b && jaccard(a.g, b.g) > 0.8) findings.push({ severity: "warning", caseId: a.id, message: `near-duplicate of ${b.id}` });
    }
  }

  for (const c of cases) {
    const user = normalize(c.turns.map((t) => t.user).join(" "));
    // Label leakage: an expected fact that the patron already typed proves nothing about the assistant.
    for (const group of c.expect.facts) {
      if (group.every((f) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalize(f))}($|[^a-z0-9])`).test(user))) {
        findings.push({ severity: "warning", caseId: c.id, message: `fact group [${group.join(" / ")}] already appears in the patron's message` });
      }
    }
    // Referenced book ids must exist.
    for (const turn of c.turns) {
      for (const round of turn.reference.tool_calls) {
        for (const step of Array.isArray(round) ? round : [round]) {
          const id = step.input.bookId;
          if (typeof id === "string" && !catalogue.byId.has(id)) findings.push({ severity: "error", caseId: c.id, message: `reference uses unknown bookId ${id}` });
        }
      }
    }
    // The reference answer must satisfy the case's own fact expectations (gold passes its grader).
    const ref = c.turns.at(-1)?.reference.answer ?? "";
    for (const group of c.expect.facts) {
      if (!group.some((f) => containsFact(ref, f))) findings.push({ severity: "error", caseId: c.id, message: `reference answer misses fact group [${group.join(" / ")}]` });
    }
    for (const re of c.expect.must_not_match) {
      try {
        new RegExp(re, "i");
      } catch {
        findings.push({ severity: "error", caseId: c.id, message: `invalid regex ${re}` });
      }
    }
    if (c.expect.scope === "decline" && c.expect.must_call.length > 0) {
      findings.push({ severity: "warning", caseId: c.id, message: "decline case also requires tool calls" });
    }
  }

  // Both directions: the set needs declines and answers, and refusal checks only mean something with both.
  const decline = cases.filter((c) => c.expect.scope === "decline").length;
  if (decline === 0 || decline === cases.length) findings.push({ severity: "error", caseId: "*", message: "dataset needs both decline and answer cases" });
  return { total: cases.length, byCategory, byDifficulty, decline, findings };
}
