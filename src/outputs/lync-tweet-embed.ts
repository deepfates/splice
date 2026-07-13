/**
 * deep-space tweet embed cache → lync (dee-jklg).
 *
 * Source: a directory of Twitter/X oEmbed responses cached by deep-space,
 * one JSON file per tweet, named `<tweetid>-light.json`. Shape (observed
 * uniform across all files): { url, author_name, author_url, html, width,
 * height, type: "rich", cache_age, provider_name: "Twitter"|"X",
 * provider_url, version, cached_at }.
 *
 * Mapping:
 * - kind: `twitter/tweet-embed` — deliberately DISTINCT from a full-archive
 *   `twitter/tweet`. A cached embed is a lossy rendering (oEmbed HTML), not
 *   the canonical tweet object; the two must never share an event identity.
 * - id: deterministic UUIDv8 from ("twitter", "tweet-embed", tweetId), so
 *   re-importing the same cache is a union no-op.
 * - author.actor: the tweet's author handle, extracted from `author_url`
 *   (last path segment), falling back to the `(@handle)` in the oEmbed HTML,
 *   then `author_name`, then "unknown". NEVER the importer.
 * - at: the tweet's own timestamp, derived on a documented ladder:
 *     1. snowflake decode of the tweet id (ids >= 2^40; millisecond-precise,
 *        deterministic — the id is part of the source identity). This is the
 *        primary source, not a fallback.
 *     2. the human-readable date in the oEmbed HTML anchor ("February 10,
 *        2019"), parsed as UTC midnight (day precision) — recorded in
 *        timestampFallbacks.
 *     3. the cache write time `cached_at` — recorded in timestampFallbacks.
 *     4. epoch/markedAt fallback — recorded in timestampFallbacks.
 *   Every non-snowflake derivation is explicit in stats; nothing is guessed
 *   silently. `atSources` counts which rung every event used.
 * - parents: when the caller supplies the set of tweet ids known to the
 *   canonical Twitter archive import, a matched embed parents to that
 *   archive tweet's deterministic event id (the ("twitter","item",id)
 *   convention of contentItemsToLyncEvents). Matching is NEVER assumed:
 *   stats.archiveMatching reports { provided, matched, unmatched }, and with
 *   no id set provided every event is unmatched with parents [].
 * - payload: { file, tweet_id, embed } where `embed` is the original cache
 *   object byte-for-byte-as-parsed — nothing discarded — plus the file name
 *   and extracted tweet id as file metadata (ticket: "payload preserves the
 *   raw cache object and file metadata").
 *
 * ZERO SILENT DROPS: every `.json` file in the cache dir either becomes an
 * event or lands in stats.skipped with its FILENAME and reason (unreadable,
 * invalid JSON, not an object, no derivable tweet id, id ambiguity).
 * Counts always reconcile: sourceFiles === emitted + skipped.length.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LyncEventBody } from "@deepfates/lync/events";

import {
  buildAuthor,
  deterministicLyncId,
  isRfc3339,
  writeLyncFile,
  verifyLyncFile,
  type LyncProducerOptions,
  type LyncVerifyResult,
} from "./lync.js";

/* --------------------------------- Types ---------------------------------- */

export const TWEET_EMBED_KIND = "twitter/tweet-embed";
export const TWEET_EMBED_IMPORTER = "twitter-embed-cache";
export const DEFAULT_TWEET_EMBED_VIA = "deep-space-embed-cache@unknown";

export interface TweetEmbedCacheOptions {
  /** Human responsible for the import. Default "deepfates". */
  operator?: string;
  /** Tool the content came through. Default "deep-space-embed-cache@unknown". */
  via?: string;
  /** Path-or-ref prefix for author.source ("<sourceRef>:<file>"). */
  sourceRef?: string;
  /** Import time (RFC 3339) recorded as `marked`. OPT-IN for determinism. */
  markedAt?: string;
  /**
   * Tweet ids known to the canonical Twitter archive import. When given,
   * matching embeds parent to the archive tweet event id. When omitted,
   * matching is reported as not provided — never silently assumed.
   */
  archiveTweetIds?: Iterable<string>;
}

