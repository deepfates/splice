/**
 * Claude Code session JSONL → lync (dee-07pu).
 *
 * Source shape (~/.claude/projects/<project>/<session>.jsonl): one JSON
 * object per line. Conversation records carry `uuid`, `parentUuid`, `type`
 * ("user" | "assistant" | "system" | ...), `timestamp`, `message`, and
 * session metadata (`sessionId`, `version`, `cwd`, ...). Sidecar records
 * (ai-title, last-prompt, mode, permission-mode, file-history-snapshot,
 * queue-operation, ...) carry no `uuid`.
 *
 * MAPPING TRUTH: portfolio-audit-20260701/lore-tools/claude_import.py — kinds,
 * author envelope, and payload shape are ported from it verbatim. Two
 * deliberate deviations, per pacts/import.md (pact law wins over the
 * reference — owner ruling on dee-07pu, 2026-07-12):
 *
 * - IDS. The reference reuses the source record's `uuid` as the event id and
 *   mints uuid7 for records without one (nondeterministic — re-import would
 *   fork ids). Real Claude journals repeat UUIDs, both within one subagent
 *   file and across compacted/copy files. A UUID therefore identifies a
 *   claimed logical record, not one physical observation. The first UUID
 *   occurrence in deterministic tree order remains the canonical
 *   `claude/<type>` event. Later byte-identical occurrences become line-scoped
 *   `lore/pointer` events; differing occurrences become `lore/annotation`
 *   events carrying the complete source record. Both target the canonical
 *   event. Thus every physical occurrence survives, parentUuid retains its
 *   stable canonical target, verification stays strict, and re-import is a
 *   union no-op.
 * - TIME. The reference substitutes import-time "now" for missing
 *   timestamps and stamps `marked` on every event, which breaks byte
 *   determinism. Here the fallback is deterministic (opts.markedAt when
 *   given, else the epoch), every substitution is recorded in
 *   stats.timestampFallbacks, and `marked` is OPT-IN.
 *
 * Event mapping (reference mapping plus explicit repeat representation):
 * - first record WITH uuid → kind `claude/<type>`; parents [parentUuid-derived id];
 *   payload { message, source: {path, line, sessionId, promptId, requestId,
 *   agentId, isSidechain, isCompactSummary, compactMetadata — null/absent
 *   dropped}, extra: every other source field }. Nothing is discarded: every
 *   source field lands in message/source/extra or is transcribed to the
 *   envelope (uuid → id, parentUuid → parents, type → kind, timestamp → at).
 * - repeated uuid → line-scoped `lore/pointer` when source bytes equal the
 *   canonical occurrence, otherwise `lore/annotation` carrying the complete
 *   differing record; both parent and target the canonical uuid event.
 * - record WITHOUT uuid → kind `lore/pointer` for {ai-title, last-prompt,
 *   mode}, else `lore/annotation`; parents []; payload { label, name,
 *   target: sessionId, source, record: extra, message }.
 *
 * Fleet author-envelope convention (dee-mb0n): actor = "deepfates" for user
 * records, the model id for assistant records, else "unknown" — NEVER the
 * importer. via = "claude-code@<record version|unknown>", imported_by =
 * "splice/claude-session-import@0.1".
 *
 * ZERO SILENT DROPS: every physical line becomes exactly one event or an
 * explicit skip entry (blank line, invalid JSON, non-object record), and the
 * reconciliation invariant emitted + skipped === sourceLines is checked
 * loudly. File-level accounting lives in lync-session-batch.ts.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";

import type { LyncEventBody } from "@deepfates/lync/events";

import {
  DEFAULT_OPERATOR,
  SPLICE_IMPORT_VERSION,
  deterministicLyncId,
  type LyncAuthor,
  type LyncProducerOptions,
  type LyncSkippedRecord,
  type LyncTimestampFallback,
  type LyncVerifyResult,
} from "./lync.js";
import {
  convertSessionTreeToLync,
  convertSessionFileToLync,
  normalizeSessionAt,
  skippedLineValue,
  splitSessionJsonl,
  type SessionLineMapper,
  type SessionTreeLyncResult,
} from "./lync-session-batch.js";

/* --------------------------------- Types ---------------------------------- */

export const CLAUDE_SESSION_IMPORTER = "claude-session-import";

