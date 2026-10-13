/**
 * Self-contained HTML report: no external scripts, styles or fonts, so it can be opened from a CI artifact.
 * Everything that comes from cases, models or tool results is untrusted text (book descriptions contain prompt
 * injections on purpose), so all of it goes through esc() and nothing is ever inserted as HTML.
 *
 * Chart choices follow the dataviz guidance: horizontal bars for a magnitude per category (one hue),
 * Wilson intervals as thin whiskers, the gate threshold as a tick, a table view next to every chart,
 * native hover tooltips on each mark, status shown with a text label and an icon, never colour alone.
 */
import type { ComparisonResult } from "../eval/compare.js";
import type { GateResult } from "../eval/gates.js";
import { JUDGE_CRITERIA } from "../eval/judge.js";
import type { RunSummary } from "../eval/metrics.js";
import type { AttemptError, AttemptRecord } from "../eval/types.js";

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const pct = (x: number | null, digits = 1): string => (x === null || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(digits)}%`);
const usd = (x: number): string => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
const ms = (x: number): string => (Number.isNaN(x) ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
const int = (x: number): string => Math.round(x).toLocaleString("en-US");

interface TraceTurn {
  role: string;
  content: string;
  name?: string;
  is_error?: boolean;
}

export interface ReportInput {
  summary: RunSummary;
  gates: GateResult[];
  attempts: AttemptRecord[];
  errors: AttemptError[];
  traces: Map<string, TraceTurn[]>;
  systemPrompt: string;
  mode: string;
  generatedAt: string;
  comparison?: ComparisonResult;
  /** Gate threshold per category, drawn as a tick on the category chart. */
  categoryThresholds?: Record<string, number>;
  /** Extra caveat lines shown at the top (e.g. how the cassettes were produced). */
  notes?: string[];
}

const CSS = `
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--ink3:#77766f;--rule:#e4e3dd;--grid:#ecebe6;
--s1:#2a78d6;--s2:#eb6834;--good:#0ca30c;--good-ink:#006300;--bad:#d03b3b;--bad-ink:#b02a2a;--warn:#fab219;--warn-bg:#fff4d6;--warn-ink:#6b4a00;--chip:#efeee9}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#9a998f;--rule:#2f2f2c;--grid:#262624;
--s1:#3987e5;--s2:#d95926;--good:#0ca30c;--good-ink:#5fd35f;--bad:#d03b3b;--bad-ink:#ff8a8a;--warn:#fab219;--warn-bg:#3a2d05;--warn-ink:#ffd77a;--chip:#2a2a27}}
:root[data-theme="dark"]{--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#9a998f;--rule:#2f2f2c;--grid:#262624;
--s1:#3987e5;--s2:#d95926;--good-ink:#5fd35f;--bad-ink:#ff8a8a;--warn-bg:#3a2d05;--warn-ink:#ffd77a;--chip:#2a2a27}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}h3{font-size:14px;margin:16px 0 6px}
.muted{color:var(--ink2)}.small{font-size:12px}.card{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px}
.banner{background:var(--warn-bg);color:var(--warn-ink);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;margin:14px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-top:14px}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:10px 12px}.tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.tile .l{color:var(--ink2);font-size:12px}
table{border-collapse:collapse;width:100%;background:var(--surface)}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:12px;color:var(--ink2);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:var(--good-ink);font-weight:600}.no{color:var(--bad-ink);font-weight:600}.chip{display:inline-block;background:var(--chip);border-radius:10px;padding:0 7px;font-size:11px;margin:0 3px 2px 0;color:var(--ink2)}
.scroll{overflow-x:auto}details>summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.turn{border-left:3px solid var(--rule);padding:4px 10px;margin:6px 0}.turn .r{font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.03em}
.turn.user{border-color:var(--s1)}.turn.assistant{border-color:var(--good)}.turn.tool_call,.turn.tool_result{border-color:var(--ink3)}.turn.err{border-color:var(--bad)}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0}select,input{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:3px 6px}
svg text{fill:var(--ink2);font-size:13px}svg .val{fill:var(--ink);font-weight:600}.legend{display:flex;gap:14px;font-size:12px;color:var(--ink2);margin:4px 0}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.grid2{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px;align-items:start}@media (max-width:820px){.grid2{grid-template-columns:1fr}}
`;

const JS = `
const sel=document.getElementById('f-cat'),only=document.getElementById('f-fail'),q=document.getElementById('f-q');
function apply(){const c=sel.value,f=only.checked,t=q.value.toLowerCase();
for(const tr of document.querySelectorAll('tr[data-case]')){const show=(!c||tr.dataset.cat===c)&&(!f||tr.dataset.fail==='1')&&(!t||tr.dataset.case.includes(t));
tr.hidden=!show;const d=document.getElementById('d-'+tr.dataset.case);if(d)d.hidden=!show;}}
for(const el of [sel,only,q]) el&&el.addEventListener('input',apply);
`;

function statusCell(pass: boolean, label?: string): string {
  return pass ? `<span class="ok">✓ ${esc(label ?? "pass")}</span>` : `<span class="no">✗ ${esc(label ?? "fail")}</span>`;
}

/** Horizontal bars with optional CI whiskers and a threshold tick. One or two series. */
function barChart(
  rows: { label: string; values: { v: number; lo?: number; hi?: number; title: string }[]; threshold?: number }[],
  seriesColors: string[],
): string {
  const labelW = 120;
  const plotW = 440;
  const rowH = 16 * seriesColors.length + 14;
  const h = rows.length * rowH + 28;
  const x = (v: number): number => labelW + Math.max(0, Math.min(1, v)) * plotW;
  const parts: string[] = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${h - 20}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<text x="${x(t)}" y="${h - 6}" text-anchor="middle">${t * 100}%</text>`);
  }
  rows.forEach((row, i) => {
    const y0 = i * rowH + 6;
    parts.push(`<text x="${labelW - 8}" y="${y0 + (rowH - 14) / 2 + 4}" text-anchor="end">${esc(row.label)}</text>`);
    row.values.forEach((val, s) => {
      const y = y0 + s * 16;
      const w = Number.isNaN(val.v) ? 0 : x(val.v) - labelW;
      const color = seriesColors[s] ?? "var(--s1)";
      parts.push(`<g><title>${esc(val.title)}</title><rect x="${labelW}" y="${y}" width="${Math.max(w, 0)}" height="10" rx="2" fill="${color}"/>`);
      if (val.lo !== undefined && val.hi !== undefined) {
        parts.push(`<line x1="${x(val.lo)}" x2="${x(val.hi)}" y1="${y + 5}" y2="${y + 5}" stroke="var(--ink)" stroke-width="1.5"/>`);
        parts.push(`<line x1="${x(val.lo)}" x2="${x(val.lo)}" y1="${y + 1}" y2="${y + 9}" stroke="var(--ink)" stroke-width="1.5"/>`);
        parts.push(`<line x1="${x(val.hi)}" x2="${x(val.hi)}" y1="${y + 1}" y2="${y + 9}" stroke="var(--ink)" stroke-width="1.5"/>`);
      }
      parts.push(`<rect x="${labelW}" y="${y - 2}" width="${plotW}" height="14" fill="transparent"/></g>`);
      // values sit in a fixed column right of the plot so they never collide with bars or whiskers
      parts.push(`<text class="val" x="${labelW + plotW + 46}" y="${y + 9}" text-anchor="end">${pct(val.v, 0)}</text>`);
    });
    if (row.threshold !== undefined) {
      parts.push(`<line x1="${x(row.threshold)}" x2="${x(row.threshold)}" y1="${y0 - 3}" y2="${y0 + rowH - 11}" stroke="var(--bad)" stroke-width="2"><title>gate: ${pct(row.threshold, 0)}</title></line>`);
    }
  });
  return `<svg viewBox="0 0 ${labelW + plotW + 50} ${h}" width="100%" role="img" aria-label="Pass rate by category">${parts.join("")}</svg>`;
}