/** One cache file that could not become an event — explicit, never silent. */
export interface TweetEmbedSkippedFile {
  file: string;
  reason: string;
  /** JSON-safe snippet or value of the offending content, for audit. */
  value: unknown;
}

/** One `at` that did not come from a snowflake decode — explicit. */
export interface TweetEmbedTimestampFallback {
  file: string;
  original: unknown;
  used: string;
  reason: string;
}

export interface TweetEmbedStats {
  /** `.json` files found in the cache dir (or records passed in). */
  sourceFiles: number;
  emitted: number;
  skipped: TweetEmbedSkippedFile[];
  timestampFallbacks: TweetEmbedTimestampFallback[];
  /** Which rung of the timestamp ladder each emitted event used. */
  atSources: {
    snowflake: number;
    htmlDate: number;
    cachedAt: number;
    fallback: number;
  };
  /** Cross-import matching against the canonical Twitter archive. */
  archiveMatching: {
    /** Whether a set of archive tweet ids was supplied at all. */
    provided: boolean;
    matched: number;
    unmatched: number;
  };
}

export interface TweetEmbedMappingResult {
  events: LyncEventBody[];
  stats: TweetEmbedStats;
}

export interface TweetEmbedCacheFile {
  /** File name (basename), used in skip stats and author.source locator. */
  file: string;
  /** Raw file text; parsed here so parse failures are OUR stats, not a throw. */
  text: string;
}

/* ------------------------------ Deterministic ids ------------------------- */

/** Event id for a cached tweet embed. Distinct namespace from archive tweets. */
export function tweetEmbedEventId(tweetId: string): string {
  return deterministicLyncId("twitter", "tweet-embed", tweetId);
}

/**
 * Event id the canonical Twitter archive import mints for a tweet — the
 * ("twitter", "item", id) convention of contentItemsToLyncEvents. Used as the
 * parent for embeds matched against the archive.
 */
export function archiveTweetEventId(tweetId: string): string {
  return deterministicLyncId("twitter", "item", tweetId);
}

/* ------------------------------ Tweet id ---------------------------------- */

const STATUS_URL_RE = /\/status(?:es)?\/(\d+)(?:[/?#]|$)/;
const FILE_ID_RE = /^(\d+)(?:-[A-Za-z0-9_]+)?\.json$/;

/**
 * Derive the tweet id from the cache record. The oEmbed `url` is primary
 * (".../status/<id>"); the filename ("<id>-light.json") must agree when both
 * are present — a disagreement is an explicit skip, never a guess.
 */
export function extractTweetId(
  file: string,
  embed: Record<string, unknown>,
): { id?: string; reason?: string } {
  const fromUrl =
    typeof embed.url === "string"
      ? (embed.url.match(STATUS_URL_RE)?.[1] ?? undefined)
      : undefined;
  const fromFile = file.match(FILE_ID_RE)?.[1] ?? undefined;
  if (fromUrl && fromFile && fromUrl !== fromFile) {
    return {
      reason: `tweet id ambiguity: url says ${fromUrl}, filename says ${fromFile}`,
    };
  }
  const id = fromUrl ?? fromFile;
  if (!id) {
    return {
      reason: "no tweet id derivable from url or filename",
    };
  }
  return { id };
}

/* ------------------------------- Timestamps ------------------------------- */

/** Twitter snowflake epoch (ms): 2010-11-04T01:42:54.657Z. */
const SNOWFLAKE_EPOCH_MS = 1288834974657n;
/**
 * Ids below 2^40 are treated as pre-snowflake (sequential). Real snowflake
 * ids passed 2^40 within days of the 2010-11-04 deploy; sequential ids
 * topped out around 3e10. The tiny ambiguous window (deploy day itself)
 * falls through to the HTML-date rung, explicitly recorded.
 */
const SNOWFLAKE_MIN_ID = 1n << 40n;

/** Decode a tweet snowflake id to its RFC 3339 creation time, or undefined. */
export function snowflakeToIso(tweetId: string): string | undefined {
  if (!/^\d+$/.test(tweetId)) return undefined;
  const n = BigInt(tweetId);
  if (n < SNOWFLAKE_MIN_ID) return undefined;
  const ms = (n >> 22n) + SNOWFLAKE_EPOCH_MS;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const HTML_DATE_RE = /ref_src=twsrc%5Etfw">([A-Za-z]+ \d{1,2}, \d{4})<\/a>/;

/**
 * Parse the human-readable date from the oEmbed HTML anchor ("February 10,
 * 2019") as UTC midnight. Manual parse (not `new Date(string)`) so the bytes
 * are timezone-independent — determinism across machines is load-bearing for
 * union-as-no-op re-imports.
 */
export function htmlAnchorDateToIso(html: unknown): string | undefined {
  if (typeof html !== "string") return undefined;
  const text = html.match(HTML_DATE_RE)?.[1];
  if (!text) return undefined;
  const m = text.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!m) return undefined;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return undefined;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, month, day));
  // reject rollovers like "February 31"
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return undefined;
  return d.toISOString();
}

