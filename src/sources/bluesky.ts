import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readCarWithRoot, MemoryBlockstore, Repo } from "@atproto/repo";
import { AtUri } from "@atproto/api";
import type { AppBskyFeedPost } from "@atproto/api";
import {
  ContentItem,
  Level,
  MediaAttachment,
  toIso,
} from "../core/types";

const POST_COLLECTION = "app.bsky.feed.post";

/**
 * Detect whether the provided path looks like a Bluesky/AT Protocol CAR export.
 * We keep this lightweight and only check for a readable .car file.
 */
export async function detectBlueskyCar(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) return false;
    return path.extname(targetPath).toLowerCase() === ".car";
  } catch {
    return false;
  }
}

/**
 * Ingest a Bluesky repository export (CAR file) and normalize posts into ContentItems.
 * Media blobs are referenced but not downloaded; attachments carry blob metadata only.
 */
export async function ingestBlueskyCar(
  carPath: string,
  logger: (l: Level, m: string) => void,
): Promise<ContentItem[]> {
  const absolute = path.resolve(carPath);
  logger("info", `Reading Bluesky CAR from ${absolute}`);
  const bytes = await fs.readFile(absolute);
  const { root, blocks } = await readCarWithRoot(bytes);
  const blockstore = new MemoryBlockstore(blocks);
  const repo = await Repo.load(blockstore, root);

  logger("info", `Repo DID: ${repo.did}`);

  const items: ContentItem[] = [];
  for await (const recordEntry of repo.walkRecords()) {
    if (recordEntry.collection !== POST_COLLECTION) continue;
    const post = recordEntry.record as AppBskyFeedPost.Record | undefined;
    if (!post) continue;

    const uri = formatRecordUri(repo.did, recordEntry.collection, recordEntry.rkey);
    const parentUri = extractParentUri(post);
    const parentDid = parentUri ? extractDid(parentUri) : null;

    items.push({
      id: uri,
      text: post.text ?? "",
      createdAt: post.createdAt ? toIso(post.createdAt) : new Date().toISOString(),
      parentId: parentUri,
      inReplyToUserId: parentDid,
      accountId: repo.did,
      source: "bluesky:post",
      raw: {
        uri,
        cid: recordEntry.cid.toString(),
        collection: recordEntry.collection,
        rkey: recordEntry.rkey,
        record: cloneRecord(post),
      },
      media: extractMediaAttachments(uri, post),
    });
  }

  logger("info", `Total normalized Bluesky posts: ${items.length}`);
  return items;
}

function formatRecordUri(did: string, collection: string, rkey: string): string {
  const atUri = AtUri.make(`at://${did}`, collection, rkey);
  return atUri.toString();
}

function extractParentUri(
  record: AppBskyFeedPost.Record,
): string | null {
  const reply = record.reply;
  if (reply?.parent?.uri) {
    return reply.parent.uri;
  }
  return null;
}

function extractDid(uri: string): string | null {
  try {
    const parsed = new AtUri(uri);
    return parsed.host || null;
  } catch {
    return null;
  }
}

function cloneRecord(record: AppBskyFeedPost.Record): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record));
}

function extractMediaAttachments(
  uri: string,
  record: AppBskyFeedPost.Record,
): MediaAttachment[] {
  const embed = record.embed as Record<string, any> | undefined;
  if (!embed) return [];

  if (embed.$type === "app.bsky.embed.images") {
    return (embed.images ?? []).map((image: any, idx: number) =>
      makeBlobAttachment(
        uri,
        `image-${idx}`,
        image?.image,
        "photo",
        { alt: image?.alt, aspectRatio: image?.aspectRatio },
      ),
    );
  }

  if (embed.$type === "app.bsky.embed.video") {
    return [
      makeBlobAttachment(uri, "video", embed.video, "video", {
        alt: embed.alt,
        aspectRatio: embed.aspectRatio,
      }),
    ].filter(Boolean) as MediaAttachment[];
  }

  if (embed.$type === "app.bsky.embed.recordWithMedia" && embed.media) {
    return extractMediaAttachments(uri, { ...record, embed: embed.media });
  }

  return [];
}

function makeBlobAttachment(
  uri: string,
  suffix: string,
  blob: any,
  contentType: MediaAttachment["contentType"],
  metadata: Record<string, unknown>,
): MediaAttachment | null {
  if (!blob) return null;
  const cid =
    typeof blob.cid === "string"
      ? blob.cid
      : blob.ref?.toString?.() ?? `${uri}#${suffix}`;
  return {
    id: `${uri}#${suffix}`,
    contentType,
    metadata: {
      ...metadata,
      cid,
      mimeType: blob.mimeType,
      size: blob.size,
    },
  };
}

