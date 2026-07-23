/**
 * Private, rebuildable search projection for Splice-produced session lync.
 * Lync remains authority. Only human/assistant text enters this projection.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import { isRfc3339 } from "./lync.js";
import { verifyLyncFileStreaming } from "./lync-session-batch.js";

export const SESSION_SEARCH_SCHEMA = "splice-session-search/v2";
// Each flush is a filesystem write plus a synchronous SQLite command. At the
// old 256-row default, multi-million-event archives spent most of their time
// crossing that boundary. These bounds keep memory finite while amortizing
// the fixed cost over production-sized batches.
const DEFAULT_BATCH_ROWS = 32_768;
const DEFAULT_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_DETAILS = 1_000;

type JsonRecord = Record<string, unknown>;

export interface SessionSearchError {
  source: string;
  line: number | null;
  reason: string;
}

export interface SessionSearchFileManifest {
  locator: string;
  sha256: string;
  bytes: number;
  events: { seen: number; searchable: number; nonSearchable: number; errors: number };
  messageSegments: number;
}

export interface SessionSearchManifest {
  schema: typeof SESSION_SEARCH_SCHEMA;
  authority: "lync";
  privacy: "human-and-assistant-message-text-only";
  sourceFiles: SessionSearchFileManifest[];
  files: { discovered: number; indexed: number; failed: number };
  events: {
    seen: number;
    searchable: number;
    nonSearchable: number;
    nonSearchableByReason: Record<string, number>;
    errors: number;
  };
  union: { identitiesSeen: number; unique: number; identicalDuplicates: number };
  /** Source message segments before lync union de-duplication. */
  messageSegments: number;
  /** Unique searchable rows actually present in SQLite. */
  messages: number;
  build: {
    batchRows: number;
    batchBytes: number;
    peakBatchRows: number;
    peakBatchBytes: number;
    peakIdentityBatchRows: number;
    peakIdentityBatchBytes: number;
    messageFlushes: number;
    identityFlushes: number;
    oversizeMessageRows: number;
    staleStagesRemoved: number;
  };
  errors: SessionSearchError[];
  errorDetailsTruncated: number;
}

export interface SessionSearchBuildResult {
  projectionRoot: string;
  generation: string;
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
  /** Safe argument vector for spawn/execFile. */
  resumeArgv: string[];
}

interface SearchableSegment extends SessionSearchHit { id: number }

type Extraction =
  | { status: "searchable"; segments: Omit<SearchableSegment, "id" | "segment">[] }
  | { status: "non-searchable"; reason: string }
  | { status: "error"; reason: string };

export class SessionSearchBuildError extends Error {
  constructor(message: string, readonly manifest: SessionSearchManifest) {
    super(message);
    this.name = "SessionSearchBuildError";
  }
}

function asObject(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sqlText(value: string): string {
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}

function commonMessageError(event: JsonRecord): string | null {
  if (typeof event["id"] !== "string" || event["id"].length === 0) return "message event has invalid id";
  if (!isRfc3339(event["at"])) return "message event has invalid at timestamp";
  return null;
}

function sourceCoordinate(payload: JsonRecord): { source: string; line: number } | null {
  const source = asObject(payload["source"]);
  if (!source || typeof source["path"] !== "string" || source["path"].length === 0) return null;
  const line = source["line"];
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  return { source: source["path"], line };
}

function sessionIdFromLocator(source: string): string | null {
  const name = path.posix.basename(source).replace(/\.lync$/, "");
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i)?.[1] ?? null;
}

function publicTextParts(content: unknown):
  | { ok: true; texts: string[] }
  | { ok: false; reason: string } {
  if (typeof content === "string") {
    return content.length > 0
      ? { ok: true, texts: [content] }
      : { ok: false, reason: "message text is empty" };
  }
  if (!Array.isArray(content)) return { ok: false, reason: "message content is missing or invalid" };
  const texts: string[] = [];
  for (const item of content) {
    const block = asObject(item);
    if (!block || typeof block["type"] !== "string") {
      return { ok: false, reason: "message content block is invalid" };
    }
    if (["text", "input_text", "output_text"].includes(block["type"])) {
      if (typeof block["text"] !== "string" || block["text"].length === 0) {
        return { ok: false, reason: "public message text block is missing text" };
      }
      texts.push(block["text"]);
    }
    // All other block types are deliberately privacy-filtered.
  }
  return { ok: true, texts };
}

