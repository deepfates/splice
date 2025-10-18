import * as fs from "node:fs/promises";
import * as path from "node:path";
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

/**
 * Copy media attachments for a set of items into imagesDir, prefixing names with "_".
 * If an attachment lacks absPath, it will be skipped with a warning.
 */
async function copyMedia(
  items: ContentItem[],
  imagesDir: string,
  logger: (l: Level, m: string) => void,
) {
  await ensureDir(imagesDir);
  for (const it of items) {
    for (const m of it.media ?? []) {
      const base = m.absPath ? path.basename(m.absPath) : `${m.id}.bin`;
      try {
        if (!m.absPath) {
          logger("warn", `No absPath for media ${m.id}; skipping copy`);
          continue;
        }
        await fs.copyFile(m.absPath, path.join(imagesDir, `_${base}`));
      } catch (e) {
        logger(
          "warn",
          `Failed to copy media ${m.absPath ?? m.id}: ${(e as Error).message}`,
        );
      }
    }
  }
}

/**
 * Write Markdown outputs:
 * - threads/<title>.md with frontmatter, cleaned text, media links, and link to Twitter
 * - tweets_by_date/<YYYY-MM-DD>.md for non-thread tweets (excluding RTs)
 * - images/_<file> copied for referenced items
 */
export async function writeMarkdown(
  threads: Thread[],
  items: ContentItem[],
  outDir: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean,
) {
  const threadsDir = path.join(outDir, "threads");
  const byDateDir = path.join(outDir, "tweets_by_date");
  const imagesDir = path.join(outDir, "images");

  if (!dryRun) {
    await ensureDir(threadsDir);
    await ensureDir(byDateDir);
    await ensureDir(imagesDir);
  }

  // Copy media for all thread items + non-thread tweets
  const threadItems = threads.flatMap((t) => t.items);
  const threadIds = new Set(threadItems.map((i) => i.id));
  const nonThreadTweets = items.filter(
    (i) =>
      i.source === "twitter:tweet" &&
      !i.parentId &&
      !threadIds.has(i.id) &&
      !isRetweet(i.text),
  );
  const copyPool = threadItems.concat(nonThreadTweets);

  logger("info", `Preparing media for ${copyPool.length} items`);
  if (!dryRun) await copyMedia(copyPool, imagesDir, logger);

  // Save threads
  logger("info", `Saving ${threads.length} threads`);
  for (const thread of threads) {
    const first = thread.items[0];
    const date = formatIsoDateOnly(first.createdAt);
    const fm = `---\nDate: ${date}\n---\n`;

    const parts: string[] = [];
    for (const t of thread.items) {
      const mediaLinks = (t.media ?? []).map((m) => {
        const base = m.absPath ? path.basename(m.absPath) : `${m.id}.bin`;
        return `![${base}](../images/_${base})`;
      });
      const cleaned = cleanText(t.text, (t.raw as any)?.entities);
      parts.push(`${cleaned}\n\n${mediaLinks.join("\n")}`.trim());
    }

    const firstWords = thread.items[0].text.split(/\s+/).slice(0, 5).join(" ");
    const name = sanitizeFilename(firstWords) || thread.id;
    const filePath = path.join(threadsDir, `${name}.md`);
    const topLink = `https://twitter.com/i/web/status/${first.id}`;
    const body = `${fm}\n${parts.join("\n\n")}\n\n[View on Twitter](${topLink})`;

    if (dryRun) {
      logger("info", `(dry-run) would write thread file: ${filePath}`);
    } else {
      await fs.writeFile(filePath, body, "utf8");
    }
  }

  // Save non-thread tweets by date
  const byDate: Record<string, ContentItem[]> = {};
  for (const t of nonThreadTweets) {
    const d = formatIsoDateOnly(t.createdAt);
    (byDate[d] ||= []).push(t);
  }

  for (const [date, dayItems] of Object.entries(byDate)) {
    dayItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const content = dayItems
      .map((t) => {
        const dt = new Date(t.createdAt);
        const time = isNaN(dt.getTime())
          ? ""
          : dt.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            });
        const images = (t.media ?? [])
          .map((m) => {
            const base = m.absPath ? path.basename(m.absPath) : `${m.id}.bin`;
            return `![${base}](../images/_${base})`;
          })
          .join("");
        const cleaned = cleanText(t.text, (t.raw as any)?.entities);
        return `*${time}*  \n${cleaned}${images}`;
      })
      .join("\n\n---\n\n");

    const filePath = path.join(byDateDir, `${date}.md`);
    if (dryRun) {
      logger("info", `(dry-run) would write daily file: ${filePath}`);
    } else {
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
