/**
 * Shared plumbing for agent-session JSONL → lync importers (dee-07pu).
 *
 * Both session importers (lync-claude-session.ts, lync-codex-session.ts)
 * consume the same physical shape — a tree of append-only `.jsonl` session
 * files — and owe the same accounting:
 *
 * - line splitting that counts every line (blank lines are explicit skips,
 *   never silently ignored; a trailing LF does not invent a phantom line),
 * - timestamp normalization to RFC 3339 with every repair/substitution
 *   recorded (pacts/import.md "Payload and Time"),
 * - a tree walker + batch converter with ZERO SILENT DROPS at the FILE level:
 *   every file under the input root is converted, named unreadable with its
 *   error, or named ignored (non-.jsonl) — there is no fourth path, and the
 *   file-accounting invariant is checked loudly.
 *
 * The batch path STREAMS: the archives it exists for hold multi-GB session
 * files (the largest observed rollout is ~1.8GB, past V8's ~512MB string
 * limit), so inputs are read line-by-line, outputs are written through a
 * stream, and verification re-parses the written file in newline-aligned
 * chunks — every chunk through @deepfates/lync's own parser, with same-id
 * conflict detection carried across chunks via the parser's body digests.
 *
 * Every written `.lync` file must verify 100% accepted (pacts/import.md
 * "Verify Before You Believe").
 */

import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import { serializeLyncEvent } from "@deepfates/lync/store";
import { parseLyncFiles } from "@deepfates/lync/events";
import type { LyncEventBody } from "@deepfates/lync/events";

import {
  isRfc3339,
  type LyncSkippedRecord,
  type LyncTimestampFallback,
  type LyncVerifyProblem,
  type LyncVerifyResult,
} from "./lync.js";

/* ------------------------------- Line splitting ---------------------------- */

/** One physical line of a session JSONL file, 1-based like `source:line`. */
export interface SessionJsonlLine {
  lineNo: number;
  text: string;
}

/**
 * Split JSONL text into physical lines. A trailing LF terminates the final
 * line rather than opening an empty one (matching how the files are written);
 * every other line — including blank ones — is returned and must be accounted
 * for by the caller.
 */
export function splitSessionJsonl(text: string): SessionJsonlLine[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line, i) => ({ lineNo: i + 1, text: line }));
}

/* ------------------------------- Timestamps -------------------------------- */

/**
 * Normalize a source-claimed timestamp for the envelope `at` field
 * (pacts/import.md): RFC 3339 strings pass verbatim (bytes are canonical);
 * Date-parseable strings are converted with the repair recorded; anything
 * else takes the deterministic `fallback`, also recorded. `index` is the
 * 1-based source line number.
 */
export function normalizeSessionAt(
  value: unknown,
  index: number,
  fallback: string,
  fallbacks: LyncTimestampFallback[],
): string {
  if (isRfc3339(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      const iso = parsed.toISOString();
      fallbacks.push({
        index,
        original: value,
        used: iso,
        reason: "non-RFC3339 source timestamp parsed via Date",
      });
      return iso;
    }
  }
  fallbacks.push({
    index,
    original: value ?? null,
    used: fallback,
    reason: "missing or unparseable source timestamp; substituted fallback",
  });
  return fallback;
}