function extractClaude(event: JsonRecord): Extraction {
  if (event["kind"] !== "claude/user" && event["kind"] !== "claude/assistant") {
    return { status: "non-searchable", reason: "privacy-filtered-non-message-or-internal" };
  }
  const common = commonMessageError(event);
  if (common) return { status: "error", reason: common };
  const payload = asObject(event["payload"]);
  const message = asObject(payload?.["message"]);
  const sourceBlock = asObject(payload?.["source"]);
  if (!payload || !message || !sourceBlock) return { status: "error", reason: "message payload/source structure is invalid" };
  const expectedRole = event["kind"] === "claude/user" ? "user" : "assistant";
  if (message["role"] !== expectedRole) return { status: "error", reason: "message role is missing or inconsistent with kind" };
  const coordinate = sourceCoordinate(payload);
  if (!coordinate) return { status: "error", reason: "message source coordinate is missing or invalid" };
  const sessionId = typeof sourceBlock["sessionId"] === "string" && sourceBlock["sessionId"].length > 0
    ? sourceBlock["sessionId"]
    : sessionIdFromLocator(coordinate.source);
  if (!sessionId) return { status: "error", reason: "message session id is missing or invalid" };
  const text = publicTextParts(message["content"]);
  if (text.ok === false) return { status: "error", reason: text.reason };
  if (text.texts.length === 0) {
    return { status: "non-searchable", reason: "privacy-filtered-message-without-public-text" };
  }
  return {
    status: "searchable",
    segments: text.texts.map((value) => ({
      source: coordinate.source,
      line: coordinate.line,
      eventId: event["id"] as string,
      platform: "claude",
      sessionId,
      role: expectedRole,
      kind: event["kind"] as string,
      at: event["at"] as string,
      text: value,
      resumeArgv: ["claude", "--resume", sessionId],
    })),
  };
}

function extractCodex(event: JsonRecord, knownSessionId: string | null): Extraction {
  const kind = event["kind"];
  if (!["codex/user_message", "codex/agent_message", "codex/message"].includes(String(kind))) {
    return { status: "non-searchable", reason: "privacy-filtered-non-message-or-internal" };
  }
  const payload = asObject(event["payload"]);
  const original = asObject(payload?.["payload"]);
  if (!payload || !original) return { status: "error", reason: "message payload structure is invalid" };
  let role: "user" | "assistant";
  let content: unknown;
  if (kind === "codex/user_message") {
    role = "user";
    content = Object.prototype.hasOwnProperty.call(original, "message")
      ? original["message"]
      : original["content"];
  } else if (kind === "codex/agent_message") {
    role = "assistant";
    content = Object.prototype.hasOwnProperty.call(original, "message")
      ? original["message"]
      : original["content"];
  } else {
    if (original["role"] === "system" || original["role"] === "developer") {
      return { status: "non-searchable", reason: "privacy-filtered-system-or-developer-message" };
    }
    if (original["role"] !== "user" && original["role"] !== "assistant") {
      return { status: "error", reason: "message role is missing or invalid" };
    }
    role = original["role"];
    content = original["content"];
  }
  const common = commonMessageError(event);
  if (common) return { status: "error", reason: common };
  const coordinate = sourceCoordinate(payload);
  if (!coordinate) return { status: "error", reason: "message source coordinate is missing or invalid" };
  const sessionId = knownSessionId ?? sessionIdFromLocator(coordinate.source);
  if (!sessionId) return { status: "error", reason: "message session id is missing or invalid" };
  const text = publicTextParts(content);
  if (text.ok === false) return { status: "error", reason: text.reason };
  if (text.texts.length === 0) {
    return { status: "non-searchable", reason: "privacy-filtered-message-without-public-text" };
  }
  return {
    status: "searchable",
    segments: text.texts.map((value) => ({
      source: coordinate.source,
      line: coordinate.line,
      eventId: event["id"] as string,
      platform: "codex",
      sessionId,
      role,
      kind: String(kind),
      at: event["at"] as string,
      text: value,
      resumeArgv: ["codex", "resume", sessionId],
    })),
  };
}

async function privateMkdir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
}

