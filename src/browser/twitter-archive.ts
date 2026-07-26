import JSON5 from "json5";

export const TWITTER_ARCHIVE_BROWSER_PROFILE = "splice/twitter-archive/v1" as const;

export interface BrowserConversationSnapshot<TPayload, TLoomMeta, TTurnMeta> {
  loom: {
    id: string;
    meta: TLoomMeta;
    createdAt: number;
  };
  turns: Array<{
    id: string;
    loomId: string;
    parentId: string | null;
    payload: TPayload;
    meta?: TTurnMeta;
    createdAt: number;
  }>;
}

export interface BrowserArchiveEntry {
  /** Portable slash-separated path inside an extracted archive or ZIP. */
  path: string;
  /** Exact decoded UTF-8 text for this archive member. */
  text: string;
}

export type TwitterArchiveRecordKind = "tweet" | "retweet" | "like";

export interface TwitterArchiveTurnSource {
  profile: typeof TWITTER_ARCHIVE_BROWSER_PROFILE;
  provider: "twitter";
  kind: TwitterArchiveRecordKind;
  recordId: string;
  parentRecordId: string | null;
  parentHeld: boolean;
  accountId: string | null;
  ownerHandle: string;
  createdAt: string | null;
}

export interface TwitterArchiveConversationMeta {
  profile: "conversation";
  source: "twitter-archive";
  title: string;
  archiveProfile: typeof TWITTER_ARCHIVE_BROWSER_PROFILE;
  accountId: string | null;
  ownerHandle: string;
  sourceRecords: number;
  readableRecords: number;
  malformedRecords: number;
  unresolvedReplies: number;
}

export interface TwitterArchiveTurnMeta {
  role: "corpus" | "user" | "artifact";
  author: string;
  via: "splice/twitter-archive-browser@0.1";
  portableTurnId: string;
  portableOriginLoomId: string;
  archiveSource?: TwitterArchiveTurnSource;
}

export interface TwitterArchiveTurnPayload {
  text: string;
  message: unknown;
}

export interface TwitterArchiveBrowserStats {
  sourceRecords: number;
  readableRecords: number;
  tweets: number;
  retweets: number;
  likes: number;
  malformedRecords: number;
  unresolvedReplies: number;
  ownerHandle: string;
  accountId: string | null;
}

export interface TwitterArchiveBrowserResult {
  snapshot: BrowserConversationSnapshot<
    TwitterArchiveTurnPayload,
    TwitterArchiveConversationMeta,
    TwitterArchiveTurnMeta
  >;
  stats: TwitterArchiveBrowserStats;
}

interface ArchiveRecord {
  id: string;
  kind: TwitterArchiveRecordKind;
  text: string;
  parentId: string | null;
  createdAt: string | null;
  raw: Record<string, unknown>;
}

interface AccountIdentity {
  accountId: string | null;
  ownerHandle: string;
}

interface ManifestFile {
  fileName?: unknown;
}

interface ManifestType {
  files?: unknown;
}

interface ArchiveManifest {
  dataTypes?: unknown;
}

