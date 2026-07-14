/**
 * ChatGPT account data export (`conversations.json`) → real lync conversation
 * LOOMS (dee-do4a, textile-explorer / dee-arch archive-instrument lane).
 *
 * WHY THIS EXISTS. `lync-claudeai-export.ts` frames a Claude.ai account export
 * (a top-level array of conversations, each a FLAT `chat_messages` list) as lync
 * conversation looms textile can open. ChatGPT's export is a DIFFERENT source
 * shape: a top-level ARRAY of conversations, each with a `mapping` — an OBJECT
 * of message nodes keyed by id, each node `{ id, message?, parent, children[] }`.
 * It is a genuine parent/children GRAPH: regenerations and edits fan out as
 * branches. This module turns EACH conversation into its own
 * `ConversationLoomSnapshot`, the exact shape textile's `parseConversationSnapshot`
 * / `importConversationLoom` opens — walking the mapping graph so branches
 * survive rather than being flattened.
 *
 * WHAT THIS DOES. Same loom-framing approach as the claude.ai adapter: replay
 * each conversation's message nodes through the real @deepfates/lync Looms API
 * (`createLyncLooms` + `loom.appendTurn`) over an in-memory event store, then
 * export a `LoomSnapshot`. Nodes are visited in topological order (parents
 * before children) reconstructed from the `parent` links, so `appendTurn` can
 * link each turn to its parent turn and the branch structure is preserved. One
 * message-bearing node → one turn:
 *   - payload: { message: <the raw node.message object, verbatim>, text:
 *     <derived display text, always non-empty> }. Text derivation reuses the
 *     shared `deriveTurnText`: a node's `content.parts` are joined (string parts
 *     are text; non-text parts — image pointers, code, tool blocks — get a
 *     compact, faithful `[content_type]` summary, never a blank, never a
 *     fabricated sentence); a `content.text` (code / execution_output nodes) is
 *     taken directly.
 *   - meta: { role: message.author.role verbatim (user | assistant | system |
 *     tool | …), author: "deepfates" for user, the model slug for assistant when
 *     the export carries one, else the author name / role }.
 *   - parent: the turn of the nearest message-bearing ANCESTOR node (placeholder
 *     ancestors — the client root, hidden system nodes with no message — are
 *     skipped, so a first real message roots at null). Branches survive: a node
 *     with two children yields two child turns under the same parent turn.
 *
 * ZERO SILENT DROPS. Every conversation and every mapping node is accounted for.
 * A non-object conversation, or one with no `mapping` object, is counted in
 * `stats.skippedConversations` (never a thrown-away loom). Within a conversation:
 * a node WITH a message object becomes a turn; a node with NO message (the root
 * placeholder, a hidden system-context node) is counted in
 * `stats.placeholderNodes`; a non-object mapping value is counted in
 * `stats.malformedNodes`. The invariant
 * nodes === turns + placeholderNodes + malformedNodes holds per conversation and
 * is summed across the export.
 *
 * PRIVACY. This module transforms SHAPE only. Message content is copied verbatim
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

export const CHATGPT_EXPORT_IMPORTER = "chatgpt-export-import";

/** The loom's own meta: marks it a conversation loom for the reader/index. */
export interface ChatGptLoomMeta {
  profile: "conversation";
  source: "chatgpt-export";
  /** The conversation's own id (`conversation_id`/`id`) — stable identity. */
  conversationId: string;
  /** The conversation's `title` (its name in the app), when present. */
  title?: string;
}

export interface ChatGptConversationStats {
  /** The conversation's id (or a locator when absent). */
  conversationId: string;
  /** The conversation `title`, or "(untitled)" when absent. */
  title: string;
  /** Total node entries seen in the `mapping` object. */
  nodes: number;
  /** Message-bearing nodes mapped to loom turns. */
  turns: number;
  /** Nodes with NO message (root/hidden placeholders), counted never dropped. */
  placeholderNodes: number;
  /** Non-object mapping values, counted never dropped. */
  malformedNodes: number;
  /** Distinct actors across the turns (e.g. deepfates + one model slug). */
  distinctActors: string[];
  /** How many turns have a sibling under the same parent (branch fan-out). */
  branchedTurns: number;
}

