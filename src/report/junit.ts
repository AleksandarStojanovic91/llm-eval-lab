/**
 * JUnit XML for CI test reporters: one testsuite per category, one testcase per golden case.
 * A case fails when a majority of its reps fail; flaky cases (mixed results) pass but are flagged in
 * system-out, so they are visible without turning every flaky case red. The regression gate, not JUnit,
 * decides whether CI fails.
 */
import { esc } from "./html.js";
import type { RunSummary } from "../eval/metrics.js";
import type { AttemptRecord } from "../eval/types.js";

export function renderJunit(s: RunSummary, attempts: AttemptRecord[]): string {
  const suites = s.categories.map((cat) => {
    const cases = s.cases.filter((c) => c.category === cat.category);
    const failures = cases.filter((c) => c.passRate <= 0.5).length;
    const body = cases
      .map((c) => {
        const reps = attempts.filter((a) => a.caseId === c.caseId).sort((a, b) => a.rep - b.rep);
        const time = reps.reduce((t, a) => t + a.latencyMs, 0) / 1000;
        const detail = reps
          .map((a) => `rep ${a.rep}: ${a.pass ? "pass" : "fail"}${a.pass ? "" : ` (${a.checks.filter((ch) => !ch.pass).map((ch) => `${ch.id}: ${ch.detail}`).join("; ")})`}`)
          .join("\n");
        const failure = c.passRate <= 0.5 ? `<failure message="${esc(`${c.passes}/${c.reps} reps passed; failing: ${c.failingChecks.join(", ")}`)}">${esc(detail)}</failure>` : "";
        const out = c.flaky ? `<system-out>${esc(`FLAKY: ${c.passes}/${c.reps} reps passed\n${detail}`)}</system-out>` : "";
        return `    <testcase classname="${esc(`eval.${cat.category}`)}" name="${esc(c.caseId)}" time="${time.toFixed(3)}">${failure}${out}</testcase>`;
      })
      .join("\n");
    return `  <testsuite name="${esc(cat.category)}" tests="${cases.length}" failures="${failures}" errors="0">\n${body}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="llm-eval-lab ${esc(s.configName)}">\n${suites.join("\n")}\n</testsuites>\n`;
}