/**
 * Versioned recipe for physical repeats of UUID-bearing records. The canonical
 * first occurrence retains the longstanding UUID-only id.
 */
export const CLAUDE_REPEAT_ID_SCHEMA = "splice-claude-repeat/v2";

/** Sidecar record types the reference maps to `lore/pointer`. */
export const CLAUDE_POINTER_TYPES = new Set(["ai-title", "last-prompt", "mode"]);

export interface ClaudeSessionOptions
  extends Partial<Omit<LyncProducerOptions, "importer">> {
  /** Actor recorded for user-authored records. Default "deepfates". */
  userActor?: string;
}

export interface ClaudeSessionLyncStats {
  /** Physical lines in the source file. */
  sourceLines: number;
  emitted: number;
  /** Records whose id derives from their source `uuid`. */
  uuidRecords: number;
  /** First observed records retaining their canonical UUID-derived id. */
  canonicalUuidRecords: number;
  /** Later byte-identical occurrences represented as lore/pointer events. */
  identicalUuidRepeats: number;
  /** Later differing occurrences represented as lore/annotation events. */
  variantUuidRepeats: number;
  /** uuid-less sidecar records whose id derives from (locator, line). */
  derivedRecords: number;
  skipped: LyncSkippedRecord[];
  timestampFallbacks: LyncTimestampFallback[];
  byKind: Record<string, number>;
}

export interface ClaudeSessionLyncResult {
  events: LyncEventBody[];
  stats: ClaudeSessionLyncStats;
}

/* ------------------------------ Deterministic ids ------------------------- */

/** Canonical event id for a record that carries its own source `uuid`. */
export function claudeRecordEventId(uuid: string): string {
  return deterministicLyncId("claude", "record", uuid);
}

/** Event id for a later physical occurrence of a UUID-bearing record. */
export function claudeRepeatEventId(
  uuid: string,
  sessionLocator: string,
  lineNo: number,
): string {
  return deterministicLyncId(
    "claude",
    CLAUDE_REPEAT_ID_SCHEMA,
    uuid,
    sessionLocator,
    String(lineNo),
  );
}

/** Event id for a uuid-less sidecar record: (session file identity, line). */
export function claudeLineEventId(
  sessionLocator: string,
  lineNo: number,
): string {
  return deterministicLyncId("claude", "line", sessionLocator, String(lineNo));
}

/* -------------------------------- Mapping ---------------------------------- */

type JsonRecord = Record<string, unknown>;

function claudeActor(record: JsonRecord, userActor: string): string {
  const message = record["message"];
  const messageObj =
    message !== null && typeof message === "object" && !Array.isArray(message)
      ? (message as JsonRecord)
      : null;
  if (record["type"] === "user" || messageObj?.["role"] === "user") {
    return userActor;
  }
  const model = messageObj?.["model"];
  if (typeof model === "string" && model.length > 0) return model;
  return "unknown";
}

function claudeVia(record: JsonRecord): string {
  const version = record["version"];
  return `claude-code@${version ? String(version) : "unknown"}`;
}

function claudeAuthor(
  record: JsonRecord,
  lineNo: number,
  sourceRef: string,
  opts: ClaudeSessionOptions,
): LyncAuthor {
  return {
    actor: claudeActor(record, opts.userActor ?? DEFAULT_OPERATOR),
    operator: opts.operator ?? DEFAULT_OPERATOR,
    via: opts.via ?? claudeVia(record),
    imported_by: `splice/${CLAUDE_SESSION_IMPORTER}@${SPLICE_IMPORT_VERSION}`,
    source: `${sourceRef}:${lineNo}`,
  };
}

/** The reference's payload.source block: locator + ids, null/absent dropped. */
function claudeSourceBlock(
  record: JsonRecord,
  lineNo: number,
  sourceRef: string,
): JsonRecord {
  const block: JsonRecord = { path: sourceRef, line: lineNo };
  for (const key of [
    "sessionId",
    "promptId",
    "requestId",
    "agentId",
    "isSidechain",
    "isCompactSummary",
    "compactMetadata",
  ]) {
    const value = record[key];
    if (value !== null && value !== undefined) block[key] = value;
  }
  return block;
}

const CLAUDE_ENVELOPE_FIELDS = new Set([
  "uuid",
  "parentUuid",
  "type",
  "timestamp",
  "message",
]);