export interface ChatGptConversationLoom {
  snapshot: LoomSnapshot<SessionTurnPayload, ChatGptLoomMeta, SessionTurnMeta>;
  stats: ChatGptConversationStats;
}

export interface ChatGptExportStats {
  /** Conversation objects mapped to looms. */
  conversations: number;
  /** Non-object / mapping-less conversations counted, never dropped. */
  skippedConversations: number;
  /** Sum of source mapping nodes across all mapped conversations. */
  totalNodes: number;
  /** Sum of emitted turns across all looms. */
  totalTurns: number;
  /** Sum of placeholder (message-less) nodes across all conversations. */
  totalPlaceholderNodes: number;
  /** Sum of malformed (non-object) mapping values across all conversations. */
  totalMalformedNodes: number;
  /** Per-conversation accounting, in source order. */
  perConversation: ChatGptConversationStats[];
}

export interface ChatGptExportResult {
  looms: ChatGptConversationLoom[];
  stats: ChatGptExportStats;
}

export interface ChatGptExportOptions {
  /** Actor recorded for user-authored messages. Default "deepfates". */
  userActor?: string;
  /** Fallback author for assistant messages with no model slug. Default "assistant". */
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

/** A parsed mapping node: its id, its parent id, and the raw node object. */
interface MappingNode {
  id: string;
  parent: string | null;
  node: JsonRecord;
  /** The `message` object when the node carries one (else null → placeholder). */
  message: JsonRecord | null;
}

/**
 * A node's role: `message.author.role` verbatim (user/assistant/system/tool/…).
 * Read EXPLICITLY so textile's origin classifier never guesses by absence.
 */
function messageRole(message: JsonRecord): string {
  const author = message["author"];
  if (isObject(author)) {
    const role = stringField(author, "role");
    if (role) return role;
  }
  return stringField(message, "role") ?? "unknown";
}

/** The message's outer metadata object, where ChatGPT stamps the model slug. */
function messageMetadata(message: JsonRecord): JsonRecord | null {
  const meta = message["metadata"];
  return isObject(meta) ? meta : null;
}

/**
 * A message's author identity: "deepfates" for a user turn; the model slug
 * (`metadata.model_slug`) for an assistant when present, else the author name,
 * else the assistant fallback; the author name or role otherwise (tool → its
 * tool name). The actor rides in meta.author because lync's fold drops
 * event.author.
 */
function messageAuthor(message: JsonRecord, opts: ChatGptExportOptions): string {
  const role = messageRole(message);
  if (role === "user") return opts.userActor ?? DEFAULT_OPERATOR;

  const author = message["author"];
  const authorName = isObject(author) ? stringField(author, "name") : null;

  if (role === "assistant") {
    const meta = messageMetadata(message);
    const slug = meta ? stringField(meta, "model_slug") : null;
    if (slug) return slug;
    if (authorName) return authorName;
    return opts.assistantActor ?? "assistant";
  }
  // system / tool / anything else: prefer the explicit author name, else role.
  return authorName ?? role;
}

/**
 * A node's display text, ALWAYS non-empty, via the shared `deriveTurnText`.
 * ChatGPT carries text in `message.content`:
 *   - `{ content_type, parts: [...] }` — the common case. String parts are text;
 *     non-text parts (image_asset_pointer, audio, etc.) are normalized to
 *     `deriveTurnText` blocks so each yields a faithful `[content_type]` summary.
 *   - `{ content_type: "code" | "execution_output" | …, text: "…" }` — taken
 *     directly as the block text.
 *   - a bare string, or anything else — passed through for a faithful fallback.
 * Never blank (the reader throws on blank), never a fabricated sentence.
 */
function deriveChatGptText(message: JsonRecord): string {
  const content = message["content"];
  if (isObject(content)) {
    const parts = content["parts"];
    if (Array.isArray(parts)) {
      return deriveTurnText({ content: partsToBlocks(parts) });
    }
    const text = content["text"];
    if (typeof text === "string") {
      return deriveTurnText({ content: text });
    }
    const contentType = stringField(content, "content_type");
    if (contentType) return `[${contentType}]`;
  }
  if (typeof content === "string") {
    return deriveTurnText({ content });
  }
  return deriveTurnText(message);
}

/**
 * Normalize ChatGPT `content.parts` into the block shape `deriveTurnText`
 * understands: a string part stays a string (text-bearing); an object part is
 * given a `type` mirror of its `content_type` so the shared `blockSummary`
 * labels it faithfully (e.g. `[image_asset_pointer]`) instead of a bare
 * `[block]`. Nothing is invented; the object's own content_type is used.
 */
function partsToBlocks(parts: unknown[]): unknown[] {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (isObject(part)) {
      const contentType = stringField(part, "content_type");
      return contentType ? { ...part, type: contentType } : part;
    }
    return part;
  });
}

