/**
 * Claude.ai account data export (`conversations.json`) → real lync conversation
 * LOOMS (dee-6nkt, textile-explorer / dee-arch archive-instrument lane).
 *
 * WHY THIS EXISTS. `lync-session-loom.ts` frames a Claude Code SESSION (a local
 * `.jsonl` event stream) as a lync conversation loom textile can open. The
 * Claude.ai account export is a DIFFERENT source shape: a single
 * `conversations.json` — a top-level ARRAY of conversations, each a chat with a
 * `uuid`, a `name`, and a `chat_messages` array (each message a `sender`
 * "human"/"assistant", `text` + structured `content`, `created_at`, and — in
 * newer exports — a `parent_message_uuid`). This module turns EACH conversation
 * into its own `ConversationLoomSnapshot`, the exact shape textile's
 * `parseConversationSnapshot` / `importConversationLoom` opens.
 *
 * WHAT THIS DOES. Same loom-framing approach as the session adapter: replay
 * each conversation's messages through the real @deepfates/lync Looms API
 * (`createLyncLooms` + `loom.appendTurn`) over an in-memory event store, then
 * export a `LoomSnapshot`. `appendTurn` nests payload/meta correctly and links
 * parents, so the result folds cleanly and textile's generic conversation
 * reader renders each turn's actor + message. Per message → one turn:
 *   - payload: { message: <the raw chat_message object, verbatim>, text:
 *     <derived display text, always non-empty> }. Text derivation is shared
 *     with the session adapter (`deriveTurnText`) so what splice stamps is what
 *     textile shows; a message with no text (attachment-only) gets a compact,
 *     faithful block summary — never a blank turn, never a fabricated sentence.
 *   - meta: { role: "user" (sender "human") | "assistant" | <sender verbatim>,
 *     author: "deepfates" for human, the model id for assistant when the export
 *     carries one, else "assistant" }.
 *   - parent: derived from `parent_message_uuid` when the export carries message
 *     linkage (branches survive); otherwise the messages are chained LINEARLY in
 *     array order (older exports have no per-message parent). Which mode was used
 *     is recorded per conversation in `stats.linkage`, never guessed silently.
 *
 * ZERO SILENT DROPS. Every conversation and every message is accounted for. A
 * non-object conversation, or one with no `chat_messages` array, is counted in
 * `stats.skippedConversations` (never a thrown-away loom). A non-object message
 * is counted in that conversation's `stats.skippedMessages`. The invariant
 * messages === turns + skippedMessages holds per conversation and is summed
 * across the export.
 *
 * PRIVACY. This module transforms SHAPE only. Message text is copied verbatim
 * from the source into the loom payload; it is NEVER logged or summarized to
 * stdout by this module. Tests + fixtures that exercise it are SYNTHETIC.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createLyncLooms,
  createMemoryEventStore,
} from "@deepfates/lync";
import type { LoomSnapshot } from "@deepfates/lync";

import { DEFAULT_OPERATOR, SPLICE_IMPORT_VERSION } from "./lync.js";
import {
  deriveTurnText,
  type SessionTurnMeta,
  type SessionTurnPayload,
} from "./lync-session-loom.js";

/* --------------------------------- Types ---------------------------------- */

export const CLAUDEAI_EXPORT_IMPORTER = "claudeai-export-import";

/** The loom's own meta: marks it a conversation loom for the reader/index. */
export interface ClaudeAiLoomMeta {
  profile: "conversation";
  source: "claudeai-export";
  /** The conversation's own `uuid` from the export (stable identity). */
  conversationUuid: string;
  /** The conversation's `name` (its title in the app), when present. */
  title?: string;
}

export interface ClaudeAiConversationStats {
  /** The conversation's `uuid` (or a locator when absent). */
  conversationUuid: string;
  /** The conversation `name`, or "(untitled)" when absent. */
  title: string;
  /** Source `chat_messages` entries seen. */
  messages: number;
  /** Messages mapped to loom turns. */
  turns: number;
  /** Non-object messages counted, never dropped (messages = turns + skipped). */
  skippedMessages: number;
  /** Distinct actors across the turns (e.g. deepfates + one model id). */
  distinctActors: string[];
  /** How turn parents were derived: explicit linkage vs linear array order. */
  linkage: "parent" | "linear";
}

export interface ClaudeAiConversationLoom {
  snapshot: LoomSnapshot<SessionTurnPayload, ClaudeAiLoomMeta, SessionTurnMeta>;
  stats: ClaudeAiConversationStats;
}

export interface ClaudeAiExportStats {
  /** Conversation objects mapped to looms. */
  conversations: number;
  /** Non-object / message-less conversations counted, never dropped. */
  skippedConversations: number;
  /** Sum of source messages across all mapped conversations. */
  totalMessages: number;
  /** Sum of emitted turns across all looms. */
  totalTurns: number;
  /** Sum of skipped (non-object) messages across all conversations. */
  totalSkippedMessages: number;
  /** Per-conversation accounting, in source order. */
  perConversation: ClaudeAiConversationStats[];
}

