#!/usr/bin/env -S tsx
/**
 * splice — simple, human-friendly starter CLI to:
 * - ingest a Twitter/X archive
 * - normalize items (tweets/likes + media)
 * - group into threads/conversations
 * - export Markdown and/or OAI JSONL
 *
 * Usage:
 *   splice --source ./archive --out ./out --format markdown oai
 *   splice --source ./archive --out ./out --format markdown --dry-run
 *   splice --help
 *
 * Exit codes: 0 success, 1 runtime error, 2 invalid args
 */
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

type SourceId = "twitter:tweet" | "twitter:like" | string;

interface MediaAttachment {
  id: string;
  contentType: "photo" | "video" | "unknown";
  absPath: string;
  metadata?: Record<string, unknown>;
}

interface ContentItem {
  id: string;
  text: string;
  createdAt: string; // ISO-8601
  parentId?: string | null;
  source: SourceId; // 'twitter:tweet' | 'twitter:like'
  raw?: Record<string, unknown>;
  media?: MediaAttachment[];
}

interface Thread {
  id: string;
  items: ContentItem[]; // ordered oldest → newest
}

type Role = "assistant" | "user";

interface ChatMessage {
  role: Role;
  content: string;
}

/* ----------------------------- tiny arg parser ---------------------------- */

type CLIOptions = {
  source?: string;
  out?: string;
  format: string[]; // e.g. ['markdown','oai']
  systemMessage: string;
  dryRun: boolean;
  logLevel: Level;
  help: boolean;
};

function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    format: ["markdown", "oai"],
    systemMessage: "You have been uploaded to the internet",
    dryRun: false,
    logLevel: "info",
    help: false,
  };

  const args = argv.slice(2);
  let systemExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--source" || a === "--archive-path") {
      opts.source = args[++i];
    } else if (a === "--out" || a === "--output-dir") {
      opts.out = args[++i];
    } else if (
      a === "--format" ||
      a === "--formats" ||
      a === "--output-formats"
    ) {
      const next = args[++i];
      if (!next) continue;
      // allow space or comma separated
      const parts = next.split(",").filter(Boolean);
      if (parts.length > 1) opts.format = parts;
      else {
        // collect following non-flag tokens too (space-separated list)
        const list = [next];
        while (args[i + 1] && !args[i + 1].startsWith("-")) {
          list.push(args[++i]);
        }
        opts.format = list;
      }
    } else if (a === "--system-message" || a === "--system") {
      const val = args[++i];
      if (val) {
        opts.systemMessage = val;
        systemExplicit = true;
      }
    } else if (a === "--dry-run" || a === "-n") {
      opts.dryRun = true;
    } else if (a === "--log-level") {
      const lvl = (args[++i] ?? "").toLowerCase();
      if (
        lvl === "debug" ||
        lvl === "info" ||
        lvl === "warn" ||
        lvl === "error"
      ) {
        opts.logLevel = lvl;
      }
    } else if (a === "--") {
      break;
    } else if (a.startsWith("-")) {
      // unknown flag; ignore to keep simple
      // could collect for suggestions
    } else {
      // positional? ignore for now
    }
  }
  if (!systemExplicit && process.env.SPLICE_SYSTEM_MESSAGE) {
    opts.systemMessage = process.env.SPLICE_SYSTEM_MESSAGE as string;
  }
  return opts;
}

/* --------------------------------- logger -------------------------------- */

function makeLogger(level: Level): (lvl: Level, msg: string) => void {
  const order: Level[] = ["debug", "info", "warn", "error"];
  const minIdx = order.indexOf(level);
  return (lvl: Level, msg: string) => {
    if (order.indexOf(lvl) >= minIdx) {
      process.stderr.write(`[${lvl}] ${msg}\n`);
    }
  };
}

/* --------------------------------- utils --------------------------------- */

