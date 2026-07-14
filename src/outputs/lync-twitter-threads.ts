/**
 * Twitter/X archive reply-threads → real lync conversation LOOMS (dee-7biz,
 * textile-explorer / archive-instrument lane).
 *
 * WHY THIS EXISTS. splice already frames three *chat* exports as lync conversation
 * looms textile opens: a Claude Code session (`lync-session-loom.ts`, a flat
 * stream), a Claude.ai account export (`lync-claudeai-export.ts`, a flat
 * `chat_messages` list), and a ChatGPT export (`lync-chatgpt-export.ts`, a
 * parent/children mapping GRAPH). A Twitter/X archive is a FOURTH source shape: a
 * flat list of the owner's tweets, each optionally carrying an
 * `in_reply_to_status_id`. Those reply links form a reply FOREST — self-threads
 * chain, and a tweet answered by several others FORKS. `src/sources/twitter.ts`
 * already parses the archive into `ContentItem`s (id, text, `parentId` from
 * `in_reply_to_status_id`, the owner `accountId`), and `lync-tweet-embed.ts`
 * frames single embedded tweets — but nothing turned a reply-THREAD into a
 * conversation loom. This module does: each connected reply-tree of tweets →
 * one `ConversationLoomSnapshot`, the exact shape textile's
 * `parseConversationSnapshot` / `importConversationLoom` opens.
 *
 * WHAT THIS DOES. Same loom-framing approach as the three chat adapters: replay a
 * thread's tweets through the real @deepfates/lync Looms API (`createLyncLooms`
 * + `loom.appendTurn`) over an in-memory event store, then export a
 * `LoomSnapshot`. One tweet → one turn:
 *   - payload: { message: <the raw tweet object verbatim when present, else its
 *     text>, text: <the tweet text, always non-empty via the shared
 *     `deriveTurnText`> }.
 *   - meta: { role, author }. The archive owner's own tweets → author = the
 *     `userActor` ("deepfates"), role "user"; a tweet by any OTHER handle →
 *     author = that handle, role "assistant". (A conversation loom's `role` is a
 *     side/origin hint — "user" = the owner's own voice, "assistant" = the
 *     counterparty — so textile's origin classifier never guesses by absence; the
 *     true handle always rides verbatim in `author`, so no identity is lost.)
 *   - parent: the turn of the tweet's `in_reply_to` target when that tweet is in
 *     the SAME thread; otherwise the turn roots at null. Forks survive: a tweet
 *     answered by two others yields two child turns under the same parent turn.
 *
 * WHAT A "THREAD" IS (stated, per the ticket's "your call"). A thread is a
 * connected component of the reply graph over the tweets we have, connected
 * through `in_reply_to` links. A tweet whose parent is present in the set is a
 * child of that parent's turn. A tweet whose `in_reply_to` target is ABSENT (an
 * external tweet not in the archive, or no reply at all) roots its component.
 * Tweets that all reply to the SAME absent external tweet are grouped into ONE
 * thread (keyed by that external id) with parallel roots — no turn is ever
 * fabricated for the missing external tweet. A STANDALONE tweet (no reply in or
 * out) is its own single-turn thread → its own one-turn loom.
 *
 * ZERO SILENT DROPS. Every archive record is accounted for. Original owner/other
 * tweets become turns. Retweets (`RT @…`, or a `retweeted_status` marker) are
 * counted in `stats.retweets`; likes are counted in `stats.likes`; a record with
 * no usable id/text is counted in `stats.malformed`. None become turns (a retweet
 * echoes another's tweet; a like is not authored conversation), and none are
 * discarded — the invariant
 * `sourceRecords === totalTurns + retweets + likes + malformed` holds and is
 * asserted. Per thread, `nodes === turns` (every node in a thread is a turn).
 *
 * PRIVACY. This module transforms SHAPE only. Tweet content is copied verbatim
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

import {
  type ContentItem,
  type Level,
  readJsonFromJs,
  parseLooseArray,
  cleanJsonString,
  toIso,
} from "../core/types.js";
import {
  detectTwitterArchive,
  ingestTwitter,
} from "../sources/twitter.js";
import { DEFAULT_OPERATOR, SPLICE_IMPORT_VERSION } from "./lync.js";
import {
  deriveTurnText,
  type SessionTurnMeta,
  type SessionTurnPayload,
} from "./lync-session-loom.js";

/* --------------------------------- Types ---------------------------------- */

export const TWITTER_THREADS_IMPORTER = "twitter-threads-import";

