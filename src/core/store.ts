import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ContentItem, Thread, Level } from "./types";

/**
 * Minimal JSONL-based filesystem store for checkpoints and artifacts.
 * - Content-addressed objects under <workspace>/objects/<sha256>.{json|jsonl}
 * - Checkpoint manifests under <workspace>/checkpoints/<id>.json
 */

export const SCHEMA_VERSION = "0.1.0";

/* ------------------------------ Type contracts ------------------------------ */

export type Logger = (level: Level, message: string) => void;

export interface CheckpointManifest {
  id: string;
  createdAt: string; // ISO
  schemaVersion: string; // bump on breaking changes
  parentId?: string | null;

  // Provenance for sources (freeform; useful for incremental ingest later)
  sourceRefs: Array<{ kind: string; uri?: string; cursor?: string }>;

  // Primary normalized input
  inputs: {
    itemsRef: string; // ref to JSONL of ContentItem
  };

  // Pure transforms applied to inputs or intermediate refs
  transforms: Array<{
    name: string; // e.g., "filter:minLength=30"
    config: Record<string, unknown>;
    inputRef: string;
    outputRef: string;
    stats?: Record<string, number>;
  }>;

  // Optional manual decisions (append-only JSONL)
  decisionsRef?: string;

  // Materialized selections/groups for fast output
  materialized?: {
    threadsRef?: string; // JSON of Thread[] or JSONL of ids (future)
    conversationsRef?: string; // JSON of ContentItem[][] (or id lists)
  };

  notes?: string;
}

export interface Store {
  putObject(obj: unknown, opts?: { kind?: string }): Promise<string>;
  putJSONL<T>(
    iterable: Iterable<T> | AsyncIterable<T>,
    opts?: { kind?: string },
  ): Promise<string>;

  getObject<T = unknown>(ref: string): Promise<T>;
  getJSONL<T = unknown>(ref: string): AsyncIterable<T>;

  saveCheckpoint(manifest: CheckpointManifest): Promise<string>;
  readCheckpoint(id: string): Promise<CheckpointManifest>;
  listCheckpoints(): Promise<CheckpointManifest[]>;
  resolveLatestCheckpoint(): Promise<CheckpointManifest | null>;
}

/* -------------------------------- Utilities -------------------------------- */

async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

function stableStringify(value: unknown): string {
  // Deterministic JSON stringify (sort object keys)
  const seen = new WeakSet<object>();
  const stringify = (v: any): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (seen.has(v)) throw new TypeError("Converting circular structure to JSON");
    seen.add(v);
    if (Array.isArray(v)) {
      const out = "[" + v.map((x) => stringify(x)).join(",") + "]";
      seen.delete(v);
      return out;
    }
    const keys = Object.keys(v).sort();
    const body = keys.map((k) => JSON.stringify(k) + ":" + stringify(v[k])).join(",");
    const out = "{" + body + "}";
    seen.delete(v);
    return out;
  };
  return stringify(value);
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hashInit() {
  return createHash("sha256");
}
function hashUpdate(h: ReturnType<typeof createHash>, s: string) {
  h.update(s);
}
function hashDigest(h: ReturnType<typeof createHash>): string {
  return h.digest("hex");
}

type RefKind = "json" | "jsonl";
type Ref = { kind: RefKind; hash: string };

function makeRef(kind: RefKind, hash: string): string {
  return `${kind}:${hash}`;
}
function parseRef(ref: string): Ref {
  const [kind, hash] = ref.split(":");
  if ((kind !== "json" && kind !== "jsonl") || !hash) {
    throw new Error(`Invalid ref: ${ref}`);
  }
  return { kind: kind as RefKind, hash };
}

/**
 * Read a file line-by-line and yield parsed JSON per line.
 */
async function* readJSONL<T = unknown>(filePath: string): AsyncIterable<T> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      yield JSON.parse(line) as T;
    }
  }
  const last = buffer.trim();
  if (last) yield JSON.parse(last) as T;
}

/* --------------------------------- FsStore --------------------------------- */

export class FsStore implements Store {
  private root: string;
  private objectsDir: string;
  private checkpointsDir: string;
  private log: Logger;

  constructor(workspaceDir: string, logger?: Logger) {
    this.root = path.resolve(workspaceDir);
    this.objectsDir = path.join(this.root, "objects");
    this.checkpointsDir = path.join(this.root, "checkpoints");
    this.log = logger ?? (() => {});
  }

  private async init() {
    await ensureDir(this.objectsDir);
    await ensureDir(this.checkpointsDir);
  }

  private objectPath(kind: RefKind, hash: string): string {
    return path.join(this.objectsDir, `${hash}.${kind}`);
  }

  async putObject(obj: unknown, _opts?: { kind?: string }): Promise<string> {
    await this.init();
    const json = stableStringify(obj);
    const hash = hashString(json);
    const ref = makeRef("json", hash);
    const p = this.objectPath("json", hash);
    try {
      await fsp.stat(p); // exists
      this.log("debug", `putObject: reuse ${ref}`);
      return ref;
    } catch {
      // fallthrough
    }
    await fsp.writeFile(p, json, "utf8");
    this.log("info", `putObject: wrote ${ref}`);
    return ref;
  }

