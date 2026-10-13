/**
 * HTTP adapter to a running library-api (Java on :8081 or TypeScript on :8082, same contract).
 * Only public, read-only endpoints are used, so no token is needed:
 *   GET /api/v1/books?q&tag&available&limit   GET /api/v1/books/{id}   GET /api/v1/books/{id}/copies
 * Responses are validated against the contract shapes (contract/openapi.yaml, components.schemas) with zod,
 * so a contract drift fails loudly here instead of feeding the model malformed data.
 */
import { z } from "zod";
import { LOAN_RULES } from "./rules.js";
import {
  BookNotFoundError,
  previewDescription,
  SEARCH_LIMIT,
  type BookDetail,
  type BookSummary,
  type LibraryBackend,
  type ListCopiesOutput,
  type LoanRules,
  type SearchBooksInput,
  type SearchBooksOutput,
} from "./types.js";

const ContractBook = z.object({
  id: z.string(),
  isbn: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  publishedYear: z.number().int().nullable().optional(),
  authors: z.array(z.object({ id: z.string(), name: z.string() })),
  tags: z.array(z.string()),
  totalCopies: z.number().int().min(0),
  availableCopies: z.number().int().min(0),
});
type ContractBook = z.infer<typeof ContractBook>;

const ContractBookPage = z.object({
  data: z.array(ContractBook),
  page: z.object({ limit: z.number().int(), nextCursor: z.string().nullable() }),
});

const ContractCopies = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      bookId: z.string(),
      barcode: z.string(),
      status: z.enum(["AVAILABLE", "ON_LOAN", "RESERVED", "LOST"]),
    }),
  ),
});

const Problem = z.object({ code: z.string(), title: z.string(), detail: z.string().optional() }).loose();

export class LibraryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "LibraryApiError";
  }
}

export interface HttpBackendOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpLibraryBackend implements LibraryBackend {
  readonly kind = "http" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async getJson(path: string, bookId?: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429 && attempt === 1) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(Math.max(retryAfter, 0), 5) * 1000));
        continue;
      }
      if (res.ok) return await res.json();
      const problem = Problem.safeParse(await res.json().catch(() => null));
      if (res.status === 404 && bookId !== undefined) throw new BookNotFoundError(bookId);
      const code = problem.success ? problem.data.code : undefined;
      throw new LibraryApiError(res.status, code, `library-api ${path} returned ${res.status}${code ? ` (${code})` : ""}`);
    }
  }

  private static summary(b: ContractBook): BookSummary {
    return {
      bookId: b.id,
      isbn: b.isbn,
      title: b.title,
      authors: b.authors.map((a) => a.name),
      publishedYear: b.publishedYear ?? null,
      tags: b.tags,
      descriptionPreview: previewDescription(b.description ?? null),
      availableCopies: b.availableCopies,
      totalCopies: b.totalCopies,
    };
  }

  async searchBooks(input: SearchBooksInput): Promise<SearchBooksOutput> {
    const params = new URLSearchParams({ limit: String(SEARCH_LIMIT) });
    if (input.q.trim() !== "") params.set("q", input.q);
    if (input.tag !== undefined) params.set("tag", input.tag);
    if (input.available !== undefined) params.set("available", String(input.available));
    const page = ContractBookPage.parse(await this.getJson(`/api/v1/books?${params.toString()}`));
    return { results: page.data.map((b) => HttpLibraryBackend.summary(b)), truncated: page.page.nextCursor !== null };
  }

  async getBook(bookId: string): Promise<BookDetail> {
    const b = ContractBook.parse(await this.getJson(`/api/v1/books/${encodeURIComponent(bookId)}`, bookId));
    return {
      bookId: b.id,
      isbn: b.isbn,
      title: b.title,
      authors: b.authors.map((a) => a.name),
      publishedYear: b.publishedYear ?? null,
      tags: b.tags,
      description: b.description ?? null,
      availableCopies: b.availableCopies,
      totalCopies: b.totalCopies,
    };
  }

  async listCopies(bookId: string): Promise<ListCopiesOutput> {
    const body = ContractCopies.parse(await this.getJson(`/api/v1/books/${encodeURIComponent(bookId)}/copies`, bookId));
    return {
      bookId,
      copies: [...body.data]
        .sort((x, y) => x.barcode.localeCompare(y.barcode))
        .map((c) => ({ barcode: c.barcode, status: c.status })),
    };
  }

  getLoanRules(): Promise<LoanRules> {
    // library-api has no rules endpoint; the values are the service defaults from docs/SPEC.md.
    return Promise.resolve(LOAN_RULES);
  }
}
