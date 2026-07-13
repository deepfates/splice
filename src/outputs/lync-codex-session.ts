/**
 * Codex rollout session JSONL → lync (dee-07pu).
 *
 * Source shape (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl): one
 * JSON object per line, `{ timestamp, type, payload }`, where top-level
 * `type` is "session_meta" | "turn_context" | "response_item" | "event_msg" |
 * "compacted" | ... and `payload.type` names the fine-grained record
 * ("message", "function_call", "function_call_output", "reasoning", ...).
 * Codex records carry NO source ids of their own.
 *
 * MAPPING TRUTH: portfolio-audit-20260701/lore-tools/codex_import.py — kinds,
 * author envelope, payload shape, sequence-as-parents chaining, function-call
 * pairing, and session_meta lineage pointers are ported from it verbatim.
 * One deliberate deviation, per pacts/import.md (pact law wins over the
 * reference — owner ruling on dee-07pu, 2026-07-12):
 *
 * - IDS. The reference mints uuid7 for EVERY event (nondeterministic —
 *   re-import would fork every id). Here every id is a deterministic UUIDv8
 *   via deterministicLyncId from ("codex", "line", sessionLocator, lineNo) —
 *   the line position in an append-only rollout file IS the record's source
 *   identity — and lineage pointers derive from ("codex", "lineage",
 *   sessionLocator, lineNo, key). Re-import is a union no-op; an upstream
 *   edit surfaces as a same-id conflict, which is the pact's tamper-evidence
 *   feature.
 * - TIME. As in the claude importer: deterministic fallback (opts.markedAt
 *   when given, else the epoch) instead of the reference's import-time "now";
 *   every substitution recorded; `marked` OPT-IN.
 *
 * Event mapping (as the reference defines it):
 * - kind: `codex/<payload.type>` when present, else `codex/<top type>`.
 * - parents: the previous emitted event (sequence-as-parents — the rollout
 *   IS a strict sequence, pacts/import.md blesses exactly this); a
 *   `function_call_output` additionally parents to its `function_call` event
 *   matched by `call_id`.
 * - payload: { record_type, payload: <original payload verbatim>, source:
 *   {path, line} } plus `turn_id` hoisted when present. Nothing discarded.
 * - session_meta records with `forked_from_id` / `parent_thread_id` each emit
 *   a `lore/pointer` event parented to the session_meta event.
 *
 * Fleet author-envelope convention (dee-mb0n): actor = "deepfates" for user
 * records, the model id when the payload names one, else "codex" (the
 * environment counts as an actor per FORMAT.md) — NEVER the importer.
 * via = "codex@<payload.cli_version|unknown>", imported_by =
 * "splice/codex-session-import@0.1".
 *
 * ZERO SILENT DROPS: every physical line becomes a record event or an
 * explicit skip entry; recordEvents + skipped === sourceLines and
 * emitted === recordEvents + lineagePointers are checked loudly. File-level
 * accounting lives in lync-session-batch.ts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LyncEventBody } from "@deepfates/lync/events";

import {
  DEFAULT_OPERATOR,
  SPLICE_IMPORT_VERSION,
  deterministicLyncId,
  writeLyncFile,
  verifyLyncFile,
  type LyncAuthor,
  type LyncProducerOptions,
  type LyncSkippedRecord,
  type LyncTimestampFallback,
  type LyncVerifyResult,
} from "./lync.js";
import {
  convertSessionTreeToLync,
  normalizeSessionAt,
  skippedLineValue,
  splitSessionJsonl,
  type SessionLineMapper,
  type SessionTreeLyncResult,
} from "./lync-session-batch.js";

/* --------------------------------- Types ---------------------------------- */

export const CODEX_SESSION_IMPORTER = "codex-session-import";

/** session_meta payload keys that emit lineage pointer events. */
export const CODEX_LINEAGE_KEYS = ["forked_from_id", "parent_thread_id"] as const;

export interface CodexSessionOptions
  extends Partial<Omit<LyncProducerOptions, "importer">> {
  /** Actor recorded for user-authored records. Default "deepfates". */
  userActor?: string;
}

export interface CodexSessionLyncStats {
  /** Physical lines in the source file. */
  sourceLines: number;
  /** All events written: recordEvents + lineagePointers. */
  emitted: number;
  /** One per successfully mapped source line. */
  recordEvents: number;
  /** lore/pointer events derived from session_meta lineage keys. */
  lineagePointers: number;
  /** function_call_output events matched to their function_call by call_id. */
  functionPairs: number;
  /** Distinct payload.turn_id values seen. */
  turns: number;
  skipped: LyncSkippedRecord[];
  timestampFallbacks: LyncTimestampFallback[];
  byKind: Record<string, number>;
}

export interface CodexSessionLyncResult {
  events: LyncEventBody[];
  stats: CodexSessionLyncStats;
}

/* ------------------------------ Deterministic ids ------------------------- */

/** Event id for one rollout line: (session file identity, line position). */
export function codexLineEventId(
  sessionLocator: string,
  lineNo: number,
): string {
  return deterministicLyncId("codex", "line", sessionLocator, String(lineNo));
}