export interface ClaudeAiExportResult {
  looms: ClaudeAiConversationLoom[];
  stats: ClaudeAiExportStats;
}

export interface ClaudeAiExportOptions {
  /** Actor recorded for human-authored messages. Default "deepfates". */
  userActor?: string;
  /** Fallback author for assistant messages with no model id. Default "assistant". */
  assistantActor?: string;
  /** Operator recorded in the author envelope. Default "deepfates". */
  operator?: string;
  /** Provenance source ref stamped in the author envelope. */
  sourceRef?: string;
}

/* --------------------------------- Helpers -------------------------------- */

type JsonRecord = Record<string, unknown>;

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A message's role: sender "human" → "user", "assistant" → "assistant", any
 * other non-empty sender kept verbatim, else the message's own `role`, else
 * "unknown". Read EXPLICITLY so textile's origin classifier never guesses by
 * absence.
 */
function messageRole(message: JsonRecord): string {
  const sender = stringField(message, "sender");
  if (sender === "human") return "user";
  if (sender === "assistant") return "assistant";
  if (sender) return sender;
  return stringField(message, "role") ?? "unknown";
}

/**
 * A message's author: "deepfates" for a human sender, the export's model id for
 * an assistant when present, else the assistant fallback; "unknown" otherwise.
 * The actor rides in meta.author because lync's fold drops event.author.
 */
function messageAuthor(message: JsonRecord, opts: ClaudeAiExportOptions): string {
  const sender = stringField(message, "sender");
  if (sender === "human") return opts.userActor ?? DEFAULT_OPERATOR;
  const model = stringField(message, "model");
  if (model) return model;
  if (sender === "assistant") return opts.assistantActor ?? "assistant";
  return "unknown";
}

/** The message's explicit parent pointer, when the export carries one. */
function parentUuidOf(message: JsonRecord): string | null {
  return (
    stringField(message, "parent_message_uuid") ??
    stringField(message, "parent") ??
    null
  );
}

/**
 * Topological order (parents before children) over messages linked by
 * `parent_message_uuid`. A parent pointer outside the message set (a root
 * sentinel, an absent uuid) is treated as a root. Ties keep source order; a
 * cycle is broken loudly rather than silently.
 */
function orderByParentUuid(
  messages: { uuid: string | null; message: JsonRecord; index: number }[],
): typeof messages {
  const byUuid = new Map<string, (typeof messages)[number]>();
  for (const item of messages) {
    if (item.uuid && !byUuid.has(item.uuid)) byUuid.set(item.uuid, item);
  }
  const ordered: typeof messages = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (item: (typeof messages)[number]): void => {
    if (visited.has(item.index)) return;
    if (visiting.has(item.index)) {
      throw new Error(
        `claudeai export: parent cycle detected at message ${item.uuid ?? item.index}`,
      );
    }
    visiting.add(item.index);
    const parentUuid = parentUuidOf(item.message);
    const parent = parentUuid ? byUuid.get(parentUuid) : undefined;
    if (parent) visit(parent);
    visiting.delete(item.index);
    visited.add(item.index);
    ordered.push(item);
  };
  for (const item of messages) visit(item);
  return ordered;
}

/* -------------------------------- Adapters -------------------------------- */

/**
 * Build one lync conversation LOOM from a single Claude.ai export conversation
 * object by replaying its messages through the real Looms API. Returns the
 * exported snapshot (importable by textile via `looms.import`) plus
 * zero-silent-drops stats.
 */
