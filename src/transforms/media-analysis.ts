/**
 * Media Analysis Transform
 *
 * VLM-powered analysis of images and videos in content items.
 * Generates captions, descriptions, OCR text, and semantic slugs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ContentItem, Level, MediaAttachment } from "../core/types";
import type {
  MediaAnalysis,
  MediaAnalysisConfig,
  VLMAnalysisResult,
} from "../core/media-types";
import { DEFAULT_MEDIA_ANALYSIS_CONFIG } from "../core/media-types";
import { getProvider, PROMPT_VERSION } from "../vlm/index";
import type { VLMProvider } from "../vlm/providers";
import {
  AnalysisCache,
  hashFile,
  getDefaultCachePath,
} from "./media-cache";

/**
 * Stopwords to filter from slug generation
 */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "of", "in", "to",
  "for", "with", "on", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "under",
  "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "each", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "and", "but", "if", "or", "because", "until",
  "while", "this", "that", "these", "those", "image", "picture", "photo",
  "shows", "showing", "depicts", "depicting", "features", "featuring",
]);

/**
 * Generate a human-readable slug from analysis
 */
export function generateSlug(analysis: VLMAnalysisResult, contentHash: string): string {
  const words = analysis.caption
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 4);

  const shortHash = contentHash.slice(0, 8);

  if (words.length === 0) {
    return `media_${shortHash}`;
  }

  return [...words, shortHash].join("_");
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Check if file is a video by extension
 */
function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".mp4", ".mov", ".webm", ".avi", ".mkv"].includes(ext);
}

/**
 * Preprocess image: resize if larger than maxSize
 * Uses native macOS sips for fast resizing based on ACTUAL dimensions, not file size
 */
async function preprocessImage(
  buffer: Buffer,
  filePath: string,
  maxSize: number,
  logger: (l: Level, m: string) => void,
): Promise<Buffer> {
  // Skip if no preprocessing needed or not an image
  if (maxSize <= 0 || isVideoFile(filePath)) {
    return buffer;
  }

  // Use macOS sips to check actual dimensions and resize if needed
  if (process.platform === "darwin") {
    try {
      const { execSync } = await import("node:child_process");
      const os = await import("node:os");
      
      // Create temp file
      const ext = path.extname(filePath).toLowerCase();
      const tmpFile = path.join(os.tmpdir(), `splice-resize-${Date.now()}${ext}`);
      await fs.writeFile(tmpFile, buffer);
      
      // Get actual dimensions using sips
      const sipsOutput = execSync(`sips -g pixelWidth -g pixelHeight "${tmpFile}" 2>/dev/null`, {
        encoding: "utf-8",
      });
      
      // Parse dimensions: "pixelWidth: 1234\n  pixelHeight: 5678"
      const widthMatch = sipsOutput.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = sipsOutput.match(/pixelHeight:\s*(\d+)/);
      const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
      const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
      
      // Check if resize is needed based on ACTUAL dimensions
      if (width <= maxSize && height <= maxSize) {
        await fs.unlink(tmpFile).catch(() => {});
        return buffer; // Already small enough
      }
      
      logger("debug", `Image ${path.basename(filePath)} is ${width}x${height}, resizing to max ${maxSize}...`);
      
      // Resize with sips (preserves aspect ratio)
      execSync(`sips --resampleHeightWidthMax ${maxSize} "${tmpFile}" 2>/dev/null`, {
        stdio: "pipe",
      });
      
      // Read resized file
      const resized = await fs.readFile(tmpFile);
      await fs.unlink(tmpFile).catch(() => {});
      
      logger("debug", `Resized ${path.basename(filePath)}: ${width}x${height} → max ${maxSize}, ${buffer.length} → ${resized.length} bytes`);
      return resized;
    } catch (error) {
      logger("debug", `sips resize failed, using original: ${error}`);
    }
  }

  return buffer;
}

/**
 * Analyze a single media file
 */