/**
 * Topological order (parents before children) over the mapping nodes, using each
 * node's `parent` link. A parent pointer outside the node set (the absent root
 * sentinel, a dangling id) is treated as a root. Ties keep the mapping's own
 * key order. A cycle is broken loudly rather than silently.
 */
function orderByParent(nodes: MappingNode[]): MappingNode[] {
  const byId = new Map<string, MappingNode>();
  for (const item of nodes) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const ordered: MappingNode[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (item: MappingNode): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) {
      throw new Error(
        `chatgpt export: parent cycle detected at node ${item.id}`,
      );
    }
    visiting.add(item.id);
    const parent = item.parent ? byId.get(item.parent) : undefined;
    if (parent) visit(parent);
    visiting.delete(item.id);
    visited.add(item.id);
    ordered.push(item);
  };
  for (const item of nodes) visit(item);
  return ordered;
}

/* -------------------------------- Adapters -------------------------------- */

/**
 * Build one lync conversation LOOM from a single ChatGPT export conversation
 * object by replaying its `mapping` graph through the real Looms API. Returns the
 * exported snapshot (importable by textile via `looms.import`) plus
 * zero-silent-drops stats.
 */
export async function chatGptConversationToLoom(
  conversation: JsonRecord,
  locator: string,
  opts: ChatGptExportOptions = {},
): Promise<ChatGptConversationLoom> {
  const conversationId =
    stringField(conversation, "conversation_id") ??
    stringField(conversation, "id") ??
    locator;
  const title = stringField(conversation, "title");
  const mapping = conversation["mapping"];

  // Partition mapping values: real message-nodes, message-less placeholders,
  // and non-object malformed values — nothing silent. Preserve key order.
  const nodes: MappingNode[] = [];
  let placeholderNodes = 0;
  let malformedNodes = 0;
  let totalNodes = 0;
  if (isObject(mapping)) {
    for (const [id, value] of Object.entries(mapping)) {
      totalNodes += 1;
      if (!isObject(value)) {
        malformedNodes += 1;
        continue;
      }
      const parent = stringField(value, "parent");
      const message = value["message"];
      if (isObject(message)) {
        nodes.push({ id, parent, node: value, message });
      } else {
        // Root / hidden system placeholder — kept in the graph for parent
        // resolution, but produces no turn. Counted, never dropped.
        nodes.push({ id, parent, node: value, message: null });
        placeholderNodes += 1;
      }
    }
  }

  const store = createMemoryEventStore();
  const looms = createLyncLooms<
    SessionTurnPayload,
    ChatGptLoomMeta,
    SessionTurnMeta
  >({
    store,
    author: {
      actor: opts.userActor ?? DEFAULT_OPERATOR,
      operator: opts.operator ?? DEFAULT_OPERATOR,
      imported_by: `splice/${CHATGPT_EXPORT_IMPORTER}@${SPLICE_IMPORT_VERSION}`,
      source: opts.sourceRef ?? locator,
    },
  });

  const loomMeta: ChatGptLoomMeta = {
    profile: "conversation",
    source: "chatgpt-export",
    conversationId,
    ...(title ? { title } : {}),
  };
  const info = await looms.create(loomMeta);
  const loom = await looms.open(info.id);

  const nodesById = new Map<string, MappingNode>();
  for (const item of nodes) nodesById.set(item.id, item);

  // node id → the turn id it produced (placeholders never enter this map).
  const idMap = new Map<string, string>();
  // Resolve a node's parent TURN: nearest message-bearing ancestor, skipping
  // placeholder ancestors (the client root, hidden system nodes) so a first real
  // message roots at null.
  const resolveParentTurnId = (item: MappingNode): string | null => {
    let cursor = item.parent;
    const guard = new Set<string>();
    while (cursor) {
      if (idMap.has(cursor)) return idMap.get(cursor) as string;
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const parentNode = nodesById.get(cursor);
      if (!parentNode) break;
      cursor = parentNode.parent;
    }
    return null;
  };

  const actors = new Set<string>();
  const parentTurnCounts = new Map<string, number>();
  let turns = 0;

  for (const item of orderByParent(nodes)) {
    if (!item.message) continue; // placeholder: kept for linkage, no turn.
    const message = item.message;
    const author = messageAuthor(message, opts);
    actors.add(author);
    const parentTurnId = resolveParentTurnId(item);
    const turn = await loom.appendTurn(
      parentTurnId,
      { message, text: deriveChatGptText(message) },
      { role: messageRole(message), author },
    );
    idMap.set(item.id, turn.id);
    turns += 1;
    // Track branch fan-out: a parent (or the root, keyed "") with >1 child turn.
    const key = parentTurnId ?? "";
    parentTurnCounts.set(key, (parentTurnCounts.get(key) ?? 0) + 1);
  }

  // A turn is "branched" when it shares a parent with at least one sibling.
  let branchedTurns = 0;
  for (const count of parentTurnCounts.values()) {
    if (count > 1) branchedTurns += count;
  }

  const snapshot = await loom.export();
  loom.close();

  return {
    snapshot,
    stats: {
      conversationId,
      title: title ?? "(untitled)",
      nodes: totalNodes,
      turns,
      placeholderNodes,
      malformedNodes,
      distinctActors: [...actors],
      branchedTurns,
    },
  };
}

