/**
 * Media Analysis Cache
 *
 * Content-addressed cache for VLM analysis results.
 * Follows the pattern from curare's embedding cache.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { MediaAnalysis } from "../core/media-types";
import type { Level } from "../core/types";

/**
 * Cache entry structure
 */
interface CacheEntry {
  analysis: MediaAnalysis;
  cachedAt: string;
}

/**
 * Cache file structure
 */
interface CacheFile {
  version: string;
  promptVersion: string;
  entries: Record<string, CacheEntry>;
}

const CACHE_VERSION = "1";

/**
 * Analysis cache with content-addressed keys
 */
export class AnalysisCache {
  private entries: Map<string, CacheEntry> = new Map();
  private dirty = false;
  private promptVersion: string;
  private cachePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs = 5000; // Save at most every 5 seconds

  constructor(cachePath: string, promptVersion: string) {
    this.cachePath = cachePath;
    this.promptVersion = promptVersion;
  }

  /**
   * Load cache from disk
   */
  async load(logger: (l: Level, m: string) => void): Promise<void> {
    try {
      const data = await fs.readFile(this.cachePath, "utf8");
      const parsed: CacheFile = JSON.parse(data);

      // Check version compatibility
      if (parsed.version !== CACHE_VERSION) {
        logger("warn", `Cache version mismatch (${parsed.version} vs ${CACHE_VERSION}), starting fresh`);
        return;
      }

      // Check prompt version - invalidate if changed
      if (parsed.promptVersion !== this.promptVersion) {
        logger("info", `Prompt version changed (${parsed.promptVersion} → ${this.promptVersion}), reanalyzing`);
        return;
      }

      this.entries = new Map(Object.entries(parsed.entries));
      logger("info", `Loaded ${this.entries.size} cached analyses`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger("warn", `Failed to load cache: ${error}`);
      }
    }
  }

  /**
   * Save cache to disk
   */
  async save(logger: (l: Level, m: string) => void): Promise<void> {
    if (!this.dirty) return;

    const cacheFile: CacheFile = {
      version: CACHE_VERSION,
      promptVersion: this.promptVersion,
      entries: Object.fromEntries(this.entries),
    };

    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.writeFile(this.cachePath, JSON.stringify(cacheFile, null, 2));
      this.dirty = false;
      logger("info", `Saved ${this.entries.size} analyses to cache`);
    } catch (error) {
      logger("error", `Failed to save cache: ${error}`);
    }
  }

  /**
   * Schedule an incremental save (debounced to avoid excessive disk writes)
   */
  saveIncremental(logger: (l: Level, m: string) => void): void {
    if (this.saveTimer) return; // Already scheduled
    
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.save(logger);
    }, this.saveDebounceMs);
  }

  /**
   * Flush any pending saves immediately
   */
  async flush(logger: (l: Level, m: string) => void): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save(logger);
  }

  /**
   * Get cached analysis by content hash
   */
  get(contentHash: string): MediaAnalysis | undefined {
    const key = this.makeKey(contentHash);
    return this.entries.get(key)?.analysis;
  }

  /**
   * Store analysis in cache
   */
  set(contentHash: string, analysis: MediaAnalysis): void {
    const key = this.makeKey(contentHash);
    this.entries.set(key, {
      analysis,
      cachedAt: new Date().toISOString(),
    });
    this.dirty = true;
  }

  /**
   * Check if content hash is cached
   */
  has(contentHash: string): boolean {
    return this.entries.has(this.makeKey(contentHash));
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Generate cache key from content hash
   */
  private makeKey(contentHash: string): string {
    return `${contentHash}:${this.promptVersion}`;
  }
}

/**
 * Compute SHA256 hash of file content
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA256 hash of buffer
 */
export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Get default cache path for an output directory
 */
export function getDefaultCachePath(outDir: string): string {
  return path.join(outDir, ".splice", "media-analysis-cache.json");
}
