/**
 * Public library API
 *
 * This module re-exports the core types, utilities, source adapters, transforms,
 * and output writers so consumers can:
 * - Import only the pieces they need
 * - Plug in proprietary/custom sources or outputs without forking
 * - Compose their own pipelines programmatically
 *
 * Backwards-compatibility
 * - The CLI uses the same functions exported here.
 * - These extension interfaces (SourceAdapter/Transform/OutputAdapter) are intended
 *   to remain stable; changes will be signaled with semver.
 */

// Re-export shared types, args, logger, and utilities
export * from "./core/types";

// Re-export built-in Sources
export * from "./sources/twitter";
export * from "./sources/bluesky";
export * from "./sources/glowfic";

// Re-export built-in Transforms
export * from "./transforms/core";

// Re-export built-in Outputs
export {
  writeMarkdown,
  writeOAI,
  writeNormalizedJSONL,
  writeShareGPT,
  writeStatsJSON,
} from "./outputs/writers";

/* ------------------------------- Extensions ------------------------------- */

import type { Level, ContentItem, Thread } from "./core/types";

/**
 * Logger signature used across the pipeline
 */
export type Logger = (level: Level, message: string) => void;

/**
 * A pluggable input adapter for new sources (e.g., Bluesky, ChatGPT exports, custom archives).
 * Implementors normalize their inputs to ContentItem[] and preserve rich metadata in `raw`.
 */
export interface SourceAdapter {
  kind: string; // e.g., "twitter", "bluesky", "chatgpt", "custom:foo"
  detect(pathOrUri: string): Promise<boolean>;
  ingest(pathOrUri: string, log: Logger): Promise<ContentItem[]>;
}

/**
 * Generic transform step. Keep these pure where possible so results
 * can be cached by input hash + config hash when we add checkpointing.
 */
export interface Transform<Input, Output> {
  name: string; // e.g., "filter", "group:threads", "score:length"
  apply(
    input: Input,
    config: Record<string, unknown>,
  ): Promise<{ output: Output; stats?: Record<string, number> }>;
}

/**
 * Context provided to OutputAdapters.
 */
export interface OutputAdapterContext {
  outDir: string;
  dryRun?: boolean;
  logger: Logger;
}

/**
 * Arguments passed to OutputAdapters.
 * Consumers can pass only what their adapter needs; undefined fields can be ignored.
 */
export interface OutputWriteArgs {
  items?: ContentItem[];
  threads?: Thread[];
  conversations?: ContentItem[][];
  systemMessage?: string;
  // room for future fields (e.g., selection metadata, annotations, etc.)
  [key: string]: unknown;
}

/**
 * A pluggable output adapter for new render targets.
 * Examples: proprietary JSONL, HTML site, custom training data, etc.
 */
export interface OutputAdapter {
  name: string; // e.g., "markdown", "oai", "custom:myformat"
  write(args: OutputWriteArgs, ctx: OutputAdapterContext): Promise<void>;
}