async function analyzeMediaFile(
  media: MediaAttachment,
  provider: VLMProvider,
  cache: AnalysisCache,
  logger: (l: Level, m: string) => void,
  skipVideo: boolean,
  maxImageSize: number,
): Promise<MediaAnalysis | null> {
  if (!media.absPath) {
    logger("debug", `Skipping media ${media.id}: no local path`);
    return null;
  }

  // Skip videos if configured (check by extension since contentType may be wrong)
  if (skipVideo && isVideoFile(media.absPath)) {
    logger("debug", `Skipping video ${media.id}`);
    return null;
  }

  try {
    // Check if file exists
    await fs.access(media.absPath);
  } catch {
    logger("warn", `Media file not found: ${media.absPath}`);
    return null;
  }

  // Compute content hash
  const contentHash = await hashFile(media.absPath);

  // Check cache
  const cached = cache.get(contentHash);
  if (cached) {
    logger("debug", `Cache hit for ${media.id}`);
    return cached;
  }

  logger("debug", `Analyzing ${media.id}...`);

  // Try with progressively smaller sizes if model crashes (OOM)
  const sizesToTry = [maxImageSize, 768, 512, 384];
  let lastError: Error | null = null;

  for (const size of sizesToTry) {
    if (size <= 0 || size > maxImageSize) continue; // Skip if disabled or larger than requested
    
    try {
      // Read file and preprocess
      let buffer = await fs.readFile(media.absPath);
      if (size > 0) {
        buffer = await preprocessImage(buffer, media.absPath, size, logger);
      }
      const mimeType = getMimeType(media.absPath);

      const result = await provider.analyze(buffer, mimeType);
      const slug = generateSlug(result, contentHash);

      const analysis: MediaAnalysis = {
        caption: result.caption,
        description: result.description,
        ocrText: result.ocrText,
        tags: result.tags,
        slug,
        contentHash,
        analysisHash: `${contentHash}:${PROMPT_VERSION}`,
        provider: provider.name,
        promptVersion: PROMPT_VERSION,
        analyzedAt: new Date().toISOString(),
      };

      // Store in cache
      cache.set(contentHash, analysis);

      return analysis;
    } catch (error) {
      lastError = error as Error;
      const errorMsg = String(error);
      
      // Check if this is a crash/OOM that might benefit from smaller size
      if (errorMsg.includes("crashed") || errorMsg.includes("Exit code: 11")) {
        logger("warn", `Model crashed on ${media.id} at ${size}px, waiting for model reload...`);
        
        // Wait for LM Studio model to be available again (up to 30s)
        const host = process.env.LMSTUDIO_HOST || "http://localhost:1234";
        const startTime = Date.now();
        let modelAvailable = false;
        while (Date.now() - startTime < 30000) {
          try {
            const resp = await fetch(`${host}/v1/models`);
            if (resp.ok) {
              const data = (await resp.json()) as { data?: Array<{ id: string }> };
              if (data.data && data.data.length > 0) {
                modelAvailable = true;
                logger("debug", `Model reloaded, retrying with smaller size...`);
                break;
              }
            }
          } catch {
            // Model not ready yet
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        
        if (!modelAvailable) {
          logger("error", `Model did not reload within 30s, giving up on ${media.id}`);
          break;
        }
        continue;
      }
      
      // Other errors - don't retry
      break;
    }
  }

  logger("error", `Failed to analyze ${media.id}: ${lastError}`);
  return null;
}

/**
 * Process items with bounded concurrency
 */
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await processor(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return results;
}

/**
 * Analyze all media in content items
 *
 * This transform enriches MediaAttachment.metadata with analysis results.
 */
export async function analyzeMedia(
  items: ContentItem[],
  config: Partial<MediaAnalysisConfig>,
  outDir: string,
  logger: (l: Level, m: string) => void,
): Promise<ContentItem[]> {
  const cfg: MediaAnalysisConfig = { ...DEFAULT_MEDIA_ANALYSIS_CONFIG, ...config };

  // Collect all media files
  const mediaItems: Array<{ item: ContentItem; media: MediaAttachment; index: number }> = [];
  for (const item of items) {
    if (!item.media) continue;
    for (let i = 0; i < item.media.length; i++) {
      const media = item.media[i];
      // Skip videos if configured
      if (cfg.skipVideo && media.contentType === "video") continue;
      mediaItems.push({ item, media, index: i });
    }
  }

  if (mediaItems.length === 0) {
    logger("info", "No media files to analyze");
    return items;
  }

  logger("info", `Analyzing ${mediaItems.length} media files with ${cfg.provider}...`);

  // Initialize provider and cache
  const provider = await getProvider(cfg.provider, cfg.model);
  const cachePath = cfg.cachePath || getDefaultCachePath(outDir);
  const cache = new AnalysisCache(cachePath, PROMPT_VERSION);
  await cache.load(logger);

  // Adjust concurrency for local vs API
  // Local providers can handle ~3 concurrent requests for 2x speedup
  const concurrency = (cfg.provider === "ollama" || cfg.provider === "lmstudio") ? 3 : cfg.concurrency;

  // Track progress
  let processed = 0;
  let cached = 0;
  let failed = 0;

  // Process media with bounded concurrency
  await processWithConcurrency(
    mediaItems,
    concurrency,
    async ({ item, media, index }) => {
      // Check if this item is already cached (before analysis)
      const contentHash = media.absPath ? await hashFile(media.absPath) : null;
      const wasCached = contentHash ? cache.has(contentHash) : false;
      
      const analysis = await analyzeMediaFile(media, provider, cache, logger, cfg.skipVideo, cfg.maxImageSize);

      if (analysis) {
        // Enrich the media attachment with analysis
        if (!media.metadata) media.metadata = {};
        media.metadata.analysis = analysis;

        if (wasCached) {
          cached++;
        }
        processed++;
        
        // Incremental save for crash recovery (debounced)
        cache.saveIncremental(logger);
      } else {
        failed++;
      }

      // Log progress every 10 items
      if ((processed + failed) % 10 === 0) {
        logger("info", `Progress: ${processed + failed}/${mediaItems.length} (${cached} cached, ${failed} failed)`);
      }
    },
  );

  // Flush any pending saves
  await cache.flush(logger);

  logger("info", `Analysis complete: ${processed} processed, ${cached} from cache, ${failed} failed`);

  return items;
}

/**
 * Extract text description from media for inclusion in text content
 */
export function formatMediaDescription(analysis: MediaAnalysis): string {
  const parts = [`[Image: ${analysis.caption}]`];

  if (analysis.ocrText) {
    parts.push(`Text in image: "${analysis.ocrText}"`);
  }

  return parts.join(" ");
}

/**
 * Inject media descriptions into item text
 */
export function injectMediaDescriptions(items: ContentItem[]): ContentItem[] {
  return items.map((item) => {
    if (!item.media || item.media.length === 0) return item;

    const descriptions: string[] = [];
    for (const media of item.media) {
      const analysis = media.metadata?.analysis as MediaAnalysis | undefined;
      if (analysis) {
        descriptions.push(formatMediaDescription(analysis));
      }
    }

    if (descriptions.length === 0) return item;

    return {
      ...item,
      text: item.text + "\n\n" + descriptions.join("\n"),
    };
  });
}
