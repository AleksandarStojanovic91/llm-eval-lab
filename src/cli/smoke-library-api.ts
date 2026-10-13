/**
 * npm run smoke:library-api
 *
 * Exercises the four tools through HttpLibraryBackend against a running library-api, with no LLM involved:
 * full-text search, typo-tolerant search, book detail, copies, a missing book, and the static rules.
 * Every response is validated against the contract shapes inside the adapter. Default target is the
 * TypeScript service on :8082; set LIBRARY_API_URL=http://localhost:8081 for the Java one.
 * Start the services first: (cd ../library-api && docker compose up --build).
 */
import { HttpLibraryBackend } from "../backends/http.js";
import { BookNotFoundError } from "../backends/types.js";
import { runCli } from "./common.js";

runCli(async () => {
  const baseUrl = process.env.LIBRARY_API_URL ?? "http://localhost:8082";
  const api = new HttpLibraryBackend({ baseUrl });
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
  };
  console.log(`library-api at ${baseUrl}`);

  const kleppmann = await api.searchBooks({ q: "kleppmann" });
  check("search_books full text", kleppmann.results.some((b) => b.title === "Designing Data-Intensive Applications"), kleppmann.results.map((b) => b.title).join(", "));
  const typo = await api.searchBooks({ q: "Clean Cdoe" });
  check("search_books trigram fallback", typo.results.some((b) => b.title === "Clean Code"), typo.results.map((b) => b.title).join(", "));
  const first = kleppmann.results[0];
  if (first) {
    const book = await api.getBook(first.bookId);
    check("get_book", book.bookId === first.bookId, `${book.title} (${String(book.availableCopies)}/${String(book.totalCopies)} available)`);
    const copies = await api.listCopies(first.bookId);
    check("list_copies", copies.copies.length === book.totalCopies, copies.copies.map((c) => `${c.barcode}:${c.status}`).join(", "));
  }
  try {
    await api.getBook("99999999-0000-4000-8000-000000000000");
    check("get_book missing", false, "expected 404");
  } catch (err) {
    check("get_book missing", err instanceof BookNotFoundError, String(err));
  }
  const rules = await api.getLoanRules();
  check("get_loan_rules", rules.loanDays === 14 && rules.maxActiveLoans === 3, `${String(rules.loanDays)} days, ${String(rules.maxActiveLoans)} loans, €${rules.overdueFee.amountPerStartedDay}/started day`);
  console.log(failures.length ? `${String(failures.length)} check(s) failed` : "all checks passed");
  return failures.length ? 1 : 0;
});