  async putJSONL<T>(
    iterable: Iterable<T> | AsyncIterable<T>,
    _opts?: { kind?: string },
  ): Promise<string> {
    await this.init();
    // Write to temp, compute hash while writing lines
    const tmpName = `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tmpPath = path.join(this.objectsDir, tmpName);
    const fh = await fsp.open(tmpPath, "w");
    const h = hashInit();
    try {
      for await (const item of iterable as any) {
        const line = JSON.stringify(item) + "\n";
        await fh.write(line);
        hashUpdate(h, line);
      }
    } finally {
      await fh.close();
    }
    const hash = hashDigest(h);
    const ref = makeRef("jsonl", hash);
    const finalPath = this.objectPath("jsonl", hash);
    // If already exists, remove temp and reuse existing
    try {
      await fsp.stat(finalPath);
      await fsp.rm(tmpPath).catch(() => {});
      this.log("debug", `putJSONL: reuse ${ref}`);
      return ref;
    } catch {
      // rename temp into place
      await fsp.rename(tmpPath, finalPath);
      this.log("info", `putJSONL: wrote ${ref}`);
      return ref;
    }
  }

  async getObject<T = unknown>(ref: string): Promise<T> {
    await this.init();
    const { kind, hash } = parseRef(ref);
    if (kind !== "json") throw new Error(`getObject expects json ref, got ${ref}`);
    const p = this.objectPath(kind, hash);
    const data = await fsp.readFile(p, "utf8");
    return JSON.parse(data) as T;
  }

  getJSONL<T = unknown>(ref: string): AsyncIterable<T> {
    const { kind, hash } = parseRef(ref);
    if (kind !== "jsonl") {
      throw new Error(`getJSONL expects jsonl ref, got ${ref}`);
    }
    const p = this.objectPath(kind, hash);
    return readJSONL<T>(p);
  }

  async saveCheckpoint(manifest: CheckpointManifest): Promise<string> {
    await this.init();
    const id = manifest.id || this.generateCheckpointId(manifest);
    const full: CheckpointManifest = {
      ...manifest,
      id,
      schemaVersion: manifest.schemaVersion || SCHEMA_VERSION,
      createdAt: manifest.createdAt || new Date().toISOString(),
    };
    const p = path.join(this.checkpointsDir, `${id}.json`);
    await fsp.writeFile(p, stableStringify(full), "utf8");
    this.log("info", `saveCheckpoint: ${id}`);
    return id;
  }

  async readCheckpoint(id: string): Promise<CheckpointManifest> {
    await this.init();
    const p = path.join(this.checkpointsDir, `${id}.json`);
    const data = await fsp.readFile(p, "utf8");
    return JSON.parse(data) as CheckpointManifest;
  }

  async listCheckpoints(): Promise<CheckpointManifest[]> {
    await this.init();
    let files: string[] = [];
    try {
      files = await fsp.readdir(this.checkpointsDir);
    } catch {
      return [];
    }
    const out: CheckpointManifest[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = await fsp.readFile(path.join(this.checkpointsDir, f), "utf8");
        const m = JSON.parse(data) as CheckpointManifest;
        out.push(m);
      } catch {
        // skip invalid files
      }
    }
    out.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    return out;
  }

  async resolveLatestCheckpoint(): Promise<CheckpointManifest | null> {
    const list = await this.listCheckpoints();
    if (!list.length) return null;
    return list[list.length - 1];
  }

  private generateCheckpointId(manifest: Partial<CheckpointManifest>): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const basis = stableStringify({
      parentId: manifest.parentId ?? null,
      inputs: manifest.inputs ?? {},
      transforms: manifest.transforms ?? [],
      notes: manifest.notes ?? "",
    });
    const short = hashString(basis).slice(0, 8);
    return `${stamp}-${short}`;
  }
}

/* ------------------------ Convenience manifest builders ----------------------- */

export function createCheckpointManifest(args: {
  parentId?: string | null;
  itemsRef: string;
  sourceRefs?: Array<{ kind: string; uri?: string; cursor?: string }>;
  transforms?: CheckpointManifest["transforms"];
  decisionsRef?: string;
  materialized?: CheckpointManifest["materialized"];
  notes?: string;
}): CheckpointManifest {
  const now = new Date().toISOString();
  return {
    id: "",
    createdAt: now,
    schemaVersion: SCHEMA_VERSION,
    parentId: args.parentId ?? null,
    sourceRefs: args.sourceRefs ?? [],
    inputs: { itemsRef: args.itemsRef },
    transforms: args.transforms ?? [],
    decisionsRef: args.decisionsRef,
    materialized: args.materialized,
    notes: args.notes,
  };
}

/* ------------------------- Typed helpers for common refs ---------------------- */

// Helpers to store common structures and return refs

export async function storeItemsJSONL(
  store: Store,
  items: Iterable<ContentItem> | AsyncIterable<ContentItem>,
): Promise<string> {
  return store.putJSONL(items, { kind: "items" });
}

export async function storeThreadsJSON(
  store: Store,
  threads: Thread[],
): Promise<string> {
  return store.putObject(threads, { kind: "threads" });
}

export async function storeConversationsJSON(
  store: Store,
  conversations: ContentItem[][],
): Promise<string> {
  return store.putObject(conversations, { kind: "conversations" });
}
