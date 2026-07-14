/**
 * Claude Code session → a real lync LOOM (dee-07pu, textile-explorer lane).
 *
 * WHY THIS EXISTS. `lync-claude-session.ts` emits a FLAT `claude/<type>` event
 * stream: the actor lives at `event.author.actor` and the text at
 * `payload.message`. lync's `foldLoom` (looms.js) does NOT read those — it folds
 * only `lync/loom` + `lync/turn` events, pulling a turn's payload from the
 * NESTED `payload.payload`, its meta from `payload.meta`, and its parent from
 * `event.parents[0]`; `event.author` is dropped by the fold entirely. So the
 * flat stream, while a faithful append-only import, is un-openable by lync's
 * Looms API and by textile's reader.
 *
 * WHAT THIS DOES. Re-frames one session as a proper lync loom by REPLAYING it
 * through the real @deepfates/lync Looms API (`createLyncLooms` +
 * `loom.appendTurn`) over an in-memory event store, then exporting a
 * `LoomSnapshot`. `appendTurn` nests payload/meta correctly and links parents,
 * so the result folds cleanly and textile's generic reader (PR #65) renders
 * each turn's actor + message. Per turn:
 *   - payload: { message: <the raw Claude message, verbatim>, text: <derived
 *     display text, always non-empty> }. textile's reader takes `payload.text`
 *     first, so a turn NEVER renders blank (even a tool-only assistant record
 *     gets a compact, faithful summary — never a fabricated sentence).
 *   - meta: { role: "user" | "assistant" | <the record type>, author: the
 *     record's actor (deepfates for user turns, the model id for assistant
 *     turns) }. The actor rides in `meta.author` because the fold drops
 *     `event.author` — this is the whole fix.
 *   - parent: the turn minted from this record's `parentUuid` predecessor, or
 *     the loom root when there is none.
 *
 * SCOPE / ZERO SILENT DROPS. Conversation records (every uuid-bearing
 * `claude/<type>` event) become turns. uuid-less sidecars (the reference's
 * `lore/pointer` / `lore/annotation` events — ai-title, mode, file snapshots,
 * …) are NOT conversation turns; they are counted in
 * `stats.nonTurnEvents` with their kinds, never dropped in silence. The
 * underlying line-level accounting (blank/invalid/non-object skips, timestamp
 * fallbacks) is carried through verbatim from `claudeSessionToLyncEvents`.
 *
 * PRIVACY. This module transforms SHAPE only. Message text is copied verbatim
 * from the source into the loom; it is never logged or summarized to stdout by
 * this module. Tests + fixtures that exercise it are SYNTHETIC.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createLyncLooms,
  createMemoryEventStore,
} from "@deepfates/lync";
import type { LoomSnapshot } from "@deepfates/lync";
import type { LyncEventBody } from "@deepfates/lync/events";

import { DEFAULT_OPERATOR, SPLICE_IMPORT_VERSION } from "./lync.js";
import {
  claudeSessionToLyncEvents,
  CLAUDE_SESSION_IMPORTER,
  type ClaudeSessionLyncStats,
  type ClaudeSessionOptions,
} from "./lync-claude-session.js";

/* --------------------------------- Types ---------------------------------- */

/** A conversation turn's payload: raw message kept, display text guaranteed. */
export interface SessionTurnPayload {
  /** The Claude message object (or string) verbatim from the source record. */
  message: unknown;
  /** Display text, ALWAYS non-empty — textile's reader takes this first. */
  text: string;
}

/** A conversation turn's meta: role + the actor identity (dee-9y0k provenance). */
export interface SessionTurnMeta {
  /** "user" | "assistant" | the record's `claude/<type>` suffix. */
  role: string;
  /** The record's actor: deepfates for user turns, the model id for assistant. */
  author: string;
}

/** The loom's own meta: marks it a conversation loom for the reader/index. */
export interface SessionLoomMeta {
  profile: "conversation";
  source: "claude-session";
  /** Stable session identity (the file basename, e.g. "<sessionId>.jsonl"). */
  sessionLocator: string;
  title?: string;
}

export interface SessionLoomStats {
  /** Conversation records mapped to loom turns. */
  turns: number;
  /** Distinct actors across the turns (e.g. deepfates + one model id). */
  distinctActors: string[];
  /** Sidecar events not mapped to turns, by kind — never silently dropped. */
  nonTurnEvents: Record<string, number>;
  /** The full line-level accounting from the flat importer, carried through. */
  session: ClaudeSessionLyncStats;
}

export interface SessionLoomResult {
  snapshot: LoomSnapshot<SessionTurnPayload, SessionLoomMeta, SessionTurnMeta>;
  stats: SessionLoomStats;
}

export interface SessionLoomOptions extends ClaudeSessionOptions {
  /** Optional human title stamped into the loom meta. */
  title?: string;
}

/* ------------------------------ Text derivation --------------------------- */

/**
 * A turn's display text, ALWAYS non-empty. Mirrors textile's reader
 * (`deriveTurnText`/`textFromMessage`) so what splice stamps is what textile
 * shows: a string message is itself; a structured Claude message concatenates
 * its text blocks. A record with NO text (a tool-only assistant turn, an empty
 * content array) gets a compact, faithful summary of its block types — never a
 * blank turn (the reader throws on blank) and never a fabricated sentence.
 */