function usage(): string {
  return [
    "splice — convert a Twitter archive to Markdown and/or OAI JSONL",
    "",
    "Usage:",
    "  splice --source <path> --out <dir> [--format markdown oai] [--system-message <text>] [--dry-run] [--log-level <level>]",
    "",
    "Options:",
    "  --source <path>            Path to the Twitter archive directory",
    "  --out <dir>                Output directory",
    "  --format <fmt...>          One or more formats: markdown, oai (default: markdown oai)",
    '  --system-message <text>    System message for OAI JSONL (default: "You have been uploaded to the internet")',
    "  --dry-run, -n              Plan only; don’t write files",
    "  --log-level <level>        debug|info|warn|error (default: info)",
    "  --help, -h                 Show help",
    "",
    "Examples:",
    "  splice --source ./archive --out ./out",
    "  splice --source ./archive --out ./out --format markdown",
    '  splice --source ./archive --out ./out --format oai --system-message "You are helpful."',
  ].join("\n");
}

function cleanJsonString(js: string): string {
  // remove window.* = prefix and trailing semicolon
  return js
    .trim()
    .replace(/^window\.[^=]+=\s*/i, "")
    .replace(/;?\s*$/, "");
}

async function readJsonFromJs(filePath: string): Promise<any> {
  const raw = await fs.readFile(filePath, "utf8");
  const cleaned = cleanJsonString(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // try __THAR_CONFIG fallback
    const match = raw.match(/window\.__THAR_CONFIG\s*=\s*({[\s\S]*?})\s*;?/);
    if (match) return JSON.parse(match[1]);
    throw new Error(`Could not parse JSON from ${filePath}`);
  }
}

function mediaTypeFromExt(filename: string): "photo" | "video" | "unknown" {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".mp4" || ext === ".mov") return "video";
  if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".gif")
    return "photo";
  return "unknown";
}

