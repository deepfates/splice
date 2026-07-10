/**
 * lync output layer — splice as a lync PRODUCER.
 *
 * Emits append-only `.lync` JSONL event files (spec: lync FORMAT.md) from
 * splice's normalized ContentItems/Threads and from Glowfic JSON exports
 * (glowfic-dl `thread.json`).
 *
 * Fleet author-envelope convention (dee-mb0n):
 * - author.actor       = the SOURCE author identity (character/account/display
 *                        name), fallback "unknown". NEVER the importer.
 * - author.operator    = "deepfates" (overridable)
 * - author.via         = "<source-lib>@<version-or-unknown>"
 * - author.imported_by = "splice/<importer>@0.1"
 * - author.source      = "<path-or-ref>:<locator>"
 *
 * Kinds are source-namespaced (e.g. "glowfic/thread", "glowfic/post",
 * "twitter/tweet"); the envelope never interprets payload, so unknown kinds
 * are fine per FORMAT.md rule 3.
 *
 * Ids are stable + deterministic: derived from source ids via SHA-256 and
 * formatted as UUIDv8 (RFC 9562 custom version). Determinism is the point:
 * re-importing the same source must reproduce the same event byte-for-byte so
 * lync's merge-is-union-by-id treats it as "one event seen twice", not a
 * same-id conflict. For the same reason `marked` (import time) is OPT-IN via
 * opts.markedAt: a default of "now" would make two imports of the same source
 * differ in body bytes under one id, which union surfaces as a conflict.
 *
 * ZERO SILENT DROPS: every source record either becomes an event or lands in
 * an explicit `skipped` stats entry with its index and reason. Timestamp
 * repairs are surfaced in `timestampFallbacks`. Verification requires every
 * written line to be classified `accepted` by lync-core's parser.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { serializeLyncEvent } from "lync-core/store";
import { parseLyncFiles } from "lync-core/events";
import type { LyncEventBody } from "lync-core/events";

import type { ContentItem, Thread } from "../core/types.js";

/* --------------------------------- Types ---------------------------------- */

export interface LyncAuthor {
  actor: string;
  operator?: string;
  via?: string;
  imported_by?: string;
  source?: string;
}

export interface LyncProducerOptions {
  /** Human responsible for the import. Default "deepfates". */
  operator?: string;
  /** Tool the content came through, "<source-lib>@<version-or-unknown>". */
  via?: string;
  /** Importer name; becomes imported_by = "splice/<importer>@0.1". */
  importer: string;
  /** Path-or-ref prefix for author.source ("<sourceRef>:<locator>"). */
  sourceRef: string;
  /**
   * Import time (RFC 3339) recorded as `marked`. OPT-IN: omitting keeps event
   * bytes deterministic across re-imports (see module doc).
   */
  markedAt?: string;
  /** Override actor for every event (else derived per item, fallback "unknown"). */
  actor?: string;
}

/** One source record that could not become an event — explicit, never silent. */
export interface LyncSkippedRecord {
  index: number;
  reason: string;
  /** The offending source value, JSON-safe, for audit. */
  value: unknown;
}

/** One timestamp that was repaired or replaced — explicit, never silent. */
export interface LyncTimestampFallback {
  index: number;
  original: unknown;
  used: string;
  reason: string;
}

export interface LyncMappingStats {
  sourceRecords: number;
  emitted: number;
  skipped: LyncSkippedRecord[];
  timestampFallbacks: LyncTimestampFallback[];
}

export interface LyncMappingResult {
  events: LyncEventBody[];
  stats: LyncMappingStats;
}

export interface LyncVerifyCounts {
  lines: number;
  events: number;
  accepted: number;
  byKind: Record<string, number>;
}

export interface LyncVerifyProblem {
  line: number;
  class: string;
  reason: string;
}

export interface LyncVerifyResult {
  ok: boolean;
  counts: LyncVerifyCounts;
  /** Every non-accepted line, with classification and reason. Empty when ok. */
  problems: LyncVerifyProblem[];
}

export const SPLICE_IMPORT_VERSION = "0.1";
export const DEFAULT_OPERATOR = "deepfates";

/* ------------------------------ Deterministic ids ------------------------- */

/**
 * Deterministic UUID from source identifiers.
 *
 * SHA-256 over NUL-joined parts, first 16 bytes, stamped as UUID version 8
 * (RFC 9562 "custom") with the RFC 4122 variant. Same source id in, same
 * event id out — so re-imports union as duplicates instead of forking ids.
 */
export function deterministicLyncId(...parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(part, "utf8");
    h.update(Buffer.from([0]));
  }
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // version 8: custom/deterministic
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------- Timestamps ------------------------------- */

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function isRfc3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339_RE.test(value);
}