export function deriveTurnText(message: unknown): string {
  if (typeof message === "string") {
    return message.length > 0 ? message : "(empty message)";
  }
  if (message && typeof message === "object") {
    const record = message as { text?: unknown; content?: unknown };
    if (typeof record.text === "string" && record.text.length > 0) {
      return record.text;
    }
    const content = record.content;
    if (typeof content === "string") {
      return content.length > 0 ? content : "(empty message)";
    }
    if (Array.isArray(content)) {
      const parts = content
        .map((block) => blockText(block))
        .filter((part) => part.length > 0);
      if (parts.length > 0) return parts.join("");
      const summary = content
        .map((block) => blockSummary(block))
        .filter((part) => part.length > 0);
      if (summary.length > 0) return summary.join(" ");
    }
  }
  return "(no text content)";
}

/** Text carried by one content block ("" when the block is not text-bearing). */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object") {
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** A compact, faithful label for a non-text block (never its raw content). */
function blockSummary(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const record = block as { type?: unknown; name?: unknown };
  const type = typeof record.type === "string" ? record.type : "block";
  const name = typeof record.name === "string" ? `:${record.name}` : "";
  return `[${type}${name}]`;
}

/* ------------------------------ Role derivation --------------------------- */

const CLAUDE_KIND_PREFIX = "claude/";

/** Is this a conversation record (a uuid-bearing `claude/<type>` event)? */
function isConversationEvent(event: LyncEventBody): boolean {
  return event.kind.startsWith(CLAUDE_KIND_PREFIX);
}

/**
 * A turn's role: the message's own `role` when present (user/assistant), else
 * the `claude/<type>` suffix (system, summary, …). Read EXPLICITLY so textile's
 * `originFromMeta` can classify origin without guessing by absence.
 */
function deriveRole(event: LyncEventBody): string {
  const message = (event.payload as { message?: unknown } | undefined)?.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string" && role.length > 0) return role;
  }
  return event.kind.slice(CLAUDE_KIND_PREFIX.length);
}

/* -------------------------------- Adapter --------------------------------- */

/**
 * Topological order (parents before children) over the flat event list, using
 * each event's `parents[0]` linkage. A parent pointer to an event OUTSIDE the
 * conversation set (or absent) is treated as a root. Ties keep source order.
 */
function orderByParents(events: LyncEventBody[]): LyncEventBody[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const ordered: LyncEventBody[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (event: LyncEventBody): void => {
    if (visited.has(event.id)) return;
    if (visiting.has(event.id)) {
      // A cycle in a session file is malformed; break it loudly rather than
      // hang, but never silently — the event still lands, root-attached.
      throw new Error(
        `session loom: parent cycle detected at event ${event.id}`,
      );
    }
    visiting.add(event.id);
    const parentId = event.parents[0];
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) visit(parent);
    visiting.delete(event.id);
    visited.add(event.id);
    ordered.push(event);
  };
  for (const event of events) visit(event);
  return ordered;
}

/**
 * Build a lync conversation LOOM from Claude session JSONL text by replaying it
 * through the real Looms API. Returns the exported snapshot (importable by
 * textile via `looms.import`) plus zero-silent-drops stats.
 */
export async function claudeSessionToLoom(
  jsonlText: string,
  sessionLocator: string,
  opts: SessionLoomOptions = {},
): Promise<SessionLoomResult> {
  const { events, stats: sessionStats } = claudeSessionToLyncEvents(
    jsonlText,
    sessionLocator,
    opts,
  );

  const conversation = events.filter(isConversationEvent);
  const nonTurnEvents: Record<string, number> = {};
  for (const event of events) {
    if (isConversationEvent(event)) continue;
    nonTurnEvents[event.kind] = (nonTurnEvents[event.kind] ?? 0) + 1;
  }

  const store = createMemoryEventStore();
  const looms = createLyncLooms<
    SessionTurnPayload,
    SessionLoomMeta,
    SessionTurnMeta
  >({
    store,
    author: {
      actor: opts.userActor ?? DEFAULT_OPERATOR,
      operator: opts.operator ?? DEFAULT_OPERATOR,
      imported_by: `splice/${CLAUDE_SESSION_IMPORTER}@${SPLICE_IMPORT_VERSION}`,
      source: opts.sourceRef ?? sessionLocator,
    },
  });

  const loomMeta: SessionLoomMeta = {
    profile: "conversation",
    source: "claude-session",
    sessionLocator,
    ...(opts.title ? { title: opts.title } : {}),
  };
  const info = await looms.create(loomMeta);
  const loom = await looms.open(info.id);

  const idMap = new Map<string, string>();
  const actors = new Set<string>();
  for (const event of orderByParents(conversation)) {
    const parentEventId = event.parents[0];
    const parentTurnId =
      parentEventId && idMap.has(parentEventId)
        ? (idMap.get(parentEventId) as string)
        : null;
    const message = (event.payload as { message?: unknown }).message ?? null;
    const author = event.author.actor;
    actors.add(author);
    const turn = await loom.appendTurn(
      parentTurnId,
      { message, text: deriveTurnText(message) },
      { role: deriveRole(event), author },
    );
    idMap.set(event.id, turn.id);
  }

  const snapshot = await loom.export();
  loom.close();

  return {
    snapshot,
    stats: {
      turns: snapshot.turns.length,
      distinctActors: [...actors],
      nonTurnEvents,
      session: sessionStats,
    },
  };
}

/**
 * End-to-end: read one Claude session `.jsonl`, build the conversation loom,
 * and write its snapshot as pretty JSON that textile can import. Returns the
 * output path + stats (SHAPE only, never message content).
 */
export async function convertClaudeSessionToLoomFile(
  inputPath: string,
  outputPath: string,
  opts: SessionLoomOptions = {},
): Promise<{ outputPath: string; stats: SessionLoomStats }> {
  const text = await fs.readFile(inputPath, "utf8");
  const { snapshot, stats } = await claudeSessionToLoom(
    text,
    path.basename(inputPath),
    { sourceRef: opts.sourceRef ?? inputPath, ...opts },
  );
  await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { outputPath, stats };
}
