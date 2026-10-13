import type { LoanRules } from "./types.js";

/**
 * Static loan rules, taken from library-api/contract/openapi.yaml (info.description) and docs/SPEC.md:
 * LOAN_DAYS=14, maxActiveLoans default 3, FEE_CENTS_PER_DAY=50 per *started* overdue day
 * (fee = ceil(overdue seconds / 86400) * 50 cents), RESERVATION_HOLD_HOURS=48, FIFO queue.
 * library-api exposes no endpoint for these, so both backends return this constant.
 */
export const LOAN_RULES: LoanRules = {
  loanDays: 14,
  maxActiveLoans: 3,
  overdueFee: {
    amountPerStartedDay: "0.50",
    currency: "EUR",
    rule: "No fee if the book is returned on or before the due date (borrow date + 14 days). Otherwise the fee is 0.50 EUR for every started day after the due date: fee = ceil(time overdue in days) x 0.50 EUR. Example: 2 days and 1 hour late = 3 started days = 1.50 EUR.",
  },
  reservations: {
    allowedOnlyWhen: "A book can be reserved only when none of its copies is AVAILABLE; otherwise borrow an available copy.",
    queue: "Reservations form a first-come, first-served queue per book.",
    holdHours: 48,
    oneOpenReservationPerBook: true,
    heldCopy: "When a copy is returned and someone is waiting, the copy is held (status RESERVED) for the first person in the queue for 48 hours. Only that person can borrow the held copy.",
  },
  suspendedMembers: "Suspended members can still log in and read the catalogue, but cannot borrow or reserve.",
  notCovered: [
    "renewals or loan extensions",
    "fee waivers",
    "an individual patron's current loans or fee balance",
  ],
};

/** Fee in cents for a loan that is `overdueSeconds` late. Mirrors library-api SPEC.md (Decisions 3). */
export function overdueFeeCents(overdueSeconds: number, centsPerDay = 50): number {
  if (overdueSeconds <= 0) return 0;
  return Math.ceil(overdueSeconds / 86_400) * centsPerDay;
}