async function publishCurrentPointer(root: string, generation: string): Promise<void> {
  const current = path.join(root, "CURRENT");
  const existing = await fs.stat(current).catch(() => null);
  if (existing && !existing.isFile()) {
    throw new Error("session search: CURRENT exists but is not a regular file");
  }
  const temporary = path.join(root, `.CURRENT-${randomUUID()}`);
  const backup = path.join(root, `.CURRENT-backup-${randomUUID()}`);
  await fs.writeFile(temporary, generation + "\n", { mode: 0o600 });
  try {
    try {
      // Atomic replacement on POSIX; also succeeds on Windows for first publish.
      await fs.rename(temporary, current);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(code)) {
        throw error;
      }
    }

    // Windows rename cannot replace an existing file. Move the tiny pointer
    // aside first, install the new one, and restore on a controlled failure.
    // This is not an atomic replacement, but immutable generation readers are
    // unaffected once they have resolved CURRENT.
    let backedUp = false;
    let preserveBackup = false;
    try {
      await fs.rename(current, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(temporary, current);
    } catch (error) {
      if (backedUp) {
        try {
          await fs.rename(backup, current);
          backedUp = false;
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError(
            [error, restoreError],
            `session search: CURRENT replacement failed; prior pointer remains at ${backup}`,
          );
        }
      }
      throw error;
    } finally {
      if (backedUp && !preserveBackup) {
        await fs.rm(backup, { force: true }).catch(() => {});
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function populateGeneration(
  stage: string,
  generations: string,
  generation: string,
  manifestBytes: string,
  sqliteBinary: string,
  currentGeneration: string | null,
): Promise<{ dir: string; created: boolean }> {
  const dir = path.join(generations, generation);
  let created = false;
  try {
    await fs.mkdir(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      await preflightSessionSearchIndex(path.join(dir, "index.sqlite3"), sqliteBinary);
      if (await fs.readFile(path.join(dir, "manifest.json"), "utf8") !== manifestBytes) {
        throw new Error("generation manifest mismatch");
      }
      return { dir, created: false };
    } catch (validationError) {
      if (currentGeneration === generation) {
        throw new Error(
          `session search: current generation ${generation} is incomplete or invalid; refusing destructive repair: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
        );
      }
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { mode: 0o700 });
      created = true;
    }
  }

  try {
    await fs.copyFile(path.join(stage, "index.sqlite3"), path.join(dir, "index.sqlite3"));
    await fs.copyFile(path.join(stage, "manifest.json"), path.join(dir, "manifest.json"));
    if (process.platform !== "win32") {
      await fs.chmod(dir, 0o700);
      await fs.chmod(path.join(dir, "index.sqlite3"), 0o600);
      await fs.chmod(path.join(dir, "manifest.json"), 0o600);
    }
    await preflightSessionSearchIndex(path.join(dir, "index.sqlite3"), sqliteBinary);
    if (await fs.readFile(path.join(dir, "manifest.json"), "utf8") !== manifestBytes) {
      throw new Error("session search: copied generation manifest failed verification");
    }
    return { dir, created };
  } catch (error) {
    if (created) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function discoverLyncFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => byteCompare(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".lync")) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  files.sort(byteCompare);
  return files;
}

async function digestFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function codexSessionId(file: string): Promise<string | null> {
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = asObject(JSON.parse(line));
      if (event?.["kind"] !== "codex/session_meta") continue;
      const original = asObject(asObject(event["payload"])?.["payload"]);
      if (typeof original?.["id"] === "string" && original["id"].length > 0) return original["id"];
    } catch {
      // The accounting pass reports this exact line; this pass only finds metadata.
    }
  }
  return null;
}

class SqliteTransaction {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private stdout = "";
  private stderr = "";
  private failed: Error | null = null;
  private readonly closed: Promise<void>;

  constructor(binary: string, database: string) {
    this.child = spawn(binary, [database], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderr += chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.closed = new Promise((resolve, reject) => {
      this.child.on("close", (code) => {
        if (code === 0 && !this.failed) resolve();
        else {
          const error = this.failed ?? new Error(`sqlite3 exited ${code}: ${this.stderr.trim()}`);
          this.fail(error);
          reject(error);
        }
      });
    });
    // A sqlite process can fail before the build reaches its finally/abort
    // path. Mark the promise observed immediately; callers still await the
    // original promise and receive the same rejection.
    void this.closed.catch(() => {});
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline).replace(/\r$/, "");
      this.stdout = this.stdout.slice(newline + 1);
      const waiter = this.pending.get(line);
      if (waiter) {
        this.pending.delete(line);
        waiter.resolve();
      }
    }
  }

  private fail(error: Error): void {
    if (!this.failed) this.failed = error;
    for (const waiter of this.pending.values()) waiter.reject(this.failed);
    this.pending.clear();
  }

  private async write(text: string): Promise<void> {
    if (this.failed) throw this.failed;
    if (!this.child.stdin.write(text)) await once(this.child.stdin, "drain");
  }

  async execute(sql: string): Promise<void> {
    const token = `__splice_ack_${randomUUID()}__`;
    const ack = new Promise<void>((resolve, reject) => this.pending.set(token, { resolve, reject }));
    await this.write(`${sql}\nSELECT '${token}';\n`);
    await ack;
  }

  async finish(): Promise<void> {
    this.child.stdin.end();
    await this.closed;
  }

  async abort(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill();
    await this.closed.catch(() => {});
  }
}

async function sqliteOnce(
  binary: string,
  database: string,
  sql: string,
  opts: { json?: boolean; readonly?: boolean } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const args = [...(opts.readonly ? ["-readonly"] : []), ...(opts.json ? ["-json"] : []), database];
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
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

export async function checkSessionSearchPrerequisites(sqliteBinary = "sqlite3"): Promise<string> {
  const probe = path.join(os.tmpdir(), `splice-sqlite-probe-${randomUUID()}`);
  await fs.writeFile(probe, "[]", { mode: 0o600 });
  try {
    const sql = [
      "CREATE VIRTUAL TABLE probe USING fts5(text, tokenize='trigram case_sensitive 1');",
      `SELECT sqlite_version() || ':' || json_array_length(CAST(readfile(${sqlText(probe)}) AS TEXT));`,
    ].join("\n");
    const output = await sqliteOnce(sqliteBinary, ":memory:", `PRAGMA temp_store=FILE;\nPRAGMA temp_store;\n${sql}`);
    const lines = output.trim().split(/\r?\n/);
    if (lines[0] !== "1") throw new Error("sqlite3 refused PRAGMA temp_store=FILE");
    const verdict = lines.at(-1);
    if (!verdict?.endsWith(":0")) throw new Error("sqlite3 lacks FTS5 trigram, JSON1, or readfile support");
    return verdict.slice(0, -2);
  } finally {
    await fs.rm(probe, { force: true });
  }
}

function emptyManifest(batchRows: number, batchBytes: number): SessionSearchManifest {
  return {
    schema: SESSION_SEARCH_SCHEMA,
    authority: "lync",
    privacy: "human-and-assistant-message-text-only",
    sourceFiles: [],
    files: { discovered: 0, indexed: 0, failed: 0 },
    events: { seen: 0, searchable: 0, nonSearchable: 0, nonSearchableByReason: {}, errors: 0 },
    union: { identitiesSeen: 0, unique: 0, identicalDuplicates: 0 },
    messageSegments: 0,
    messages: 0,
    build: {
      batchRows,
      batchBytes,
      peakBatchRows: 0,
      peakBatchBytes: 0,
      peakIdentityBatchRows: 0,
      peakIdentityBatchBytes: 0,
      messageFlushes: 0,
      identityFlushes: 0,
      oversizeMessageRows: 0,
      staleStagesRemoved: 0,
    },
    errors: [],
    errorDetailsTruncated: 0,
  };
}

function recordError(manifest: SessionSearchManifest, error: SessionSearchError): void {
  if (manifest.errors.length < MAX_ERROR_DETAILS) manifest.errors.push(error);
  else manifest.errorDetailsTruncated++;
}

/** Build an immutable generation, then atomically publish its CURRENT pointer. */
export async function rebuildSessionSearchIndex(
  lyncRoot: string,
  outputDir: string,
  opts: { sqliteBinary?: string; batchRows?: number; batchBytes?: number } = {},
): Promise<SessionSearchBuildResult> {
  const root = path.resolve(lyncRoot);
  const out = path.resolve(outputDir);
  const sqliteBinary = opts.sqliteBinary ?? "sqlite3";
  const batchRows = opts.batchRows ?? DEFAULT_BATCH_ROWS;
  const batchBytes = opts.batchBytes ?? DEFAULT_BATCH_BYTES;
  if (!Number.isInteger(batchRows) || batchRows < 1 || !Number.isInteger(batchBytes) || batchBytes < 1024) {
    throw new Error("session search: invalid batch bounds");
  }
  await checkSessionSearchPrerequisites(sqliteBinary);
  await privateMkdir(out);
  const generations = path.join(out, "generations");
  const lock = path.join(out, ".rebuild.lock");
  const stage = path.join(out, `.stage-${randomUUID()}`);
  const manifest = emptyManifest(batchRows, batchBytes);
  let locked = false;
  let writer: SqliteTransaction | null = null;
  let createdGeneration: string | null = null;
  let published = false;
  try {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`session search: rebuild already running for ${out}`);
      }
      throw error;
    }
    // A process killed after acquiring the lock can leave private snapshots
    // and large temporary databases behind. Once this rebuild owns the lock,
    // no stage can be live, so stale stages are safe to remove before work.
    for (const entry of await fs.readdir(out, { withFileTypes: true })) {
      if (!entry.name.startsWith(".stage-")) continue;
      await fs.rm(path.join(out, entry.name), { recursive: true, force: true });
      manifest.build.staleStagesRemoved++;
    }
    await privateMkdir(stage);
    const indexPath = path.join(stage, "index.sqlite3");
    const snapshots = path.join(stage, "source-snapshots");
    await privateMkdir(snapshots);
    const files = await discoverLyncFiles(root);
    manifest.files.discovered = files.length;
    writer = new SqliteTransaction(sqliteBinary, indexPath);
    await writer.execute([
      ".bail on",
      "PRAGMA journal_mode=DELETE;",
      "PRAGMA synchronous=FULL;",
      "PRAGMA temp_store=FILE;",
      "PRAGMA user_version=2;",
      "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
      `INSERT INTO metadata VALUES('schema',${sqlText(SESSION_SEARCH_SCHEMA)}),('tokenizer','trigram case_sensitive 1');`,
      "CREATE TABLE messages(id INTEGER PRIMARY KEY,source TEXT NOT NULL,line INTEGER NOT NULL,event_id TEXT NOT NULL,segment INTEGER NOT NULL,platform TEXT NOT NULL,session_id TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,text TEXT NOT NULL,resume_argv TEXT NOT NULL);",
      "CREATE UNIQUE INDEX messages_coordinate ON messages(source,line,event_id,segment);",
      "CREATE VIRTUAL TABLE messages_fts USING fts5(text,content='messages',content_rowid='id',tokenize='trigram case_sensitive 1');",
      "CREATE TABLE union_accounting(identities_seen INTEGER NOT NULL,unique_count INTEGER NOT NULL);",
      "INSERT INTO union_accounting VALUES(0,0);",
      "CREATE TEMP TABLE seen_event_bodies(id TEXT PRIMARY KEY,body_digest TEXT NOT NULL) WITHOUT ROWID;",
      "CREATE TEMP TRIGGER reject_event_body_conflict BEFORE INSERT ON seen_event_bodies WHEN EXISTS(SELECT 1 FROM seen_event_bodies WHERE id=NEW.id AND body_digest<>NEW.body_digest) BEGIN SELECT RAISE(ABORT,'lync union same-id different-body conflict'); END;",
      "BEGIN IMMEDIATE;",
    ].join("\n"));

    let nextId = 1;
    let batch: SearchableSegment[] = [];
    let batchSize = 2; // JSON array brackets; commas are added on enqueue.
    let batchNo = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      manifest.build.peakBatchRows = Math.max(manifest.build.peakBatchRows, batch.length);
      manifest.build.peakBatchBytes = Math.max(manifest.build.peakBatchBytes, batchSize);
      manifest.build.messageFlushes++;
      const batchFile = path.join(stage, `batch-${String(batchNo++).padStart(8, "0")}.json`);
      await fs.writeFile(batchFile, JSON.stringify(batch), { mode: 0o600 });
      const first = batch[0].id;
      const last = batch.at(-1)!.id;
      await writer!.execute([
        "INSERT OR IGNORE INTO messages(id,source,line,event_id,segment,platform,session_id,role,kind,at,text,resume_argv)",
        `SELECT json_extract(value,'$.id'),json_extract(value,'$.source'),json_extract(value,'$.line'),json_extract(value,'$.eventId'),json_extract(value,'$.segment'),json_extract(value,'$.platform'),json_extract(value,'$.sessionId'),json_extract(value,'$.role'),json_extract(value,'$.kind'),json_extract(value,'$.at'),json_extract(value,'$.text'),json_extract(value,'$.resumeArgv') FROM json_each(CAST(readfile(${sqlText(batchFile)}) AS TEXT));`,
        `INSERT INTO messages_fts(rowid,text) SELECT id,text FROM messages WHERE id BETWEEN ${first} AND ${last};`,
      ].join("\n"));
      await fs.rm(batchFile, { force: true });
      batch = [];
      batchSize = 2;
    };
    const enqueue = async (row: Omit<SearchableSegment, "id">): Promise<void> => {
      const withId: SearchableSegment = { ...row, id: nextId++ };
      const bytes = Buffer.byteLength(JSON.stringify(withId), "utf8");
      const addedBytes = bytes + (batch.length > 0 ? 1 : 0);
      if (batch.length > 0 && (batch.length >= batchRows || batchSize + addedBytes > batchBytes)) await flush();
      if (batch.length === 0 && batchSize + bytes > batchBytes) {
        manifest.build.oversizeMessageRows++;
      }
      batch.push(withId);
      batchSize += bytes + (batch.length > 1 ? 1 : 0);
    };

    let identityBatch: { id: string; bodyDigest: string }[] = [];
    let identityBatchSize = 2;
    let identityBatchNo = 0;
    const flushIdentities = async (): Promise<void> => {
      if (identityBatch.length === 0) return;
      manifest.build.peakIdentityBatchRows = Math.max(
        manifest.build.peakIdentityBatchRows,
        identityBatch.length,
      );
      manifest.build.peakIdentityBatchBytes = Math.max(
        manifest.build.peakIdentityBatchBytes,
        identityBatchSize,
      );
      manifest.build.identityFlushes++;
      const batchFile = path.join(stage, `identity-${String(identityBatchNo++).padStart(8, "0")}.json`);
      await fs.writeFile(batchFile, JSON.stringify(identityBatch), { mode: 0o600 });
      await writer!.execute([
        `UPDATE union_accounting SET identities_seen=identities_seen+(SELECT count(*) FROM json_each(CAST(readfile(${sqlText(batchFile)}) AS TEXT)));`,
        "INSERT OR IGNORE INTO seen_event_bodies(id,body_digest)",
        `SELECT json_extract(value,'$.id'),json_extract(value,'$.bodyDigest') FROM json_each(CAST(readfile(${sqlText(batchFile)}) AS TEXT));`,
      ].join("\n"));
      await fs.rm(batchFile, { force: true });
      identityBatch = [];
      identityBatchSize = 2;
    };
    const enqueueIdentity = async (identity: { id: string; bodyDigest: string }): Promise<void> => {
      const bytes = Buffer.byteLength(JSON.stringify(identity), "utf8");
      const addedBytes = bytes + (identityBatch.length > 0 ? 1 : 0);
      if (
        identityBatch.length > 0 &&
        (identityBatch.length >= batchRows || identityBatchSize + addedBytes > batchBytes)
      ) {
        await flushIdentities();
      }
      identityBatch.push(identity);
      identityBatchSize += bytes + (identityBatch.length > 1 ? 1 : 0);
    };

    for (const relative of files) {
      const full = path.join(root, ...relative.split("/"));
      const snapshot = path.join(
        snapshots,
        `${createHash("sha256").update(relative).digest("hex")}.lync`,
      );
      const copying = `${snapshot}.copying`;
      await fs.copyFile(full, copying);
      if (process.platform !== "win32") await fs.chmod(copying, 0o400);
      await fs.rename(copying, snapshot);
      const digest = await digestFile(snapshot);
      const fileStats: SessionSearchFileManifest = {
        locator: relative,
        ...digest,
        events: { seen: 0, searchable: 0, nonSearchable: 0, errors: 0 },
        messageSegments: 0,
      };
      manifest.sourceFiles.push(fileStats);
      let fileFailed = false;
      let knownCodexId: string | null = null;
      try {
        let integrityLines = 0;
        let verify;
        try {
          verify = await verifyLyncFileStreaming(snapshot, {
            trackConflicts: false,
            onAccepted: async ({ id, bodyDigest }) => {
              integrityLines++;
              await enqueueIdentity({ id, bodyDigest });
            },
          });
          await flushIdentities();
        } catch (error) {
          fileFailed = true;
          const reason = error instanceof Error ? error.message : String(error);
          fileStats.events.seen = integrityLines;
          fileStats.events.errors = integrityLines || 1;
          manifest.events.seen += fileStats.events.errors;
          manifest.events.errors += fileStats.events.errors;
          recordError(manifest, { source: relative, line: null, reason });
          manifest.files.failed++;
          throw new SessionSearchBuildError(
            /same-id different-body conflict/.test(reason)
              ? `session search: lync union conflict in ${relative}`
              : `session search: lync verification failed for ${relative}`,
            manifest,
          );
        }
        if (!verify.ok) {
          fileFailed = true;
          fileStats.events.seen = verify.counts.lines;
          fileStats.events.errors = verify.counts.lines;
          manifest.events.seen += verify.counts.lines;
          manifest.events.errors += verify.counts.lines;
          for (const problem of verify.problems) {
            recordError(manifest, {
              source: relative,
              line: problem.line < 0 ? null : problem.line,
              reason: `${problem.class}: ${problem.reason}`,
            });
          }
          manifest.files.failed++;
          throw new SessionSearchBuildError(
            `session search: lync integrity failed for ${relative}`,
            manifest,
          );
        }
        knownCodexId = await codexSessionId(snapshot);
        const lines = readline.createInterface({ input: createReadStream(snapshot, { encoding: "utf8" }), crlfDelay: Infinity });
        let physicalLine = 0;
        for await (const line of lines) {
          physicalLine++;
          fileStats.events.seen++;
          manifest.events.seen++;
          let event: JsonRecord | null = null;
          let parseReason: string | null = null;
          if (line.length === 0) parseReason = "blank event line";
          else {
            try {
              event = asObject(JSON.parse(line));
              if (!event) parseReason = "event is not a JSON object";
            } catch (error) {
              parseReason = error instanceof Error ? error.message : String(error);
            }
          }
          if (parseReason || !event) {
            fileFailed = true;
            fileStats.events.errors++;
            manifest.events.errors++;
            recordError(manifest, { source: relative, line: physicalLine, reason: parseReason ?? "invalid event" });
            continue;
          }
          const extraction = String(event["kind"]).startsWith("codex/")
            ? extractCodex(event, knownCodexId)
            : extractClaude(event);
          if (extraction.status === "error") {
            fileFailed = true;
            fileStats.events.errors++;
            manifest.events.errors++;
            recordError(manifest, { source: relative, line: physicalLine, reason: extraction.reason });
          } else if (extraction.status === "non-searchable") {
            fileStats.events.nonSearchable++;
            manifest.events.nonSearchable++;
            manifest.events.nonSearchableByReason[extraction.reason] =
              (manifest.events.nonSearchableByReason[extraction.reason] ?? 0) + 1;
          } else {
            fileStats.events.searchable++;
            manifest.events.searchable++;
            fileStats.messageSegments += extraction.segments.length;
            manifest.messageSegments += extraction.segments.length;
            for (const [segment, row] of extraction.segments.entries()) await enqueue({ ...row, segment });
          }
        }
      } catch (error) {
        if (error instanceof SessionSearchBuildError) throw error;
        fileFailed = true;
        recordError(manifest, { source: relative, line: null, reason: error instanceof Error ? error.message : String(error) });
      } finally {
        await fs.rm(snapshot, { force: true }).catch(() => {});
      }
      if (fileFailed) manifest.files.failed++;
      else manifest.files.indexed++;
    }
    await flush();
    await fs.rm(snapshots, { recursive: true, force: true });
    if (manifest.events.seen !== manifest.events.searchable + manifest.events.nonSearchable + manifest.events.errors) {
      throw new Error("session search: event counts do not reconcile");
    }
    if (manifest.files.failed > 0) {
      throw new SessionSearchBuildError(`session search: ${manifest.files.failed} source file(s) failed validation`, manifest);
    }
    await writer.execute([
      "UPDATE union_accounting SET unique_count=(SELECT count(*) FROM seen_event_bodies);",
      "COMMIT;",
      "VACUUM;",
    ].join("\n"));
    await writer.finish();
    writer = null;
    const messageCountOutput = await sqliteOnce(sqliteBinary, indexPath, "SELECT count(*) AS count FROM messages;", { json: true, readonly: true });
    manifest.messages = Number((JSON.parse(messageCountOutput) as JsonRecord[])[0]?.["count"] ?? 0);
    const unionOutput = await sqliteOnce(sqliteBinary, indexPath, "SELECT identities_seen AS identitiesSeen,unique_count AS uniqueCount FROM union_accounting;", { json: true, readonly: true });
    const unionRow = (JSON.parse(unionOutput) as JsonRecord[])[0] ?? {};
    manifest.union.identitiesSeen = Number(unionRow["identitiesSeen"] ?? 0);
    manifest.union.unique = Number(unionRow["uniqueCount"] ?? 0);
    manifest.union.identicalDuplicates = manifest.union.identitiesSeen - manifest.union.unique;
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    const generation = `gen-${createHash("sha256").update(manifestBytes).digest("hex")}`;
    const manifestPath = path.join(stage, "manifest.json");
    await fs.writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.chmod(indexPath, 0o600);
      await fs.chmod(manifestPath, 0o600);
    }
    await privateMkdir(generations);
    const currentGeneration = await fs.readFile(path.join(out, "CURRENT"), "utf8")
      .then((value) => value.trim(), () => null);
    const populated = await populateGeneration(
      stage,
      generations,
      generation,
      manifestBytes,
      sqliteBinary,
      currentGeneration,
    );
    const generationDir = populated.dir;
    if (populated.created) createdGeneration = generationDir;
    await publishCurrentPointer(out, generation);
    published = true;
    return {
      projectionRoot: out,
      generation,
      indexPath: path.join(generationDir, "index.sqlite3"),
      manifestPath: path.join(generationDir, "manifest.json"),
      manifest,
    };
  } finally {
    if (writer) await writer.abort();
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!published && createdGeneration) {
      await fs.rm(createdGeneration, { recursive: true, force: true }).catch(() => {});
    }
    if (locked) await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveIndex(indexOrProjection: string): Promise<string> {
  const input = path.resolve(indexOrProjection);
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`session search: index path does not exist: ${input}`);
  if (stat.isFile()) return input;
  if (!stat.isDirectory()) throw new Error(`session search: index path is not a file or projection directory: ${input}`);
  const generation = (await fs.readFile(path.join(input, "CURRENT"), "utf8")).trim();
  if (!/^gen-[0-9a-f]{64}$/.test(generation)) throw new Error("session search: invalid CURRENT generation pointer");
  return path.join(input, "generations", generation, "index.sqlite3");
}

export async function preflightSessionSearchIndex(indexPath: string, sqliteBinary = "sqlite3"): Promise<void> {
  const stat = await fs.stat(indexPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`session search: index is missing or not a regular file: ${indexPath}`);
  const sql = "SELECT key,value FROM metadata WHERE key IN ('schema','tokenizer') ORDER BY key;";
  const output = await sqliteOnce(sqliteBinary, indexPath, sql, { json: true, readonly: true });
  const rows = output.trim() ? JSON.parse(output) as JsonRecord[] : [];
  const metadata = Object.fromEntries(rows.map((row) => [String(row["key"]), String(row["value"])]));
  if (metadata["schema"] !== SESSION_SEARCH_SCHEMA || metadata["tokenizer"] !== "trigram case_sensitive 1") {
    throw new Error("session search: incompatible or invalid projection index");
  }
}

/** Literal, case-sensitive substring search, FTS-trigram candidates first. */
export async function searchSessionIndex(
  indexOrProjection: string,
  query: string,
  opts: { sqliteBinary?: string; limit?: number } = {},
): Promise<SessionSearchHit[]> {
  if ([...query].length < 3) throw new Error("session search: literal query must contain at least 3 characters");
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("session search: limit must be an integer from 1 to 10000");
  }
  const sqliteBinary = opts.sqliteBinary ?? "sqlite3";
  const indexPath = await resolveIndex(indexOrProjection);
  await preflightSessionSearchIndex(indexPath, sqliteBinary);
  const phrase = `"${query.replaceAll('"', '""')}"`;
  const sql = [
    "WITH candidates AS (",
    ` SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${sqlText(phrase)}`,
    ")",
    "SELECT m.source,m.line,m.event_id AS eventId,m.segment,m.platform,m.session_id AS sessionId,m.role,m.kind,m.at,m.text,m.resume_argv AS resumeArgv",
    "FROM candidates c JOIN messages m ON m.id=c.rowid",
    `WHERE instr(m.text,${sqlText(query)}) > 0`,
    `ORDER BY m.source,m.line,m.event_id,m.segment LIMIT ${limit};`,
  ].join("\n");
  const output = await sqliteOnce(sqliteBinary, indexPath, sql, { json: true, readonly: true });
  const raw = output.trim() ? JSON.parse(output) as JsonRecord[] : [];
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