/* --------------------------------- Actor ---------------------------------- */

const HTML_HANDLE_RE = /&mdash;[^<]*\(@([A-Za-z0-9_]+)\)/;

/** The tweet author's handle: author_url path, else (@handle) in HTML. */
export function actorForEmbed(embed: Record<string, unknown>): string {
  if (typeof embed.author_url === "string") {
    const m = embed.author_url.match(
      /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)\/?$/,
    );
    if (m) return m[1];
  }
  if (typeof embed.html === "string") {
    const m = embed.html.match(HTML_HANDLE_RE);
    if (m) return m[1];
  }
  if (
    typeof embed.author_name === "string" &&
    embed.author_name.trim().length > 0
  ) {
    return embed.author_name.trim();
  }
  return "unknown";
}

/* -------------------------------- Mapping ---------------------------------- */

function jsonSafeSnippet(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Map cache files (name + raw text) to lync events. Pure: no filesystem.
 * Every input file becomes exactly one event or one skipped entry.
 */
export function tweetEmbedCacheToLyncEvents(
  files: TweetEmbedCacheFile[],
  opts: TweetEmbedCacheOptions & { sourceRef: string },
): TweetEmbedMappingResult {
  const producer: LyncProducerOptions = {
    importer: TWEET_EMBED_IMPORTER,
    sourceRef: opts.sourceRef,
    via: opts.via ?? DEFAULT_TWEET_EMBED_VIA,
    operator: opts.operator,
    markedAt: opts.markedAt,
  };
  const archiveIds =
    opts.archiveTweetIds !== undefined
      ? new Set(opts.archiveTweetIds)
      : undefined;

  const events: LyncEventBody[] = [];
  const skipped: TweetEmbedSkippedFile[] = [];
  const timestampFallbacks: TweetEmbedTimestampFallback[] = [];
  const atSources = { snowflake: 0, htmlDate: 0, cachedAt: 0, fallback: 0 };
  let matched = 0;
  let unmatched = 0;
  const lastResortAt = opts.markedAt ?? new Date(0).toISOString();

  for (const { file, text } of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      skipped.push({
        file,
        reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        value: jsonSafeSnippet(text),
      });
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      skipped.push({
        file,
        reason: "cache record is not a JSON object",
        value: parsed,
      });
      continue;
    }
    const embed = parsed as Record<string, unknown>;

    const idResult = extractTweetId(file, embed);
    if (!idResult.id) {
      skipped.push({
        file,
        reason: idResult.reason ?? "no tweet id",
        value: embed.url ?? null,
      });
      continue;
    }
    const tweetId = idResult.id;

    // timestamp ladder: snowflake → html date → cached_at → last resort
    let at = snowflakeToIso(tweetId);
    if (at !== undefined) {
      atSources.snowflake++;
    } else {
      const htmlDate = htmlAnchorDateToIso(embed.html);
      if (htmlDate !== undefined) {
        at = htmlDate;
        atSources.htmlDate++;
        timestampFallbacks.push({
          file,
          original: embed.html,
          used: at,
          reason:
            "pre-snowflake tweet id; used oEmbed HTML anchor date at UTC midnight (day precision)",
        });
      } else if (isRfc3339(embed.cached_at)) {
        at = embed.cached_at;
        atSources.cachedAt++;
        timestampFallbacks.push({
          file,
          original: embed.cached_at,
          used: at,
          reason:
            "no snowflake or HTML anchor date; used cache write time cached_at (NOT the tweet time)",
        });
      } else {
        at = lastResortAt;
        atSources.fallback++;
        timestampFallbacks.push({
          file,
          original: embed.cached_at ?? null,
          used: at,
          reason:
            "no tweet timestamp derivable anywhere; substituted markedAt/epoch fallback",
        });
      }
    }

    let parents: string[] = [];
    if (archiveIds?.has(tweetId)) {
      parents = [archiveTweetEventId(tweetId)];
      matched++;
    } else {
      unmatched++;
    }

    const ev: LyncEventBody = {
      v: 1,
      id: tweetEmbedEventId(tweetId),
      kind: TWEET_EMBED_KIND,
      at,
      author: buildAuthor(
        actorForEmbed(embed),
        producer,
        file,
      ) as unknown as LyncEventBody["author"],
      parents,
      payload: {
        file,
        tweet_id: tweetId,
        embed,
      },
    };
    if (producer.markedAt !== undefined) ev.marked = producer.markedAt;
    events.push(ev);
  }

  if (events.length + skipped.length !== files.length) {
    // Structurally impossible, but reconciliation is the whole point —
    // fail loudly rather than miscount silently.
    throw new Error(
      `tweet embed cache: counts do not reconcile: ${events.length} events + ${skipped.length} skipped !== ${files.length} files`,
    );
  }

  return {
    events,
    stats: {
      sourceFiles: files.length,
      emitted: events.length,
      skipped,
      timestampFallbacks,
      atSources,
      archiveMatching: {
        provided: archiveIds !== undefined,
        matched,
        unmatched,
      },
    },
  };
}

