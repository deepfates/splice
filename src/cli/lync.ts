/**
 * splice lync — archive → lync CLI commands.
 *
 * Wires the lync converter library (src/outputs/lync*.ts) to the shell so a
 * human can run archive→lync without writing code:
 *
 *   splice lync archive      Twitter archive dir or Bluesky .car → .lync
 *   splice lync glowfic      glowfic-dl JSON export (thread.json) → .lync
 *   splice lync ocr          OCR page-set directory → .lync
 *   splice lync tweet-embed  tweet embed cache directory → .lync
 *
 * The queued exporters (training, markdown, sessions) slot in as sibling
 * subcommands here once their modules land on main.
 *
 * Converter modules are imported by DIRECT path (never via src/index.ts) so
 * this file does not collide with pending export-block changes.
 *
 * ZERO SILENT DROPS made visible: every command prints its full stats block —
 * emitted/skipped counts WITH per-record reasons, timestamp fallbacks, verify
 * counts — as JSON to stdout. Logs stay on stderr so stdout pipes cleanly.
 * Unknown flags are hard errors (exit 2), not warnings: a typoed flag that is
 * silently ignored would be a silent drop.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { makeLogger, type Level } from "../core/types.js";
import { detectTwitterArchive, ingestTwitter } from "../sources/twitter.js";
import { detectBlueskyCar, ingestBlueskyCar } from "../sources/bluesky.js";
import {
  contentItemsToLyncEvents,
  glowficExportToLyncEvents,
  writeLyncFile,
  verifyLyncFile,
  isRfc3339,
  type GlowficExportThread,
  type LyncProducerOptions,
  type LyncVerifyResult,
} from "../outputs/lync.js";
import {
  scanOcrPageDir,
  ocrPageSetToLyncEvents,
} from "../outputs/lync-ocr.js";
import {
  tweetEmbedCacheToLyncEvents,
  type TweetEmbedCacheFile,
  type TweetEmbedSkippedFile,
  type TweetEmbedStats,
} from "../outputs/lync-tweet-embed.js";

/* --------------------------------- Types ---------------------------------- */

const LYNC_COMMANDS = ["archive", "glowfic", "ocr", "tweet-embed"] as const;
type LyncCommand = (typeof LYNC_COMMANDS)[number];

interface LyncCliOptions {
  help: boolean;
  dryRun: boolean;
  logLevel: Level;
  source?: string;
  out?: string;
  operator?: string;
  via?: string;
  sourceRef?: string;
  markedAt?: string;
  actor?: string;
  setLocator?: string;
  archiveIdsFile?: string;
}

/** What every command prints to stdout: the stats block, nothing hidden. */
interface LyncCliReport {
  command: string;
  source: string;
  out: string;
  dryRun: boolean;
  /** Converter stats: emitted/skipped counts with per-record reasons. */
  stats: unknown;
  /** @deepfates/lync re-parse of the written file. Absent on --dry-run. */
  verify?: LyncVerifyResult;
  [key: string]: unknown;
}

/* --------------------------------- Usage ---------------------------------- */

export function lyncUsage(): string {
  return [
    "splice lync — convert archives to lync event files (.lync)",
    "",
    "Usage:",
    "  splice lync <command> --source <path> --out <file.lync> [options]",
    "",
    "Commands:",
    "  archive        Twitter archive directory or Bluesky .car file → .lync",
    "  glowfic        glowfic-dl JSON export (thread.json) → .lync",
    "  ocr            OCR page-set directory (page-NNN.txt, page-NNN.desc.txt, *.md) → .lync",
    "  tweet-embed    tweet embed cache directory (<tweetid>-light.json oEmbed files) → .lync",
    "",
    "Options:",
    "  --source <path>            Input path (directory or file, per command)",
    "  --out <file>               Output .lync file path",
    "  --operator <name>          author.operator on every event (default: deepfates)",
    "  --via <tool@version>       author.via override (default: per command)",
    "  --source-ref <ref>         author.source prefix (default: the --source path)",
    "  --marked-at <rfc3339>      Record import time as `marked`. Opt-in: omitting keeps",
    "                             re-runs byte-identical so lync unions them as duplicates",
    "  --actor <name>             Override author.actor on every event (archive, ocr)",
    "  --set-locator <name>       Stable page-set identity for event ids (ocr; default: dir basename)",
    "  --archive-ids-file <path>  Tweet ids known to the canonical archive import, JSON array",
    "                             or one id per line; matching embeds parent to the archive",
    "                             tweet events (tweet-embed)",
    "  --dry-run, -n              Map and report stats; don't write the .lync file",
    "  --log-level <level>        debug|info|warn|error (default: info)",
    "  --quiet, -q                Errors only",
    "  --verbose                  Debug logging",
    "  --help, -h                 Show this help",
    "",
    "Output:",
    "  The .lync file is written to --out, then re-verified with @deepfates/lync (every line",
    "  must classify `accepted`). The full stats block — emitted/skipped counts with",
    "  per-record reasons, timestamp fallbacks, verify counts — prints to stdout as JSON;",
    "  logs stay on stderr. Nothing is dropped silently.",
    "",
    "Examples:",
    "  splice lync archive --source ~/Downloads/my-twitter-archive --out ./out/twitter.lync",
    "  splice lync archive --source ~/Downloads/my-bsky-repo.car --out ./out/bluesky.lync",
    "  splice lync glowfic --source ./thread.json --out ./out/thread-5506.lync",
    "  splice lync ocr --source ../deep-space/data/signal-ocr --out ./out/signal-ocr.lync",
    "  splice lync tweet-embed --source ../deep-space/.embed-cache/tweets --out ./out/embeds.lync",
    "",
    "Docs: https://github.com/deepfates/splice • lync format: lync FORMAT.md",
  ].join("\n");
}