/**
 * Normalize a source timestamp to RFC 3339 for the envelope `at` field.
 * - already RFC 3339: used verbatim (bytes are canonical; do not reformat).
 * - parseable by Date (e.g. "Jan 04, 2022 7:55 PM"): converted to ISO.
 * - anything else: `fallback` is used and the repair is recorded in stats.
 */
function normalizeAt(
  value: unknown,
  index: number,
  fallback: string,
  fallbacks: LyncTimestampFallback[],
): string {
  if (isRfc3339(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      const iso = parsed.toISOString();
      fallbacks.push({
        index,
        original: value,
        used: iso,
        reason: "non-RFC3339 source timestamp parsed via Date",
      });
      return iso;
    }
  }
  fallbacks.push({
    index,
    original: value ?? null,
    used: fallback,
    reason: "missing or unparseable source timestamp; substituted fallback",
  });
  return fallback;
}

/* --------------------------------- Authors -------------------------------- */

function buildAuthor(
  actor: string,
  opts: LyncProducerOptions,
  locator: string,
): LyncAuthor {
  const author: LyncAuthor = {
    actor: actor && actor.trim().length > 0 ? actor : "unknown",
    operator: opts.operator ?? DEFAULT_OPERATOR,
    imported_by: `splice/${opts.importer}@${SPLICE_IMPORT_VERSION}`,
    source: `${opts.sourceRef}:${locator}`,
  };
  if (opts.via && opts.via.length > 0) author.via = opts.via;
  return author;
}

