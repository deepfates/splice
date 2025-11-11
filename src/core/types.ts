/**
 * Core types, CLI args, logger, and shared utilities.
 * Extracted to support a modular pipeline architecture.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/* --------------------------------- Types --------------------------------- */

export type Level = "debug" | "info" | "warn" | "error";

export type SourceId =
  | "twitter:tweet"
  | "twitter:like"
  | "glowfic:post"
  | string;

export interface MediaAttachment {
  id: string;
  contentType: "photo" | "video" | "unknown";
  absPath?: string; // local absolute path if available
  url?: string; // remote URL if available
  metadata?: Record<string, unknown>;
}

export interface ContentItem {
  id: string;
  text: string;
  createdAt: string; // ISO-8601
  parentId?: string | null;
  inReplyToUserId?: string | null; // Twitter user ID this is replying to
  accountId?: string | null; // Account owner's user ID (for filtering self-threads)
  source: SourceId;
  raw?: Record<string, unknown>;
  media?: MediaAttachment[];
  annotations?: Record<string, unknown>;
}

export interface Thread {
  id: string;
  items: ContentItem[]; // ordered oldest → newest
}

export type Role = "assistant" | "user";

export interface ChatMessage {
  role: Role;
  content: string;
}

/* -------------------------------- Logger --------------------------------- */

export function makeLogger(level: Level): (lvl: Level, msg: string) => void {
  const order: Level[] = ["debug", "info", "warn", "error"];
  const minIdx = order.indexOf(level);
  return (lvl: Level, msg: string) => {
    if (order.indexOf(lvl) >= minIdx) {
      process.stderr.write(`[${lvl}] ${msg}\n`);
    }
  };
}

/* --------------------------------- Args ---------------------------------- */

export type CLIOptions = {
  source?: string;
  out?: string;
  workspace?: string;
  checkpoint?: string;
  format: string[]; // e.g. ['markdown','oai']
  systemMessage: string;
  dryRun: boolean;
  logLevel: Level;
  help: boolean;
  version: boolean;
  // filters
  since?: string;
  until?: string;
  minLength: number;
  excludeRt: boolean;
  onlyThreads: boolean;
  withMedia: boolean;
  // decisions
  decisionsImport?: string;
  setStatus?: string;
  ids?: string[];
  idsFile?: string;
  // outputs
  statsJson: boolean;
  // bluesky enrichment
  enrich: boolean;
  // glowfic
  glowfic?: string[]; // one or more Glowfic URLs (thread/section/board)
  assistant?: string; // case-insensitive match on character display name/handle/author
  assistantRegex?: string; // regex (JS) on display name/handle/author
};

export const DEFAULT_SYSTEM_MESSAGE = "You have been uploaded to the internet";

export function parseArgs(argv: string[]): CLIOptions {
  const opts: CLIOptions = {
    format: ["markdown", "oai", "json"],
    systemMessage: DEFAULT_SYSTEM_MESSAGE,
    dryRun: false,
    logLevel: "info",
    help: false,
    version: false,
    since: undefined,
    until: undefined,
    minLength: 0,
    excludeRt: false,
    onlyThreads: false,
    withMedia: false,
    // decisions
    decisionsImport: undefined,
    setStatus: undefined,
    ids: [],
    idsFile: undefined,
    // outputs
    statsJson: false,
    workspace: undefined,
    checkpoint: undefined,
    // bluesky enrichment
    enrich: false,
    // glowfic
    glowfic: [],
    assistant: undefined,
    assistantRegex: undefined,
  };

  const args = argv.slice(2);
  let systemExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--version" || a === "-V") {
      opts.version = true;
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
    } else if (a === "--since") {
      opts.since = args[++i];
    } else if (a === "--until") {
      opts.until = args[++i];
    } else if (a === "--min-length") {
      const v = parseInt(args[++i] ?? "", 10);
      if (!Number.isNaN(v)) opts.minLength = v;
    } else if (a === "--exclude-rt") {
      opts.excludeRt = true;
    } else if (a === "--only-threads") {
      opts.onlyThreads = true;
    } else if (a === "--with-media") {
      opts.withMedia = true;
    } else if (
      a === "--glowfic" ||
      a === "--glowfic-url" ||
      a === "--glowfic-urls"
    ) {
      const next = args[++i];
      if (next) {
        const parts = next.split(",").filter(Boolean);
        if (parts.length > 1) opts.glowfic = parts;
        else {
          const list = [next];
          while (args[i + 1] && !args[i + 1].startsWith("-")) {
            list.push(args[++i]);
          }
          opts.glowfic = list;
        }
      }
    } else if (a === "--assistant") {
      opts.assistant = args[++i];
    } else if (a === "--assistant-regex" || a === "--assistant-re") {
      opts.assistantRegex = args[++i];
    } else if (a === "--stats-json") {
      opts.statsJson = true;
    } else if (a === "--enrich") {
      opts.enrich = true;
    } else if (a === "--decisions-import" || a === "--decisions-file") {
      opts.decisionsImport = args[++i];
    } else if (a === "--set-status" || a === "--status") {
      opts.setStatus = args[++i];
    } else if (a === "--ids") {
      const next = args[++i];
      if (next) {
        const parts = next.split(",").filter(Boolean);
        if (parts.length > 1) opts.ids = parts;
        else {
          const list = [next];
          while (args[i + 1] && !args[i + 1].startsWith("-")) {
            list.push(args[++i]);
          }
          opts.ids = list;
        }
      }
    } else if (a === "--ids-file") {
      opts.idsFile = args[++i];
    } else if (a === "--") {
      break;
    } else if (a.startsWith("-")) {
      // unknown flag; ignore to keep simple (CLI will warn elsewhere)
    } else {
      // positional? ignore for now
    }
  }
  if (!systemExplicit && process.env.SPLICE_SYSTEM_MESSAGE) {
    opts.systemMessage = process.env.SPLICE_SYSTEM_MESSAGE as string;
  }
  return opts;
}

