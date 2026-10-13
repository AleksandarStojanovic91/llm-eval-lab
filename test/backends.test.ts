import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTool } from "../src/assistant/tools.js";
import { HttpLibraryBackend, LibraryApiError } from "../src/backends/http.js";
import { searchCatalogue, trigramSimilarity } from "../src/backends/search.js";
import { BookNotFoundError } from "../src/backends/types.js";
import { isValidIsbn13 } from "../src/catalogue/catalogue.js";
import { backend, catalogue } from "./helpers.js";

const titles = (q: string, opts: { tag?: string; available?: boolean } = {}): string[] =>
  searchCatalogue(catalogue.books, { q, ...opts }).map((b) => b.title);

describe("fixture catalogue", () => {
  it("has valid ISBN-13 check digits and mirrors the library-api seed for books 01-05", () => {
    expect(catalogue.books.every((b) => isValidIsbn13(b.isbn))).toBe(true);
    expect(catalogue.byId.get("20000000-0000-4000-8000-000000000001")?.isbn).toBe("9780132350884");
    expect(catalogue.byId.get("20000000-0000-4000-8000-000000000005")?.authors).toEqual(["Ivo Andric"]);
  });

  it("derives copy counts from copy statuses", () => {
    const ddd = catalogue.byId.get("20000000-0000-4000-8000-000000000003");
    expect(ddd?.availableCopies).toBe(0);
    expect(ddd?.totalCopies).toBe(1);
    expect(catalogue.byId.get("20000000-0000-4000-8000-000000000015")?.totalCopies).toBe(0);
  });
});

describe("fake search", () => {
  it("matches every word over titles, descriptions and authors", () => {
    expect(titles("kleppmann")).toEqual(["Designing Data-Intensive Applications"]);
    expect(titles("Petar Lukin")).toEqual(["Rivers Remember", "Salt Roads of the Adriatic"]);
    expect(titles("milica saric")).toContain("The Winter Orchard"); // diacritics folded
  });

  it("filters by tag and availability", () => {
    expect(titles("", { tag: "mystery", available: true })).toEqual(["The Cartographer's Daughter", "The Lighthouse Ledger", "The Overdue Notice"]);
  });

  it("falls back to trigram similarity on the title, like pg_trgm", () => {
    expect(titles("Clean Cdoe")).toEqual(["Clean Code"]);
    // "Clen Cdoe" (the library-api README example) scores 3/16 = 0.19 against "Clean Code", below the 0.3 threshold.
    expect(trigramSimilarity("Clean Code", "Clen Cdoe")).toBeCloseTo(0.1875);
    expect(titles("The Clean Coder")[0]).toBe("Clean Code");
    expect(trigramSimilarity("Clean Code", "Clean Code")).toBe(1);
  });

  it("returns nothing for authors that are not in the catalogue", () => {
    expect(titles("Haruki Murakami")).toEqual([]);
  });
});

describe("fake backend", () => {
  it("lists copies sorted by barcode and rejects unknown books", async () => {
    const copies = await backend.listCopies("20000000-0000-4000-8000-000000000002");
    expect(copies.copies.map((c) => c.status)).toEqual(["ON_LOAN", "ON_LOAN", "ON_LOAN"]);
    await expect(backend.getBook("99999999-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(BookNotFoundError);
  });
});

/** A tiny HTTP server that serves the three contract endpoints from the fixtures, shaped like library-api. */
function fixtureServer(): Server {
  const toContract = (id: string): Record<string, unknown> | undefined => {
    const b = catalogue.byId.get(id);
    if (!b) return undefined;
    return {
      id: b.id,
      isbn: b.isbn,
      title: b.title,
      description: b.description,
      publishedYear: b.publishedYear,
      authors: b.authors.map((name, i) => ({ id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name })),
      tags: b.tags,
      totalCopies: b.totalCopies,
      availableCopies: b.availableCopies,
      version: 1,
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
  };
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": status < 400 ? "application/json" : "application/problem+json" });
      res.end(JSON.stringify(body));
    };
    const m = /^\/api\/v1\/books(?:\/([^/]+))?(\/copies)?$/.exec(url.pathname);
    if (!m) {
      send(404, { code: "not-found", title: "Resource not found", status: 404 });
      return;
    }
    if (!m[1]) {
      const all = searchCatalogue(catalogue.books, {
        q: url.searchParams.get("q") ?? "",
        tag: url.searchParams.get("tag") ?? undefined,
        available: url.searchParams.get("available") === "true" ? true : undefined,
      });
      const limit = Number(url.searchParams.get("limit") ?? "20");
      send(200, { data: all.slice(0, limit).map((b) => toContract(b.id)), page: { limit, nextCursor: all.length > limit ? "next" : null } });
      return;
    }
    const book = catalogue.byId.get(m[1]);
    if (!book) {
      send(404, { code: "not-found", title: "Resource not found", status: 404 });
      return;
    }
    if (m[2]) {
      send(200, { data: book.copies.map((c) => ({ ...c, bookId: book.id, createdAt: "2026-10-13T00:00:00.000Z" })) });
      return;
    }
    send(200, toContract(book.id));
  });
}

describe("HTTP backend against a contract-shaped server", () => {
  let server: Server;
  let http: HttpLibraryBackend;

  beforeAll(async () => {
    server = fixtureServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    http = new HttpLibraryBackend({ baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
  });
  afterAll(() => {
    server.close();
  });

  it("produces exactly the same tool outputs as the fake backend", async () => {
    const calls: [string, unknown][] = [
      ["search_books", { q: "Clean Code" }],
      ["search_books", { q: "", tag: "mystery", available: true }],
      ["search_books", { q: "", tag: "software" }],
      ["get_book", { bookId: "20000000-0000-4000-8000-000000000012" }],
      ["list_copies", { bookId: "20000000-0000-4000-8000-000000000009" }],
      ["get_book", { bookId: "99999999-0000-4000-8000-000000000000" }],
      ["get_loan_rules", {}],
    ];
    for (const [name, input] of calls) {
      expect(await executeTool(name, input, http)).toEqual(await executeTool(name, input, backend));
    }
  });

  it("rejects responses that drift from the contract", async () => {
    const bad = new HttpLibraryBackend({
      baseUrl: "http://example.invalid",
      fetch: () => Promise.resolve(new Response(JSON.stringify({ data: [{ id: 1 }], page: { limit: 10, nextCursor: null } }), { status: 200 })),
    });
    await expect(bad.searchBooks({ q: "x" })).rejects.toThrow();
  });

  it("retries once on 429 and surfaces other errors with the problem code", async () => {
    let calls = 0;
    const flaky = new HttpLibraryBackend({
      baseUrl: "http://example.invalid",
      fetch: () => {
        calls++;
        if (calls === 1) return Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "0" } }));
        return Promise.resolve(new Response(JSON.stringify({ code: "internal", title: "Internal server error", status: 500 }), { status: 500 }));
      },
    });
    await expect(flaky.searchBooks({ q: "x" })).rejects.toBeInstanceOf(LibraryApiError);
    expect(calls).toBe(2);
  });
});
