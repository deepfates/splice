import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AtUri } from "@atproto/api";
import {
  ContentItem,
  Thread,
  Level,
  MediaAttachment,
  formatIsoDateOnly,
  sanitizeFilename,
  isRetweet,
} from "../core/types";
import { cleanText, messagesFromConversation } from "../transforms/core";

/**
 * Ensure a directory exists (mkdir -p).
 */
async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Copy media attachments for a set of items into imagesDir, prefixing names with "_".
 * If an attachment lacks absPath, it will be skipped with a warning.
 */
async function copyMedia(
  items: ContentItem[],
  imagesDir: string,
  logger: (l: Level, m: string) => void
) {
  await ensureDir(imagesDir);
  for (const it of items) {
    for (const m of it.media ?? []) {
      const base = m.absPath ? path.basename(m.absPath) : `${m.id}.bin`;
      try {
        if (!m.absPath) {
          logger("debug", `No absPath for media ${m.id}; skipping copy`);
          continue;
        }
        await fs.copyFile(m.absPath, path.join(imagesDir, `_${base}`));
      } catch (e) {
        logger(
          "warn",
          `Failed to copy media ${m.absPath ?? m.id}: ${(e as Error).message}`
        );
      }
    }
  }
}

const SELF_POST_SOURCES = new Set(["twitter:tweet", "bluesky:post"]);

function isSelfAuthoredPost(item: ContentItem): boolean {
  return SELF_POST_SOURCES.has(item.source);
}

function isReshare(item: ContentItem): boolean {
  return item.source === "twitter:tweet" && isRetweet(item.text);
}

function mediaMarkdownLinks(media?: MediaAttachment[]): string[] {
  if (!media) return [];
  return media
    .filter((m) => !!m.absPath)
    .map((m) => {
      const base = path.basename(m.absPath as string);
      return `![${base}](../../images/_${base})`;
    });
}

function buildPermalink(item: ContentItem): { url: string; label: string } | null {
  if (item.source === "twitter:tweet") {
    return {
      url: `https://twitter.com/i/web/status/${item.id}`,
      label: "Twitter",
    };
  }
  if (item.source === "bluesky:post") {
    try {
      const uri = new AtUri(item.id);
      if (!uri.host || !uri.rkey) return null;
      return {
        url: `https://bsky.app/profile/${uri.host}/post/${uri.rkey}`,
        label: "Bluesky",
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Ensure quoted tweet links render as separate paragraphs.
 * Surround twitter.com or x.com status URLs with blank lines, without stripping intentional spacing.
 */
function isolateQuotedTweetLinks(text: string): string {
  if (!text) return "";
  const urlPattern =
    /(https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^)\s]*)?)/g;
  // First, put links on their own line
  let s = text.replace(urlPattern, "\n$1\n");
  // Then ensure a blank line before and after any standalone link line
  const urlLineRe =
    /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^)\s]*)?$/;
  const lines = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isUrl = urlLineRe.test(line.trim());
    if (isUrl) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      out.push(line.trim());
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== "") {
        out.push("");
      }
    } else {
      out.push(line);
    }
  }
  // Collapse runs of 3+ blank lines to exactly two
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Write Markdown outputs:
 * - threads/&lt;yyyymmdd&gt;-thread-&lt;slug&gt;.md with frontmatter, cleaned text, media links, and link to the source platform
 * - tweets/&lt;yyyymmdd&gt;-tweet-&lt;slug&gt;.md for non-thread posts (excluding reshares)
 * - images/_&lt;file&gt; copied for referenced items
 */
export async function writeMarkdown(
  threads: Thread[],
  items: ContentItem[],
  outDir: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean
) {
  const threadsDir = path.join(outDir, "threads");
  const tweetsDir = path.join(outDir, "tweets");
  const imagesDir = path.join(outDir, "images");

  if (!dryRun) {
    await ensureDir(threadsDir);
    await ensureDir(tweetsDir);
    await ensureDir(imagesDir);
  }

  // Copy media for all thread items + non-thread tweets
  const realThreads = threads.filter((t) => t.items.length > 1);
  const threadItems = realThreads.flatMap((t) => t.items);
  const threadIds = new Set(threadItems.map((i) => i.id));
  const nonThreadPosts = items.filter(
    (i) => isSelfAuthoredPost(i) && !threadIds.has(i.id) && !isReshare(i)
  );
  const copyPool = threadItems.concat(nonThreadPosts);

  logger("info", `Preparing media for ${copyPool.length} items`);
  if (!dryRun) await copyMedia(copyPool, imagesDir, logger);

  // Save threads
  logger("info", `Saving ${realThreads.length} threads`);
  for (const thread of realThreads) {
    const first = thread.items[0];
    const date = formatIsoDateOnly(first.createdAt);
    const fm = `---\nDate: ${date}\n---\n`;

    const parts: string[] = [];
    for (const t of thread.items) {
      const mediaLinks = mediaMarkdownLinks(t.media);
      const cleaned = cleanText(t.text, (t.raw as any)?.entities);
      const prepared = isolateQuotedTweetLinks(cleaned);
      const segments = [prepared];
      if (mediaLinks.length) {
        segments.push(mediaLinks.join("\n"));
      }
      parts.push(segments.filter(Boolean).join("\n\n").trim());
    }

    const firstWords = thread.items[0].text.split(/\s+/).slice(0, 5).join(" ");
    const name = sanitizeFilename(firstWords) || thread.id;
    const ymd = date.replace(/-/g, "");
    const filePath = path.join(threadsDir, `${ymd}/${name}.md`);
    const permalink = buildPermalink(first);
    const footer = permalink
      ? `\n\n[View on ${permalink.label}](${permalink.url})`
      : "";
    const body = `${fm}\n${parts.join("\n\n")}${footer}`;

    if (dryRun) {
      logger("info", `(dry-run) would write thread file: ${filePath}`);
    } else {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, body, "utf8");
    }
  }

  // Save single posts (non-reshares not part of multi-item threads) as individual files in tweets/
  for (const t of nonThreadPosts) {
    const date = formatIsoDateOnly(t.createdAt);
    const ymd = date.replace(/-/g, "");
    const fm = `---\nDate: ${date}\n---\n`;
    const images = mediaMarkdownLinks(t.media).join("\n");
    const cleaned = cleanText(t.text, (t.raw as any)?.entities);
    const prepared = isolateQuotedTweetLinks(cleaned);
    const withImages = images ? `${prepared}\n\n${images}` : prepared;
    const words = t.text.split(/\s+/).slice(0, 5).join(" ");
    const slug = sanitizeFilename(words) || t.id;
    const permalink = buildPermalink(t);
    const footer = permalink
      ? `\n\n[View on ${permalink.label}](${permalink.url})`
      : "";
    const content = `${fm}\n${withImages}${footer}`;
    const filePath = path.join(tweetsDir, `${ymd}/${slug}.md`);
    if (dryRun) {
      logger("info", `(dry-run) would write tweet file: ${filePath}`);
    } else {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, content, "utf8");
    }
  }
}

