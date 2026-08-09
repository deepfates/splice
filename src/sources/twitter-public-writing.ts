import * as fs from "node:fs/promises";
import * as path from "node:path";
import JSON5 from "json5";

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

export interface TwitterPublicWritingRecord {
  id: string;
  kind: TwitterPublicWritingKind;
  text: string;
  title?: string;
  createdAt: string | null;
  parentId: string | null;
  sourceUrl: string | null;
  communityId?: string;
  media: TwitterPublicWritingMedia[];
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

async function readArchiveValue(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  const expression = raw
    .trim()
    .replace(/^window\.[^=]+\s*=\s*/i, "")
    .replace(/;\s*$/, "");
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

async function accountHandle(root: string): Promise<string> {
  try {
    const values = await readArchiveArray(path.join(root, "data", "account.js"));
    const first = values[0];
    if (isObject(first) && isObject(first.account)) {
      return asString(first.account.username) ?? "unknown";
    }
  } catch {
    // The archive remains usable without account.js; URLs use the i/web form.
  }
  return "unknown";
}

async function mediaMap(root: string, directory: string): Promise<Map<string, string[]>> {
  const dir = path.join(root, "data", directory);
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
    const stat = await fs.stat(sourcePath);
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
  let text = fallback.replace(/\r\n?/g, "\n");
  const entities = isObject(raw.entities) ? raw.entities : null;
  const urls = entities && Array.isArray(entities.urls) ? entities.urls : [];
  for (const value of urls) {
    if (!isObject(value)) continue;
    const short = asString(value.url);
    const expanded = asString(value.expanded_url) ?? asString(value.expandedUrl);
    if (short && expanded) text = text.split(short).join(expanded);
  }
  return text.trim();
}

function tweetRecord(
  wrapper: unknown,
  kind: "tweet" | "community-tweet" | "deleted-tweet",
  handle: string,
  media: Map<string, string[]>,
): TwitterPublicWritingRecord | "retweet" | "malformed" | "empty" {
  const raw = isObject(wrapper) && isObject(wrapper.tweet) ? wrapper.tweet : wrapper;
  if (!isObject(raw)) return "malformed";
  const id = asString(raw.id_str) ?? asString(raw.id);
  const sourceText = asString(raw.full_text) ?? asString(raw.text);
  if (!id) return "malformed";
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
    : handle === "unknown"
      ? `https://x.com/i/web/status/${id}`
      : `https://x.com/${handle}/status/${id}`;
  return {
    id,
    kind,
    text: expandedText(raw, sourceText),
    createdAt: asIso(raw.created_at) ?? asIso(raw.createdAt),
    parentId:
      asString(raw.in_reply_to_status_id_str) ??
      asString(raw.in_reply_to_status_id) ??
      asString(raw.inReplyTo),
    sourceUrl,
    communityId:
      kind === "community-tweet"
        ? asString(raw.community_id_str) ?? asString(raw.community_id) ?? undefined
        : undefined,
    media: localMedia(media.get(id) ?? []),
  };
}

function noteRecord(
  wrapper: unknown,
  handle: string,
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
  if (!id) return "malformed";
  if (!text) return "empty";
  const tweetId = asString(raw.tweetId) ?? (core ? asString(core.tweetId) : null);
  return {
    id,
    kind: "note-tweet",
    text: text.replace(/\r\n?/g, "\n").trim(),
    createdAt: asIso(raw.createdAt),
    parentId: null,
    sourceUrl: tweetId
      ? handle === "unknown"
        ? `https://x.com/i/web/status/${tweetId}`
        : `https://x.com/${handle}/status/${tweetId}`
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
  handle: string,
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
  if (!id) return "malformed";
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
    sourceUrl: tweetId
      ? handle === "unknown"
        ? `https://x.com/i/web/status/${tweetId}`
        : `https://x.com/${handle}/status/${tweetId}`
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

export async function ingestTwitterPublicWriting(
  root: string,
  logger: (level: Level, message: string) => void,
  options: TwitterPublicWritingOptions = {},
): Promise<TwitterPublicWritingResult> {
  const manifestValue = await readArchiveValue(path.join(root, "data", "manifest.js"));
  if (!isObject(manifestValue)) {
    throw new Error("twitter public writing: manifest.js must contain an object");
  }
  const parsedManifest = manifestValue as Manifest;

  const handle = await accountHandle(root);
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
      values.push(...await readArchiveArray(path.join(root, relative)));
    }
    return values;
  };

  for (const value of await readType("tweets")) {
    sourceRecords.tweet += 1;
    add(tweetRecord(value, "tweet", handle, tweetMedia));
  }
  for (const value of await readType("communityTweet")) {
    sourceRecords["community-tweet"] += 1;
    add(tweetRecord(value, "community-tweet", handle, communityMedia));
  }
  for (const value of await readType("noteTweet")) {
    sourceRecords["note-tweet"] += 1;
    add(noteRecord(value, handle));
  }

  const articles = await readType("article");
  const metadata = await readType("articleMetadata");
  sourceRecords.article = articles.length;
  for (let index = 0; index < articles.length; index += 1) {
    add(articleRecord(articles[index], metadata[index], handle));
  }

  const deletedTweets = await readType("deletedTweets");
  sourceRecords["deleted-tweet"] = deletedTweets.length;
  if (options.includeDeleted) {
    for (const value of deletedTweets) {
      add(tweetRecord(value, "deleted-tweet", handle, deletedMedia));
    }
  } else {
    skipped.deletedTweets = deletedTweets.length;
  }

  records.sort((a, b) => {
    const at = a.createdAt ?? "9999";
    const bt = b.createdAt ?? "9999";
    return at.localeCompare(bt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
  });
  if (new Set(records.map((record) => `${record.kind}:${record.id}`)).size !== records.length) {
    throw new Error("twitter public writing: duplicate kind/id records in archive");
  }

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
  logger("info", `Prepared ${records.length} public writing record(s) for @${handle}`);
  return {
    records,
    stats: { accountHandle: handle, sourceRecords, emitted, skipped, totals },
  };
}
