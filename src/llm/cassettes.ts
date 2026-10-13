/**
 * SDK-level record/replay. Every model call goes through a Transport; in record mode the request and the
 * response are written to a cassette, in replay mode the response is read back by a stable hash of the request.
 *
 * Key = sha256 of the canonical JSON of the request params (object keys sorted, undefined and functions dropped)
 * plus the repetition index, so `--runs 3` replays three different recorded answers for the same request.
 * Any change to the system prompt, tools, model, effort or conversation changes the hash, so a stale cassette
 * is a loud `cassette_miss`, never a silent wrong answer.
 *
 * Layout: <root>/<scope>/<caseId>.json, one file per case so diffs stay reviewable.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError, type CallContext, type CallResult, type Transport } from "./transport.js";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined || typeof v === "function" ? null : canonicalize(v)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === "function") continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function requestHash(params: unknown): string {
  return createHash("sha256").update(canonicalJson(params)).digest("hex").slice(0, 32);
}

export interface Recording {
  message: unknown;
  latencyMs: number;
  recordedAt: string;
  recordedFrom: "live" | "synthetic";
}

export interface CassetteEntry {
  kind: "assistant" | "judge";
  /** Small, human-readable description of the request, for reviewing cassette diffs. Not used for matching. */
  summary: { model: string; lastMessage: string };
  recordings: Record<string, Recording>;
}

export interface CassetteFile {
  version: 1;
  caseId: string;
  entries: Record<string, CassetteEntry>;
}

function summarize(params: unknown): CassetteEntry["summary"] {
  const p = params as { model?: unknown; messages?: { role: string; content: unknown }[] };
  const last = p.messages?.at(-1);
  let text = "";
  if (last) {
    text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  }
  return { model: typeof p.model === "string" ? p.model : "?", lastMessage: `${last?.role ?? "?"}: ${text.slice(0, 160)}` };
}

export class CassetteStore {
  private readonly files = new Map<string, CassetteFile>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  private path(scope: string, caseId: string): string {
    return join(this.root, scope, `${caseId}.json`);
  }

  load(scope: string, caseId: string): CassetteFile {
    const p = this.path(scope, caseId);
    let file = this.files.get(p);
    if (!file) {
      file = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CassetteFile) : { version: 1, caseId, entries: {} };
      this.files.set(p, file);
    }
    return file;
  }

  lookup(ctx: CallContext, hash: string): Recording | undefined {
    return this.load(ctx.scope, ctx.caseId).entries[hash]?.recordings[String(ctx.rep)];
  }

  async put(ctx: CallContext, hash: string, params: unknown, recording: Recording): Promise<void> {
    const file = this.load(ctx.scope, ctx.caseId);
    const entry = (file.entries[hash] ??= { kind: ctx.kind, summary: summarize(params), recordings: {} });
    entry.recordings[String(ctx.rep)] = recording;
    const p = this.path(ctx.scope, ctx.caseId);
    // Serialise writes per file: reps of the same case run concurrently.
    const previous = this.writes.get(p) ?? Promise.resolve();
    const next = previous.then(() => {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(canonicalize(file), null, 2)}\n`);
      renameSync(tmp, p);
    });
    this.writes.set(p, next);
    await next;
  }
}

/** Replays recorded responses. Never touches the network. */
export class ReplayTransport<P, M> implements Transport<P, M> {
  constructor(private readonly store: CassetteStore) {}

  call(params: P, ctx: CallContext): Promise<CallResult<M>> {
    const hash = requestHash(params);
    const rec = this.store.lookup(ctx, hash);
    if (!rec) {
      return Promise.reject(
        new HarnessError(
          "cassette_miss",
          `No ${ctx.kind} cassette for case ${ctx.caseId} rep ${ctx.rep} in ${join(this.store.root, ctx.scope)} (request hash ${hash}). ` +
            "The request changed since it was recorded (prompt, tools, model, effort or an earlier answer), or this rep was never recorded. " +
            "Re-record with --record (needs ANTHROPIC_API_KEY and --budget-usd).",
        ),
      );
    }
    return Promise.resolve({
      message: rec.message as M,
      latencyMs: rec.latencyMs,
      attempts: 1,
      source: "replay",
      recordedFrom: rec.recordedFrom,
    });
  }
}

/** Calls the inner transport (live API or a fake model) and writes every response to the cassette store. */
export class RecordingTransport<P, M> implements Transport<P, M> {
  constructor(
    private readonly inner: Transport<P, M>,
    private readonly store: CassetteStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async call(params: P, ctx: CallContext): Promise<CallResult<M>> {
    const result = await this.inner.call(params, ctx);
    await this.store.put(ctx, requestHash(params), params, {
      message: result.message,
      latencyMs: Math.round(result.latencyMs),
      recordedAt: this.clock().toISOString(),
      recordedFrom: result.source === "live" ? "live" : "synthetic",
    });
    return result;
  }
}
