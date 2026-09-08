import * as path from "node:path";

import { makeLogger, type Level } from "../core/types.js";
import { ingestTwitterPublicWriting } from "../sources/twitter-public-writing.js";
import { writeTwitterPublicMarkdown } from "../outputs/twitter-public-markdown.js";

interface Options {
  source?: string;
  out?: string;
  includeDeleted: boolean;
  copyMedia: boolean;
  dryRun: boolean;
  help: boolean;
  logLevel: Level;
}

export function twitterMarkdownUsage(): string {
  return [
    "splice twitter-markdown — export public authored Twitter/X writing as portable, Obsidian-ready Markdown",
    "",
    "Usage:",
    "  splice twitter-markdown --source <extracted-archive-dir> --out <new-directory> [options]",
    "",
    "Scope:",
    "  Includes authored tweets, community tweets, published articles, and nonempty Note Tweets.",
    "  Excludes retweets and standalone likes; liked-post text only recovers missing reply context.",
    "  Excludes DMs, Grok chats, drafts, and account metadata.",
    "",
    "Options:",
    "  --include-deleted       Include the archive's recent deleted-tweet records",
    "  --no-media              Omit archived local-media embeds and skip copying files",
    "  --dry-run, -n           Parse and reconcile without writing the export",
    "  --log-level <level>     debug|info|warn|error (default: info)",
    "  --quiet, -q             Errors only",
    "  --verbose               Debug logging",
    "  --help, -h              Show help",
    "",
    "The output directory must not already exist. Splice writes to a sibling partial directory",
    "and renames it into place only after notes, media, README, and export-report.json succeed.",
  ].join("\n");
}

function parse(argv: string[]): Options {
  const options: Options = {
    includeDeleted: false,
    copyMedia: true,
    dryRun: false,
    help: false,
    logLevel: "info",
  };
  const args = argv.slice(3);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = () => {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${flag} requires a value`);
      index += 1;
      return next;
    };
    if (flag === "--source" || flag === "--archive-path") options.source = value();
    else if (flag === "--out" || flag === "--output-dir") options.out = value();
    else if (flag === "--include-deleted") options.includeDeleted = true;
    else if (flag === "--no-media") options.copyMedia = false;
    else if (flag === "--dry-run" || flag === "-n") options.dryRun = true;
    else if (flag === "--quiet" || flag === "-q") options.logLevel = "error";
    else if (flag === "--verbose") options.logLevel = "debug";
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--log-level") {
      const level = value();
      if (!(["debug", "info", "warn", "error"] as string[]).includes(level)) {
        throw new Error(`invalid log level: ${level}`);
      }
      options.logLevel = level as Level;
    } else {
      throw new Error(`unknown flag for twitter-markdown: ${flag}`);
    }
  }
  return options;
}

export async function runTwitterMarkdown(argv: string[]): Promise<void> {
  let options: Options;
  try {
    options = parse(argv);
  } catch (error) {
    process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`${twitterMarkdownUsage()}\n`);
    process.exit(2);
    return;
  }
  if (options.help) {
    process.stderr.write(`${twitterMarkdownUsage()}\n`);
    process.exit(0);
  }
  if (!options.source || !options.out) {
    process.stderr.write(`${twitterMarkdownUsage()}\n`);
    process.exit(2);
  }
  const source = path.resolve(options.source);
  const out = path.resolve(options.out);
  const logger = makeLogger(options.logLevel);
  try {
    const result = await ingestTwitterPublicWriting(source, logger, {
      includeDeleted: options.includeDeleted,
    });
    const report = await writeTwitterPublicMarkdown(result, out, logger, {
      copyMedia: options.copyMedia,
      dryRun: options.dryRun,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    logger("error", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