function sanitizeFilename(name: string, maxLen = 50): string {
  return (
    name
      .replace(/[^\w\-_ ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, maxLen) || "untitled"
  );
}

function toIso(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(dt.getTime())
    ? new Date().toISOString()
    : dt.toISOString();
}

function isRetweet(text: string): boolean {
  return /^RT\b/.test(text || "");
}

function formatIsoDateOnly(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
}

/* ------------------------------ twitter ingest --------------------------- */

type Manifest = {
  dataTypes?: Record<string, { files?: Array<{ fileName: string }> }>;
};

async function detectTwitterArchive(rootPath: string): Promise<boolean> {
  try {
    const p = path.join(rootPath, "data", "manifest.js");
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

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

function normalizeTweetLike(
  item: any,
  source: "twitter:tweet" | "twitter:like",
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

async function ingestTwitter(
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
      const data = JSON.parse(cleanJsonString(raw));
      if (!Array.isArray(data)) continue;

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
          createdAt: norm.created_at
            ? toIso(norm.created_at)
            : new Date().toISOString(),
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

/* ----------------------------- transforms/group -------------------------- */

function cleanText(
  text: string,
  entities?: { urls?: Array<{ url: string; expanded_url?: string }> },
): string {
  let t = text ?? "";
  if (entities?.urls) {
    for (const u of entities.urls) {
      if (u.url && u.expanded_url) t = t.split(u.url).join(u.expanded_url);
    }
  }
  t = t.replace(/https:\/\/t\.co\/\w+/g, "");
  t = t.replace(/@\w+/g, "");
  t = t.replace(/#\w+/g, "");
  t = t.replace(/\s+/g, " ");
  return t.trim();
}

function indexById(items: ContentItem[]): Record<string, ContentItem> {
  const m: Record<string, ContentItem> = {};
  for (const it of items) if (it.id) m[it.id] = it;
  return m;
}

function groupThreadsAndConversations(all: Record<string, ContentItem>): {
  threads: Thread[];
  conversations: ContentItem[][];
} {
  const processed = new Set<string>();
  const threads: Thread[] = [];
  const conversations: ContentItem[][] = [];

  const items = Object.values(all);
  for (const item of items) {
    if (processed.has(item.id)) continue;

    const chain: ContentItem[] = [item];
    let current = item;
    while (current.parentId && all[current.parentId]) {
      const parent = all[current.parentId];
      chain.push(parent);
      current = parent;
      if (processed.has(current.id)) break;
    }
    for (const c of chain) processed.add(c.id);

    const allTweets = chain.every((c) => c.source === "twitter:tweet");
    if (allTweets) {
      const ordered = chain.slice().reverse();
      threads.push({ id: ordered[0].id, items: ordered });
    } else {
      conversations.push(chain.slice().reverse());
    }
  }
  return { threads, conversations };
}

function messagesFromConversation(items: ContentItem[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let currentRole: Role | undefined;
  let currentContent: string[] = [];

  function flush() {
    if (!currentRole) return;
    const content = currentContent.join("\n\n").trim();
    if (content) msgs.push({ role: currentRole, content });
    currentContent = [];
  }

  for (const it of items) {
    const role: Role =
      it.raw && "full_text" in (it.raw as any) ? "assistant" : "user";
    const cleaned = cleanText(it.text, (it.raw as any)?.entities);
    if (!cleaned) continue;
    if (role !== currentRole && currentRole) flush();
    currentRole = role;
    currentContent.push(cleaned);
  }
  flush();

  // trim to last assistant
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return msgs.slice(0, i + 1);
  }
  return [];
}

/* --------------------------------- outputs -------------------------------- */

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function copyMedia(
  items: ContentItem[],
  imagesDir: string,
  logger: (l: Level, m: string) => void,
) {
  await ensureDir(imagesDir);
  for (const it of items) {
    for (const m of it.media ?? []) {
      try {
        const base =
          "_" + (m.absPath ? path.basename(m.absPath) : `${m.id}.bin`);
        await fs.copyFile(m.absPath, path.join(imagesDir, base));
      } catch (e) {
        logger(
          "warn",
          `Failed to copy media ${m.absPath}: ${(e as Error).message}`,
        );
      }
    }
  }
}

async function writeMarkdown(
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

  // copy media for all referenced items
  const allItems = threads.flatMap((t) => t.items);
  const threadIds = new Set(allItems.map((i) => i.id));
  const nonThreadTweets = items.filter(
    (i) =>
      i.source === "twitter:tweet" &&
      !i.parentId &&
      !threadIds.has(i.id) &&
      !isRetweet(i.text),
  );
  const copyPool = allItems.concat(nonThreadTweets);

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
      const mediaLinks = (t.media ?? []).map(
        (m) =>
          `![${path.basename(m.absPath)}](../images/_${path.basename(m.absPath)})`,
      );
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
          .map(
            (m) =>
              `![${path.basename(m.absPath)}](../images/_${path.basename(m.absPath)})`,
          )
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

async function writeOAI(
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
    await fh.write(JSON.stringify(record) + "\n", "utf8");
  };

  for (const t of threads) await writeConv(t.items);
  for (const c of conversations) await writeConv(c);
  await fh.close();
  logger("info", `Wrote OAI JSONL to ${outPath}`);
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    process.stderr.write(usage() + "\n");
    process.exit(0);
  }
  const logger = makeLogger(opts.logLevel);

  if (!opts.source || !opts.out) {
    process.stderr.write(usage() + "\n");
    process.exit(2);
  }

  const source = path.resolve(opts.source);
  const outDir = path.resolve(opts.out);

  const detected = await detectTwitterArchive(source);
  if (!detected) {
    logger(
      "error",
      `Could not detect a Twitter archive at ${source} (missing data/manifest.js)`,
    );
    process.exit(2);
  }

  try {
    logger("info", `Ingesting from ${source}`);
    const items = await ingestTwitter(source, logger);
    const all = indexById(items);
    const { threads, conversations } = groupThreadsAndConversations(all);
    logger(
      "info",
      `Threads: ${threads.length}, Conversations: ${conversations.length}`,
    );

    if (opts.format.includes("markdown")) {
      await writeMarkdown(threads, items, outDir, logger, opts.dryRun);
    }
    const systemMessage =
      process.env.SPLICE_SYSTEM_MESSAGE ?? opts.systemMessage;
    logger("debug", `System message: ${systemMessage}`);
    if (opts.format.includes("oai")) {
      await writeOAI(
        threads,
        conversations,
        outDir,
        systemMessage,
        logger,
        opts.dryRun,
      );
    }

    logger("info", opts.dryRun ? "Dry run complete." : "Done.");
    process.exit(0);
  } catch (e) {
    logger("error", (e as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[error] ${(err as Error).message}\n`);
  process.exit(1);
});