/** Event id for a lineage pointer derived from a session_meta line. */
export function codexLineageEventId(
  sessionLocator: string,
  lineNo: number,
  key: string,
): string {
  return deterministicLyncId(
    "codex",
    "lineage",
    sessionLocator,
    String(lineNo),
    key,
  );
}

/* -------------------------------- Mapping ---------------------------------- */

type JsonRecord = Record<string, unknown>;

function asObject(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function codexActor(payload: unknown, userActor: string): string {
  const obj = asObject(payload);
  if (!obj) return "codex";
  if (obj["role"] === "user" || obj["type"] === "user_message") return userActor;
  const model = obj["model"];
  if (typeof model === "string" && model.length > 0) return model;
  return "codex";
}

function codexVia(payload: unknown): string {
  const obj = asObject(payload);
  const cliVersion = obj?.["cli_version"];
  return `codex@${cliVersion ? String(cliVersion) : "unknown"}`;
}

function codexKind(record: JsonRecord, payload: unknown): string {
  const obj = asObject(payload);
  const payloadType = obj?.["type"];
  if (typeof payloadType === "string" && payloadType.length > 0) {
    return `codex/${payloadType}`;
  }
  return `codex/${record["type"] ? String(record["type"]) : "unknown"}`;
}

function codexAuthor(
  actor: string,
  payload: unknown,
  lineNo: number,
  sourceRef: string,
  opts: CodexSessionOptions,
): LyncAuthor {
  return {
    actor,
    operator: opts.operator ?? DEFAULT_OPERATOR,
    via: opts.via ?? codexVia(payload),
    imported_by: `splice/${CODEX_SESSION_IMPORTER}@${SPLICE_IMPORT_VERSION}`,
    source: `${sourceRef}:${lineNo}`,
  };
}

/**
 * Incremental per-line mapper (the streaming batch path uses this directly;
 * codexSessionToLyncEvents wraps it for whole-text callers). `sessionLocator`
 * is the stable file identity used in every derived id (the file basename,
 * e.g. "rollout-<ts>-<uuid>.jsonl" — machine-independent); `sourceRef` (the
 * path-or-ref for author.source and payload.source.path) defaults to it.
 */
export interface CodexSessionLineMapper extends SessionLineMapper {
  finish(): CodexSessionLyncStats;
  /** Current stats without the end-of-file reconciliation check. */
  stats(): CodexSessionLyncStats;
}

export function createCodexSessionLineMapper(
  sessionLocator: string,
  opts: CodexSessionOptions = {},
): CodexSessionLineMapper {
  const sourceRef = opts.sourceRef ?? sessionLocator;
  const skipped: LyncSkippedRecord[] = [];
  const timestampFallbacks: LyncTimestampFallback[] = [];
  const byKind: Record<string, number> = {};
  const fallbackAt = opts.markedAt ?? new Date(0).toISOString();
  const callEvents = new Map<string, string>();
  const turnIds = new Set<string>();
  let sourceLines = 0;
  let recordEvents = 0;
  let lineagePointers = 0;
  let functionPairs = 0;
  let previousId: string | undefined;

  function stats(): CodexSessionLyncStats {
    return {
      sourceLines,
      emitted: recordEvents + lineagePointers,
      recordEvents,
      lineagePointers,
      functionPairs,
      turns: turnIds.size,
      skipped,
      timestampFallbacks,
      byKind,
    };
  }

  function mapLine(text: string, lineNo: number): LyncEventBody[] {
    sourceLines++;
    if (text.trim().length === 0) {
      skipped.push({ index: lineNo, reason: "blank line", value: null });
      return [];
    }
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(text);
    } catch (err) {
      skipped.push({
        index: lineNo,
        reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        value: skippedLineValue(text),
      });
      return [];
    }
    const rec = asObject(parsedLine);
    if (!rec) {
      skipped.push({
        index: lineNo,
        reason: "line is not a JSON object",
        value: skippedLineValue(text),
      });
      return [];
    }

    const events: LyncEventBody[] = [];
    const payload = rec["payload"];
    const payloadObj = asObject(payload);
    const eventId = codexLineEventId(sessionLocator, lineNo);
    const parents: string[] = previousId ? [previousId] : [];
    if (payloadObj?.["type"] === "function_call_output") {
      const callId = payloadObj["call_id"];
      if (typeof callId === "string" && callEvents.has(callId)) {
        functionPairs++;
        const callEventId = callEvents.get(callId)!;
        if (!parents.includes(callEventId)) parents.push(callEventId);
      }
    }

    const at = normalizeSessionAt(
      rec["timestamp"],
      lineNo,
      fallbackAt,
      timestampFallbacks,
    );
    const eventPayload: JsonRecord = {
      record_type: rec["type"] ?? null,
      payload: payload ?? null,
      source: { path: sourceRef, line: lineNo },
    };
    const turnId = payloadObj?.["turn_id"];
    if (typeof turnId === "string") {
      eventPayload["turn_id"] = turnId;
      turnIds.add(turnId);
    }

    const ev: LyncEventBody = {
      v: 1,
      id: eventId,
      kind: codexKind(rec, payload),
      at,
      author: codexAuthor(
        codexActor(payload, opts.userActor ?? DEFAULT_OPERATOR),
        payload,
        lineNo,
        sourceRef,
        opts,
      ) as unknown as LyncEventBody["author"],
      parents,
      payload: eventPayload,
    };
    if (opts.markedAt !== undefined) ev.marked = opts.markedAt;
    events.push(ev);
    recordEvents++;
    byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
    previousId = eventId;

    if (
      payloadObj?.["type"] === "function_call" &&
      typeof payloadObj["call_id"] === "string"
    ) {
      callEvents.set(payloadObj["call_id"] as string, eventId);
    }

    // session_meta lineage → lore/pointer events, parented to this event.
    if (rec["type"] === "session_meta" && payloadObj) {
      for (const key of CODEX_LINEAGE_KEYS) {
        const target = payloadObj[key];
        if (typeof target !== "string" || target.length === 0) continue;
        const pointer: LyncEventBody = {
          v: 1,
          id: codexLineageEventId(sessionLocator, lineNo, key),
          kind: "lore/pointer",
          at: normalizeSessionAt(
            rec["timestamp"],
            lineNo,
            fallbackAt,
            timestampFallbacks,
          ),
          author: codexAuthor(
            "codex",
            payload,
            lineNo,
            sourceRef,
            opts,
          ) as unknown as LyncEventBody["author"],
          parents: [eventId],
          payload: { name: `codex/${key}`, target, source_event: eventId },
        };
        if (opts.markedAt !== undefined) pointer.marked = opts.markedAt;
        events.push(pointer);
        lineagePointers++;
        byKind[pointer.kind] = (byKind[pointer.kind] ?? 0) + 1;
        previousId = pointer.id;
      }
    }
    return events;
  }

  return {
    mapLine,
    finish(): CodexSessionLyncStats {
      if (recordEvents + skipped.length !== sourceLines) {
        // Structurally impossible, but the reconciliation invariant is the
        // whole point of this importer — fail loudly, never miscount silently.
        throw new Error(
          `codex session: counts do not reconcile: ${recordEvents} record events + ${skipped.length} skipped !== ${sourceLines} lines`,
        );
      }
      return stats();
    },
    stats,
  };
}

