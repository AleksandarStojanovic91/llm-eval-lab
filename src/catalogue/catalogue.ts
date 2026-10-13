import { readFileSync } from "node:fs";
import { z } from "zod";

export const CopyStatus = z.enum(["AVAILABLE", "ON_LOAN", "RESERVED", "LOST"]);
export type CopyStatus = z.infer<typeof CopyStatus>;

const FixtureCopy = z.object({
  id: z.uuid(),
  barcode: z.string().regex(/^[A-Z0-9-]{4,32}$/),
  status: CopyStatus,
});

const FixtureBook = z.object({
  id: z.uuid(),
  isbn: z.string().regex(/^97[89][0-9]{10}$/),
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  description: z.string().nullable(),
  publishedYear: z.number().int().nullable(),
  authorIds: z.array(z.uuid()).min(1),
  tags: z.array(z.string()),
  copies: z.array(FixtureCopy),
});

const FixtureAuthor = z.object({ id: z.uuid(), name: z.string().min(1) });

export const CatalogueFile = z.object({
  $comment: z.string().optional(),
  authors: z.array(FixtureAuthor),
  books: z.array(FixtureBook),
});

export type FixtureBook = z.infer<typeof FixtureBook>;
export type FixtureAuthor = z.infer<typeof FixtureAuthor>;

/** A book as the assistant sees it: authors resolved, copy counts derived. */
export interface CatalogueBook {
  id: string;
  isbn: string;
  title: string;
  aliases: string[];
  description: string | null;
  publishedYear: number | null;
  authors: string[];
  tags: string[];
  copies: { id: string; barcode: string; status: CopyStatus }[];
  totalCopies: number;
  availableCopies: number;
}

export interface Catalogue {
  books: CatalogueBook[];
  byId: Map<string, CatalogueBook>;
}

/** ISBN-13 check digit, the same rule library-api enforces. */
export function isValidIsbn13(isbn: string): boolean {
  if (!/^\d{13}$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function buildCatalogue(raw: unknown): Catalogue {
  const file = CatalogueFile.parse(raw);
  const authors = new Map(file.authors.map((a) => [a.id, a.name]));
  const books = file.books.map((b): CatalogueBook => {
    if (!isValidIsbn13(b.isbn)) throw new Error(`fixture ${b.id}: invalid ISBN-13 check digit ${b.isbn}`);
    return {
      id: b.id,
      isbn: b.isbn,
      title: b.title,
      aliases: b.aliases ?? [],
      description: b.description,
      publishedYear: b.publishedYear,
      authors: b.authorIds.map((id) => {
        const name = authors.get(id);
        if (name === undefined) throw new Error(`fixture ${b.id}: unknown author ${id}`);
        return name;
      }),
      tags: b.tags,
      copies: b.copies,
      totalCopies: b.copies.length,
      availableCopies: b.copies.filter((c) => c.status === "AVAILABLE").length,
    };
  });
  const ids = new Set<string>();
  for (const b of books) {
    if (ids.has(b.id)) throw new Error(`duplicate book id ${b.id}`);
    ids.add(b.id);
  }
  return { books, byId: new Map(books.map((b) => [b.id, b])) };
}

export function loadCatalogue(path: string): Catalogue {
  return buildCatalogue(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
