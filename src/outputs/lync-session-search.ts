/**
 * Rebuildable private search projection for Splice-produced agent-session
 * `.lync` files.
 *
 * The lync files remain authority. This module projects only human/assistant
 * message text into SQLite FTS5; system/developer prompts, reasoning, tool
 * calls/results, and sidecar records are deliberately not copied into the
 * index. Every source event is accounted as searchable, non-searchable, or an
 * explicit error. Source paths stored in the projection are root-relative.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export const SESSION_SEARCH_SCHEMA = "splice-session-search/v1";

type JsonRecord = Record<string, unknown>;

export interface SessionSearchError {
  source: string;
  line: number | null;
  reason: string;
}

export interface SessionSearchManifest {
  schema: typeof SESSION_SEARCH_SCHEMA;
  authority: "lync";
  privacy: "human-and-assistant-message-text-only";
  files: { discovered: number; indexed: number; failed: number };
  events: {
    seen: number;
    searchable: number;
    nonSearchable: number;
    nonSearchableByReason: Record<string, number>;
    errors: number;
  };
  messages: number;
  errors: SessionSearchError[];
}

export interface SessionSearchBuildResult {
  indexPath: string;
  manifestPath: string;
  manifest: SessionSearchManifest;
}

export interface SessionSearchHit {
  source: string;
  line: number;
  eventId: string;
  segment: number;
  platform: "codex" | "claude";
  sessionId: string;
  role: "user" | "assistant";
  kind: string;
  at: string;
  text: string;
  /** Argument vector, safe to pass directly to spawn/execFile. */
  resumeArgv: string[];
}

interface SearchableSegment extends SessionSearchHit {}

function asObject(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  const parts: string[] = [];
  for (const item of value) {
    const block = asObject(item);
    if (!block) continue;
    // Explicit allowlist: never index thinking, tool_use, or tool_result.
    if (!["text", "input_text", "output_text"].includes(String(block["type"]))) {
      continue;
    }
    if (typeof block["text"] === "string" && block["text"].length > 0) {
      parts.push(block["text"]);
    }
  }
  return parts;
}

function sessionIdFromLocator(source: string): string | null {
  const name = path.posix.basename(source).replace(/\.lync$/, "");
  const match = name.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i,
  );
  return match?.[1] ?? null;
}

function eventSource(payload: JsonRecord): { source: string; line: number } | null {
  const source = asObject(payload["source"]);
  if (!source || typeof source["path"] !== "string") return null;
  if (typeof source["line"] !== "number" || !Number.isInteger(source["line"])) {
    return null;
  }
  return { source: source["path"], line: source["line"] };
}

function extractClaude(event: JsonRecord): Omit<SearchableSegment, "segment">[] {
  if (event["kind"] !== "claude/user" && event["kind"] !== "claude/assistant") {
    return [];
  }
  const payload = asObject(event["payload"]);
  const message = asObject(payload?.["message"]);
  const sourceBlock = asObject(payload?.["source"]);
  if (!payload || !message || !sourceBlock) return [];
  const role = message["role"];
  if (role !== "user" && role !== "assistant") return [];
  const source = eventSource(payload);
  const sessionId =
    typeof sourceBlock["sessionId"] === "string"
      ? sourceBlock["sessionId"]
      : source
        ? sessionIdFromLocator(source.source)
        : null;
  if (!source || !sessionId) return [];
  return textParts(message["content"]).map((text) => ({
    source: source.source,
    line: source.line,
    eventId: String(event["id"]),
    platform: "claude" as const,
    sessionId,
    role,
    kind: String(event["kind"]),
    at: String(event["at"]),
    text,
    resumeArgv: ["claude", "--resume", sessionId],
  }));
}

