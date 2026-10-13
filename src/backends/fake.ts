import type { Catalogue, CatalogueBook } from "../catalogue/catalogue.js";
import { LOAN_RULES } from "./rules.js";
import { searchCatalogue } from "./search.js";
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

export function toSummary(b: CatalogueBook): BookSummary {
  return {
    bookId: b.id,
    isbn: b.isbn,
    title: b.title,
    authors: b.authors,
    publishedYear: b.publishedYear,
    tags: b.tags,
    descriptionPreview: previewDescription(b.description),
    availableCopies: b.availableCopies,
    totalCopies: b.totalCopies,
  };
}

export function toDetail(b: CatalogueBook): BookDetail {
  return {
    bookId: b.id,
    isbn: b.isbn,
    title: b.title,
    authors: b.authors,
    publishedYear: b.publishedYear,
    tags: b.tags,
    description: b.description,
    availableCopies: b.availableCopies,
    totalCopies: b.totalCopies,
  };
}

/** Deterministic in-memory backend built from fixtures/catalogue.json. Used by evals, CI and unit tests. */
export class FakeLibraryBackend implements LibraryBackend {
  readonly kind = "fake" as const;

  constructor(private readonly catalogue: Catalogue) {}

  searchBooks(input: SearchBooksInput): Promise<SearchBooksOutput> {
    const matches = searchCatalogue(this.catalogue.books, input);
    return Promise.resolve({
      results: matches.slice(0, SEARCH_LIMIT).map(toSummary),
      truncated: matches.length > SEARCH_LIMIT,
    });
  }

  getBook(bookId: string): Promise<BookDetail> {
    const b = this.catalogue.byId.get(bookId);
    if (!b) return Promise.reject(new BookNotFoundError(bookId));
    return Promise.resolve(toDetail(b));
  }

  listCopies(bookId: string): Promise<ListCopiesOutput> {
    const b = this.catalogue.byId.get(bookId);
    if (!b) return Promise.reject(new BookNotFoundError(bookId));
    return Promise.resolve({
      bookId,
      copies: [...b.copies]
        .sort((x, y) => x.barcode.localeCompare(y.barcode))
        .map((c) => ({ barcode: c.barcode, status: c.status })),
    });
  }

  getLoanRules(): Promise<LoanRules> {
    return Promise.resolve(LOAN_RULES);
  }
}