/** Sentinel owner handle when the archive owner's screen name is unknown. */
export const OWNER_SENTINEL = "__owner__";

/** The loom's own meta: marks it a conversation loom for the reader/index. */
export interface TwitterThreadLoomMeta {
  profile: "conversation";
  source: "twitter-threads";
  /** Stable thread identity: the component's root key (see WHAT A "THREAD" IS). */
  threadId: string;
  /** The tweet id(s) that root this thread (>1 when several answer one external tweet). */
  rootTweetIds: string[];
}

/** One record from a Twitter/X archive, normalized for thread building. */
export interface TwitterRecord {
  /** The tweet's id (`id_str`/`id`). */
  id: string;
  /** tweet = original authored tweet; retweet/like = counted, never a turn. */
  kind: "tweet" | "retweet" | "like";
  /** The tweet text (`full_text`/`text`). */
  text: string;
  /** `in_reply_to_status_id` — the tweet this replies to (null when none). */
  parentId?: string | null;
  /** The screen name of THIS record's author (owner tweets carry the owner handle). */
  authorHandle: string;
  /** ISO-8601 creation time, used only for stable ordering. */
  createdAt?: string | null;
  /** The raw tweet object, preserved verbatim in the turn payload. */
  raw?: unknown;
}

export interface TwitterThreadStats {
  /** Stable thread id (the component root key). */
  threadId: string;
  /** Root tweet ids of this thread. */
  rootTweetIds: string[];
  /** Tweets in this thread mapped to loom turns. */
  turns: number;
  /** Distinct actors across the turns (e.g. deepfates + one other handle). */
  distinctActors: string[];
  /** Turns that share a parent with at least one sibling (fork fan-out). */
  branchedTurns: number;
  /** How many turns root at null (>1 when parallel replies to one external tweet). */
  roots: number;
}

export interface TwitterThreadLoom {
  snapshot: LoomSnapshot<
    SessionTurnPayload,
    TwitterThreadLoomMeta,
    SessionTurnMeta
  >;
  stats: TwitterThreadStats;
}

export interface TwitterThreadsStats {
  /** Threads (connected reply components) mapped to looms. */
  threads: number;
  /** Threads with exactly one turn (standalone tweets). */
  standaloneThreads: number;
  /** Total source records seen (tweets + retweets + likes + malformed). */
  sourceRecords: number;
  /** Sum of emitted turns across all threads. */
  totalTurns: number;
  /** Retweet records counted, never turned. */
  retweets: number;
  /** Like records counted, never turned. */
  likes: number;
  /** Records with no usable id/text counted, never turned. */
  malformed: number;
  /** Per-thread accounting, in stable order. */
  perThread: TwitterThreadStats[];
}

export interface TwitterThreadsResult {
  looms: TwitterThreadLoom[];
  stats: TwitterThreadsStats;
}

export interface TwitterThreadsOptions {
  /** Actor recorded for the archive owner's own tweets. Default "deepfates". */
  userActor?: string;
  /**
   * The archive owner's screen name. A record whose `authorHandle` equals this
   * (or the `OWNER_SENTINEL`) is the owner's; every other handle is a counterparty.
   * Default `OWNER_SENTINEL`.
   */
  ownerHandle?: string;
  /** Operator recorded in the author envelope. Default "deepfates". */
  operator?: string;
  /** Provenance source ref stamped in the author envelope. */
  sourceRef?: string;
}

/* --------------------------------- Helpers -------------------------------- */