/* ---------------------------------- Args ----------------------------------- */

/** Flags every lync command accepts. */
const COMMON_FLAGS = new Set([
  "--source",
  "--archive-path",
  "--out",
  "--operator",
  "--via",
  "--source-ref",
  "--marked-at",
  "--dry-run",
  "-n",
  "--log-level",
  "--quiet",
  "-q",
  "--verbose",
  "--help",
  "-h",
]);

/** Extra flags per command; anything else is a hard error, never ignored. */
const COMMAND_FLAGS: Record<LyncCommand, Set<string>> = {
  archive: new Set(["--actor"]),
  glowfic: new Set(),
  ocr: new Set(["--actor", "--set-locator"]),
  "tweet-embed": new Set(["--archive-ids-file"]),
};

function parseLyncArgs(
  command: LyncCommand,
  args: string[],
  usageError: (msg: string) => never,
): LyncCliOptions {
  const opts: LyncCliOptions = {
    help: false,
    dryRun: false,
    logLevel: "info",
  };
  let logLevelExplicit = false;
  let wantsQuiet = false;
  let wantsVerbose = false;

  const allowed = new Set([...COMMON_FLAGS, ...COMMAND_FLAGS[command]]);
  const takeValue = (flag: string, i: number): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("-")) {
      usageError(`Flag ${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") && !allowed.has(a)) {
      usageError(`Unknown flag ${a} for \`splice lync ${command}\``);
    }
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--source" || a === "--archive-path") {
      opts.source = takeValue(a, i++);
    } else if (a === "--out") {
      opts.out = takeValue(a, i++);
    } else if (a === "--operator") {
      opts.operator = takeValue(a, i++);
    } else if (a === "--via") {
      opts.via = takeValue(a, i++);
    } else if (a === "--source-ref") {
      opts.sourceRef = takeValue(a, i++);
    } else if (a === "--marked-at") {
      opts.markedAt = takeValue(a, i++);
    } else if (a === "--actor") {
      opts.actor = takeValue(a, i++);
    } else if (a === "--set-locator") {
      opts.setLocator = takeValue(a, i++);
    } else if (a === "--archive-ids-file") {
      opts.archiveIdsFile = takeValue(a, i++);
    } else if (a === "--dry-run" || a === "-n") {
      opts.dryRun = true;
    } else if (a === "--log-level") {
      const lvl = takeValue(a, i++).toLowerCase();
      if (
        lvl === "debug" ||
        lvl === "info" ||
        lvl === "warn" ||
        lvl === "error"
      ) {
        opts.logLevel = lvl;
        logLevelExplicit = true;
      } else {
        usageError(`Invalid --log-level ${lvl} (debug|info|warn|error)`);
      }
    } else if (a === "--quiet" || a === "-q") {
      wantsQuiet = true;
    } else if (a === "--verbose") {
      wantsVerbose = true;
    } else if (!a.startsWith("-")) {
      usageError(`Unexpected argument "${a}"`);
    }
  }

  if (!logLevelExplicit) {
    if (wantsQuiet) opts.logLevel = "error";
    else if (wantsVerbose) opts.logLevel = "debug";
  }

  if (opts.help) return opts;

  if (!opts.source) usageError(`\`splice lync ${command}\` requires --source`);
  if (!opts.out) usageError(`\`splice lync ${command}\` requires --out`);
  if (opts.markedAt !== undefined && !isRfc3339(opts.markedAt)) {
    usageError(`--marked-at must be RFC 3339 (got "${opts.markedAt}")`);
  }

  return opts;
}