function extractCodex(
  event: JsonRecord,
  knownSessionId: string | null,
): Omit<SearchableSegment, "segment">[] {
  const payload = asObject(event["payload"]);
  const original = asObject(payload?.["payload"]);
  if (!payload || !original) return [];
  const kind = String(event["kind"]);
  let role: "user" | "assistant" | null = null;
  let content: unknown;
  if (kind === "codex/user_message") {
    role = "user";
    content = original["message"];
  } else if (kind === "codex/agent_message") {
    role = "assistant";
    content = original["message"];
  } else if (kind === "codex/message") {
    role = original["role"] === "user" || original["role"] === "assistant"
      ? original["role"]
      : null;
    content = original["content"];
  }
  if (!role) return [];
  const source = eventSource(payload);
  const sessionId = knownSessionId ?? (source ? sessionIdFromLocator(source.source) : null);
  if (!source || !sessionId) return [];
  return textParts(content).map((text) => ({
    source: source.source,
    line: source.line,
    eventId: String(event["id"]),
    platform: "codex" as const,
    sessionId,
    role,
    kind,
    at: String(event["at"]),
    text,
    resumeArgv: ["codex", "resume", sessionId],
  }));
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

async function sqlite(
  sqliteBinary: string,
  database: string,
  sql: string,
  json = false,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const args = json ? ["-json", database] : [database];
    const child = spawn(sqliteBinary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout);
      else reject(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(sql);
  });
}

async function discoverLyncFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".lync")) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  return files;
}

async function privateMkdir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
}

function accountNonSearchable(
  manifest: SessionSearchManifest,
  event: JsonRecord,
): void {
  manifest.events.nonSearchable++;
  const kind = String(event["kind"]);
  const isSafeMessage = [
    "claude/user",
    "claude/assistant",
    "codex/user_message",
    "codex/agent_message",
    "codex/message",
  ].includes(kind);
  const reason = isSafeMessage
    ? "message-has-no-indexable-text-or-resume-coordinate"
    : "privacy-filtered-non-message-or-internal";
  manifest.events.nonSearchableByReason[reason] =
    (manifest.events.nonSearchableByReason[reason] ?? 0) + 1;
}