/** Every source field outside the envelope-transcribed set, order preserved. */
function claudeExtra(record: JsonRecord): JsonRecord {
  const extra: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CLAUDE_ENVELOPE_FIELDS.has(key)) extra[key] = value;
  }
  return extra;
}

/**
 * Incremental per-line mapper (the streaming batch path uses this directly;
 * claudeSessionToLyncEvents wraps it for whole-text callers). `sessionLocator`
 * is the stable file identity used in derived ids. In a batch it is the
 * normalized root-relative path; single-file callers use the basename unless
 * they provide another locator. `sourceRef` (the path-or-ref for author.source
 * and payload.source.path) defaults to it.
 */
export interface ClaudeSessionLineMapper extends SessionLineMapper {
  finish(): ClaudeSessionLyncStats;
  /** Current stats without the end-of-file reconciliation check. */
  stats(): ClaudeSessionLyncStats;
}

interface ClaudeUuidRegistryEntry {
  digest: string;
  eventId: string;
}

interface ClaudeUuidRegistry {
  byUuid: Map<string, ClaudeUuidRegistryEntry>;
}

function createClaudeUuidRegistry(): ClaudeUuidRegistry {
  return { byUuid: new Map() };
}

export function createClaudeSessionLineMapper(
  sessionLocator: string,
  opts: ClaudeSessionOptions = {},
  registry: ClaudeUuidRegistry = createClaudeUuidRegistry(),
): ClaudeSessionLineMapper {
  const sourceRef = opts.sourceRef ?? sessionLocator;
  const skipped: LyncSkippedRecord[] = [];
  const timestampFallbacks: LyncTimestampFallback[] = [];
  const byKind: Record<string, number> = {};
  const fallbackAt = opts.markedAt ?? new Date(0).toISOString();
  let sourceLines = 0;
  let emitted = 0;
  let uuidRecords = 0;
  let canonicalUuidRecords = 0;
  let identicalUuidRepeats = 0;
  let variantUuidRepeats = 0;
  let derivedRecords = 0;

  function stats(): ClaudeSessionLyncStats {
    return {
      sourceLines,
      emitted,
      uuidRecords,
      canonicalUuidRecords,
      identicalUuidRepeats,
      variantUuidRepeats,
      derivedRecords,
      skipped,
      timestampFallbacks,
      byKind,
    };
  }

  return {
    mapLine(text: string, lineNo: number): LyncEventBody[] {
      sourceLines++;
      if (text.trim().length === 0) {
        skipped.push({ index: lineNo, reason: "blank line", value: null });
        return [];
      }
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch (err) {
        skipped.push({
          index: lineNo,
          reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          value: skippedLineValue(text),
        });
        return [];
      }
      if (
        record === null ||
        typeof record !== "object" ||
        Array.isArray(record)
      ) {
        skipped.push({
          index: lineNo,
          reason: "line is not a JSON object",
          value: skippedLineValue(text),
        });
        return [];
      }

      const rec = record as JsonRecord;
      const at = normalizeSessionAt(
        rec["timestamp"],
        lineNo,
        fallbackAt,
        timestampFallbacks,
      );
      const author = claudeAuthor(
        rec,
        lineNo,
        sourceRef,
        opts,
      ) as unknown as LyncEventBody["author"];
      const kindType = rec["type"] ? String(rec["type"]) : "unknown";
      const sourceBlock = claudeSourceBlock(rec, lineNo, sourceRef);
      const extra = claudeExtra(rec);
      const message = rec["message"] ?? null;
      const uuid = rec["uuid"];

      let ev: LyncEventBody;
      if (typeof uuid === "string" && uuid.length > 0) {
        uuidRecords++;
        const parent = rec["parentUuid"];
        const canonicalId = claudeRecordEventId(uuid);
        const digest = createHash("sha256").update(text).digest("hex");
        const prior = registry.byUuid.get(uuid);
        if (prior === undefined) {
          canonicalUuidRecords++;
          registry.byUuid.set(uuid, { digest, eventId: canonicalId });
          ev = {
            v: 1,
            id: canonicalId,
            kind: `claude/${kindType}`,
            at,
            author,
            parents:
              typeof parent === "string" && parent.length > 0
                ? [claudeRecordEventId(parent)]
                : [],
            payload: { message, source: sourceBlock, extra },
          };
        } else {
          const identical = prior.digest === digest;
          if (identical) identicalUuidRepeats++;
          else variantUuidRepeats++;
          ev = {
            v: 1,
            id: claudeRepeatEventId(uuid, sessionLocator, lineNo),
            kind: identical ? "lore/pointer" : "lore/annotation",
            at,
            author,
            parents: [prior.eventId],
            payload: {
              label: identical
                ? "claude/repeated-record"
                : "claude/record-variant",
              name: identical
                ? "claude/repeated-record"
                : "claude/record-variant",
              target: prior.eventId,
              source_uuid: uuid,
              source: sourceBlock,
              ...(identical ? {} : { record: rec }),
            },
          };
        }
      } else {
        derivedRecords++;
        ev = {
          v: 1,
          id: claudeLineEventId(sessionLocator, lineNo),
          kind: CLAUDE_POINTER_TYPES.has(kindType)
            ? "lore/pointer"
            : "lore/annotation",
          at,
          author,
          parents: [],
          payload: {
            label: `claude/${kindType}`,
            name: `claude/${kindType}`,
            target: rec["sessionId"] ?? null,
            source: sourceBlock,
            record: extra,
            message,
          },
        };
      }
      if (opts.markedAt !== undefined) ev.marked = opts.markedAt;
      emitted++;
      byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
      return [ev];
    },

    finish(): ClaudeSessionLyncStats {
      if (emitted + skipped.length !== sourceLines) {
        // Structurally impossible, but the reconciliation invariant is the
        // whole point of this importer — fail loudly, never miscount silently.
        throw new Error(
          `claude session: counts do not reconcile: ${emitted} events + ${skipped.length} skipped !== ${sourceLines} lines`,
        );
      }
      return stats();
    },

    stats,
  };
}

