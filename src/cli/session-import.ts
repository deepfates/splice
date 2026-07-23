/** Direct CLI for deterministic, private Codex and Claude Code session intake. */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isRfc3339 } from "../outputs/lync.js";
import { convertCodexSessionTreeToLync } from "../outputs/lync-codex-session.js";
import { convertClaudeSessionTreeToLync } from "../outputs/lync-claude-session.js";
import type { SessionTreeLyncResult } from "../outputs/lync-session-batch.js";

type SessionImportKind = "codex" | "claude";

interface SessionImportOptions {
  kind: SessionImportKind;
  source: string;
  out: string;
  operator?: string;
  via?: string;
  markedAt?: string;
  userActor?: string;
}

export function sessionImportUsage(): string {
  return [
    "splice session-import — convert private agent-session trees to deterministic lync",
    "",
    "Usage:",
    "  splice session-import codex  --source <sessions-dir> --out <lync-dir> [options]",
    "  splice session-import claude --source <projects-dir> --out <lync-dir> [options]",
    "",
    "Options:",
    "  --source <dir>           Root shaped like ~/.codex/sessions or ~/.claude/projects",
    "  --out <dir>              Separate private output tree (directories 0700, files 0600)",
    "  --operator <name>        Operator recorded on imported events (default: deepfates)",
    "  --user-actor <name>      Actor recorded on user-authored events (default: deepfates)",
    "  --via <tool@version>     Override source tool provenance on every event",
    "  --marked-at <rfc3339>    Opt-in import timestamp; omitting keeps reruns byte-identical",
    "  --help, -h               Show this help",
    "",
    "The source and output trees must not overlap. Every discovered JSONL file is",
    "converted or named unreadable; every non-JSONL file is named ignored. The command",
    "prints the complete accounting report as JSON. Any unreadable source file makes the",
    "command fail after reporting the partial result. Raw session JSONL remains authority.",
  ].join("\n");
}

function parse(args: string[]): SessionImportOptions {
  const kind = args[0];
  if (kind !== "codex" && kind !== "claude") {
    throw new Error("expected importer kind codex or claude");
  }

  const values: Record<string, string> = {};
  const allowed = new Set([
    "--source",
    "--out",
    "--operator",
    "--user-actor",
    "--via",
    "--marked-at",
  ]);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag)) {
      throw new Error(`unknown flag ${flag} for session-import ${kind}`);
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`flag ${flag} requires a value`);
    }
    values[flag] = value;
  }
  if (!values["--source"] || !values["--out"]) {
    throw new Error(`session-import ${kind} requires --source and --out`);
  }
  if (values["--marked-at"] && !isRfc3339(values["--marked-at"])) {
    throw new Error(`--marked-at must be RFC 3339 (got ${JSON.stringify(values["--marked-at"])})`);
  }
  return {
    kind,
    source: path.resolve(values["--source"]),
    out: path.resolve(values["--out"]),
    operator: values["--operator"],
    userActor: values["--user-actor"],
    via: values["--via"],
    markedAt: values["--marked-at"],
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function validateTrees(source: string, out: string): Promise<void> {
  const stat = await fs.stat(source);
  if (!stat.isDirectory()) throw new Error(`session source is not a directory: ${source}`);

  // realpath the source so a symlink cannot disguise output-inside-source.
  const realSource = await fs.realpath(source);
  let realOut = out;
  try {
    realOut = await fs.realpath(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Resolve the nearest existing ancestor, then append the missing suffix.
    const missing: string[] = [];
    let cursor = out;
    for (;;) {
      try {
        const ancestor = await fs.realpath(cursor);
        realOut = path.join(ancestor, ...missing.reverse());
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw ancestorError;
        missing.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }
  if (isWithin(realSource, realOut) || isWithin(realOut, realSource)) {
    throw new Error("session source and output trees must not overlap");
  }
}

async function writeJson(stream: NodeJS.WriteStream, value: unknown): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.write(`${JSON.stringify(value, null, 2)}\n`, () => resolve());
  });
}

export async function runSessionImport(argv: string[]): Promise<never> {
  const args = argv.slice(3);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(sessionImportUsage() + "\n");
    process.exit(args.length === 0 ? 2 : 0);
  }

  try {
    const opts = parse(args);
    await validateTrees(opts.source, opts.out);
    const converterOptions = {
      operator: opts.operator,
      userActor: opts.userActor,
      via: opts.via,
      markedAt: opts.markedAt,
    };
    const result: SessionTreeLyncResult = opts.kind === "codex"
      ? await convertCodexSessionTreeToLync(opts.source, opts.out, converterOptions)
      : await convertClaudeSessionTreeToLync(opts.source, opts.out, converterOptions);
    const report = { command: `session-import ${opts.kind}`, ...result };
    await writeJson(process.stdout, report);
    if (result.filesUnreadable.length > 0) {
      await writeJson(process.stderr, {
        error: `${result.filesUnreadable.length} session file(s) were unreadable`,
        filesUnreadable: result.filesUnreadable,
      });
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    await writeJson(process.stderr, {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
