/**
 * Fake catalogue search that approximates library-api's behaviour (docs/SPEC.md, "Books"):
 *  1. full-text match over title, description and author names (every query word must match);
 *  2. if nothing matches and q has >= 3 characters, fall back to trigram similarity on the title
 *     (pg_trgm semantics, threshold 0.3), which makes "Clean Cdoe" find "Clean Code".
 * It is an approximation (no stemming, prefix matching for words of 4+ letters), which is fine because the
 * eval pins the backend to fixtures; it is not a reimplementation of Postgres ranking.
 */
import type { CatalogueBook } from "../catalogue/catalogue.js";

export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function words(s: string): string[] {
  return foldText(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(s)) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

function tokenMatches(token: string, haystack: string[]): boolean {
  return haystack.some((w) => w === token || (token.length >= 4 && w.startsWith(token)));
}

const byTitle = (a: CatalogueBook, b: CatalogueBook): number =>
  foldText(a.title).localeCompare(foldText(b.title)) || a.id.localeCompare(b.id);

export function searchCatalogue(
  books: CatalogueBook[],
  opts: { q: string; tag?: string | undefined; available?: boolean | undefined },
): CatalogueBook[] {
  const filtered = books.filter(
    (b) =>
      (opts.tag === undefined || b.tags.includes(opts.tag.toLowerCase())) &&
      (opts.available !== true || b.availableCopies > 0),
  );
  const tokens = words(opts.q);
  if (tokens.length === 0) return [...filtered].sort(byTitle);

  const scored = filtered
    .map((b) => {
      const titleWords = words(b.title);
      const all = [...titleWords, ...words(b.description ?? ""), ...b.authors.flatMap(words)];
      if (!tokens.every((t) => tokenMatches(t, all))) return null;
      const titleHits = tokens.filter((t) => tokenMatches(t, titleWords)).length;
      return { b, score: titleHits };
    })
    .filter((x): x is { b: CatalogueBook; score: number } => x !== null)
    .sort((x, y) => y.score - x.score || byTitle(x.b, y.b));
  if (scored.length > 0) return scored.map((x) => x.b);

  if (opts.q.trim().length < 3) return [];
  return filtered
    .map((b) => ({ b, sim: Math.max(trigramSimilarity(b.title, opts.q), ...b.aliases.map((a) => trigramSimilarity(a, opts.q))) }))
    .filter((x) => x.sim >= 0.3)
    .sort((x, y) => y.sim - x.sim || byTitle(x.b, y.b))
    .map((x) => x.b);
}