/** JSON-safe truncation of an offending source line for skip-entry audit. */
export function skippedLineValue(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/* ------------------------------ Tree discovery ----------------------------- */

/** Every file under a session root, classified — nothing vanishes. */
export interface SessionTreeScan {
  dir: string;
  /** Relative paths of `.jsonl` files, sorted for deterministic ordering. */
  jsonlFiles: string[];
  /** Relative paths of everything else — named, not silently passed over. */
  ignoredFiles: string[];
}

/**
 * Turn a physical root-relative path into the machine-independent identity
 * used for event ids and source references. Both separator spellings are
 * normalized deliberately: an archive copied between POSIX and Windows must
 * retain the same identity.
 */
export function sessionLogicalLocator(relativePath: string): string {
  const locator = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  if (
    locator === "." ||
    locator === ".." ||
    locator.startsWith("../") ||
    locator.startsWith("/")
  ) {
    throw new Error(
      `session tree: locator must be root-relative, got ${JSON.stringify(relativePath)}`,
    );
  }
  return locator;
}

/**
 * Resolve every discovered file to its logical identity before any output is
 * written. Distinct physical paths that normalize to one identity would mint
 * colliding deterministic ids, so reject the entire batch at preflight.
 */
export function preflightSessionLogicalLocators(
  relativePaths: readonly string[],
): Map<string, string> {
  const byFile = new Map<string, string>();
  const fileByLocator = new Map<string, string>();
  for (const file of relativePaths) {
    const locator = sessionLogicalLocator(file);
    const previous = fileByLocator.get(locator);
    if (previous !== undefined) {
      throw new Error(
        `session tree: duplicate logical locator ${JSON.stringify(locator)} from ${JSON.stringify(previous)} and ${JSON.stringify(file)}`,
      );
    }
    fileByLocator.set(locator, file);
    byFile.set(file, locator);
  }
  return byFile;
}

/** Recursively discover `.jsonl` session files under `dir`. */
export async function scanSessionTree(dir: string): Promise<SessionTreeScan> {
  const jsonlFiles: string[] = [];
  const ignoredFiles: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, full);
        if (entry.name.endsWith(".jsonl")) jsonlFiles.push(rel);
        else ignoredFiles.push(rel);
      } else {
        // Symlinks, sockets, and other non-regular entries are deliberately
        // not followed, but they still belong in the file-level accounting.
        ignoredFiles.push(path.relative(dir, full));
      }
    }
  }

  await walk(dir);
  jsonlFiles.sort();
  ignoredFiles.sort();
  return { dir, jsonlFiles, ignoredFiles };
}

/* ---------------------------- Streaming verify ----------------------------- */

const VERIFY_CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * Verify a written `.lync` file of any size: re-parse it in newline-aligned
 * chunks, EVERY chunk through @deepfates/lync's parseLyncFiles, and require every
 * line to classify `accepted`. Same-id conflict detection (same id, different
 * body bytes) is carried across chunks using the parser's own body digests,
 * so the verdict matches lync.ts's verifyLyncFile — this variant just never
 * materializes the whole file as one string, which multi-GB session outputs
 * cannot do.
 */
export async function verifyLyncFileStreaming(
  filePath: string,
  opts: {
    /**
     * Observe parser-accepted identities without retaining them in memory.
     * Callers may use a disk-backed union table for cross-file conflicts.
     */
    onAccepted?: (identity: {
      id: string;
      bodyDigest: string;
      line: number;
    }) => void | Promise<void>;
    /** Disable the per-file in-memory id map when onAccepted owns conflicts. */
    trackConflicts?: boolean;
  } = {},
): Promise<LyncVerifyResult> {
  const byKind: Record<string, number> = {};
  const problems: LyncVerifyProblem[] = [];
  const digestById = new Map<string, string>();
  const conflictIds = new Set<string>();
  let lines = 0;
  let accepted = 0;

  const handle = await fs.open(filePath, "r");
  try {
    const chunk = Buffer.alloc(VERIFY_CHUNK_BYTES);
    // Bytes after the last newline seen so far, as a LIST of buffers: a single
    // event line larger than the chunk size accumulates one part per read and
    // is concatenated ONCE when its newline arrives (or at EOF). Concatenating
    // carry+chunk every read instead would re-copy the whole accumulated line
    // per 32MB read — O(line² / chunk) on multi-GB single-line pathologies.
    let carryParts: Buffer[] = [];
    let lineOffset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length);
      const atEof = bytesRead === 0;
      let piece: Buffer;
      if (atEof) {
        piece = carryParts.length === 1 ? carryParts[0] : Buffer.concat(carryParts);
        carryParts = [];
      } else {
        const read = chunk.subarray(0, bytesRead);
        const lastNl = read.lastIndexOf(0x0a);
        if (lastNl === -1) {
          // No complete line yet — keep accumulating (a single event line
          // can legitimately exceed the chunk size).
          carryParts.push(Buffer.from(read));
          continue;
        }
        piece = Buffer.concat([...carryParts, read.subarray(0, lastNl + 1)]);
        carryParts = [Buffer.from(read.subarray(lastNl + 1))];
      }
      if (piece.length > 0) {
        const result = parseLyncFiles([{ file: filePath, bytes: piece }]);
        for (const line of result.lines) {
          lines++;
          if (line.class === "accepted") {
            accepted++;
            const kind = line.event?.kind ?? "<unknown>";
            byKind[kind] = (byKind[kind] ?? 0) + 1;
            if (line.id && line.bodyDigest) {
              if (opts.trackConflicts !== false) {
                const seen = digestById.get(line.id);
                if (seen === undefined) digestById.set(line.id, line.bodyDigest);
                else if (seen !== line.bodyDigest) conflictIds.add(line.id);
              }
              await opts.onAccepted?.({
                id: line.id,
                bodyDigest: line.bodyDigest,
                line: lineOffset + line.line,
              });
            }
          } else {
            problems.push({
              line: lineOffset + line.line,
              class: line.class,
              reason: line.reason,
            });
          }
        }
        lineOffset += result.lines.length;
      }
      if (atEof) break;
    }
  } finally {
    await handle.close();
  }

  for (const id of conflictIds) {
    problems.push({
      line: -1,
      class: "conflict-variant",
      reason: `id ${id} appears with differing body bytes across the file`,
    });
  }

  return {
    ok: problems.length === 0 && accepted === lines && conflictIds.size === 0,
    counts: {
      lines,
      events: opts.trackConflicts === false ? accepted : digestById.size,
      accepted,
      byKind,
    },
    problems,
  };
}