export function usage(): string {
  return [
    "splice — convert a Twitter archive or Glowfic URLs to Markdown, OAI JSONL, and/or JSON",
    "",
    "Usage:",
    "  splice --source <path> --out <dir> [--format markdown oai json sharegpt] [--system-message <text>]",
    "         [--since <iso>] [--until <iso>] [--min-length <n>] [--exclude-rt] [--only-threads] [--with-media]",
    "         [--dry-run] [--stats-json] [--log-level <level>] [--json-stdout] [--quiet|-q] [--verbose] [--version|-V] [--decisions-import <path>] [--set-status <status> --ids <...>|--ids-file <path>]",
    "",
    "Options:",
    "  --source <path>            Path to the Twitter archive directory",
    "  --out <dir>                Output directory",
    "  --format <fmt...>          One or more formats: markdown, oai, json, sharegpt (default: markdown oai)",
    '  --system, --system-message <text>    System message for OAI JSONL (default: "You have been uploaded to the internet")',
    "  --since <iso>              Include items on/after this ISO date",
    "  --until <iso>              Include items on/before this ISO date",
    "  --min-length <n>           Minimum text length",
    "  --exclude-rt               Exclude retweets (RT ...)",
    "  --only-threads             Output threads only (ignore conversations/non-thread tweets)",
    "  --with-media               Only include items that have media",
    "  --dry-run, -n              Plan only; don’t write files",
    "  --stats-json               Write a stats.json summary",
    "  --log-level <level>        debug|info|warn|error (default: info)",
    "  --json-stdout              Emit normalized items JSONL to stdout (no files); logs to stderr",
    "  --quiet, -q                Errors only",
    "  --verbose                  Debug logging",
    "  --version, -V              Show version",
    "  --help, -h                 Show help",
    "  --glowfic <url...>         One or more Glowfic URLs (thread, section, or board)",
    "  --assistant <text>         Assistant selector (case-insensitive match on character display name, handle, or author)",
    "  --assistant-regex <re>     Assistant selector regex (JavaScript), tested on display name, handle, or author",
    "",
    "Examples:",
    "  splice --source ./archive --out ./out --format markdown oai json",
    '  splice --source ./archive --out ./out --format oai --system-message "You are helpful."',
    "  splice --source ./archive --out ./out --since 2024-01-01 --only-threads",
    "  splice --source ./archive --out ./out --json-stdout",
    "  splice --version",
    "  splice --glowfic https://glowfic.com/posts/5506 --out ./out --format oai --assistant carissa",
    '  splice --glowfic https://glowfic.com/boards/215 --out ./out --format oai --assistant-regex "carissa"',
    "",
    "Docs: https://github.com/deepfates/splice • Context: https://deepfates.com/convert-your-twitter-archive-into-training-data",
  ].join("\n");
}

/* --------------------------------- Utils --------------------------------- */

export function cleanJsonString(js: string): string {
  // remove window.* = prefix and trailing semicolon
  return js
    .trim()
    .replace(/^window\.[^=]+=\s*/i, "")
    .replace(/;?\s*$/, "");
}

export async function readJsonFromJs(filePath: string): Promise<any> {
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

/**
 * Accepts strict JSON arrays or loose JS array/object literals.
 * Returns [] on failure.
 */
export function parseLooseArray(input: string): any[] {
  // Try strict JSON first
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Fall through to loose JS evaluation
  }

  // Attempt to evaluate as a JS array/object literal in a confined context.
  // cleanJsonString should have removed any "window.* = " prefix so input should be an array expression.
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('"use strict"; return (' + input + ");");
    const result = fn();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function loadConfig(): Promise<any | undefined> {
  try {
    const mod: any = await import("cosmiconfig");
    const explorer = mod.cosmiconfig("splice");
    const result = await explorer.search();
    return result?.config;
  } catch {
    return undefined;
  }
}

export function mediaTypeFromExt(
  filename: string,
): "photo" | "video" | "unknown" {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".mp4" || ext === ".mov") return "video";
  if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".gif")
    return "photo";
  return "unknown";
}

export function sanitizeFilename(name: string, maxLen = 50): string {
  return (
    name
      .replace(/[^\w\-_ ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, maxLen) || "untitled"
  );
}

export function toIso(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(dt.getTime())
    ? new Date().toISOString()
    : dt.toISOString();
}

export function isRetweet(text: string): boolean {
  return /^RT\b/.test(text || "");
}

export function formatIsoDateOnly(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
}
