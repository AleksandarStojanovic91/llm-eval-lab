/**
 * The four read-only tools the assistant can call, expressed as a backend interface.
 * Two implementations: FakeLibraryBackend (fixtures, deterministic) and HttpLibraryBackend (a running library-api).
 * Both must return byte-identical tool outputs for the same data; test/backends.test.ts checks that.
 */

export interface BookSummary {
  bookId: string;
  isbn: string;
  title: string;
  authors: string[];
  publishedYear: number | null;
  tags: string[];
  /** First 160 characters of the description; null when the book has none. */
  descriptionPreview: string | null;
  availableCopies: number;
  totalCopies: number;
}

export interface SearchBooksInput {
  q: string;
  tag?: string | undefined;
  available?: boolean | undefined;
}

export interface SearchBooksOutput {
  results: BookSummary[];
  /** True when more matches exist than were returned. */
  truncated: boolean;
}

export interface BookDetail {
  bookId: string;
  isbn: string;
  title: string;
  authors: string[];
  publishedYear: number | null;
  tags: string[];
  description: string | null;
  availableCopies: number;
  totalCopies: number;
}

export interface CopyInfo {
  barcode: string;
  status: "AVAILABLE" | "ON_LOAN" | "RESERVED" | "LOST";
}

export interface ListCopiesOutput {
  bookId: string;
  copies: CopyInfo[];
}

export interface LoanRules {
  loanDays: number;
  maxActiveLoans: number;
  overdueFee: {
    amountPerStartedDay: string;
    currency: "EUR";
    rule: string;
  };
  reservations: {
    allowedOnlyWhen: string;
    queue: string;
    holdHours: number;
    oneOpenReservationPerBook: boolean;
    heldCopy: string;
  };
  suspendedMembers: string;
  notCovered: string[];
}

/** Raised by a backend when the requested book does not exist; becomes an is_error tool_result. */
export class BookNotFoundError extends Error {
  constructor(readonly bookId: string) {
    super(`No book with id ${bookId} exists in the catalogue.`);
    this.name = "BookNotFoundError";
  }
}

export interface LibraryBackend {
  readonly kind: "fake" | "http";
  searchBooks(input: SearchBooksInput): Promise<SearchBooksOutput>;
  getBook(bookId: string): Promise<BookDetail>;
  listCopies(bookId: string): Promise<ListCopiesOutput>;
  getLoanRules(): Promise<LoanRules>;
}

export const SEARCH_LIMIT = 10;
export const DESCRIPTION_PREVIEW_CHARS = 160;

export function previewDescription(description: string | null): string | null {
  if (description === null) return null;
  return description.length <= DESCRIPTION_PREVIEW_CHARS
    ? description
    : `${description.slice(0, DESCRIPTION_PREVIEW_CHARS - 1)}…`;
}