const RETWEET_PREFIX = /^RT @[A-Za-z0-9_]+:/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Is this raw/text a retweet (an echo of another's tweet, not authored)? */
function isRetweet(text: string, raw: unknown): boolean {
  if (isObject(raw)) {
    if (
      typeof raw["retweeted_status_id_str"] === "string" ||
      typeof raw["retweeted_status_id"] === "string" ||
      isObject(raw["retweeted_status"])
    ) {
      return true;
    }
  }
  return RETWEET_PREFIX.test(text);
}

/** A record's author identity + role: owner → userActor/"user", else handle/"assistant". */
function actorFor(
  record: TwitterRecord,
  opts: TwitterThreadsOptions,
): { author: string; role: string } {
  const owner = opts.ownerHandle ?? OWNER_SENTINEL;
  if (record.authorHandle === owner) {
    return { author: opts.userActor ?? DEFAULT_OPERATOR, role: "user" };
  }
  return { author: record.authorHandle, role: "assistant" };
}

/** The turn's display text, ALWAYS non-empty (reader throws on blank). */
function tweetText(record: TwitterRecord): string {
  return deriveTurnText(record.text);
}

/**
 * A disjoint-set (union-find) over tweet ids plus virtual `ext:<id>` nodes for
 * absent external parents. Groups tweets connected through `in_reply_to` links —
 * self-threads, forks, and parallel replies to the same external tweet — into one
 * component each.
 */
class DisjointSet {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)) {
      const next = this.parent.get(root) as string;
      this.parent.set(root, this.parent.get(next) ?? next);
      root = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Stable order: earliest createdAt first, ties broken by id. */
function compareRecords(a: TwitterRecord, b: TwitterRecord): number {
  const ta = a.createdAt ?? "";
  const tb = b.createdAt ?? "";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* -------------------------------- Adapters -------------------------------- */

/**
 * Build one lync conversation LOOM from a single thread (a connected group of
 * tweet records already ordered) by replaying it through the real Looms API.
 */
async function threadToLoom(
  threadId: string,
  tweets: TwitterRecord[],
  turnSet: Set<string>,
  opts: TwitterThreadsOptions,
): Promise<TwitterThreadLoom> {
  // Roots of THIS thread: tweets whose in_reply_to target is not in the set.
  const rootTweetIds = tweets
    .filter((t) => !t.parentId || !turnSet.has(t.parentId))
    .map((t) => t.id);

  const store = createMemoryEventStore();
  const looms = createLyncLooms<
    SessionTurnPayload,
    TwitterThreadLoomMeta,
    SessionTurnMeta
  >({
    store,
    author: {
      actor: opts.userActor ?? DEFAULT_OPERATOR,
      operator: opts.operator ?? DEFAULT_OPERATOR,
      imported_by: `splice/${TWITTER_THREADS_IMPORTER}@${SPLICE_IMPORT_VERSION}`,
      source: opts.sourceRef ?? threadId,
    },
  });

  const loomMeta: TwitterThreadLoomMeta = {
    profile: "conversation",
    source: "twitter-threads",
    threadId,
    rootTweetIds,
  };
  const info = await looms.create(loomMeta);
  const loom = await looms.open(info.id);

  // Topological order (parents before children) over the in-thread parent links,
  // preserving the incoming (createdAt) order among ready tweets. Every tweet's
  // parent is either in this thread or absent, so a simple sorted sweep with a
  // ready-check suffices; a residual cycle is broken loudly.
  const byId = new Map<string, TwitterRecord>();
  for (const t of tweets) byId.set(t.id, t);
  const ordered: TwitterRecord[] = [];
  const placed = new Set<string>();
  let progress = true;
  while (ordered.length < tweets.length && progress) {
    progress = false;
    for (const t of tweets) {
      if (placed.has(t.id)) continue;
      const parentInThread = t.parentId && turnSet.has(t.parentId);
      if (!parentInThread || placed.has(t.parentId as string)) {
        ordered.push(t);
        placed.add(t.id);
        progress = true;
      }
    }
  }
  if (ordered.length !== tweets.length) {
    throw new Error(
      `twitter threads: parent cycle detected in thread ${threadId}`,
    );
  }

  const idMap = new Map<string, string>(); // tweet id → turn id
  const actors = new Set<string>();
  const parentTurnCounts = new Map<string, number>();
  let turns = 0;

  for (const t of ordered) {
    const { author, role } = actorFor(t, opts);
    actors.add(author);
    const parentTurnId =
      t.parentId && idMap.has(t.parentId)
        ? (idMap.get(t.parentId) as string)
        : null;
    const turn = await loom.appendTurn(
      parentTurnId,
      { message: t.raw ?? t.text, text: tweetText(t) },
      { role, author },
    );
    idMap.set(t.id, turn.id);
    turns += 1;
    const key = parentTurnId ?? "";
    parentTurnCounts.set(key, (parentTurnCounts.get(key) ?? 0) + 1);
  }

  let branchedTurns = 0;
  for (const count of parentTurnCounts.values()) {
    if (count > 1) branchedTurns += count;
  }

  const snapshot = await loom.export();
  loom.close();

  return {
    snapshot,
    stats: {
      threadId,
      rootTweetIds,
      turns,
      distinctActors: [...actors],
      branchedTurns,
      roots: rootTweetIds.length,
    },
  };
}

/**
 * Turn a whole set of Twitter/X archive records into one conversation loom per
 * reply-thread. Retweets/likes/malformed records are counted (never turned,
 * never dropped); the reconciliation invariant is asserted.
 */
export async function twitterThreadsToLooms(
  records: TwitterRecord[],
  opts: TwitterThreadsOptions = {},
): Promise<TwitterThreadsResult> {
  // Partition: turn-bearing tweets vs counted-but-not-turned records.
  const turnTweets: TwitterRecord[] = [];
  let retweets = 0;
  let likes = 0;
  let malformed = 0;
  for (const r of records) {
    if (r.kind === "like") {
      likes += 1;
      continue;
    }
    if (r.kind === "retweet") {
      retweets += 1;
      continue;
    }
    if (!r.id || (!r.text && r.raw === undefined)) {
      malformed += 1;
      continue;
    }
    turnTweets.push(r);
  }

  const turnSet = new Set(turnTweets.map((t) => t.id));

  // Group into threads (connected components) via union-find over the parent
  // links; an absent external parent unions its repliers under one virtual node.
  const dsu = new DisjointSet();
  for (const t of turnTweets) {
    dsu.find(t.id);
    if (t.parentId) {
      if (turnSet.has(t.parentId)) dsu.union(t.id, t.parentId);
      else dsu.union(t.id, `ext:${t.parentId}`);
    }
  }

  const groups = new Map<string, TwitterRecord[]>();
  for (const t of turnTweets) {
    const root = dsu.find(t.id);
    const arr = groups.get(root);
    if (arr) arr.push(t);
    else groups.set(root, [t]);
  }

  // Stable thread order: by each group's earliest tweet.
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const ea = [...a[1]].sort(compareRecords)[0];
    const eb = [...b[1]].sort(compareRecords)[0];
    return compareRecords(ea, eb);
  });