const BSKY_PUBLIC_API = "https://public.api.bsky.app";

interface ThreadPost {
  $type?: string;
  post?: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string };
    record: { text?: string; createdAt?: string; reply?: any };
  };
  parent?: ThreadPost;
}

/**
 * Extract a ContentItem from a thread post object.
 */
function threadPostToItem(tp: ThreadPost, parentUri: string | null): ContentItem | null {
  if (!tp.post) return null;
  const post = tp.post;
  const record = post.record;
  const author = post.author;
  
  return {
    id: post.uri,
    text: record.text ?? "",
    createdAt: record.createdAt ? toIso(record.createdAt) : new Date().toISOString(),
    parentId: parentUri,
    inReplyToUserId: parentUri ? null : null, // We don't track this for fetched posts
    accountId: author.did,
    source: "bluesky:fetched",
    raw: {
      uri: post.uri,
      cid: post.cid,
      author: {
        did: author.did,
        handle: author.handle,
        displayName: author.displayName,
      },
      record,
    },
    media: [],
  };
}

/**
 * Fetch a post and its full parent chain from the public Bluesky API.
 * Returns all posts in the chain (newest first), or empty array if not found.
 */
async function fetchPostChain(
  uri: string,
  logger: (l: Level, m: string) => void,
): Promise<ContentItem[]> {
  const url = `${BSKY_PUBLIC_API}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=50`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404 || res.status === 400) {
        logger("debug", `Post not found: ${uri}`);
        return [];
      }
      throw new Error(`API error ${res.status}`);
    }
    const data = await res.json() as { thread?: ThreadPost };
    const thread = data.thread;
    if (!thread || thread.$type !== "app.bsky.feed.defs#threadViewPost") {
      return [];
    }
    
    // Walk up the parent chain and collect all posts
    const posts: ContentItem[] = [];
    let current: ThreadPost | undefined = thread;
    let childUri: string | null = null;
    
    while (current && current.$type === "app.bsky.feed.defs#threadViewPost" && current.post) {
      // Determine parent URI for this post
      const parentUri = current.parent?.post?.uri ?? null;
      const item = threadPostToItem(current, parentUri);
      if (item) {
        posts.push(item);
      }
      current = current.parent;
    }
    
    return posts; // newest first (the requested post, then its parent, grandparent, etc.)
  } catch (e) {
    logger("warn", `Failed to fetch ${uri}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Enrich a list of Bluesky posts by fetching their parent posts from the public API.
 * Returns the original items plus any successfully fetched parent posts.
 */
export async function enrichBlueskyPosts(
  items: ContentItem[],
  logger: (l: Level, m: string) => void,
): Promise<ContentItem[]> {
  // Collect unique parent URIs that we don't already have
  const existingIds = new Set(items.map(i => i.id));
  const parentUris = new Set<string>();
  
  for (const item of items) {
    if (item.parentId && !existingIds.has(item.parentId)) {
      parentUris.add(item.parentId);
    }
  }
  
  if (parentUris.size === 0) {
    logger("info", "No parent posts to fetch");
    return items;
  }
  
  logger("info", `Fetching thread context for ${parentUris.size} parent posts from Bluesky API...`);
  
  const fetched: ContentItem[] = [];
  const fetchedIds = new Set<string>();
  const uriList = Array.from(parentUris);
  let completed = 0;
  
  // Batch with rate limiting - 10 concurrent, 100ms delay between batches
  const BATCH_SIZE = 10;
  const DELAY_MS = 100;
  
  for (let i = 0; i < uriList.length; i += BATCH_SIZE) {
    const batch = uriList.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(uri => fetchPostChain(uri, logger))
    );
    
    // Flatten and dedupe (same parent may appear in multiple chains)
    for (const chain of results) {
      for (const item of chain) {
        if (!existingIds.has(item.id) && !fetchedIds.has(item.id)) {
          fetched.push(item);
          fetchedIds.add(item.id);
        }
      }
    }
    
    completed += batch.length;
    if (completed % 500 === 0 || completed === uriList.length) {
      logger("info", `Fetched ${completed}/${uriList.length} thread contexts (${fetched.length} unique posts)`);
    }
    
    // Rate limit delay
    if (i + BATCH_SIZE < uriList.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  
  logger("info", `Enrichment complete: fetched ${fetched.length} unique context posts`);
  
  return [...items, ...fetched];
}