/* ------------------------------ End-to-end wire ---------------------------- */

export interface TweetEmbedCacheConversion {
  outputPath: string;
  stats: TweetEmbedStats;
  verify: LyncVerifyResult;
}

/**
 * End-to-end: read every `.json` file in the cache dir (READ ONLY — splice
 * never writes into the source dir), map to lync events, write a `.lync`
 * file, verify with @deepfates/lync, and throw loudly on any non-accepted line or
 * count mismatch. Unreadable files are explicit skips, not crashes.
 */
export async function convertTweetEmbedCacheToLync(
  cacheDir: string,
  outputPath: string,
  opts?: TweetEmbedCacheOptions,
): Promise<TweetEmbedCacheConversion> {
  const names = (await fs.readdir(cacheDir))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const files: TweetEmbedCacheFile[] = [];
  const unreadable: TweetEmbedSkippedFile[] = [];
  for (const file of names) {
    try {
      files.push({
        file,
        text: await fs.readFile(path.join(cacheDir, file), "utf8"),
      });
    } catch (err) {
      unreadable.push({
        file,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
        value: null,
      });
    }
  }

  const mapped = tweetEmbedCacheToLyncEvents(files, {
    ...opts,
    sourceRef: opts?.sourceRef ?? cacheDir,
  });
  const stats: TweetEmbedStats = {
    ...mapped.stats,
    sourceFiles: names.length,
    skipped: [...unreadable, ...mapped.stats.skipped],
  };
  if (stats.emitted + stats.skipped.length !== stats.sourceFiles) {
    throw new Error(
      `tweet embed cache: counts do not reconcile after read: ${stats.emitted} events + ${stats.skipped.length} skipped !== ${stats.sourceFiles} files`,
    );
  }

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
  return { outputPath, stats, verify };
}