/* ------------------------------ Write + verify ----------------------------- */

type Logger = (lvl: Level, msg: string) => void;

/**
 * Write events and re-verify the file with @deepfates/lync, loudly: any
 * non-accepted line or count drift is a thrown error, never a shrug.
 */
async function writeAndVerify(
  outPath: string,
  events: Parameters<typeof writeLyncFile>[1],
  logger: Logger,
): Promise<LyncVerifyResult> {
  await writeLyncFile(outPath, events);
  logger("info", `Wrote ${events.length} event(s) to ${outPath}`);
  const verify = await verifyLyncFile(outPath);
  if (!verify.ok) {
    throw new Error(
      `lync verify failed for ${outPath}: ${JSON.stringify(verify.problems)}`,
    );
  }
  if (verify.counts.accepted !== events.length) {
    throw new Error(
      `lync verify count mismatch for ${outPath}: wrote ${events.length}, accepted ${verify.counts.accepted}`,
    );
  }
  logger("info", `Verified ${outPath}: ${verify.counts.accepted} line(s) accepted`);
  return verify;
}

/* -------------------------------- Commands --------------------------------- */

async function runArchive(
  opts: LyncCliOptions,
  logger: Logger,
): Promise<LyncCliReport> {
  const source = path.resolve(opts.source as string);
  const out = path.resolve(opts.out as string);

  const adapters = [
    { kind: "twitter", detect: detectTwitterArchive, ingest: ingestTwitter },
    { kind: "bluesky", detect: detectBlueskyCar, ingest: ingestBlueskyCar },
  ] as const;
  let selected: (typeof adapters)[number] | null = null;
  for (const adapter of adapters) {
    // eslint-disable-next-line no-await-in-loop
    const matches = await adapter.detect(source);
    if (matches) {
      selected = adapter;
      break;
    }
  }
  if (!selected) {
    throw new Error(
      `Could not detect a supported archive at ${source} (expected Twitter directory or Bluesky .car file)`,
    );
  }
  logger("info", `Detected source: ${selected.kind}`);

  logger("info", `Ingesting ${selected.kind} data from ${source}`);
  const items = await selected.ingest(source, logger);
  logger("info", `Ingested ${items.length} item(s)`);

  const producer: LyncProducerOptions = {
    importer: `${selected.kind}-archive`,
    sourceRef: opts.sourceRef ?? source,
    via: opts.via ?? `${selected.kind}-archive@unknown`,
    operator: opts.operator,
    markedAt: opts.markedAt,
    actor: opts.actor,
  };
  const mapped = contentItemsToLyncEvents(items, producer);

  const report: LyncCliReport = {
    command: "lync archive",
    source,
    out,
    dryRun: opts.dryRun,
    detected: selected.kind,
    stats: mapped.stats,
  };
  if (opts.dryRun) {
    logger("info", `(dry-run) would write ${mapped.events.length} event(s) to ${out}`);
    return report;
  }
  report.verify = await writeAndVerify(out, mapped.events, logger);
  return report;
}

async function runGlowfic(
  opts: LyncCliOptions,
  logger: Logger,
): Promise<LyncCliReport> {
  const source = path.resolve(opts.source as string);
  const out = path.resolve(opts.out as string);

  logger("info", `Reading glowfic export ${source}`);
  const raw = await fs.readFile(source, "utf8");
  const thread = JSON.parse(raw) as GlowficExportThread;
  const mapped = glowficExportToLyncEvents(thread, {
    sourceRef: opts.sourceRef ?? source,
    via: opts.via,
    operator: opts.operator,
    markedAt: opts.markedAt,
  });

  const report: LyncCliReport = {
    command: "lync glowfic",
    source,
    out,
    dryRun: opts.dryRun,
    threadEventId: mapped.threadEventId,
    stats: mapped.stats,
  };
  if (opts.dryRun) {
    logger("info", `(dry-run) would write ${mapped.events.length} event(s) to ${out}`);
    return report;
  }
  report.verify = await writeAndVerify(out, mapped.events, logger);
  return report;
}