const VIA = "splice/twitter-archive-browser@0.1" as const;
const RETWEET_PREFIX = /^RT @([A-Za-z0-9_]+):/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function archiveRelativePath(value: string): string {
  const path = normalizePath(value);
  const data = path.toLowerCase().lastIndexOf("/data/");
  if (data >= 0) return path.slice(data + 1);
  return path.replace(/^data\//i, "data/");
}

function parseAssignedData(text: string, label: string): unknown {
  const expression = text
    .trim()
    .replace(/^window\.[^=]+\s*=\s*/i, "")
    .replace(/;\s*$/, "");
  try {
    return JSON5.parse(expression);
  } catch (error) {
    throw new Error(
      `twitter archive: could not parse ${label} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

function entryMap(entries: readonly BrowserArchiveEntry[]): Map<string, BrowserArchiveEntry> {
  const result = new Map<string, BrowserArchiveEntry>();
  for (const entry of entries) {
    const path = archiveRelativePath(entry.path);
    if (!result.has(path.toLowerCase())) result.set(path.toLowerCase(), { ...entry, path });
  }
  return result;
}

function requiredEntry(
  entries: Map<string, BrowserArchiveEntry>,
  path: string,
): BrowserArchiveEntry {
  const entry = entries.get(archiveRelativePath(path).toLowerCase());
  if (!entry) throw new Error(`twitter archive: manifest names missing file ${path}`);
  return entry;
}

function manifestFiles(manifest: ArchiveManifest, kind: "tweets" | "like"): string[] {
  if (!isObject(manifest.dataTypes)) return [];
  const type = manifest.dataTypes[kind] as ManifestType | undefined;
  if (!isObject(type) || !Array.isArray(type.files)) return [];
  return type.files.flatMap((file) => {
    const name = isObject(file) ? (file as ManifestFile).fileName : null;
    return typeof name === "string" && name.length > 0 ? [name] : [];
  });
}

function accountIdentity(entries: Map<string, BrowserArchiveEntry>): AccountIdentity {
  const account = entries.get("data/account.js");
  if (!account) return { accountId: null, ownerHandle: "__owner__" };
  const parsed = parseAssignedData(account.text, account.path);
  const first = Array.isArray(parsed) ? parsed[0] : null;
  const value = isObject(first) && isObject(first.account) ? first.account : null;
  return {
    accountId:
      value && typeof value.accountId === "string" && value.accountId.length > 0
        ? value.accountId
        : null,
    ownerHandle:
      value && typeof value.username === "string" && value.username.length > 0
        ? value.username
        : "__owner__",
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeRecord(value: unknown, sourceKind: "tweets" | "like"): ArchiveRecord | null {
  if (!isObject(value)) return null;
  const candidate = value[sourceKind === "tweets" ? "tweet" : "like"] ?? value;
  if (!isObject(candidate)) return null;
  const id = stringValue(candidate.id_str)
    ?? stringValue(candidate.id)
    ?? stringValue(candidate.tweetId);
  const text = stringValue(candidate.full_text)
    ?? stringValue(candidate.fullText)
    ?? stringValue(candidate.text);
  if (!id || !text) return null;
  const createdAt = stringValue(candidate.created_at) ?? stringValue(candidate.createdAt);
  const parentId = stringValue(candidate.in_reply_to_status_id_str)
    ?? stringValue(candidate.in_reply_to_status_id)
    ?? stringValue(candidate.inReplyTo);
  const kind: TwitterArchiveRecordKind = sourceKind === "like"
    ? "like"
    : RETWEET_PREFIX.test(text) || candidate.retweeted_status !== undefined
      || candidate.retweeted_status_id !== undefined
      || candidate.retweeted_status_id_str !== undefined
      ? "retweet"
      : "tweet";
  return { id, kind, text, parentId, createdAt, raw: candidate };
}

function compareRecords(a: ArchiveRecord, b: ArchiveRecord): number {
  const at = a.createdAt ?? "";
  const bt = b.createdAt ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sourceActor(record: ArchiveRecord, ownerHandle: string): string {
  if (record.kind === "tweet") return ownerHandle;
  if (record.kind === "retweet") return record.text.match(RETWEET_PREFIX)?.[1] ?? "unknown";
  return "unknown";
}

async function deterministicId(...parts: string[]): Promise<string> {
  const chunks = parts.map((part) => new TextEncoder().encode(`${part}\0`));
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const input = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("twitter archive: Web Crypto SHA-256 is unavailable");
  }
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseArchive(entries: readonly BrowserArchiveEntry[]): {
  identity: AccountIdentity;
  records: ArchiveRecord[];
  sourceRecords: number;
  malformedRecords: number;
} {
  const files = entryMap(entries);
  const manifestEntry = files.get("data/manifest.js");
  if (!manifestEntry) {
    throw new Error("twitter archive: expected data/manifest.js in the selected archive");
  }
  const manifest = parseAssignedData(manifestEntry.text, manifestEntry.path);
  if (!isObject(manifest)) throw new Error("twitter archive: manifest must be an object");
  const named = [
    ...manifestFiles(manifest, "tweets").map((path) => ({ path, kind: "tweets" as const })),
    ...manifestFiles(manifest, "like").map((path) => ({ path, kind: "like" as const })),
  ];
  if (named.length === 0) {
    throw new Error("twitter archive: manifest names no tweets or likes files");
  }
  const records: ArchiveRecord[] = [];
  let sourceRecords = 0;
  let malformedRecords = 0;
  for (const item of named) {
    const entry = requiredEntry(files, item.path);
    const parsed = parseAssignedData(entry.text, entry.path);
    if (!Array.isArray(parsed)) {
      throw new Error(`twitter archive: ${entry.path} must contain an array`);
    }
    sourceRecords += parsed.length;
    for (const value of parsed) {
      const record = normalizeRecord(value, item.kind);
      if (record) records.push(record);
      else malformedRecords += 1;
    }
  }
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new Error(`twitter archive: duplicate source record id ${record.id}`);
    }
    ids.add(record.id);
  }
  return {
    identity: accountIdentity(files),
    records: records.sort(compareRecords),
    sourceRecords,
    malformedRecords,
  };
}

/**
 * Convert an extracted Twitter/X archive into one deterministic conversation
 * loom for Textile. Everything happens in memory: callers provide local file
 * text and this function performs no reads, writes, network requests, or logs.
 *
 * One synthetic corpus turn owns every archive item. Held replies retain their
 * thread parent; replies to unavailable external tweets root under the corpus
 * turn while retaining the exact external source id in `archiveSource`.
 * Tweets, retweets, and likes all remain reviewable. Malformed records are
 * counted in both stats and the visible corpus-root summary.
 */
export async function twitterArchiveEntriesToConversation(
  entries: readonly BrowserArchiveEntry[],
): Promise<TwitterArchiveBrowserResult> {
  const { identity, records, sourceRecords, malformedRecords } = parseArchive(entries);
  const accountLocator = identity.accountId ?? identity.ownerHandle;
  const rootId = await deterministicId("twitter", "archive", accountLocator);
  const loomId = `lync:${rootId}`;
  const ids = new Set(records.map((record) => record.id));
  const unresolvedReplies = records.filter(
    (record) => record.kind === "tweet" && record.parentId && !ids.has(record.parentId),
  ).length;
  const counts = {
    tweets: records.filter((record) => record.kind === "tweet").length,
    retweets: records.filter((record) => record.kind === "retweet").length,
    likes: records.filter((record) => record.kind === "like").length,
  };
  const earliest = records.flatMap((record) => {
    const time = record.createdAt ? Date.parse(record.createdAt) : Number.NaN;
    return Number.isFinite(time) ? [time] : [];
  }).sort((a, b) => a - b)[0] ?? 0;
  const corpusTurnId = await deterministicId("twitter", "archive-corpus", accountLocator);
  const turnIds = new Map<string, string>();
  await Promise.all(records.map(async (record) => {
    turnIds.set(record.id, await deterministicId("twitter", "archive-turn", record.id));
  }));
  const title = identity.ownerHandle === "__owner__"
    ? "Twitter archive"
    : `Twitter archive @${identity.ownerHandle}`;
  const rootText = [
    title,
    `${records.length} readable records: ${counts.tweets} tweets, ${counts.retweets} retweets, ${counts.likes} likes.`,
    `${unresolvedReplies} replies reference tweets outside this archive; ${malformedRecords} malformed records were retained in the import accounting.`,
  ].join("\n");

  const turns: TwitterArchiveBrowserResult["snapshot"]["turns"] = [
    {
      id: corpusTurnId,
      loomId,
      parentId: null,
      payload: { text: rootText, message: rootText },
      meta: {
        role: "corpus",
        author: identity.ownerHandle,
        via: VIA,
        portableTurnId: corpusTurnId,
        portableOriginLoomId: loomId,
      },
      createdAt: earliest,
    },
  ];
  for (const record of records) {
    const heldParent = record.kind === "tweet" && record.parentId && ids.has(record.parentId)
      ? (turnIds.get(record.parentId) as string)
      : corpusTurnId;
    const createdAt = record.createdAt ? Date.parse(record.createdAt) : Number.NaN;
    const id = turnIds.get(record.id) as string;
    turns.push({
      id,
      loomId,
      parentId: heldParent,
      payload: { text: record.text, message: record.raw },
      meta: {
        role: record.kind === "tweet" ? "user" : "artifact",
        author: sourceActor(record, identity.ownerHandle),
        via: VIA,
        portableTurnId: id,
        portableOriginLoomId: loomId,
        archiveSource: {
          profile: TWITTER_ARCHIVE_BROWSER_PROFILE,
          provider: "twitter",
          kind: record.kind,
          recordId: record.id,
          parentRecordId: record.parentId,
          parentHeld: Boolean(record.parentId && ids.has(record.parentId)),
          accountId: identity.accountId,
          ownerHandle: identity.ownerHandle,
          createdAt: record.createdAt,
        },
      },
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    });
  }

  const stats: TwitterArchiveBrowserStats = {
    sourceRecords,
    readableRecords: records.length,
    ...counts,
    malformedRecords,
    unresolvedReplies,
    ownerHandle: identity.ownerHandle,
    accountId: identity.accountId,
  };
  return {
    snapshot: {
      loom: {
        id: loomId,
        meta: {
          profile: "conversation",
          source: "twitter-archive",
          title,
          archiveProfile: TWITTER_ARCHIVE_BROWSER_PROFILE,
          accountId: identity.accountId,
          ownerHandle: identity.ownerHandle,
          sourceRecords,
          readableRecords: records.length,
          malformedRecords,
          unresolvedReplies,
        },
        createdAt: earliest,
      },
      turns,
    },
    stats,
  };
}