/* ------------------------------ Batch convert ------------------------------ */

/** The per-file stats every session mapper owes the batch layer. */
export interface SessionMappingStats {
  /** Physical lines in the source file. */
  sourceLines: number;
  /** Events written for this file. */
  emitted: number;
  /** Lines that could not become events — explicit, never silent. */
  skipped: LyncSkippedRecord[];
  timestampFallbacks: LyncTimestampFallback[];
}

export interface SessionMappingResult {
  events: LyncEventBody[];
  stats: SessionMappingStats;
}

/**
 * Incremental per-line mapper for one session file: `mapLine` returns the
 * events the line produced (possibly none — then the line MUST land in the
 * mapper's skipped stats), and `finish` returns stats whose reconciliation
 * invariants the mapper checks loudly.
 */
export interface SessionLineMapper<
  TStats extends SessionMappingStats = SessionMappingStats,
> {
  mapLine(text: string, lineNo: number): LyncEventBody[];
  finish(): TStats;
}

/**
 * Build a per-file line mapper. `sessionLocator` is the normalized logical
 * root-relative path used in deterministic ids; `sourceRef` is the
 * path-or-ref used in author.source and payload source locators.
 */
export type SessionMapperFactory = (
  sessionLocator: string,
  sourceRef: string,
) => SessionLineMapper;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Identity contract for deterministic ids produced by session-tree imports.
 * A future incompatible locator/id change must bump this value and document
 * how generated outputs cross the boundary.
 */
export const SESSION_TREE_IMPORT_SCHEMA = "splice-session-tree/v1";

/** Versioned deterministic-id input; source references remain root-relative. */
export function sessionTreeIdentityLocator(relativePath: string): string {
  return `${SESSION_TREE_IMPORT_SCHEMA}:${sessionLogicalLocator(relativePath)}`;
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // mkdir's mode is filtered by umask and does not affect an existing path.
  // Trace destinations are private by contract, so enforce the final mode.
  await fs.chmod(dir, PRIVATE_DIRECTORY_MODE);
}

/**
 * Create missing parents privately without changing permissions on any
 * directory supplied by the caller. This is the single-file conversion
 * contract: the output file is ours; an existing parent is not.
 */
async function createMissingPrivateDirectories(dir: string): Promise<void> {
  const missing: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = await fs.stat(current);
      if (!stat.isDirectory()) {
        throw new Error(`session output parent is not a directory: ${current}`);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
  for (const next of missing.reverse()) {
    try {
      await fs.mkdir(next, { mode: PRIVATE_DIRECTORY_MODE });
      // mkdir is filtered by umask. Enforce exact privacy only for the path
      // this call actually created, never for a raced/existing directory.
      await fs.chmod(next, PRIVATE_DIRECTORY_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      const stat = await fs.stat(next);
      if (!stat.isDirectory()) throw err;
    }
  }
}

async function replaceGeneratedFile(
  stagedPath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await fs.rename(stagedPath, destinationPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (
      process.platform !== "win32" ||
      (code !== "EEXIST" && code !== "EPERM")
    ) {
      throw err;
    }
    // Windows cannot consistently rename over an existing file. Preserve
    // repeatability there with a remove-then-rename fallback; POSIX retains
    // atomic replacement and never takes this branch.
    await fs.rm(destinationPath, { force: true });
    await fs.rename(stagedPath, destinationPath);
  }
}

async function ensurePrivateDirectoryTree(
  rootDir: string,
  targetDir: string,
): Promise<void> {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetDir);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`session tree: output path escapes output root: ${target}`);
  }
  await ensurePrivateDirectory(root);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    await ensurePrivateDirectory(current);
  }
}

