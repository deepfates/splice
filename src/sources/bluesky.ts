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

