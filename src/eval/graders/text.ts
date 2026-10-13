/**
 * Text helpers for the deterministic graders. The aim is "not overly rigid" (eval-audit.md section 4):
 * case, diacritics, typographic quotes, markdown emphasis, hyphenated ISBNs, "€1.50" vs "1,50 EUR" vs
 * "150 cents" all normalise to the same thing before comparing.
 */

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[*_]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Join digits separated by hyphens or spaces, so 978-86-521-0001-9 matches 9788652100019. */
export function compactDigits(s: string): string {
  return s.replace(/(\d)[-\s](?=\d)/g, "$1");
}

export function containsFact(answer: string, fact: string): boolean {
  const a = normalize(answer);
  const f = normalize(fact);
  if (a.includes(f)) return true;
  return /^\d{10,}$/.test(f) && compactDigits(a).includes(f);
}

export function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

function toCents(amount: string): number | undefined {
  const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(amount);
  if (!m) return undefined;
  const whole = Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0"));
  return whole * 100 + frac;
}

/** Every euro amount mentioned in the text, in cents: €1.50, 1.50 EUR, 1,50 €, EUR 1.50, 1.5 euros, 50 cents. */
export function extractAmountsCents(text: string): Set<number> {
  const out = new Set<number>();
  const t = text.replace(/\u00a0/g, " ");
  const num = String.raw`(\d{1,6}(?:[.,]\d{1,2})?)`;
  const patterns = [
    new RegExp(String.raw`€\s?${num}`, "g"),
    new RegExp(String.raw`\beur\s?${num}`, "gi"),
    new RegExp(String.raw`${num}\s?(?:€|eur\b|euros?\b)`, "gi"),
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const c = m[1] === undefined ? undefined : toCents(m[1]);
      if (c !== undefined) out.add(c);
    }
  }
  for (const m of t.matchAll(/\b(\d{1,6})\s?(?:cents?|c)\b/gi)) {
    if (m[1] !== undefined) out.add(Number(m[1]));
  }
  return out;
}

/** ISBN-13s (with or without hyphens/spaces) mentioned in the text. */
export function extractIsbns(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b97[89](?:[-\s]?\d){10}\b/g)) out.push(m[0].replace(/\D/g, ""));
  return out;
}

/**
 * Book titles the answer presents as titles. The system prompt asks for titles in italics (*Title*), which is a
 * product convention (the UI renders italics as book titles) and makes this check precise. Bold (**...**) is
 * ignored because it is used for emphasis and headings. Candidates that do not look like titles are dropped.
 */
export function extractItalicTitles(text: string): string[] {
  const withoutBold = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  const out: string[] = [];
  const patterns = [/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![*\w])/g, /(?<![_\w])_(?![\s_])([^_\n]+?)(?<!\s)_(?![_\w])/g];
  for (const re of patterns) {
    for (const m of withoutBold.matchAll(re)) {
      const candidate = (m[1] ?? "").trim();
      if (candidate.length < 3 || candidate.endsWith(":")) continue;
      if (!/^[\p{Lu}\p{N}]/u.test(candidate)) continue;
      out.push(candidate);
    }
  }
  return out;
}

const DECLINE_PATTERNS = [
  /\b(can ?not|can't|unable to|not able to|won't be able to)\b/,
  /\bonly (help|assist)\b/,
  /\boutside (of )?(what|my|the)\b/,
  /\bnot something i can\b/,
  /\bi('m| am) (just |only )?(a|the) library assistant\b/,
];

/** True when the answer declines or redirects. Used for scope: decline. */
export function looksLikeDecline(answer: string): boolean {
  const a = normalize(answer);
  return DECLINE_PATTERNS.some((re) => re.test(a));
}

/** True when an in-scope answer is a blanket refusal ("Sorry, I can't help with that.") rather than an answer. */
export function looksLikeBlanketRefusal(answer: string): boolean {
  const first = normalize(answer).split(/(?<=[.!?])\s/)[0] ?? "";
  return /^((i'm |i am )?sorry,? |i apologi[sz]e,? )?(but )?i (can ?not|can't|am unable to|won't) (help|assist)( you)? with (that|this)\b/.test(first);
}

/** Word shingles, for detecting verbatim reuse of the system prompt. */
export function shingles(text: string, size: number): Set<string> {
  const ws = normalize(text)
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + size <= ws.length; i++) out.add(ws.slice(i, i + size).join(" "));
  return out;
}
