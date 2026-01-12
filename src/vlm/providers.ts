/**
 * VLM Provider Abstraction
 *
 * Pluggable interface for vision-language models. Supports both API-based
 * (Gemini, OpenAI) and local (Ollama) providers.
 */

import type { VLMAnalysisResult } from "../core/media-types";

/**
 * Abstract interface for VLM providers
 */
export interface VLMProvider {
  /** Provider identifier (e.g., "gemini", "ollama:llava") */
  readonly name: string;

  /** Analyze an image and return structured results */
  analyze(image: Buffer, mimeType: string): Promise<VLMAnalysisResult>;

  /** Whether this provider supports video frame analysis */
  readonly supportsVideo: boolean;
}

/**
 * Factory function signature for creating providers
 */
export type VLMProviderFactory = (model?: string) => Promise<VLMProvider>;

/**
 * Registry of available providers
 */
const providers = new Map<string, VLMProviderFactory>();

/**
 * Register a VLM provider factory
 */
export function registerProvider(name: string, factory: VLMProviderFactory): void {
  providers.set(name, factory);
}

/**
 * Get a VLM provider by name
 */
export async function getProvider(
  name: string,
  model?: string,
): Promise<VLMProvider> {
  const factory = providers.get(name);
  if (!factory) {
    throw new Error(
      `Unknown VLM provider: ${name}. Available: ${[...providers.keys()].join(", ")}`,
    );
  }
  return factory(model);
}

/**
 * List available provider names
 */
export function listProviders(): string[] {
  return [...providers.keys()];
}

/**
 * Standard analysis prompt for consistent results across providers
 */
export const ANALYSIS_PROMPT = `Analyze this image in detail. Provide:

1. CAPTION: A single sentence (max 20 words) describing the main subject and action.

2. DESCRIPTION: A detailed paragraph describing:
   - What is shown (objects, people, scenes)
   - Visual style (photo, illustration, meme, screenshot, etc.)
   - Mood or tone
   - Any notable details or context

3. OCR_TEXT: If there is any text visible in the image, transcribe it exactly. If no text, write "NONE".

4. TAGS: 3-7 descriptive tags as a comma-separated list.

Format your response EXACTLY as:
CAPTION: <your caption>
DESCRIPTION: <your description>
OCR_TEXT: <transcribed text or NONE>
TAGS: <tag1, tag2, tag3, ...>`;

/**
 * Current prompt version - increment when prompt changes to invalidate cache
 */
export const PROMPT_VERSION = "v1";

/**
 * Parse a VLM response into structured format
 */
export function parseAnalysisResponse(response: string): VLMAnalysisResult {
  const lines = response.split("\n");
  let caption = "";
  let description = "";
  let ocrText: string | undefined;
  let tags: string[] = [];

  let currentSection = "";
  let descriptionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("CAPTION:")) {
      currentSection = "caption";
      caption = trimmed.slice(8).trim();
    } else if (trimmed.startsWith("DESCRIPTION:")) {
      currentSection = "description";
      descriptionLines.push(trimmed.slice(12).trim());
    } else if (trimmed.startsWith("OCR_TEXT:")) {
      currentSection = "ocr";
      const text = trimmed.slice(9).trim();
      ocrText = text === "NONE" ? undefined : text;
    } else if (trimmed.startsWith("TAGS:")) {
      currentSection = "tags";
      tags = trimmed
        .slice(5)
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    } else if (trimmed && currentSection === "description") {
      descriptionLines.push(trimmed);
    } else if (trimmed && currentSection === "ocr" && ocrText) {
      ocrText += "\n" + trimmed;
    }
  }

  description = descriptionLines.join(" ").trim();

  // Fallback if parsing fails
  if (!caption && !description) {
    caption = response.slice(0, 100).trim();
    description = response;
  }

  return { caption, description, ocrText, tags };
}
