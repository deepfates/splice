import * as fs from "node:fs/promises";
import * as path from "node:path";
import JSON5 from "json5";
import { decodeTwitterEntities } from "../transforms/core.js";

import {
  type Level,
  mediaTypeFromExt,
} from "../core/types.js";

export type TwitterPublicWritingKind =
  | "tweet"
  | "community-tweet"
  | "note-tweet"
  | "article"
  | "deleted-tweet";

export interface TwitterPublicWritingMedia {
  sourcePath?: string;
  url?: string;
  alt: string;
  type: "photo" | "video" | "unknown";
}

export interface TwitterReplyContext {
  id: string;
  text: string;
  sourceUrl: string;
  screenName: string | null;
  source: "like" | "deleted-tweet";
}

export interface TwitterPublicWritingRecord {
  id: string;
  kind: TwitterPublicWritingKind;
  text: string;
  title?: string;
  createdAt: string | null;
  deletedAt?: string | null;
  parentId: string | null;
  replyToAccountId: string | null;
  replyToOwnAccount: boolean | null;
  replyToScreenName: string | null;
  replyContext: TwitterReplyContext | null;
  sourceUrl: string | null;
  communityId?: string;
  media: TwitterPublicWritingMedia[];
}

interface AccountIdentity {
  handle: string;
  accountId: string | null;
}

export interface TwitterPublicWritingStats {
  accountHandle: string;
  sourceRecords: Record<TwitterPublicWritingKind | "retweet" | "article-draft", number>;
  emitted: Record<TwitterPublicWritingKind, number>;
  skipped: {
    retweets: number;
    articleDrafts: number;
    deletedTweets: number;
    malformed: number;
    empty: number;
  };
  totals: {
    source: number;
    emitted: number;
    skipped: number;
    reconciled: boolean;
  };
  replyContext: {
    parentIdsAbsentFromAuthoredArchive: number;
    likeRecordsScanned: number;
    recoveredFromDeletedTweets: number;
    recoveredFromLikes: number;
    unavailableFromLikes: number;
    stillMissing: number;
    coverage: number;
    unavailableLikeFiles: number;
  };
}

export interface TwitterPublicWritingResult {
  records: TwitterPublicWritingRecord[];
  stats: TwitterPublicWritingStats;
}

export interface TwitterPublicWritingOptions {
  includeDeleted?: boolean;
}