function renderTrace(turns: TraceTurn[] | undefined): string {
  if (!turns) return `<p class="muted small">No trace file.</p>`;
  return turns
    .filter((t) => t.role !== "system")
    .map((t) => {
      const role = t.role === "tool_call" ? `tool call · ${t.name ?? ""}` : t.role === "tool_result" ? `tool result · ${t.name ?? ""}${t.is_error ? " (error)" : ""}` : t.role;
      return `<div class="turn ${esc(t.role)}${t.is_error ? " err" : ""}"><div class="r">${esc(role)}</div><pre>${esc(t.content === "" ? "(empty)" : t.content)}</pre></div>`;
    })
    .join("");
}

function attemptDetail(a: AttemptRecord, traces: Map<string, TraceTurn[]>): string {
  const checks = a.checks
    .map((c) => `<tr><td>${esc(c.id)}</td><td>${statusCell(c.pass)}</td><td class="small">${esc(c.detail)}</td></tr>`)
    .join("");
  const judge = a.judge
    ? `<h3>Judge (${esc(a.judge.model)})</h3><table><tr><th>criterion</th><th>verdict</th><th>rationale</th></tr>${JUDGE_CRITERIA.map(
        (k) => `<tr><td>${k}</td><td>${statusCell(a.judge?.verdicts[k].verdict === "pass")}</td><td class="small">${esc(a.judge?.verdicts[k].rationale ?? "")}</td></tr>`,
      ).join("")}</table>`
    : "";
  return `<details><summary>rep ${a.rep}: ${statusCell(a.pass, a.pass ? "pass" : "fail")} · ${esc(a.conversationStatus)} · ${a.modelCalls} model call(s) · ${a.toolCalls} tool call(s) · ${ms(a.latencyMs)} · ${usd(a.costUsd)}</summary>
<div class="grid2"><div><h3>Transcript</h3>${renderTrace(traces.get(`${a.caseId}#${a.rep}`))}</div>
<div><h3>Deterministic checks</h3><table><tr><th>check</th><th>result</th><th>detail</th></tr>${checks}</table>${judge}
<p class="small muted">tokens: ${int(a.usage.input)} in · ${int(a.usage.cacheWrite)} cache write · ${int(a.usage.cacheRead)} cache read · ${int(a.usage.output)} out · served by ${esc(a.model)} · ${esc(a.provenance)}</p></div></div></details>`;
}

function comparisonSection(c: ComparisonResult): string {
  const rows = c.categories.map((cat) => ({
    label: cat.category,
    values: [
      { v: cat.aRate, title: `${c.a.configName}: ${pct(cat.aRate)}` },
      { v: cat.bRate, title: `${c.b.configName}: ${pct(cat.bRate)}` },
    ],
  }));
  const flips = (list: ComparisonResult["fixed"]): string =>
    list.length ? list.map((x) => `<span class="chip">${esc(x.caseId)} ${pct(x.aRate, 0)} → ${pct(x.bRate, 0)}</span>`).join("") : `<span class="muted">none</span>`;
  const verdict = c.significant
    ? `The difference is statistically significant (exact McNemar p = ${c.mcnemar.p.toFixed(3)}).`
    : `The difference is <strong>not</strong> statistically significant at α = 0.05 (exact McNemar p = ${c.mcnemar.p.toFixed(3)} on ${c.mcnemar.onlyAPasses + c.mcnemar.onlyBPasses} discordant case(s)).`;
  const perf = (label: string, av: string, bv: string): string => `<tr><td>${label}</td><td class="n">${av}</td><td class="n">${bv}</td></tr>`;
  return `<h2 id="comparison">Comparison: ${esc(c.a.configName)} (A) vs ${esc(c.b.configName)} (B)</h2>
${c.warnings.map((w) => `<div class="banner">${esc(w)}</div>`).join("")}
<div class="card"><p>Mean per-case pass-rate change B − A: <strong>${(c.meanDelta * 100).toFixed(1)} points</strong>, 95% bootstrap CI [${(c.ci.lo * 100).toFixed(1)}, ${(c.ci.hi * 100).toFixed(1)}] over ${c.pairedCases} paired cases. ${verdict}</p>
<p>Fixed by B (majority of reps now pass): ${flips(c.fixed)}</p><p>Broken by B: ${flips(c.broken)}</p></div>
<div class="grid2"><div class="card"><div class="legend"><span><span class="sw" style="background:var(--s1)"></span>A · ${esc(c.a.configName)}</span><span><span class="sw" style="background:var(--s2)"></span>B · ${esc(c.b.configName)}</span></div>${barChart(rows, ["var(--s1)", "var(--s2)"])}</div>
<div><table><tr><th></th><th class="n">A · ${esc(c.a.configName)}</th><th class="n">B · ${esc(c.b.configName)}</th></tr>
${perf("pass rate", pct(c.a.totals.passRate), pct(c.b.totals.passRate))}
${perf("pass^k (every rep)", pct(c.a.consistency.passHatK), pct(c.b.consistency.passHatK))}
${perf("judge pass rate", pct(c.a.judge.allCriteriaPassRate), pct(c.b.judge.allCriteriaPassRate))}
${perf("flaky cases", String(c.a.consistency.flakyCases.length), String(c.b.consistency.flakyCases.length))}
${perf("cost per run", usd(c.a.cost.totalUsd), usd(c.b.cost.totalUsd))}
${perf("cost per attempt", usd(c.a.cost.perAttemptUsd), usd(c.b.cost.perAttemptUsd))}
${perf("latency p50 / p95", `${ms(c.a.latency.attemptP50Ms)} / ${ms(c.a.latency.attemptP95Ms)}`, `${ms(c.b.latency.attemptP50Ms)} / ${ms(c.b.latency.attemptP95Ms)}`)}
${perf("output tokens per attempt", int(c.a.tokens.meanPerAttempt.output), int(c.b.tokens.meanPerAttempt.output))}
${perf("cache hit ratio", pct(c.a.cacheHitRatio), pct(c.b.cacheHitRatio))}
</table>
<h3>Per category</h3><table><tr><th>category</th><th class="n">A</th><th class="n">B</th><th class="n">B − A</th></tr>${c.categories
    .map((x) => `<tr><td>${esc(x.category)}</td><td class="n">${pct(x.aRate)}</td><td class="n">${pct(x.bRate)}</td><td class="n">${(x.delta * 100).toFixed(1)}</td></tr>`)
    .join("")}</table></div></div>`;
}

export function renderReport(input: ReportInput): string {
  const { summary: s, gates, attempts, errors, traces } = input;
  const gatesPass = gates.every((g) => g.pass);
  const byCase = new Map<string, AttemptRecord[]>();
  for (const a of attempts) byCase.set(a.caseId, [...(byCase.get(a.caseId) ?? []), a]);

  const tiles: [string, string, string][] = [
    [pct(s.totals.passRate), "pass rate (all attempts)", `95% CI ${pct(s.totals.passRateCi.lo)}–${pct(s.totals.passRateCi.hi)} · noise floor ±${pct(s.totals.noiseFloor, 0)}`],
    [pct(s.consistency.passHatK), `pass^${s.consistency.k}: every rep passes`, `pass@${s.consistency.k} ${pct(s.consistency.passAtK)}`],
    [String(s.consistency.flakyCases.length), "flaky cases", "pass in some reps, fail in others"],
    [pct(s.judge.allCriteriaPassRate), "judge: all criteria pass", s.judgeModel ?? "judge off"],
    [usd(s.cost.totalUsd), "cost of this run", `assistant ${usd(s.cost.assistantUsd)} · judge ${usd(s.cost.judgeUsd)}`],
    [usd(s.cost.perAttemptUsd), "cost per attempt", `one dataset pass ≈ ${usd(s.cost.perDatasetPassUsd)}`],
    [`${ms(s.latency.attemptP50Ms)} / ${ms(s.latency.attemptP95Ms)}`, "latency p50 / p95 per attempt", "model time only, retries excluded"],
    [pct(s.cacheHitRatio), "prompt cache hit ratio", "cache reads / all prompt tokens"],
    [String(s.totals.errors), "harness errors (not scored)", Object.entries(s.totals.errorsByClass).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"],
  ];

  const catRows = s.categories.map((c) => ({
    label: c.category,
    values: [{ v: c.passRate, lo: c.ci.lo, hi: c.ci.hi, title: `${c.category}: ${c.passes}/${c.attempts} attempts pass (${pct(c.passRate)}), 95% CI ${pct(c.ci.lo)}–${pct(c.ci.hi)}` }],
    threshold: input.categoryThresholds?.[c.category],
  }));

  const caseRows = s.cases
    .map((c) => {
      const list = (byCase.get(c.caseId) ?? []).sort((x, y) => x.rep - y.rep);
      const first = list[0];
      const lat = list.reduce((a, x) => a + x.latencyMs, 0) / Math.max(1, list.length);
      const cost = list.reduce((a, x) => a + x.costUsd + (x.judge?.costUsd ?? 0), 0) / Math.max(1, list.length);
      const tokens = list.reduce((a, x) => a + x.usage.input + x.usage.cacheRead + x.usage.cacheWrite + x.usage.output, 0) / Math.max(1, list.length);
      const failing = c.passes < c.reps || (c.judged > 0 && c.judgePasses < c.judged);
      const repsCell = c.passes === c.reps ? statusCell(true, `${c.passes}/${c.reps}`) : statusCell(false, `${c.passes}/${c.reps}${c.flaky ? " flaky" : ""}`);
      const judgeCell = c.judged ? (c.judgePasses === c.judged ? statusCell(true, `${c.judgePasses}/${c.judged}`) : statusCell(false, `${c.judgePasses}/${c.judged}`)) : "–";
      const id = esc(c.caseId);
      return `<tr data-case="${id}" data-cat="${esc(c.category)}" data-fail="${failing ? "1" : "0"}"><td><a href="#d-${id}">${id}</a><br><span class="chip">${esc(c.category)}</span><span class="chip">${esc(c.difficulty)}</span>${c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</td>
<td class="small">${esc(first?.userTurns.join(" → ") ?? "")}</td><td>${repsCell}</td><td>${judgeCell}</td><td class="small">${c.failingChecks.map(esc).join(", ") || "–"}</td><td class="n">${ms(lat)}</td><td class="n">${int(tokens)}</td><td class="n">${usd(cost)}</td></tr>`;
    })
    .join("");

  const details = s.cases
    .map((c) => {
      const list = (byCase.get(c.caseId) ?? []).sort((x, y) => x.rep - y.rep);
      return `<section id="d-${esc(c.caseId)}" class="card" style="margin:10px 0"><strong>${esc(c.caseId)}</strong> <span class="muted small">${esc(c.category)} · ${esc(c.difficulty)}</span>${list.map((a) => attemptDetail(a, traces)).join("")}</section>`;
    })
    .join("");

  const banners = [
    ...(s.provenance.synthetic
      ? [
          "SYNTHETIC REPLAY DATA. The model responses in this run come from hand-written cassettes produced by a fake model client (npm run cassettes:synthesize), not from Claude. They exercise the harness, graders, metrics and report end to end; the pass rates, latencies and token counts say nothing about real model quality. Real numbers need `npm run eval -- --record` with an API key and an approved budget.",
        ]
      : []),
    ...(input.notes ?? []),
  ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Library Assistant Eval</title><style>${CSS}</style></head><body><main>
<h1>Library assistant eval · ${esc(s.configName)}</h1>
<div class="muted">${esc(s.description)} · assistant <strong>${esc(s.assistantModel)}</strong> (prompt ${esc(s.promptVersion)}) · judge ${esc(s.judgeModel ?? "off")} · ${s.totals.cases} cases × ${s.runs} reps · mode ${esc(input.mode)} · generated ${esc(input.generatedAt)}</div>
${banners.map((b) => `<div class="banner">${esc(b)}</div>`).join("")}
<div class="card" style="margin-top:12px">Regression gate: ${gatesPass ? statusCell(true, "all gates pass") : statusCell(false, `${gates.filter((g) => !g.pass).length} gate(s) failed`)} <span class="muted small">· headline pass/fail is deterministic; judge scores are reported separately</span></div>
<div class="tiles">${tiles.map(([v, l, sub]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div><div class="small muted">${esc(sub)}</div></div>`).join("")}</div>
${input.comparison ? comparisonSection(input.comparison) : ""}
<h2>Pass rate by category</h2>
<div class="grid2"><div class="card"><div class="legend"><span><span class="sw" style="background:var(--s1)"></span>pass rate</span><span>━ 95% Wilson interval</span><span><span class="sw" style="background:var(--bad)"></span>gate threshold</span></div>${barChart(catRows, ["var(--s1)"])}</div>
<div><table><tr><th>category</th><th class="n">cases</th><th class="n">attempts</th><th class="n">pass rate</th><th class="n">95% CI</th><th class="n">all reps pass</th><th class="n">judge</th></tr>
${s.categories.map((c) => `<tr><td>${esc(c.category)}</td><td class="n">${c.cases}</td><td class="n">${c.attempts}</td><td class="n">${pct(c.passRate)}</td><td class="n">${pct(c.ci.lo, 0)}–${pct(c.ci.hi, 0)}</td><td class="n">${c.casesAllRepsPass}/${c.cases}</td><td class="n">${pct(c.judgePassRate)}</td></tr>`).join("")}
</table></div></div>
<h2>Gates</h2><table><tr><th>gate</th><th>result</th><th class="n">actual</th><th class="n">threshold</th></tr>
${gates.map((g) => `<tr><td>${esc(g.name)}</td><td>${statusCell(g.pass)}</td><td class="n">${esc(g.actual)}</td><td class="n">${esc(g.threshold)}</td></tr>`).join("")}</table>
<h2>Judge</h2><div class="grid2"><table><tr><th>criterion</th><th class="n">pass rate</th></tr>${JUDGE_CRITERIA.map((k) => `<tr><td>${k}</td><td class="n">${pct(s.judge.criteria[k])}</td></tr>`).join("")}</table>
<div class="card small"><strong>Judge vs deterministic disagreements (${s.judge.disagreements.length})</strong><p class="muted">Where they disagree, read the transcript: either a grader has a blind spot or the judge is wrong. Run <code>npm run eval:calibrate-judge</code> for agreement with human labels.</p>${s.judge.disagreements.map((d) => `<span class="chip">${esc(d.caseId)} rep ${d.rep}: det ${d.deterministic ? "pass" : "fail"}, judge ${d.judge ? "pass" : "fail"}</span>`).join("") || "none"}</div></div>
<h2>Tokens and cost</h2><table><tr><th></th><th class="n">uncached input</th><th class="n">cache write</th><th class="n">cache read</th><th class="n">output</th></tr>
<tr><td>assistant (total)</td><td class="n">${int(s.tokens.assistant.input)}</td><td class="n">${int(s.tokens.assistant.cacheWrite)}</td><td class="n">${int(s.tokens.assistant.cacheRead)}</td><td class="n">${int(s.tokens.assistant.output)}</td></tr>
<tr><td>assistant (mean per attempt)</td><td class="n">${int(s.tokens.meanPerAttempt.input)}</td><td class="n">${int(s.tokens.meanPerAttempt.cacheWrite)}</td><td class="n">${int(s.tokens.meanPerAttempt.cacheRead)}</td><td class="n">${int(s.tokens.meanPerAttempt.output)}</td></tr>
<tr><td>judge (total)</td><td class="n">${int(s.tokens.judge.input)}</td><td class="n">${int(s.tokens.judge.cacheWrite)}</td><td class="n">${int(s.tokens.judge.cacheRead)}</td><td class="n">${int(s.tokens.judge.output)}</td></tr></table>
<p class="small muted">Cost = tokens × the price table in src/llm/pricing.ts, per served model (cache writes at the 5-minute rate, cache reads at the model's cache-read rate). Refusals: ${s.totals.refusals} · fallback-served attempts: ${pct(s.totals.fallbackRate)} · retries: ${s.totals.retries}.</p>
<h2>Cases</h2>
<div class="filters"><label>Category <select id="f-cat"><option value="">all</option>${s.categories.map((c) => `<option>${esc(c.category)}</option>`).join("")}</select></label>
<label><input type="checkbox" id="f-fail"> only cases with a failure</label><label>Search id <input id="f-q" placeholder="e.g. rules-004"></label></div>
<div class="scroll"><table><tr><th>case</th><th>patron</th><th>reps pass</th><th>judge</th><th>failing checks</th><th class="n">latency</th><th class="n">tokens</th><th class="n">cost</th></tr>${caseRows}</table></div>
<h2>Transcripts</h2><p class="muted small">Each rep shows the full exchange, every deterministic check and the judge's rationale. Tool results are shown verbatim, including injected instructions in book descriptions.</p>
${details}
<h2>Harness errors</h2>${errors.length ? `<table><tr><th>case</th><th>rep</th><th>class</th><th>message</th></tr>${errors.map((e) => `<tr><td>${esc(e.caseId)}</td><td>${e.rep}</td><td>${esc(e.failureClass)}</td><td class="small">${esc(e.message)}</td></tr>`).join("")}</table>` : `<p class="muted">None. Errors are never scored as model failures; they are listed here and fail the gate.</p>`}
<h2>System prompt under test</h2><details class="card"><summary>prompt ${esc(s.promptVersion)}</summary><pre>${esc(input.systemPrompt)}</pre></details>
<h2>How to read this report</h2><div class="card small"><p><strong>Pass</strong> means every deterministic check passed for that attempt (tool use, required facts, fee amounts, forbidden content, scope, prompt leakage, grounded ISBNs and titles, length). The judge's four criteria are a separate signal. Pass rates carry 95% Wilson intervals; with ${s.totals.cases} cases × ${s.runs} reps, differences smaller than about ±${pct(s.totals.noiseFloor, 0)} are within noise. <strong>Flaky</strong> cases passed in some reps and failed in others. pass@k is the chance that at least one of k tries passes; pass^k is the chance that all k pass. Latency is model time per attempt (all calls), without retry backoff.</p></div>
</main><script>${JS}</script></body></html>`;
}