async function runOcr(
  opts: LyncCliOptions,
  logger: Logger,
): Promise<LyncCliReport> {
  const source = path.resolve(opts.source as string);
  const out = path.resolve(opts.out as string);

  logger("info", `Scanning OCR page set ${source}`);
  const scan = await scanOcrPageDir(source);
  logger(
    "info",
    `Scanned ${scan.sourceFiles} file(s): ${scan.pages.length} page(s), ${scan.documents.length} document(s), ${scan.skipped.length} skipped`,
  );
  const mapped = ocrPageSetToLyncEvents(scan, {
    setLocator: opts.setLocator,
    actor: opts.actor,
    sourceRef: opts.sourceRef,
    via: opts.via,
    operator: opts.operator,
    markedAt: opts.markedAt,
  });

  const report: LyncCliReport = {
    command: "lync ocr",
    source,
    out,
    dryRun: opts.dryRun,
    setEventId: mapped.setEventId,
    stats: mapped.stats,
  };
  if (opts.dryRun) {
    logger("info", `(dry-run) would write ${mapped.events.length} event(s) to ${out}`);
    return report;
  }
  report.verify = await writeAndVerify(out, mapped.events, logger);
  return report;
}

/** Ids file for tweet-embed matching: JSON string array or one id per line. */
async function loadArchiveIds(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j.filter((x) => typeof x === "string");
  } catch {
    // not JSON; fall through to newline-separated
  }
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runTweetEmbed(
  opts: LyncCliOptions,
  logger: Logger,
): Promise<LyncCliReport> {
  const source = path.resolve(opts.source as string);
  const out = path.resolve(opts.out as string);

  let archiveTweetIds: string[] | undefined;
  if (opts.archiveIdsFile) {
    archiveTweetIds = await loadArchiveIds(opts.archiveIdsFile);
    logger(
      "info",
      `Loaded ${archiveTweetIds.length} archive tweet id(s) from ${opts.archiveIdsFile}`,
    );
  }

  // Same read discipline as convertTweetEmbedCacheToLync: READ ONLY, and an
  // unreadable file is an explicit skip, not a crash. Reading here (instead of
  // calling the convert wire) lets --dry-run map without writing.
  logger("info", `Reading tweet embed cache ${source}`);
  const names = (await fs.readdir(source))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const files: TweetEmbedCacheFile[] = [];
  const unreadable: TweetEmbedSkippedFile[] = [];
  for (const file of names) {
    try {
      files.push({
        file,
        text: await fs.readFile(path.join(source, file), "utf8"),
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
    sourceRef: opts.sourceRef ?? source,
    via: opts.via,
    operator: opts.operator,
    markedAt: opts.markedAt,
    archiveTweetIds,
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

  const report: LyncCliReport = {
    command: "lync tweet-embed",
    source,
    out,
    dryRun: opts.dryRun,
    stats,
  };
  if (opts.dryRun) {
    logger("info", `(dry-run) would write ${mapped.events.length} event(s) to ${out}`);
    return report;
  }
  report.verify = await writeAndVerify(out, mapped.events, logger);
  return report;
}

/* ---------------------------------- Main ----------------------------------- */

/**
 * Entry point for `splice lync ...`. Always exits the process:
 * 0 success, 1 runtime error, 2 usage error.
 */
export async function runLync(argv: string[]): Promise<never> {
  // argv: [node, splice, "lync", <command>, ...flags]
  const rest = argv.slice(3);
  const first = rest[0];

  if (first === undefined || first === "--help" || first === "-h") {
    process.stderr.write(lyncUsage() + "\n");
    process.exit(first === undefined ? 2 : 0);
  }
  if (!LYNC_COMMANDS.includes(first as LyncCommand)) {
    process.stderr.write(
      `[error] Unknown lync command "${first}". Commands: ${LYNC_COMMANDS.join(", ")}\n`,
    );
    process.stderr.write(lyncUsage() + "\n");
    process.exit(2);
  }
  const command = first as LyncCommand;

  const usageError = (msg: string): never => {
    process.stderr.write(`[error] ${msg}\n`);
    process.stderr.write(lyncUsage() + "\n");
    process.exit(2);
  };
  const opts = parseLyncArgs(command, rest.slice(1), usageError);
  if (opts.help) {
    process.stderr.write(lyncUsage() + "\n");
    process.exit(0);
  }

  const logger = makeLogger(opts.logLevel);
  try {
    let report: LyncCliReport;
    if (command === "archive") report = await runArchive(opts, logger);
    else if (command === "glowfic") report = await runGlowfic(opts, logger);
    else if (command === "ocr") report = await runOcr(opts, logger);
    else report = await runTweetEmbed(opts, logger);

    // The stats block IS the contract: full counts and reasons to stdout.
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    logger("info", opts.dryRun ? "Dry run complete." : "Done.");
    process.exit(0);
  } catch (e) {
    logger("error", (e as Error).message);
    process.exit(1);
  }
}