/**
 * Write conversations in OpenAI JSONL format.
 * Note: Includes a system message at the top of each conversation.
 */
export async function writeOAI(
  threads: Thread[],
  conversations: ContentItem[][],
  outDir: string,
  systemMessage: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean
) {
  const outPath = path.join(outDir, "conversations_oai.jsonl");
  if (dryRun) {
    logger("info", `(dry-run) would write OAI JSONL: ${outPath}`);
    return;
  }
  await ensureDir(path.dirname(outPath));
  const fh = await fs.open(outPath, "w");

  const writeConv = async (items: ContentItem[]) => {
    const msgs = messagesFromConversation(items);
    if (!msgs.length) return;
    const record = {
      messages: [{ role: "system", content: systemMessage }, ...msgs],
    };
    await fh.write(JSON.stringify(record) + "\n");
  };

  for (const t of threads) await writeConv(t.items);
  for (const c of conversations) await writeConv(c);
  await fh.close();
  logger("info", `Wrote OAI JSONL to ${outPath}`);
}

/**
 * Write the normalized ContentItem stream as JSONL for downstream reuse.
 */
export async function writeNormalizedJSONL(
  items: ContentItem[],
  outDir: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean
) {
  const outPath = path.join(outDir, "normalized_items.jsonl");
  if (dryRun) {
    logger("info", `(dry-run) would write normalized items JSONL: ${outPath}`);
    return;
  }
  await ensureDir(path.dirname(outPath));
  const fh = await fs.open(outPath, "w");
  for (const it of items) {
    await fh.write(JSON.stringify(it) + "\n");
  }
  await fh.close();
  logger("info", `Wrote normalized items JSONL to ${outPath}`);
}

/**
 * Write ShareGPT JSON format from conversations derived from threads and mixed conversations.
 */
export async function writeShareGPT(
  threads: Thread[],
  conversations: ContentItem[][],
  outDir: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean
) {
  const outPath = path.join(outDir, "sharegpt.json");
  if (dryRun) {
    logger("info", `(dry-run) would write ShareGPT JSON: ${outPath}`);
    return;
  }
  await ensureDir(path.dirname(outPath));
  const list: Array<{ conversations: Array<{ from: string; value: string }> }> =
    [];
  const addConv = async (items: ContentItem[]) => {
    const msgs = messagesFromConversation(items);
    if (!msgs.length) return;
    list.push({
      conversations: msgs.map((m) => ({
        from: m.role === "user" ? "human" : "gpt",
        value: m.content,
      })),
    });
  };
  for (const t of threads) await addConv(t.items);
  for (const c of conversations) await addConv(c);
  await fs.writeFile(outPath, JSON.stringify(list, null, 2), "utf8");
  logger("info", `Wrote ShareGPT JSON to ${outPath}`);
}

/**
 * Write a small stats.json summary about items, threads, conversations, and date range.
 */
export async function writeStatsJSON(
  items: ContentItem[],
  threads: Thread[],
  conversations: ContentItem[][],
  outDir: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean
) {
  const outPath = path.join(outDir, "stats.json");
  const dates = items
    .map((i) => new Date(i.createdAt).toISOString())
    .filter(Boolean);
  const start = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
  const end = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  const stats = {
    totalItems: items.length,
    tweets: items.filter((i) => i.source === "twitter:tweet").length,
    likes: items.filter((i) => i.source === "twitter:like").length,
    threads: threads.length,
    conversations: conversations.length,
    dateRange: { start, end },
  };
  if (dryRun) {
    logger("info", `(dry-run) would write stats JSON: ${outPath}`);
    return;
  }
  await ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, JSON.stringify(stats, null, 2), "utf8");
  logger("info", `Wrote stats JSON to ${outPath}`);
}