/**
 * Map one Claude Code session file's JSONL text to lync events (whole-text
 * convenience over createClaudeSessionLineMapper — the batch path streams
 * instead, since real session files can exceed V8's string limit).
 */
export function claudeSessionToLyncEvents(
  jsonlText: string,
  sessionLocator: string,
  opts: ClaudeSessionOptions = {},
): ClaudeSessionLyncResult {
  const mapper = createClaudeSessionLineMapper(sessionLocator, opts);
  const events: LyncEventBody[] = [];
  for (const { lineNo, text } of splitSessionJsonl(jsonlText)) {
    events.push(...mapper.mapLine(text, lineNo));
  }
  return { events, stats: mapper.finish() };
}

/* ------------------------------ End-to-end wire ---------------------------- */

export interface ClaudeSessionLyncConversion {
  outputPath: string;
  stats: ClaudeSessionLyncStats;
  verify: LyncVerifyResult;
}

/**
 * End-to-end: read one Claude Code session JSONL file, map to lync events,
 * write a `.lync` file, then verify the written file with @deepfates/lync. Throws
 * loudly when the verifier finds any non-accepted line.
 */
export async function convertClaudeSessionToLync(
  inputPath: string,
  outputPath: string,
  opts: ClaudeSessionOptions = {},
): Promise<ClaudeSessionLyncConversion> {
  const mapper = createClaudeSessionLineMapper(path.basename(inputPath), {
    sourceRef: opts.sourceRef ?? inputPath,
    ...opts,
  });
  return convertSessionFileToLync(inputPath, outputPath, mapper);
}

/**
 * Batch: convert every `.jsonl` session under `inputDir` (the shape of
 * ~/.claude/projects) to mirrored `.lync` files under `outputDir`, with
 * file-level zero-silent-drops accounting (see lync-session-batch.ts).
 * Ids derive from each file's logical root-relative path, never from the
 * machine-specific absolute root. This keeps workflow-local journal.jsonl
 * files distinct while preserving identities when the tree moves machines.
 */
export async function convertClaudeSessionTreeToLync(
  inputDir: string,
  outputDir: string,
  opts: ClaudeSessionOptions = {},
): Promise<SessionTreeLyncResult> {
  const registry = createClaudeUuidRegistry();
  return convertSessionTreeToLync(inputDir, outputDir, (locator, rel) =>
    createClaudeSessionLineMapper(locator, {
      sourceRef: opts.sourceRef ?? rel,
      ...opts,
    }, registry),
  );
}
