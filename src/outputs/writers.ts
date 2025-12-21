import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ContentItem,
  Thread,
  Level,
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

const DEFAULT_COPY_CONCURRENCY = Math.max(
  2,
  Math.min(
    32,
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : 8
  )
);

/**
 * Copy media attachments for a set of items into imagesDir, prefixing names with "_".
 * If an attachment lacks absPath, it will be skipped with a warning.
 * Copies are performed with bounded concurrency to speed up large archives.
 */
async function copyMedia(
  items: ContentItem[],
  imagesDir: string,
  logger: (l: Level, m: string) => void
) {
  await ensureDir(imagesDir);

  const copies: Array<{ src: string; dest: string }> = [];
  for (const it of items) {
    for (const m of it.media ?? []) {
      if (!m.absPath) {
        logger("warn", `No absPath for media ${m.id}; skipping copy`);
        continue;
      }
      const base = path.basename(m.absPath);
      copies.push({ src: m.absPath, dest: path.join(imagesDir, `_${base}`) });
    }
  }

  if (!copies.length) return;

  const parsedEnv = Number.parseInt(
    process.env.SPLICE_MEDIA_CONCURRENCY ?? "",
    10
  );
  const concurrency =
    Number.isFinite(parsedEnv) && parsedEnv > 0
      ? parsedEnv
      : DEFAULT_COPY_CONCURRENCY;

  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= copies.length) break;
      const { src, dest } = copies[idx];
      try {
        await fs.copyFile(src, dest);
      } catch (e) {
        logger("warn", `Failed to copy media ${src}: ${(e as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
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
 * - threads/&lt;yyyymmdd&gt;/&lt;slug&gt;.md with frontmatter, cleaned text, media links, and link to Twitter
 * - tweets/&lt;yyyymmdd&gt;-tweet-&lt;slug&gt;.md for non-thread tweets (excluding RTs)
 * - images/_&lt;file&gt; copied for referenced items
 */
export async function writeMarkdown(
  threads: Thread[],
  items: ContentItem[],
  outDir: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean,
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
  const nonThreadTweets = items.filter(
    (i) =>
      i.source === "twitter:tweet" &&
      !threadIds.has(i.id) &&
      !isRetweet(i.text),
  );
  const copyPool = threadItems.concat(nonThreadTweets);

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
      const mediaLinks = (t.media ?? []).map((m) => {
        const base = m.absPath ? path.basename(m.absPath) : `${m.id}.bin`;
        return `![${base}](../../images/_${base})`;
      });
      const cleaned = cleanText(t.text, (t.raw as any)?.entities);
      const prepared = isolateQuotedTweetLinks(cleaned);
      parts.push(`${prepared}\n\n${mediaLinks.join("\n")}`.trim());
    }

    const firstWords = thread.items[0].text.split(/\s+/).slice(0, 5).join(" ");
    const name = sanitizeFilename(firstWords) || thread.id;
    const ymd = date.replace(/-/g, "");
    const filePath = path.join(threadsDir, `${ymd}/${name}.md`);
    const topLink = `https://twitter.com/i/web/status/${first.id}`;
    const body = `${fm}\n${parts.join(
      "\n\n"
    )}\n\n[View on Twitter](${topLink})`;

    if (dryRun) {
      logger("info", `(dry-run) would write thread file: ${filePath}`);
    } else {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, body, "utf8");
    }
  }

  // Save non-thread tweets by date
  // Save single tweets (non-RTs not part of multi-tweet threads) as individual files in tweets/
  for (const t of nonThreadTweets) {
    const date = formatIsoDateOnly(t.createdAt);
    const ymd = date.replace(/-/g, "");
    const fm = `---\nDate: ${date}\n---\n`;
    const images = (t.media ?? [])
      .map((m) => {
        const base = m.absPath ? path.basename(m.absPath) : `${m.id}.bin`;
        return `![${base}](../../images/_${base})`;
      })
      .join("\n");
    const cleaned = cleanText(t.text, (t.raw as any)?.entities);
    const prepared = isolateQuotedTweetLinks(cleaned);
    const withImages = images ? `${prepared}\n\n${images}` : prepared;
    const words = t.text.split(/\s+/).slice(0, 5).join(" ");
    const slug = sanitizeFilename(words) || t.id;
    const topLink = `https://twitter.com/i/web/status/${t.id}`;
    const content = `${fm}\n${withImages}\n\n[View on Twitter](${topLink})`;
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
  dryRun: boolean,
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
  dryRun: boolean,
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
  dryRun: boolean,
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
  dryRun: boolean,
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