/**
 * Turn a whole ChatGPT `conversations.json` into one conversation loom per chat.
 * Returns every snapshot plus reconciling export-wide stats. A non-object or
 * mapping-less conversation is counted (skippedConversations), never dropped.
 */
export async function chatGptExportToLooms(
  jsonText: string,
  opts: ChatGptExportOptions = {},
): Promise<ChatGptExportResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `chatgpt export: invalid JSON (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      "chatgpt export: expected a top-level array of conversations.",
    );
  }

  const looms: ChatGptConversationLoom[] = [];
  const perConversation: ChatGptConversationStats[] = [];
  let skippedConversations = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const conversation = raw[index];
    if (!isObject(conversation) || !isObject(conversation["mapping"])) {
      skippedConversations += 1;
      continue;
    }
    const locator = `conversation-${index}`;
    const built = await chatGptConversationToLoom(conversation, locator, opts);
    looms.push(built);
    perConversation.push(built.stats);
  }

  return {
    looms,
    stats: {
      conversations: looms.length,
      skippedConversations,
      totalNodes: perConversation.reduce((sum, c) => sum + c.nodes, 0),
      totalTurns: perConversation.reduce((sum, c) => sum + c.turns, 0),
      totalPlaceholderNodes: perConversation.reduce(
        (sum, c) => sum + c.placeholderNodes,
        0,
      ),
      totalMalformedNodes: perConversation.reduce(
        (sum, c) => sum + c.malformedNodes,
        0,
      ),
      perConversation,
    },
  };
}

/** A slug for a conversation's snapshot filename (stable, filesystem-safe). */
function conversationSlug(stats: ChatGptConversationStats, index: number): string {
  const id = stats.conversationId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `conversation-${String(index).padStart(4, "0")}-${id}`;
}

/**
 * End-to-end: read a ChatGPT `conversations.json`, build one conversation loom
 * per chat, and write each snapshot as pretty JSON (`<slug>.loom.json`) that
 * textile can import. Returns the output paths + stats (SHAPE only, never
 * message content).
 */
export async function convertChatGptExportToLoomFiles(
  inputPath: string,
  outDir: string,
  opts: ChatGptExportOptions = {},
): Promise<{
  outputs: { outputPath: string; stats: ChatGptConversationStats }[];
  stats: ChatGptExportStats;
}> {
  const text = await fs.readFile(inputPath, "utf8");
  const { looms, stats } = await chatGptExportToLooms(text, {
    sourceRef: opts.sourceRef ?? inputPath,
    ...opts,
  });
  await fs.mkdir(outDir, { recursive: true });
  const outputs: { outputPath: string; stats: ChatGptConversationStats }[] = [];
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
