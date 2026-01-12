/**
 * Gemini VLM Provider
 *
 * Uses Google's Gemini API for vision-language analysis.
 * Requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable.
 */

import type { VLMProvider } from "./providers";
import type { VLMAnalysisResult } from "../core/media-types";
import { ANALYSIS_PROMPT, parseAnalysisResponse } from "./providers";

const DEFAULT_MODEL = "gemini-2.0-flash";

/**
 * Create a Gemini VLM provider
 */
export async function createGeminiProvider(model?: string): Promise<VLMProvider> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Gemini provider requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable",
    );
  }

  const modelName = model || DEFAULT_MODEL;

  return {
    name: `gemini:${modelName}`,
    supportsVideo: true,

    async analyze(image: Buffer, mimeType: string): Promise<VLMAnalysisResult> {
      const base64Image = image.toString("base64");

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: base64Image,
                    },
                  },
                  {
                    text: ANALYSIS_PROMPT,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 1024,
            },
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error("No response from Gemini API");
      }

      return parseAnalysisResponse(text);
    },
  };
}