export async function conversationToLoom(
  conversation: JsonRecord,
  locator: string,
  opts: ClaudeAiExportOptions = {},
): Promise<ClaudeAiConversationLoom> {
  const conversationUuid = stringField(conversation, "uuid") ?? locator;
  const title = stringField(conversation, "name");
  const rawMessages = conversation["chat_messages"];
  const list = Array.isArray(rawMessages) ? rawMessages : [];

  // Partition into real (object) messages and non-object skips — nothing silent.
  const items: { uuid: string | null; message: JsonRecord; index: number }[] = [];
  let skippedMessages = 0;
  list.forEach((entry, index) => {
    if (isObject(entry)) {
      items.push({ uuid: stringField(entry, "uuid"), message: entry, index });
    } else {
      skippedMessages += 1;
    }
  });

  const linkage: "parent" | "linear" = items.some(
    (item) => parentUuidOf(item.message) !== null,
  )
    ? "parent"
    : "linear";

  const store = createMemoryEventStore();
  const looms = createLyncLooms<
    SessionTurnPayload,
    ClaudeAiLoomMeta,
    SessionTurnMeta
  >({
    store,
    author: {
      actor: opts.userActor ?? DEFAULT_OPERATOR,
      operator: opts.operator ?? DEFAULT_OPERATOR,
      imported_by: `splice/${CLAUDEAI_EXPORT_IMPORTER}@${SPLICE_IMPORT_VERSION}`,
      source: opts.sourceRef ?? locator,
    },
  });

  const loomMeta: ClaudeAiLoomMeta = {
    profile: "conversation",
    source: "claudeai-export",
    conversationUuid,
    ...(title ? { title } : {}),
  };
  const info = await looms.create(loomMeta);
  const loom = await looms.open(info.id);

  const actors = new Set<string>();

  if (linkage === "parent") {
    const idMap = new Map<string, string>();
    for (const item of orderByParentUuid(items)) {
      const parentUuid = parentUuidOf(item.message);
      const parentTurnId =
        parentUuid && idMap.has(parentUuid)
          ? (idMap.get(parentUuid) as string)
          : null;
      const author = messageAuthor(item.message, opts);
      actors.add(author);
      const turn = await loom.appendTurn(
        parentTurnId,
        { message: item.message, text: deriveTurnText(item.message) },
        { role: messageRole(item.message), author },
      );
      if (item.uuid) idMap.set(item.uuid, turn.id);
    }
  } else {
    // Linear: chain each message to the previous one in source order.
    let previousTurnId: string | null = null;
    for (const item of items) {
      const author = messageAuthor(item.message, opts);
      actors.add(author);
      const turn = await loom.appendTurn(
        previousTurnId,
        { message: item.message, text: deriveTurnText(item.message) },
        { role: messageRole(item.message), author },
      );
      previousTurnId = turn.id;
    }
  }

  const snapshot = await loom.export();
  loom.close();

  return {
    snapshot,
    stats: {
      conversationUuid,
      title: title ?? "(untitled)",
      messages: list.length,
      turns: snapshot.turns.length,
      skippedMessages,
      distinctActors: [...actors],
      linkage,
    },
  };
}

/**
 * Turn a whole Claude.ai `conversations.json` into one conversation loom per
 * chat. Returns every snapshot plus reconciling export-wide stats. A non-object
 * or message-less conversation is counted (skippedConversations), never dropped.
 */
export async function claudeAiExportToLooms(
  jsonText: string,
  opts: ClaudeAiExportOptions = {},
): Promise<ClaudeAiExportResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `claudeai export: invalid JSON (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      "claudeai export: expected a top-level array of conversations.",
    );
  }

  const looms: ClaudeAiConversationLoom[] = [];
  const perConversation: ClaudeAiConversationStats[] = [];
  let skippedConversations = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const conversation = raw[index];
    if (!isObject(conversation) || !Array.isArray(conversation["chat_messages"])) {
      skippedConversations += 1;
      continue;
    }
    const locator = `conversation-${index}`;
    const built = await conversationToLoom(conversation, locator, opts);
    looms.push(built);
    perConversation.push(built.stats);
  }

  return {
    looms,
    stats: {
      conversations: looms.length,
      skippedConversations,
      totalMessages: perConversation.reduce((sum, c) => sum + c.messages, 0),
      totalTurns: perConversation.reduce((sum, c) => sum + c.turns, 0),
      totalSkippedMessages: perConversation.reduce(
        (sum, c) => sum + c.skippedMessages,
        0,
      ),
      perConversation,
    },
  };
}

/** A slug for a conversation's snapshot filename (stable, filesystem-safe). */
function conversationSlug(stats: ClaudeAiConversationStats, index: number): string {
  const id = stats.conversationUuid.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `conversation-${String(index).padStart(4, "0")}-${id}`;
}

/**
 * End-to-end: read a Claude.ai `conversations.json`, build one conversation loom
 * per chat, and write each snapshot as pretty JSON (`<slug>.loom.json`) that
 * textile can import. Returns the output paths + stats (SHAPE only, never
 * message content).
 */
export async function convertClaudeAiExportToLoomFiles(
  inputPath: string,
  outDir: string,
  opts: ClaudeAiExportOptions = {},
): Promise<{
  outputs: { outputPath: string; stats: ClaudeAiConversationStats }[];
  stats: ClaudeAiExportStats;
}> {
  const text = await fs.readFile(inputPath, "utf8");
  const { looms, stats } = await claudeAiExportToLooms(text, {
    sourceRef: opts.sourceRef ?? inputPath,
    ...opts,
  });
  await fs.mkdir(outDir, { recursive: true });
  const outputs: { outputPath: string; stats: ClaudeAiConversationStats }[] = [];
  for (let index = 0; index < looms.length; index += 1) {
    const built = looms[index];
    const outputPath = path.join(
      outDir,
      `${conversationSlug(built.stats, index)}.loom.json`,
    );
    await fs.writeFile(
      outputPath,
      `${JSON.stringify(built.snapshot, null, 2)}\n`,
      "utf8",
    );
    outputs.push({ outputPath, stats: built.stats });
  }
  return { outputs, stats };
}