/** One session file that could not be read — explicit, never silent. */
export interface SessionUnreadableFile {
  file: string;
  reason: string;
}

/** Positively attributable failure while opening or reading a source file. */
export class SessionInputReadError extends Error {
  readonly code?: string;

  constructor(inputPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`cannot read session input ${inputPath}: ${detail}`, { cause });
    this.name = "SessionInputReadError";
    this.code = (cause as NodeJS.ErrnoException)?.code;
  }
}

export interface SessionTreeFileReport {
  /** Relative path under the input root. */
  file: string;
  outputPath: string;
  sourceLines: number;
  emitted: number;
  skipped: number;
  /** Lines the verifier accepted in the written `.lync` (=== emitted). */
  accepted: number;
}

export interface SessionTreeLyncResult {
  inputDir: string;
  outputDir: string;
  /** `.jsonl` files discovered under the root. */
  filesDiscovered: number;
  filesConverted: number;
  /** Files that could not be read — counted and named, never dropped. */
  filesUnreadable: SessionUnreadableFile[];
  /** Non-`.jsonl` files seen during discovery — named, not converted. */
  filesIgnored: string[];
  totalSourceLines: number;
  totalEmitted: number;
  /** Sum of per-file skipped-line entries. */
  totalSkipped: number;
  totalAccepted: number;
  byKind: Record<string, number>;
  files: SessionTreeFileReport[];
}

/**
 * Stream one session file through a line mapper into a written `.lync` file.
 * Input is read line-by-line and output written through a stream, so files
 * past V8's string limit convert without ever materializing whole.
 */
async function streamSessionFileToLync<
  TStats extends SessionMappingStats,
>(
  inputPath: string,
  outputPath: string,
  mapper: SessionLineMapper<TStats>,
): Promise<TStats> {
  await streamSessionFile(inputPath, outputPath, mapper);
  return mapper.finish();
}

async function streamSessionFile(
  inputPath: string,
  outputPath: string,
  mapper: SessionLineMapper,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath, {
      encoding: "utf8",
      flags: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    let input: ReturnType<typeof createReadStream> | undefined;
    let rl: readline.Interface | undefined;
    let settled = false;

    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      rl?.close();
      input?.destroy();
      if (err !== undefined) {
        output.destroy();
        reject(err);
      } else {
        resolve();
      }
    };

    // Output errors retain their original type: callers must never classify
    // create/write/chmod/rename failures as unreadable inputs.
    output.once("error", finish);
    output.once("open", () => {
      input = createReadStream(inputPath, { encoding: "utf8" });
      input.once("error", (err) =>
        finish(new SessionInputReadError(inputPath, err)),
      );
      rl = readline.createInterface({ input, crlfDelay: Infinity });
      // readline forwards input failures on its own emitter as well. Handle
      // that channel explicitly so a source EACCES/EIO cannot escape later as
      // an uncaught exception after the batch has accounted for the file.
      rl.once("error", (err) =>
        finish(new SessionInputReadError(inputPath, err)),
      );
      void (async () => {
        let lineNo = 0;
        for await (const line of rl!) {
          lineNo++;
          for (const ev of mapper.mapLine(line, lineNo)) {
            if (!output.write(`${serializeLyncEvent(ev)}\n`)) {
              await once(output, "drain");
            }
          }
        }
        if (settled) return;
        output.end(() => finish());
      })().catch(finish);
    });
  });
}

export interface SessionFileLyncConversion<
  TStats extends SessionMappingStats = SessionMappingStats,
> {
  outputPath: string;
  stats: TStats;
  verify: LyncVerifyResult;
}

/**
 * End-to-end for ONE session file, streaming throughout: map line-by-line,
 * write the `.lync`, then re-verify it chunked through @deepfates/lync. Throws
 * loudly on any non-accepted line or count drift.
 */
export async function convertSessionFileToLync<
  TStats extends SessionMappingStats,
