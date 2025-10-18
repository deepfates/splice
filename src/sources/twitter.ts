import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  Level,
  ContentItem,
  MediaAttachment,
  readJsonFromJs,
  parseLooseArray,
  mediaTypeFromExt,
  toIso,
  cleanJsonString,
} from "../core/types";

/**
 * Subset of the Twitter/X archive manifest schema
 */
type Manifest = {
  dataTypes?: Record<string, { files?: Array<{ fileName: string }> }>;
};

/**
 * Detect whether a directory looks like a Twitter/X archive by checking for data/manifest.js
 */
export async function detectTwitterArchive(rootPath: string): Promise<boolean> {
  try {
    const p = path.join(rootPath, "data", "manifest.js");
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return media file basenames for a given tweet id.
 * Filters out zero-byte files to avoid broken copies.
 */
async function getMediaFiles(root: string, id: string): Promise<string[]> {
  const mediaDir = path.join(root, "data", "tweets_media");
  try {
    const files = await fs.readdir(mediaDir);
    const filtered: string[] = [];
    for (const f of files) {
      if (!f.startsWith(`${id}-`)) continue;
      const stat = await fs.stat(path.join(mediaDir, f));
      if (stat.size > 0) filtered.push(f);
    }
    return filtered;
  } catch {
    return [];
  }
}

/**
 * Normalize a raw tweet/like structure from the archive format
 */
function normalizeTweetLike(
  item: any,
  _source: "twitter:tweet" | "twitter:like",
): {
  id: string;
  text: string;
  created_at: string;
  parent_id?: string | null;
  raw: any;
} | null {
  const t = item?.tweet ?? item?.like ?? item;
  if (!t) return null;
  const id = t.id || t.tweetId;
  if (!id) return null;
  const text = t.text || t.fullText || t.full_text || "";
  const created_at = t.created_at || t.createdAt || "";
  const parent_id = t.in_reply_to_status_id || t.inReplyTo || null;
  return { id, text, created_at, parent_id, raw: t };
}

/**
 * Ingest a Twitter/X archive into normalized ContentItem records
 */
export async function ingestTwitter(
  rootPath: string,
  logger: (l: Level, m: string) => void,
): Promise<ContentItem[]> {
  const manifestPath = path.join(rootPath, "data", "manifest.js");
  const manifest: Manifest = await readJsonFromJs(manifestPath);
  const types = manifest.dataTypes ?? {};
  const out: ContentItem[] = [];

  const selected: Array<"tweets" | "like"> = Object.keys(types).filter(
    (t) => t === "tweets" || t === "like",
  ) as any;

  for (const dataType of selected) {
    const info = types[dataType];
    const files = info?.files ?? [];
    if (!files.length) continue;

    logger("info", `Processing ${files.length} files for ${dataType}`);

    for (const f of files) {
      const filePath = path.join(rootPath, f.fileName);
      const raw = await fs.readFile(filePath, "utf8");
      const cleaned = cleanJsonString(raw);
      const data = parseLooseArray(cleaned);
      if (!Array.isArray(data) || data.length === 0) continue;

      for (const item of data) {
        const norm = normalizeTweetLike(
          item,
          dataType === "tweets" ? "twitter:tweet" : "twitter:like",
        );
        if (!norm) continue;

        const mediaFiles = await getMediaFiles(rootPath, norm.id);
        const media: MediaAttachment[] = mediaFiles.map((fn) => ({
          id: `${norm.id}_${fn.replace(/\.\w+$/, "")}`,
          contentType: mediaTypeFromExt(fn),
          absPath: path.join(rootPath, "data", "tweets_media", fn),
          metadata: {
            parent: norm.id,
            media_info: norm.raw?.extended_entities?.media ?? [],
          },
        }));

        out.push({
          id: norm.id,
          text: norm.text,
          createdAt: norm.created_at ? toIso(norm.created_at) : new Date().toISOString(),
          parentId: norm.parent_id ?? null,
          source: dataType === "tweets" ? "twitter:tweet" : "twitter:like",
          raw: norm.raw,
          media,
        });
      }
    }
  }

  logger("info", `Total normalized items: ${out.length}`);
  return out;
}