/** Derive the source author identity from a normalized ContentItem. */
export function actorForContentItem(item: ContentItem): string {
  const raw = (item.raw ?? {}) as Record<string, unknown>;
  const candidates = [
    raw["character_display_name"],
    raw["character_handle"],
    raw["author"],
    raw["screen_name"],
    raw["username"],
    raw["handle"],
    item.accountId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "unknown";
}

/* ------------------------- ContentItem/Thread mapping --------------------- */

function kindForSource(source: string): string {
  // splice SourceIds are "namespace:name" (e.g. "twitter:tweet"); lync kinds
  // are "namespace/name". A bare source becomes "<source>/item".
  const idx = source.indexOf(":");
  if (idx > 0 && idx < source.length - 1) {
    return `${source.slice(0, idx)}/${source.slice(idx + 1)}`;
  }
  return `${source || "splice"}/item`;
}

function namespaceForSource(source: string): string {
  const idx = source.indexOf(":");
  return idx > 0 ? source.slice(0, idx) : source || "splice";
}

/**
 * Map normalized ContentItems to lync envelope events.
 *
 * - kind: source-namespaced from item.source ("twitter:tweet" → "twitter/tweet")
 * - id: deterministic from (namespace, item.id)
 * - parents: deterministic id of item.parentId when present (dangling parents
 *   are legal per FORMAT.md)
 * - payload: the full original source object (item.raw), else the normalized
 *   item — nothing is discarded
 * - at: source timestamp normalized to RFC 3339
 */
export function contentItemsToLyncEvents(
  items: ContentItem[],
  opts: LyncProducerOptions,
): LyncMappingResult {
  const events: LyncEventBody[] = [];
  const skipped: LyncSkippedRecord[] = [];
  const timestampFallbacks: LyncTimestampFallback[] = [];
  const fallbackAt = opts.markedAt ?? new Date(0).toISOString();

  items.forEach((item, index) => {
    if (item === null || typeof item !== "object") {
      skipped.push({ index, reason: "item is not an object", value: item });
      return;
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      skipped.push({
        index,
        reason: "item has no id; cannot mint a stable event id",
        value: item,
      });
      return;
    }
    const ns = namespaceForSource(item.source);
    const ev: LyncEventBody = {
      v: 1,
      id: deterministicLyncId(ns, "item", item.id),
      kind: kindForSource(item.source),
      at: normalizeAt(item.createdAt, index, fallbackAt, timestampFallbacks),
      author: buildAuthor(
        opts.actor ?? actorForContentItem(item),
        opts,
        item.id,
      ) as unknown as LyncEventBody["author"],
      parents: item.parentId
        ? [deterministicLyncId(ns, "item", item.parentId)]
        : [],
      payload: (item.raw ?? { ...item }) as Record<string, unknown>,
    };
    if (opts.markedAt !== undefined) ev.marked = opts.markedAt;
    events.push(ev);
  });

  return {
    events,
    stats: {
      sourceRecords: items.length,
      emitted: events.length,
      skipped,
      timestampFallbacks,
    },
  };
}

/**
 * Map Threads to lync events. Items keep their explicit parentId linkage when
 * present; otherwise each item parents to the previous item in the thread
 * (ordering-as-parents), and the first item has no parent.
 */
export function threadsToLyncEvents(
  threads: Thread[],
  opts: LyncProducerOptions,
): LyncMappingResult {
  const events: LyncEventBody[] = [];
  const skipped: LyncSkippedRecord[] = [];
  const timestampFallbacks: LyncTimestampFallback[] = [];
  let sourceRecords = 0;

  for (const thread of threads) {
    const chained: ContentItem[] = thread.items.map((item, i) => {
      if (item && typeof item === "object" && !item.parentId && i > 0) {
        return { ...item, parentId: thread.items[i - 1]?.id ?? null };
      }
      return item;
    });
    sourceRecords += chained.length;
    const mapped = contentItemsToLyncEvents(chained, opts);
    events.push(...mapped.events);
    // re-index per-thread diagnostics against the flattened stream
    const offset = sourceRecords - chained.length;
    for (const s of mapped.stats.skipped) {
      skipped.push({ ...s, index: s.index + offset });
    }
    for (const t of mapped.stats.timestampFallbacks) {
      timestampFallbacks.push({ ...t, index: t.index + offset });
    }
  }

  return {
    events,
    stats: {
      sourceRecords,
      emitted: events.length,
      skipped,
      timestampFallbacks,
    },
  };
}

/* --------------------------- Glowfic JSON export --------------------------- */

/** Shape of a glowfic-dl JSON export post (thread.json → posts[]). */
export interface GlowficExportPost {
  post_id: string;
  author?: string | null;
  character_display_name?: string | null;
  character_handle?: string | null;
  icon_url?: string | null;
  timestamp?: string | null;
  content?: string | null;
  [key: string]: unknown;
}

/** Shape of a glowfic-dl JSON export thread (thread.json). */
export interface GlowficExportThread {
  id: string | number;
  title?: string | null;
  url?: string | null;
  description?: string | null;
  posts: unknown[];
  [key: string]: unknown;
}

export interface GlowficLyncStats extends LyncMappingStats {
  threadEvents: number;
  postEvents: number;
}

export interface GlowficLyncResult {
  events: LyncEventBody[];
  threadEventId: string;
  stats: GlowficLyncStats;
}

export function glowficThreadEventId(threadId: string | number): string {
  return deterministicLyncId("glowfic", "thread", String(threadId));
}

export function glowficPostEventId(
  threadId: string | number,
  postId: string,
): string {
  return deterministicLyncId("glowfic", "post", String(threadId), postId);
}

function glowficActor(post: GlowficExportPost): string {
  for (const c of [
    post.character_display_name,
    post.character_handle,
    post.author,
  ]) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "unknown";
}

/**
 * Map a glowfic-dl JSON export (thread.json) to lync events:
 * - 1 `glowfic/thread` event: thread metadata (all fields except posts),
 *   parents [].
 * - 1 `glowfic/post` event per post: full original post object as payload.
 *   The first post parents to the thread event; post N parents to post N-1's
 *   event (source exports carry no finer reply metadata — posts are a strict
 *   sequence — so previous-post ordering IS the most specific parent).
 *
 * Malformed posts are skipped with an explicit stats entry, never silently.
 * Counts always reconcile: postEvents + skipped.length === posts.length.
 */
export function glowficExportToLyncEvents(
  thread: GlowficExportThread,
  opts?: Partial<LyncProducerOptions>,
): GlowficLyncResult {
  if (thread === null || typeof thread !== "object") {
    throw new Error("glowfic export: thread is not an object");
  }
  if (
    thread.id === undefined ||
    thread.id === null ||
    String(thread.id).length === 0
  ) {
    throw new Error("glowfic export: thread has no id");
  }
  if (!Array.isArray(thread.posts)) {
    throw new Error("glowfic export: thread.posts is not an array");
  }

  const producer: LyncProducerOptions = {
    importer: opts?.importer ?? "glowfic-json",
    sourceRef:
      opts?.sourceRef ??
      (typeof thread.url === "string" && thread.url.length > 0
        ? thread.url
        : `glowfic:${thread.id}`),
    via: opts?.via ?? "glowfic-dl@unknown",
    operator: opts?.operator,
    markedAt: opts?.markedAt,
  };

  const skipped: LyncSkippedRecord[] = [];
  const timestampFallbacks: LyncTimestampFallback[] = [];
  const events: LyncEventBody[] = [];

  const { posts: _posts, ...threadMetadata } = thread;
  const threadEventId = glowficThreadEventId(thread.id);
  const threadTimestamps = thread.posts
    .map((p) =>
      p && typeof p === "object"
        ? (p as GlowficExportPost).timestamp
        : undefined,
    )
    .filter((t): t is string => typeof t === "string");
  const fallbackAt = producer.markedAt ?? new Date(0).toISOString();
  const threadEvent: LyncEventBody = {
    v: 1,
    id: threadEventId,
    kind: "glowfic/thread",
    at: normalizeAt(
      threadTimestamps[0],
      -1,
      fallbackAt,
      timestampFallbacks,
    ),
    author: buildAuthor(
      "unknown",
      producer,
      String(thread.id),
    ) as unknown as LyncEventBody["author"],
    parents: [],
    payload: threadMetadata as Record<string, unknown>,
  };
  if (producer.markedAt !== undefined) threadEvent.marked = producer.markedAt;
  events.push(threadEvent);

  let previousPostEventId: string | undefined;
  thread.posts.forEach((rawPost, index) => {
    if (rawPost === null || typeof rawPost !== "object") {
      skipped.push({
        index,
        reason: "post is not an object",
        value: rawPost,
      });
      return;
    }
    const post = rawPost as GlowficExportPost;
    if (typeof post.post_id !== "string" || post.post_id.length === 0) {
      skipped.push({
        index,
        reason: "post has no post_id; cannot mint a stable event id",
        value: rawPost,
      });
      return;
    }

    const ev: LyncEventBody = {
      v: 1,
      id: glowficPostEventId(thread.id, post.post_id),
      kind: "glowfic/post",
      at: normalizeAt(post.timestamp, index, fallbackAt, timestampFallbacks),
      author: buildAuthor(
        glowficActor(post),
        producer,
        post.post_id,
      ) as unknown as LyncEventBody["author"],
      parents: [previousPostEventId ?? threadEventId],
      payload: post as Record<string, unknown>,
    };
    if (producer.markedAt !== undefined) ev.marked = producer.markedAt;
    events.push(ev);
    previousPostEventId = ev.id;
  });

  const postEvents = events.length - 1;
  if (postEvents + skipped.length !== thread.posts.length) {
    // Structurally impossible, but the reconciliation invariant is the whole
    // point of this producer — fail loudly rather than miscount silently.
    throw new Error(
      `glowfic export: counts do not reconcile: ${postEvents} events + ${skipped.length} skipped !== ${thread.posts.length} posts`,
    );
  }

  return {
    events,
    threadEventId,
    stats: {
      sourceRecords: thread.posts.length + 1,
      emitted: events.length,
      threadEvents: 1,
      postEvents,
      skipped,
      timestampFallbacks,
    },
  };
}

/* ------------------------------ Write + verify ----------------------------- */

/**
 * Serialize events with lync-core's serializeLyncEvent and write a `.lync`
 * file: UTF-8, one event per line, LF-terminated.
 */
export async function writeLyncFile(
  filePath: string,
  events: LyncEventBody[],
): Promise<void> {
  const body = events.map((ev) => `${serializeLyncEvent(ev)}\n`).join("");
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, body, "utf8");
}