/**
 * Map one codex rollout file's JSONL text to lync events (whole-text
 * convenience over createCodexSessionLineMapper — the batch path streams
 * instead, since real rollout files can exceed V8's string limit).
 */
export function codexSessionToLyncEvents(
  jsonlText: string,
  sessionLocator: string,
  opts: CodexSessionOptions = {},
): CodexSessionLyncResult {
  const mapper = createCodexSessionLineMapper(sessionLocator, opts);
  const events: LyncEventBody[] = [];
  for (const { lineNo, text } of splitSessionJsonl(jsonlText)) {
    events.push(...mapper.mapLine(text, lineNo));
  }
  return { events, stats: mapper.finish() };
}

/* ------------------------------ End-to-end wire ---------------------------- */

export interface CodexSessionLyncConversion {
  outputPath: string;
  stats: CodexSessionLyncStats;
  verify: LyncVerifyResult;
}

/**
 * End-to-end: read one codex rollout JSONL file, map to lync events, write a
 * `.lync` file, then verify the written file with @deepfates/lync. Throws loudly
 * when the verifier finds any non-accepted line.
 */
export async function convertCodexSessionToLync(
  inputPath: string,
  outputPath: string,
  opts: CodexSessionOptions = {},
): Promise<CodexSessionLyncConversion> {
  const text = await fs.readFile(inputPath, "utf8");
  const mapped = codexSessionToLyncEvents(text, path.basename(inputPath), {
    sourceRef: opts.sourceRef ?? inputPath,
    ...opts,
  });
  await writeLyncFile(outputPath, mapped.events);
  const verify = await verifyLyncFile(outputPath);
  if (!verify.ok) {
    throw new Error(
      `lync verify failed for ${outputPath}: ${JSON.stringify(verify.problems)}`,
    );
  }
  if (verify.counts.accepted !== mapped.events.length) {
    throw new Error(
      `lync verify count mismatch for ${outputPath}: wrote ${mapped.events.length}, accepted ${verify.counts.accepted}`,
    );
  }
  return { outputPath, stats: mapped.stats, verify };
}

/**
 * Batch: convert every `.jsonl` rollout under `inputDir` (the shape of
 * ~/.codex/sessions) to mirrored `.lync` files under `outputDir`, with
 * file-level zero-silent-drops accounting (see lync-session-batch.ts).
 * Ids derive from each file's basename, never from where the tree lives.
 */
export async function convertCodexSessionTreeToLync(
  inputDir: string,
  outputDir: string,
  opts: CodexSessionOptions = {},
): Promise<SessionTreeLyncResult> {
  return convertSessionTreeToLync(inputDir, outputDir, (locator, rel) =>
    createCodexSessionLineMapper(locator, {
      sourceRef: opts.sourceRef ?? rel,
      ...opts,
    }),
  );
}
