/**
 * Tool definitions sent to Claude, plus client-side validation and dispatch.
 *
 * Choices taken from the Claude API skill (typescript/claude-api/tool-use.md, shared/tool-use-concepts.md):
 *  - `strict: true` on every tool, with `additionalProperties: false`, so arguments match the schema. Forced
 *    `tool_choice` (`any` / `tool`) returns 400 on Claude Opus 5.5, so the request leaves tool_choice at `auto`
 *    and the descriptions say *when* to call each tool.
 *  - The JSON schemas avoid keywords strict mode does not support (minLength, maxLength, minimum...). Those
 *    limits live in the zod schemas below and are enforced before any tool runs.
 *  - Tools are serialised in a fixed order (sorted by name) so the cached prefix never changes.
 *  - All tools are read-only. Nothing the model asks for can change library state.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { BookNotFoundError, type LibraryBackend } from "../backends/types.js";

type BetaTool = Anthropic.Beta.Messages.BetaTool;

export const SearchBooksArgs = z.strictObject({
  q: z.string().max(200),
  tag: z.string().min(1).max(50).optional(),
  available: z.boolean().optional(),
});
export const BookIdArgs = z.strictObject({ bookId: z.uuid() });
export const NoArgs = z.strictObject({});

export const TOOL_ARG_SCHEMAS = {
  get_book: BookIdArgs,
  get_loan_rules: NoArgs,
  list_copies: BookIdArgs,
  search_books: SearchBooksArgs,
} as const;

export type ToolName = keyof typeof TOOL_ARG_SCHEMAS;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_ARG_SCHEMAS, name);
}

const bookIdSchema = {
  type: "object",
  properties: {
    bookId: { type: "string", format: "uuid", description: "The bookId from a search_books result." },
  },
  required: ["bookId"],
  additionalProperties: false,
} as const;

const DEFINITIONS: BetaTool[] = [
  {
    name: "search_books",
    description:
      "Search the library catalogue. Matches every word of q against titles, descriptions and author names, and falls back to fuzzy title matching for typos. Call this whenever the patron mentions a book, an author or a topic and you do not have its bookId yet, and always before telling the patron the library does not have something. Use an empty q with a tag to list a genre. Returns up to 10 books with bookId, ISBN, title, authors, year, tags, a short description and copy counts.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Words to search for. Empty string to list everything (use with tag)." },
        tag: {
          type: "string",
          description: "Optional exact tag filter, lowercase, e.g. mystery, history, software, testing, science-fiction.",
        },
        available: { type: "boolean", description: "If true, only books with at least one AVAILABLE copy." },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "get_book",
    description:
      "Get the full record of one book by bookId, including its full description. Call this when the patron asks what a book is about or needs details that the search result does not show.",
    strict: true,
    input_schema: bookIdSchema,
  },
  {
    name: "list_copies",
    description:
      "List the physical copies of one book and the status of each: AVAILABLE (can be borrowed now), ON_LOAN, RESERVED (held for the patron who reserved it) or LOST. Call this before saying whether a book can be borrowed or why it cannot.",
    strict: true,
    input_schema: bookIdSchema,
  },
  {
    name: "get_loan_rules",
    description:
      "Get the library's loan rules: loan length, the maximum number of active loans, the overdue fee rule and how reservations work. Call this before answering any question about how long a loan lasts, how many books can be borrowed, fees or reservations.",
    strict: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Tools in a deterministic order (sorted by name) so the prompt-cache prefix is byte-stable. */
export const TOOLS: readonly BetaTool[] = Object.freeze(
  [...DEFINITIONS].sort((a, b) => a.name.localeCompare(b.name)),
);

export interface ToolExecution {
  content: string;
  isError: boolean;
  /** False when the input failed schema validation and the tool was not run. */
  inputValid: boolean;
}

/**
 * Validate the model-supplied input, then run the tool. Never throws for model mistakes:
 * unknown tools, invalid input and missing books become is_error results the model can recover from.
 * Backend failures (network, contract drift) are rethrown: they are harness errors, not model errors.
 */
export async function executeTool(name: string, rawInput: unknown, backend: LibraryBackend): Promise<ToolExecution> {
  if (!isToolName(name)) {
    return { content: `Unknown tool "${name}".`, isError: true, inputValid: false };
  }
  const parsed = TOOL_ARG_SCHEMAS[name].safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: JSON.stringify({ INVALID_INPUT: JSON.stringify(rawInput), issues: parsed.error.issues.map((i) => i.message) }),
      isError: true,
      inputValid: false,
    };
  }
  try {
    let result: unknown;
    switch (name) {
      case "search_books":
        result = await backend.searchBooks(SearchBooksArgs.parse(parsed.data));
        break;
      case "get_book":
        result = await backend.getBook(BookIdArgs.parse(parsed.data).bookId);
        break;
      case "list_copies":
        result = await backend.listCopies(BookIdArgs.parse(parsed.data).bookId);
        break;
      case "get_loan_rules":
        result = await backend.getLoanRules();
        break;
    }
    return { content: JSON.stringify(result), isError: false, inputValid: true };
  } catch (err) {
    if (err instanceof BookNotFoundError) return { content: err.message, isError: true, inputValid: true };
    throw err;
  }
}