>(
  inputPath: string,
  outputPath: string,
  mapper: SessionLineMapper<TStats>,
): Promise<SessionFileLyncConversion<TStats>> {
  const resolvedOutput = path.resolve(outputPath);
  const outputDir = path.dirname(resolvedOutput);
  await createMissingPrivateDirectories(outputDir);
  const tempPath = path.join(
    outputDir,
    `.${path.basename(resolvedOutput)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const stats = await streamSessionFileToLync(inputPath, tempPath, mapper);
    await fs.chmod(tempPath, PRIVATE_FILE_MODE);
    const verify = await verifyLyncFileStreaming(tempPath);
    if (!verify.ok) {
      throw new Error(
        `lync verify failed for ${outputPath}: ${JSON.stringify(verify.problems.slice(0, 10))}`,
      );
    }
    if (verify.counts.accepted !== stats.emitted) {
      throw new Error(
        `lync verify count mismatch for ${outputPath}: wrote ${stats.emitted}, accepted ${verify.counts.accepted}`,
      );
    }
    await replaceGeneratedFile(tempPath, resolvedOutput);
    return { outputPath, stats, verify };
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Convert every `.jsonl` session file under `inputDir` to a mirrored `.lync`
 * file under `outputDir`, verifying each written file with @deepfates/lync.
 *
 * File-level accounting is loud: converted + unreadable === discovered, every
 * per-file mapping must reconcile (the mappers throw when theirs does not),
 * and any verifier-rejected line fails the whole batch.
 */
export async function convertSessionTreeToLync(
  inputDir: string,
  outputDir: string,
  mapperFor: SessionMapperFactory,
): Promise<SessionTreeLyncResult> {
  const scan = await scanSessionTree(inputDir);
  const locatorByFile = preflightSessionLogicalLocators(scan.jsonlFiles);
  await ensurePrivateDirectory(outputDir);
  const filesUnreadable: SessionUnreadableFile[] = [];
  const files: SessionTreeFileReport[] = [];
  const byKind: Record<string, number> = {};
  let totalSourceLines = 0;
  let totalEmitted = 0;
  let totalSkipped = 0;
  let totalAccepted = 0;

  for (const rel of scan.jsonlFiles) {
    const inputPath = path.join(inputDir, rel);
    const outputPath = path.join(outputDir, rel.replace(/\.jsonl$/, ".lync"));
    const sessionLocator = locatorByFile.get(rel)!;
    const identityLocator = sessionTreeIdentityLocator(sessionLocator);
    let converted: SessionFileLyncConversion;
    try {
      // Readability is probed by the stream itself: an unreadable file fails
      // here and is recorded; atomic staging leaves any prior verified output
      // intact. Verify failures are NOT readability and re-throw loudly below.
      await ensurePrivateDirectoryTree(outputDir, path.dirname(outputPath));
      converted = await convertSessionFileToLync(
        inputPath,
        outputPath,
        mapperFor(identityLocator, sessionLocator),
      );
    } catch (err) {
      if (err instanceof SessionInputReadError) {
        filesUnreadable.push({
          file: rel,
          reason: err instanceof Error ? err.message : String(err),
        });
        // Conversion writes only to an adjacent temporary file until verify
        // succeeds, so a prior verified destination remains authoritative.
        continue;
      }
      throw err;
    }
    const { stats, verify } = converted;

    for (const [kind, n] of Object.entries(verify.counts.byKind)) {
      byKind[kind] = (byKind[kind] ?? 0) + n;
    }
    totalSourceLines += stats.sourceLines;
    totalEmitted += stats.emitted;
    totalSkipped += stats.skipped.length;
    totalAccepted += verify.counts.accepted;
    files.push({
      file: rel,
      outputPath,
      sourceLines: stats.sourceLines,
      emitted: stats.emitted,
      skipped: stats.skipped.length,
      accepted: verify.counts.accepted,
    });
  }

  if (files.length + filesUnreadable.length !== scan.jsonlFiles.length) {
    // Structurally impossible, but the file-accounting invariant is the whole
    // point of the batch layer — fail loudly rather than miscount silently.
    throw new Error(
      `session tree: file counts do not reconcile: ${files.length} converted + ${filesUnreadable.length} unreadable !== ${scan.jsonlFiles.length} discovered`,
    );
  }

  return {
    inputDir,
    outputDir,
    filesDiscovered: scan.jsonlFiles.length,
    filesConverted: files.length,
    filesUnreadable,
    filesIgnored: scan.ignoredFiles,
    totalSourceLines,
    totalEmitted,
    totalSkipped,
    totalAccepted,
    byKind,
    files,
  };
}