  const looms: TwitterThreadLoom[] = [];
  const perThread: TwitterThreadStats[] = [];
  for (const [componentKey, tweets] of orderedGroups) {
    const sorted = [...tweets].sort(compareRecords);
    // Thread id: the earliest root tweet id (stable, human-traceable), falling
    // back to the union-find component key.
    const roots = sorted.filter(
      (t) => !t.parentId || !turnSet.has(t.parentId),
    );
    const threadId = (roots[0] ?? sorted[0])?.id ?? componentKey;
    const built = await threadToLoom(threadId, sorted, turnSet, opts);
    looms.push(built);
    perThread.push(built.stats);
  }

  const totalTurns = perThread.reduce((sum, t) => sum + t.turns, 0);
  const sourceRecords = records.length;
  if (sourceRecords !== totalTurns + retweets + likes + malformed) {
    throw new Error(
      `twitter threads: counts do not reconcile: ${sourceRecords} records != ` +
        `${totalTurns} turns + ${retweets} retweets + ${likes} likes + ${malformed} malformed`,
    );
  }

  return {
    looms,
    stats: {
      threads: looms.length,
      standaloneThreads: perThread.filter((t) => t.turns === 1).length,
      sourceRecords,
      totalTurns,
      retweets,
      likes,
      malformed,
      perThread,
    },
  };
}

/* ------------------------------ Normalization ------------------------------ */

/**
 * Normalize the `ContentItem`s `ingestTwitter` produces into `TwitterRecord`s.
 * The archive holds only the OWNER's records, so every tweet's `authorHandle` is
 * the owner handle; a `twitter:like` source → kind "like"; a retweet marker →
 * kind "retweet"; everything else → kind "tweet".
 */
export function contentItemsToTwitterRecords(
  items: ContentItem[],
  ownerHandle: string,
): TwitterRecord[] {
  return items.map((item) => {
    const kind: TwitterRecord["kind"] =
      item.source === "twitter:like"
        ? "like"
        : isRetweet(item.text, item.raw)
          ? "retweet"
          : "tweet";
    return {
      id: item.id,
      kind,
      text: item.text ?? "",
      parentId: item.parentId ?? null,
      authorHandle: ownerHandle,
      createdAt: item.createdAt ?? null,
      raw: item.raw,
    };
  });
}

/**
 * Read the archive owner's screen name from `data/account.js` (`username`),
 * falling back to the `OWNER_SENTINEL` when absent.
 */
async function readOwnerHandle(rootPath: string): Promise<string> {
  try {
    const accountPath = path.join(rootPath, "data", "account.js");
    const accountData = await readJsonFromJs(accountPath);
    if (Array.isArray(accountData) && accountData.length > 0) {
      const account = accountData[0]?.account;
      const username = account?.username;
      if (typeof username === "string" && username.length > 0) return username;
    }
  } catch {
    // no account.js / unreadable → owner sentinel
  }
  return OWNER_SENTINEL;
}