/**
 * Re-parse a written `.lync` file with lync-core's parseLyncFiles and require
 * EVERY line to classify `accepted` (zero garbage/damaged/nonconforming/
 * conflict-variant). Returns counts {lines, events, accepted, byKind} and an
 * explicit list of problems — never a silent verdict.
 */
export async function verifyLyncFile(
  filePath: string,
): Promise<LyncVerifyResult> {
  const bytes = await fs.readFile(filePath);
  const result = parseLyncFiles([{ file: filePath, bytes }]);

  const byKind: Record<string, number> = {};
  let accepted = 0;
  const problems: LyncVerifyProblem[] = [];
  for (const line of result.lines) {
    if (line.class === "accepted") {
      accepted++;
      const kind = line.event?.kind ?? "<unknown>";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    } else {
      problems.push({
        line: line.line,
        class: line.class,
        reason: line.reason,
      });
    }
  }

  return {
    ok:
      problems.length === 0 &&
      accepted === result.lines.length &&
      result.conflictIds.length === 0,
    counts: {
      lines: result.lines.length,
      events: result.unionEventIds.length,
      accepted,
      byKind,
    },
    problems,
  };
}

/* ------------------------- Glowfic end-to-end wire ------------------------- */

export interface GlowficLyncConversion {
  outputPath: string;
  stats: GlowficLyncStats;
  verify: LyncVerifyResult;
}

/**
 * End-to-end: read a glowfic-dl JSON export (thread.json), map to lync
 * events, write a `.lync` file, then verify the written file with lync-core.
 * Throws loudly when the verifier finds any non-accepted line.
 */
export async function convertGlowficExportToLync(
  inputPath: string,
  outputPath: string,
  opts?: Partial<LyncProducerOptions>,
): Promise<GlowficLyncConversion> {
  const raw = await fs.readFile(inputPath, "utf8");
  const thread = JSON.parse(raw) as GlowficExportThread;
  const mapped = glowficExportToLyncEvents(thread, {
    sourceRef: opts?.sourceRef ?? inputPath,
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
