/**
 * LM Studio VLM Provider
 *
 * Uses LM Studio's OpenAI-compatible API for local vision-language analysis.
 * Requires LM Studio running with a vision model loaded.
 */

import type { VLMProvider } from "./providers";
import type { VLMAnalysisResult } from "../core/media-types";

const DEFAULT_HOST = "http://localhost:1234";

/**
 * JSON prompt for structured output (more reliable than text parsing)
 */
const JSON_ANALYSIS_PROMPT = `Analyze this image and respond with a JSON object containing:
- caption: A single sentence (max 20 words) describing the main subject
- description: A detailed paragraph about what is shown, visual style, and mood
- ocr_text: ALL text visible in the image, transcribed exactly. If no text, use null
- tags: An array of 3-7 descriptive tags

IMPORTANT: If there is ANY text visible in the image (signs, captions, labels, watermarks, etc.), you MUST include it in ocr_text.`;

/**
 * JSON schema for structured output
 */
const ANALYSIS_SCHEMA = {
  name: "image_analysis",
  schema: {
    type: "object",
    properties: {
      caption: { type: "string", description: "Brief caption describing the image" },
      description: { type: "string", description: "Detailed description of the image" },
      ocr_text: { type: ["string", "null"], description: "All text visible in the image, or null if none" },
      tags: { type: "array", items: { type: "string" }, description: "Descriptive tags" },
    },
    required: ["caption", "description", "ocr_text", "tags"],
  },
};


/**
 * Create an LM Studio VLM provider
 */
export async function createLmstudioProvider(model?: string): Promise<VLMProvider> {
  const host = process.env.LMSTUDIO_HOST || DEFAULT_HOST;

  // Verify LM Studio is running
  try {
    const response = await fetch(`${host}/v1/models`);
    if (!response.ok) {
      throw new Error(`LM Studio not responding at ${host}`);
    }
    const data = (await response.json()) as {
      data?: Array<{ id: string }>;
    };
    const models = data.data?.map((m) => m.id) || [];
    
    if (models.length === 0) {
      throw new Error(
        `No models loaded in LM Studio. Load a vision model (e.g., llava, minicpm-v) first.`,
      );
    }

    // Use provided model or first available
    const modelName = model || models[0];
    console.error(`[debug] Using LM Studio model: ${modelName}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("No models")) {
      throw error;
    }
    throw new Error(
      `Cannot connect to LM Studio at ${host}. Ensure LM Studio is running with a vision model loaded.`,
    );
  }

  return {
    name: `lmstudio:${model || "default"}`,
    supportsVideo: true,

    async analyze(image: Buffer, mimeType: string): Promise<VLMAnalysisResult> {
      const base64Image = image.toString("base64");
      // Use data URL format as per OpenAI spec
      const imageUrl = `data:${mimeType};base64,${base64Image}`;

      const makeRequest = async (): Promise<Response> => {
        return fetch(`${host}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model || "default",
            messages: [
              {
                role: "user",
                content: [
                  // Text first, then image (order can matter for some models)
                  {
                    type: "text",
                    text: JSON_ANALYSIS_PROMPT,
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: imageUrl,
                      // "low" detail = 512x512 @ 85 tokens instead of thousands
                      // This prevents OOM crashes on vision models
                      detail: "low",
                    },
                  },
                ],
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: ANALYSIS_SCHEMA,
            },
            temperature: 0.2,
            max_tokens: 1024,
          }),
        });
      };

      let response = await makeRequest();

      // Check if model crashed and got unloaded
      if (!response.ok) {
        const errorText = await response.text();
        if (errorText.includes("No models loaded") || errorText.includes("model_not_found")) {
          // Don't retry same image - it'll just crash again
          // Throw "crashed" error so outer loop can try smaller size
          console.error(`[debug] Model appears to have crashed, will retry with smaller image...`);
          throw new Error(`Model crashed: ${response.status} - model unloaded`);
        } else {
          throw new Error(`LM Studio API error: ${response.status} - ${errorText}`);
        }
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string };
        }>;
      };

      const text = data.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error("No response from LM Studio");
      }

      // Parse JSON response
      try {
        const parsed = JSON.parse(text) as {
          caption?: string;
          description?: string;
          ocr_text?: string | null;
          tags?: string[];
        };
        
        return {
          caption: parsed.caption || "",
          description: parsed.description || "",
          ocrText: parsed.ocr_text || undefined,
          tags: parsed.tags || [],
        };
      } catch {
        // Fallback: if JSON parsing fails, return raw text as description
        return {
          caption: text.slice(0, 100),
          description: text,
          ocrText: undefined,
          tags: [],
        };
      }
    },
  };
}
