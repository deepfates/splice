/** Direct CLI for the private, rebuildable agent-session search projection. */

import * as path from "node:path";

import {
  rebuildSessionSearchIndex,
  searchSessionIndex,
  SessionSearchBuildError,
} from "../outputs/lync-session-search.js";

export function sessionSearchUsage(): string {
  return [
    "splice session-search — rebuild or query private Codex/Claude session search",
    "",
    "Usage:",
    "  splice session-search rebuild --source <lync-dir> --out <projection-dir>",
    "  splice session-search find --index <projection-dir|index.sqlite3> --query <literal> [--limit <n>]",
    "",
    "The lync tree remains authority. Rebuild publishes an immutable SQLite generation",
    "behind CURRENT. Find performs case-sensitive literal search via FTS5 trigram",
    "candidates and prints JSON hits including source coordinates and resumeArgv.",
    "Queries must contain at least three characters. Success JSON is written to stdout;",
    "machine-readable errors are written to stderr.",
  ].join("\n");
}

function parse(args: string[]): {
  command: "rebuild" | "find";
  source?: string;
  out?: string;
  index?: string;
  query?: string;
  limit?: number;
} {
  const command = args[0];
  if (command !== "rebuild" && command !== "find") throw new Error("expected rebuild or find");
  const result: ReturnType<typeof parse> = { command };
  const allowed = command === "rebuild"
    ? new Set(["--source", "--out"])
    : new Set(["--index", "--query", "--limit"]);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag)) throw new Error(`unknown flag ${flag} for session-search ${command}`);
    const value = args[++i];
    if (value === undefined) throw new Error(`flag ${flag} requires a value`);
    if (flag === "--source") result.source = value;
    else if (flag === "--out") result.out = value;
    else if (flag === "--index") result.index = value;
    else if (flag === "--query") result.query = value;
    else if (flag === "--limit") {
      result.limit = Number(value);
      if (!Number.isInteger(result.limit)) throw new Error("--limit must be an integer");
    }
  }
  if (command === "rebuild" && (!result.source || !result.out)) {
    throw new Error("rebuild requires --source and --out");
  }
  if (command === "find" && (!result.index || result.query === undefined)) {
    throw new Error("find requires --index and --query");
  }
  return result;
}

export async function runSessionSearch(argv: string[]): Promise<never> {
  const args = argv.slice(3);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(sessionSearchUsage() + "\n");
    process.exit(args.length === 0 ? 2 : 0);
  }
  try {
    const opts = parse(args);
    if (opts.command === "rebuild") {
      const result = await rebuildSessionSearchIndex(
        path.resolve(opts.source as string),
        path.resolve(opts.out as string),
        { sqliteBinary: process.env.SPLICE_SQLITE3 },
      );
      process.stdout.write(JSON.stringify({ command: "session-search rebuild", ...result }, null, 2) + "\n");
    } else {
      const hits = await searchSessionIndex(
        path.resolve(opts.index as string),
        opts.query as string,
        { limit: opts.limit, sqliteBinary: process.env.SPLICE_SQLITE3 },
      );
      process.stdout.write(JSON.stringify({
        command: "session-search find",
        index: path.resolve(opts.index as string),
        query: opts.query,
        count: hits.length,
        hits,
      }, null, 2) + "\n");
    }
    process.exit(0);
  } catch (error) {
    const report: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof SessionSearchBuildError) report.manifest = error.manifest;
    process.stderr.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(1);
  }
}
