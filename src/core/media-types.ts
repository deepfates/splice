/**
 * Media Analysis Types
 *
 * Defines the schema for VLM-powered content analysis of images and videos.
 */

/**
 * Result of VLM analysis on a single media file
 */
export interface MediaAnalysis {
  /** 1-2 sentence description */
  caption: string;

  /** Detailed multi-paragraph description */
  description: string;

  /** Extracted text from image (OCR) */
  ocrText?: string;

  /** Human-readable deterministic identifier */
  slug: string;

  /** SHA256 of file content (for dedup) */
  contentHash: string;

  /** Hash of (contentHash + promptVersion) for cache invalidation */
  analysisHash: string;

  /** Semantic tags extracted from content */
  tags?: string[];

  /** CLIP embedding if enabled */
  embedding?: number[];

  /** VLM provider used (e.g., "gemini", "ollama:llava") */
  provider: string;

  /** Prompt version for cache invalidation */
  promptVersion: string;

  /** ISO timestamp of analysis */
  analyzedAt: string;
}

/**
 * Extended analysis for video files
 */
export interface VideoAnalysis extends MediaAnalysis {
  /** Duration in seconds */
  duration: number;

  /** Per-frame analysis */
  frames: Array<{
    /** Timestamp in seconds */
    timestamp: number;
    /** Hash of frame image */
    frameHash: string;
    /** Caption for this frame */
    caption: string;
  }>;

  /** Audio transcription (future) */
  transcription?: string;
}

/**
 * Configuration for media analysis
 */
export interface MediaAnalysisConfig {
  /** VLM provider to use */
  provider: "gemini" | "ollama" | "openai" | "lmstudio";

  /** Model override (e.g., "gemini-2.0-flash", "llava:13b") */
  model?: string;

  /** Parallel analysis jobs */
  concurrency: number;

  /** Generate CLIP embeddings */
  embedMedia: boolean;

  /** Skip video analysis */
  skipVideo: boolean;

  /** Frame interval for video (seconds) */
  videoFrameInterval: number;

  /** Max image dimension (pixels) for preprocessing. 0 = no resize */
  maxImageSize: number;

  /** Path to analysis cache */
  cachePath?: string;
}

/**
 * Default configuration
 */
export const DEFAULT_MEDIA_ANALYSIS_CONFIG: MediaAnalysisConfig = {
  provider: "gemini",
  concurrency: 10,
  embedMedia: false,
  skipVideo: false,
  videoFrameInterval: 5,
  maxImageSize: 1024, // Resize to max 1024px for faster inference
};

/**
 * VLM analysis result from a provider
 */
export interface VLMAnalysisResult {
  caption: string;
  description: string;
  ocrText?: string;
  tags?: string[];
}