/**
 * Parse a bare `tweets.js` (or `tweets.json`) file into `TwitterRecord`s. Used
 * when `--source` points at a single tweets file rather than a full archive dir.
 * The owner handle is unknown for a bare file → every tweet is the owner's.
 */
async function readBareTweetsFile(filePath: string): Promise<TwitterRecord[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const cleaned = cleanJsonString(raw);
  const data = parseLooseArray(cleaned);
  if (!Array.isArray(data)) return [];
  const out: TwitterRecord[] = [];
  for (const item of data) {
    const t = isObject(item) ? (item["tweet"] ?? item) : item;
    if (!isObject(t)) continue;
    const id =
      (typeof t["id_str"] === "string" && t["id_str"]) ||
      (typeof t["id"] === "string" && t["id"]) ||
      "";
    const text =
      (typeof t["full_text"] === "string" && t["full_text"]) ||
      (typeof t["text"] === "string" && t["text"]) ||
      "";
    const parentId =
      (typeof t["in_reply_to_status_id_str"] === "string" &&
        t["in_reply_to_status_id_str"]) ||
      (typeof t["in_reply_to_status_id"] === "string" &&
        t["in_reply_to_status_id"]) ||
      null;
    const createdRaw = t["created_at"];
    out.push({
      id: String(id),
      kind: isRetweet(String(text), t) ? "retweet" : "tweet",
      text: String(text),
      parentId,
      authorHandle: OWNER_SENTINEL,
      createdAt:
        typeof createdRaw === "string" && createdRaw.length > 0
          ? toIso(createdRaw)
          : null,
      raw: t,
    });
  }
  return out;
}

/**
 * Read a Twitter/X archive (a directory, or a bare tweets.js/.json file) and
 * build one conversation loom per reply-thread. Returns the looms + reconciling
 * stats. A directory routes through `ingestTwitter` (manifest/account/media/likes);
 * a file is parsed directly.
 */
export async function twitterArchiveToLooms(
  inputPath: string,
  logger: (l: Level, m: string) => void,
  opts: TwitterThreadsOptions = {},
): Promise<TwitterThreadsResult> {
  const stat = await fs.stat(inputPath);
  let records: TwitterRecord[];
  if (stat.isDirectory()) {
    if (!(await detectTwitterArchive(inputPath))) {
      throw new Error(
        `twitter threads: ${inputPath} is not a Twitter archive (no data/manifest.js)`,
      );
    }
    const ownerHandle = opts.ownerHandle ?? (await readOwnerHandle(inputPath));
    logger("info", `Archive owner handle: ${ownerHandle}`);
    const items = await ingestTwitter(inputPath, logger);
    records = contentItemsToTwitterRecords(items, ownerHandle);
  } else {
    logger("info", `Parsing bare tweets file ${inputPath}`);
    records = await readBareTweetsFile(inputPath);
  }
  return twitterThreadsToLooms(records, {
    sourceRef: opts.sourceRef ?? inputPath,
    ...opts,
  });
}

/* -------------------------------- File writer ------------------------------ */

/** A slug for a thread's snapshot filename (stable, filesystem-safe). */
function threadSlug(stats: TwitterThreadStats, index: number): string {
  const id = stats.threadId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `thread-${String(index).padStart(4, "0")}-${id}`;
}

/**
 * End-to-end: read a Twitter/X archive (dir or tweets file), build one
 * conversation loom per thread, and write each snapshot as pretty JSON
 * (`<slug>.loom.json`) that textile can import. Returns the output paths + stats
 * (SHAPE only, never tweet content).
 */
export async function convertTwitterArchiveToLoomFiles(
  inputPath: string,
  outDir: string,
  logger: (l: Level, m: string) => void,
  opts: TwitterThreadsOptions = {},
): Promise<{
  outputs: { outputPath: string; stats: TwitterThreadStats }[];
  stats: TwitterThreadsStats;
}> {
  const { looms, stats } = await twitterArchiveToLooms(inputPath, logger, opts);
  await fs.mkdir(outDir, { recursive: true });
  const outputs: { outputPath: string; stats: TwitterThreadStats }[] = [];
  for (let index = 0; index < looms.length; index += 1) {
    const built = looms[index];
    const outputPath = path.join(
      outDir,
      `${threadSlug(built.stats, index)}.loom.json`,
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