type Manifest = {
  dataTypes?: Record<string, { files?: Array<{ fileName?: unknown }> }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asIso(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const millis = /^\d{11,}$/.test(raw) ? Number(raw) : Date.parse(raw);
  const date = new Date(millis);
  return Number.isFinite(millis) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : null;
}

function isTwitterId(value: string): boolean {
  return /^\d+$/.test(value);
}

async function readArchiveValue(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  const expression = raw
    .trim()
    .replace(/^window\.[^=]+\s*=\s*/i, "")
    .replace(/;\s*$/, "")
    // Twitter emits literal JS line/paragraph separators inside some liked text.
    // Escaping them preserves the text and avoids JSON5's noisy compatibility warning.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  try {
    return JSON5.parse(expression);
  } catch (error) {
    throw new Error(
      `twitter public writing: could not parse ${filePath} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

async function readArchiveArray(filePath: string): Promise<unknown[]> {
  const value = await readArchiveValue(filePath);
  if (!Array.isArray(value)) {
    throw new Error(`twitter public writing: expected an array in ${filePath}`);
  }
  return value;
}

function manifestFiles(manifest: Manifest, type: string): string[] {
  return (manifest.dataTypes?.[type]?.files ?? []).flatMap((entry) =>
    typeof entry.fileName === "string" && entry.fileName.length > 0
      ? [entry.fileName]
      : [],
  );
}

function archiveCandidate(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, candidate);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error(`twitter public writing: archive member escapes selected directory: ${relative}`);
  }
  return candidate;
}

async function archiveMemberPath(root: string, relative: string): Promise<string> {
  const candidate = archiveCandidate(root, relative);
  const [realRoot, realMember] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relation = path.relative(realRoot, realMember);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error(`twitter public writing: archive member escapes selected directory: ${relative}`);
  }
  return realMember;
}

async function accountIdentity(root: string): Promise<AccountIdentity> {
  try {
    const values = await readArchiveArray(await archiveMemberPath(root, path.join("data", "account.js")));
    const first = values[0];
    if (isObject(first) && isObject(first.account)) {
      return {
        handle: asString(first.account.username) ?? "unknown",
        accountId: asString(first.account.accountId) ?? asString(first.account.id),
      };
    }
  } catch {
    // The archive remains usable without account.js; URLs use the i/web form.
  }
  return { handle: "unknown", accountId: null };
}

async function mediaMap(root: string, directory: string): Promise<Map<string, string[]>> {
  let dir: string;
  try {
    dir = await archiveMemberPath(root, path.join("data", directory));
  } catch (error) {
    if (isObject(error) && (error as { code?: unknown }).code === "ENOENT") return new Map();
    throw error;
  }
  const result = new Map<string, string[]>();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return result;
  }
  for (const name of names.sort()) {
    const match = name.match(/^(\d+)-/);
    if (!match) continue;
    const sourcePath = path.join(dir, name);
    const stat = await fs.lstat(sourcePath);
    if (!stat.isFile() || stat.size === 0) continue;
    const current = result.get(match[1]) ?? [];
    current.push(sourcePath);
    result.set(match[1], current);
  }
  return result;
}

function localMedia(paths: string[]): TwitterPublicWritingMedia[] {
  return paths.map((sourcePath) => ({
    sourcePath,
    alt: path.basename(sourcePath),
    type: mediaTypeFromExt(sourcePath),
  }));
}

function expandedText(raw: Record<string, unknown>, fallback: string): string {
  let text = decodeTwitterEntities(fallback.replace(/\r\n?/g, "\n"));
  const entities = isObject(raw.entities) ? raw.entities : null;
  const urls = entities && Array.isArray(entities.urls) ? entities.urls : [];
  for (const value of urls) {
    if (!isObject(value)) continue;
    const short = asString(value.url);
    const expanded = asString(value.expanded_url) ?? asString(value.expandedUrl);
    if (short && expanded) text = text.split(short).join(expanded);
  }
  const media = entities && Array.isArray(entities.media) ? entities.media : [];
  for (const value of media) {
    if (!isObject(value)) continue;
    const short = asString(value.url);
    if (short) text = text.split(short).join("");
  }
  return text.trim();
}

function tweetRecord(
  wrapper: unknown,
  kind: "tweet" | "community-tweet" | "deleted-tweet",
  identity: AccountIdentity,
  media: Map<string, string[]>,
): TwitterPublicWritingRecord | "retweet" | "malformed" | "empty" {
  const raw = isObject(wrapper) && isObject(wrapper.tweet) ? wrapper.tweet : wrapper;
  if (!isObject(raw)) return "malformed";
  const id = asString(raw.id_str) ?? asString(raw.id);
  const sourceText = asString(raw.full_text) ?? asString(raw.text);
  if (!id || !isTwitterId(id)) return "malformed";
  if (!sourceText) return "empty";
  if (
    /^RT @[A-Za-z0-9_]+:/.test(sourceText) ||
    raw.retweeted_status !== undefined ||
    raw.retweeted_status_id !== undefined ||
    raw.retweeted_status_id_str !== undefined
  ) {
    return "retweet";
  }
  const sourceUrl = kind === "deleted-tweet"
    ? null
    : identity.handle === "unknown"
      ? `https://x.com/i/web/status/${id}`
      : `https://x.com/${identity.handle}/status/${id}`;
  const replyToAccountId =
    asString(raw.in_reply_to_user_id_str) ??
    asString(raw.in_reply_to_user_id) ??
    asString(raw.inReplyToUserId);
  const communityId = kind === "community-tweet"
    ? asString(raw.community_id_str) ?? asString(raw.community_id)
    : null;
  if (communityId && !isTwitterId(communityId)) return "malformed";
  return {
    id,
    kind,
    text: expandedText(raw, sourceText),
    createdAt: asIso(raw.created_at) ?? asIso(raw.createdAt),
    deletedAt: kind === "deleted-tweet" ? asIso(raw.deleted_at) ?? asIso(raw.deletedAt) : undefined,
    parentId:
      asString(raw.in_reply_to_status_id_str) ??
      asString(raw.in_reply_to_status_id) ??
      asString(raw.inReplyTo),
    replyToAccountId,
    replyToOwnAccount:
      replyToAccountId && identity.accountId
        ? replyToAccountId === identity.accountId
        : null,
    replyToScreenName:
      asString(raw.in_reply_to_screen_name) ?? asString(raw.inReplyToScreenName),
    replyContext: null,
    sourceUrl,
    communityId: communityId ?? undefined,
    media: localMedia(media.get(id) ?? []),
  };
}

function noteRecord(
  wrapper: unknown,
  identity: AccountIdentity,
): TwitterPublicWritingRecord | "malformed" | "empty" {
  const raw = isObject(wrapper) && isObject(wrapper.noteTweet)
    ? wrapper.noteTweet
    : wrapper;
  if (!isObject(raw)) return "malformed";
  const core = isObject(raw.core) ? raw.core : null;
  const id = asString(raw.noteTweetId) ?? asString(raw.id);
  const text =
    (core && (asString(core.text) ?? asString(core.richtext))) ??
    asString(raw.text);
  if (!id || !isTwitterId(id)) return "malformed";
  if (!text) return "empty";
  const tweetId = asString(raw.tweetId) ?? (core ? asString(core.tweetId) : null);
  return {
    id,
    kind: "note-tweet",
    text: decodeTwitterEntities(text.replace(/\r\n?/g, "\n")).trim(),
    createdAt: asIso(raw.createdAt),
    parentId: null,
    replyToAccountId: null,
    replyToOwnAccount: null,
    replyToScreenName: null,
    replyContext: null,
    sourceUrl: tweetId
      ? identity.handle === "unknown"
        ? `https://x.com/i/web/status/${tweetId}`
        : `https://x.com/${identity.handle}/status/${tweetId}`
      : null,
    media: [],
  };
}

function articleBody(raw: Record<string, unknown>): string {
  const content = isObject(raw.content) ? raw.content : null;
  const blocks = content && Array.isArray(content.blocks) ? content.blocks : [];
  return blocks
    .flatMap((block) => (isObject(block) ? [asString(block.text) ?? ""] : []))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

function articleRecord(
  wrapper: unknown,
  metadataWrapper: unknown,
  identity: AccountIdentity,
): TwitterPublicWritingRecord | "draft" | "malformed" | "empty" {
  const raw = isObject(wrapper) && isObject(wrapper.article) ? wrapper.article : wrapper;
  const metadata = isObject(metadataWrapper) && isObject(metadataWrapper.articleMetadata)
    ? metadataWrapper.articleMetadata
    : metadataWrapper;
  if (!isObject(raw) || !isObject(metadata)) return "malformed";
  const lifecycle = isObject(metadata.lifecycleState) && isObject(metadata.lifecycleState.lifecycle)
    ? asString(metadata.lifecycleState.lifecycle.name)
    : null;
  if (lifecycle !== "Published") return "draft";
  const id = asString(raw.id);
  const title = asString(raw.title) ?? undefined;
  const text = articleBody(raw);
  if (!id || !isTwitterId(id)) return "malformed";
  if (!title && !text) return "empty";
  const tweetId = asString(metadata.tweetId);
  const cover = asString(raw.coverMedia);
  return {
    id,
    kind: "article",
    title,
    text,
    createdAt:
      asIso(metadata.firstPublishedAtMs) ??
      asIso(metadata.createdAtMs) ??
      asIso(metadata.modifiedAtMs),
    parentId: null,
    replyToAccountId: null,
    replyToOwnAccount: null,
    replyToScreenName: null,
    replyContext: null,
    sourceUrl: tweetId
      ? identity.handle === "unknown"
        ? `https://x.com/i/web/status/${tweetId}`
        : `https://x.com/${identity.handle}/status/${tweetId}`
      : null,
    media: cover ? [{ url: cover, alt: title ?? `article ${id}`, type: "photo" }] : [],
  };
}

function emptyCounts(): TwitterPublicWritingStats["sourceRecords"] {
  return {
    tweet: 0,
    "community-tweet": 0,
    "note-tweet": 0,
    article: 0,
    "deleted-tweet": 0,
    retweet: 0,
    "article-draft": 0,
  };
}

function emptyEmitted(): TwitterPublicWritingStats["emitted"] {
  return {
    tweet: 0,
    "community-tweet": 0,
    "note-tweet": 0,
    article: 0,
    "deleted-tweet": 0,
  };
}

async function attachReplyContexts(
  root: string,
  manifest: Manifest,
  records: TwitterPublicWritingRecord[],
  excludedDeletedRecords: TwitterPublicWritingRecord[],
  logger: (level: Level, message: string) => void,
): Promise<TwitterPublicWritingStats["replyContext"]> {
  const authoredIds = new Set(records.map((record) => record.id));
  const absentParentIds = new Set(records.flatMap((record) =>
    record.parentId && !authoredIds.has(record.parentId) ? [record.parentId] : [],
  ));
  const likedText = new Map<string, { text: string; sourceUrl: string }>();
  const deletedById = new Map(excludedDeletedRecords.map((record) => [record.id, record]));
  let likeRecordsScanned = 0;
  let unavailableLikeFiles = 0;

  for (const relative of manifestFiles(manifest, "like")) {
    const candidate = archiveCandidate(root, relative);
    const filePath = await archiveMemberPath(root, relative).catch((error) => {
      if (isObject(error) && (error as { code?: unknown }).code === "ENOENT") return candidate;
      throw error;
    });
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      unavailableLikeFiles += 1;
      logger("warn", `Reply context unavailable because ${relative} is missing`);
      continue;
    }
    logger("debug", `Reading ${relative} for reply context`);
    const values = await readArchiveArray(filePath);
    likeRecordsScanned += values.length;
    for (const wrapper of values) {
      const raw = isObject(wrapper) && isObject(wrapper.like) ? wrapper.like : wrapper;
      if (!isObject(raw)) continue;
      const id = asString(raw.tweetId) ?? asString(raw.id);
      if (!id || !absentParentIds.has(id) || deletedById.has(id) || likedText.has(id)) continue;
      const text = asString(raw.fullText) ?? asString(raw.full_text) ?? asString(raw.text);
      if (!text) continue;
      likedText.set(id, {
        text: decodeTwitterEntities(text.replace(/\r\n?/g, "\n")).trim(),
        sourceUrl:
          asString(raw.expandedUrl) ??
          asString(raw.expanded_url) ??
          `https://x.com/i/web/status/${id}`,
      });
    }
  }

  for (const record of records) {
    if (!record.parentId) continue;
    const deleted = deletedById.get(record.parentId);
    if (deleted) {
      record.replyContext = {
        id: deleted.id,
        text: deleted.text,
        sourceUrl: `https://x.com/i/web/status/${deleted.id}`,
        screenName: record.replyToScreenName,
        source: "deleted-tweet",
      };
      continue;
    }
    const context = likedText.get(record.parentId);
    if (!context) continue;
    record.replyContext = {
      id: record.parentId,
      text: context.text,
      sourceUrl: context.sourceUrl,
      screenName: record.replyToScreenName,
      source: "like",
    };
  }

  const unavailablePattern = /This (?:Post|Tweet) is (?:from a suspended account|unavailable)/i;
  const unavailableFromLikes = [...likedText.values()].filter((context) =>
    unavailablePattern.test(context.text.trim())
  ).length;
  const recoveredFromLikes = likedText.size - unavailableFromLikes;
  const recoveredFromDeletedTweets = [...absentParentIds].filter((id) => deletedById.has(id)).length;
  const parentIdsAbsentFromAuthoredArchive = absentParentIds.size;
  return {
    parentIdsAbsentFromAuthoredArchive,
    likeRecordsScanned,
    recoveredFromDeletedTweets,
    recoveredFromLikes,
    unavailableFromLikes,
    stillMissing:
      parentIdsAbsentFromAuthoredArchive -
      recoveredFromDeletedTweets -
      recoveredFromLikes -
      unavailableFromLikes,
    coverage:
      parentIdsAbsentFromAuthoredArchive === 0
        ? 0
        : (recoveredFromDeletedTweets + recoveredFromLikes) /
          parentIdsAbsentFromAuthoredArchive,
    unavailableLikeFiles,
  };
}

export async function ingestTwitterPublicWriting(
  root: string,
  logger: (level: Level, message: string) => void,
  options: TwitterPublicWritingOptions = {},
): Promise<TwitterPublicWritingResult> {
  const manifestValue = await readArchiveValue(
    await archiveMemberPath(root, path.join("data", "manifest.js")),
  );
  if (!isObject(manifestValue)) {
    throw new Error("twitter public writing: manifest.js must contain an object");
  }
  const parsedManifest = manifestValue as Manifest;

  const identity = await accountIdentity(root);
  const tweetMedia = await mediaMap(root, "tweets_media");
  const communityMedia = await mediaMap(root, "community_tweet_media");
  const deletedMedia = options.includeDeleted
    ? await mediaMap(root, "deleted_tweets_media")
    : new Map<string, string[]>();
  const sourceRecords = emptyCounts();
  const emitted = emptyEmitted();
  const skipped = {
    retweets: 0,
    articleDrafts: 0,
    deletedTweets: 0,
    malformed: 0,
    empty: 0,
  };
  const records: TwitterPublicWritingRecord[] = [];

  const add = (value: TwitterPublicWritingRecord | "retweet" | "draft" | "malformed" | "empty") => {
    if (value === "retweet") {
      sourceRecords.retweet += 1;
      skipped.retweets += 1;
    } else if (value === "draft") {
      sourceRecords["article-draft"] += 1;
      skipped.articleDrafts += 1;
    } else if (value === "malformed") {
      skipped.malformed += 1;
    } else if (value === "empty") {
      skipped.empty += 1;
    } else {
      records.push(value);
      emitted[value.kind] += 1;
    }
  };

  const readType = async (type: string): Promise<unknown[]> => {
    const values: unknown[] = [];
    for (const relative of manifestFiles(parsedManifest, type)) {
      logger("debug", `Reading ${relative}`);
      values.push(...await readArchiveArray(await archiveMemberPath(root, relative)));
    }
    return values;
  };

  for (const value of await readType("tweets")) {
    sourceRecords.tweet += 1;
    add(tweetRecord(value, "tweet", identity, tweetMedia));
  }
  for (const value of await readType("communityTweet")) {
    sourceRecords["community-tweet"] += 1;
    add(tweetRecord(value, "community-tweet", identity, communityMedia));
  }
  for (const value of await readType("noteTweet")) {
    sourceRecords["note-tweet"] += 1;
    add(noteRecord(value, identity));
  }

  const articles = await readType("article");
  const metadata = await readType("articleMetadata");
  sourceRecords.article = articles.length;
  for (let index = 0; index < articles.length; index += 1) {
    add(articleRecord(articles[index], metadata[index], identity));
  }

  const deletedTweets = await readType("deletedTweets");
  sourceRecords["deleted-tweet"] = deletedTweets.length;
  const excludedDeletedRecords: TwitterPublicWritingRecord[] = [];
  if (options.includeDeleted) {
    for (const value of deletedTweets) {
      add(tweetRecord(value, "deleted-tweet", identity, deletedMedia));
    }
  } else {
    skipped.deletedTweets = deletedTweets.length;
    for (const value of deletedTweets) {
      const record = tweetRecord(value, "deleted-tweet", identity, deletedMedia);
      if (typeof record !== "string") excludedDeletedRecords.push(record);
    }
  }

  records.sort((a, b) => {
    const at = a.createdAt ?? "9999";
    const bt = b.createdAt ?? "9999";
    return at.localeCompare(bt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
  });
  if (new Set(records.map((record) => `${record.kind}:${record.id}`)).size !== records.length) {
    throw new Error("twitter public writing: duplicate kind/id records in archive");
  }

  const replyContext = await attachReplyContexts(
    root,
    parsedManifest,
    records,
    excludedDeletedRecords,
    logger,
  );

  const totals = {
    source:
      sourceRecords.tweet +
      sourceRecords["community-tweet"] +
      sourceRecords["note-tweet"] +
      sourceRecords.article +
      sourceRecords["deleted-tweet"],
    emitted: Object.values(emitted).reduce((sum, value) => sum + value, 0),
    skipped: Object.values(skipped).reduce((sum, value) => sum + value, 0),
    reconciled: false,
  };
  totals.reconciled = totals.source === totals.emitted + totals.skipped;
  if (!totals.reconciled) {
    throw new Error(
      `twitter public writing: counts do not reconcile (${totals.source} source != ${totals.emitted} emitted + ${totals.skipped} skipped)`,
    );
  }
  logger("info", `Prepared ${records.length} public writing record(s) for @${identity.handle}`);
  return {
    records,
    stats: { accountHandle: identity.handle, sourceRecords, emitted, skipped, totals, replyContext },
  };
}