/** Rebuild the projection from scratch. No source archive is mutated. */
export async function rebuildSessionSearchIndex(
  lyncRoot: string,
  outputDir: string,
  opts: { sqliteBinary?: string } = {},
): Promise<SessionSearchBuildResult> {
  const root = path.resolve(lyncRoot);
  const out = path.resolve(outputDir);
  const parent = path.dirname(out);
  const stage = path.join(parent, `.${path.basename(out)}.tmp-${randomUUID()}`);
  const previous = path.join(parent, `.${path.basename(out)}.old-${randomUUID()}`);
  const sqliteBinary = opts.sqliteBinary ?? "sqlite3";
  await fs.mkdir(parent, { recursive: true });
  await privateMkdir(stage);
  const indexPath = path.join(stage, "index.sqlite3");
  const manifestPath = path.join(stage, "manifest.json");
  const files = await discoverLyncFiles(root);
  const manifest: SessionSearchManifest = {
    schema: SESSION_SEARCH_SCHEMA,
    authority: "lync",
    privacy: "human-and-assistant-message-text-only",
    files: { discovered: files.length, indexed: 0, failed: 0 },
    events: {
      seen: 0,
      searchable: 0,
      nonSearchable: 0,
      nonSearchableByReason: {},
      errors: 0,
    },
    messages: 0,
    errors: [],
  };
  const rows: SearchableSegment[] = [];
  try {
    for (const relative of files) {
      const full = path.join(root, ...relative.split("/"));
      let fileFailed = false;
      let codexSessionId: string | null = null;
      const pendingCodex: JsonRecord[] = [];
      const stream = createReadStream(full, { encoding: "utf8" });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let physicalLine = 0;
      try {
        for await (const line of lines) {
          physicalLine++;
          manifest.events.seen++;
          if (line.length === 0) {
            fileFailed = true;
            manifest.events.errors++;
            manifest.errors.push({
              source: relative,
              line: physicalLine,
              reason: "blank event line",
            });
            continue;
          }
          let event: JsonRecord;
          try {
            const parsed: unknown = JSON.parse(line);
            const object = asObject(parsed);
            if (!object) throw new Error("event is not a JSON object");
            event = object;
          } catch (error) {
            fileFailed = true;
            manifest.events.errors++;
            manifest.errors.push({
              source: relative,
              line: physicalLine,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (event["kind"] === "codex/session_meta") {
            const original = asObject(asObject(event["payload"])?.["payload"]);
            if (typeof original?.["id"] === "string") codexSessionId = original["id"];
          }
          if (String(event["kind"]).startsWith("codex/")) pendingCodex.push(event);
          else {
            const extracted = extractClaude(event);
            if (extracted.length === 0) accountNonSearchable(manifest, event);
            else {
              manifest.events.searchable++;
              extracted.forEach((row, segment) => rows.push({ ...row, segment }));
            }
          }
        }
        for (const event of pendingCodex) {
          const extracted = extractCodex(event, codexSessionId);
          if (extracted.length === 0) accountNonSearchable(manifest, event);
          else {
            manifest.events.searchable++;
            extracted.forEach((row, segment) => rows.push({ ...row, segment }));
          }
        }
      } catch (error) {
        fileFailed = true;
        manifest.errors.push({
          source: relative,
          line: null,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (fileFailed) manifest.files.failed++;
      else manifest.files.indexed++;
    }
    manifest.messages = rows.length;
    if (manifest.events.seen !== manifest.events.searchable + manifest.events.nonSearchable + manifest.events.errors) {
      throw new Error("session search: event counts do not reconcile");
    }
    const schema = [
      "PRAGMA journal_mode=DELETE;",
      "PRAGMA synchronous=FULL;",
      "PRAGMA user_version=1;",
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, source TEXT NOT NULL, line INTEGER NOT NULL, event_id TEXT NOT NULL, segment INTEGER NOT NULL, platform TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, resume_argv TEXT NOT NULL);",
      "CREATE UNIQUE INDEX messages_coordinate ON messages(source,line,event_id,segment);",
      "CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');",
      "BEGIN IMMEDIATE;",
      ...rows.map((row, i) => {
        const values = [row.source, row.eventId, row.platform, row.sessionId, row.role, row.kind, row.at, row.text, JSON.stringify(row.resumeArgv)].map(sqlText);
        return `INSERT INTO messages(id,source,line,event_id,segment,platform,session_id,role,kind,at,text,resume_argv) VALUES(${i + 1},${values[0]},${row.line},${values[1]},${row.segment},${values[2]},${values[3]},${values[4]},${values[5]},${values[6]},${values[7]},${values[8]}); INSERT INTO messages_fts(rowid,text) VALUES(${i + 1},${values[7]});`;
      }),
      "COMMIT;",
      "VACUUM;",
    ].join("\n");
    await sqlite(sqliteBinary, indexPath, schema);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.chmod(indexPath, 0o600);
      await fs.chmod(manifestPath, 0o600);
    }
    let hadPrevious = false;
    try {
      await fs.rename(out, previous);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(stage, out);
    } catch (error) {
      if (hadPrevious) await fs.rename(previous, out);
      throw error;
    }
    if (hadPrevious) {
      await fs.rm(previous, { recursive: true, force: true }).catch(() => {});
    }
    return {
      indexPath: path.join(out, "index.sqlite3"),
      manifestPath: path.join(out, "manifest.json"),
      manifest,
    };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Literal, case-sensitive substring search with stable source-coordinate order. */
export async function searchSessionIndex(
  indexPath: string,
  query: string,
  opts: { sqliteBinary?: string; limit?: number } = {},
): Promise<SessionSearchHit[]> {
  if (query.length === 0) throw new Error("session search: query must not be empty");
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("session search: limit must be an integer from 1 to 10000");
  }
  const sql = `SELECT source,line,event_id AS eventId,segment,platform,session_id AS sessionId,role,kind,at,text,resume_argv AS resumeArgv FROM messages WHERE instr(text,${sqlText(query)}) > 0 ORDER BY source,line,event_id,segment LIMIT ${limit};`;
  const stdout = await sqlite(opts.sqliteBinary ?? "sqlite3", path.resolve(indexPath), sql, true);
  const raw = stdout.trim().length === 0 ? [] : (JSON.parse(stdout) as JsonRecord[]);
  return raw.map((row) => ({
    source: String(row["source"]),
    line: Number(row["line"]),
    eventId: String(row["eventId"]),
    segment: Number(row["segment"]),
    platform: row["platform"] as "codex" | "claude",
    sessionId: String(row["sessionId"]),
    role: row["role"] as "user" | "assistant",
    kind: String(row["kind"]),
    at: String(row["at"]),
    text: String(row["text"]),
    resumeArgv: JSON.parse(String(row["resumeArgv"])) as string[],
  }));
}
