/**
 * Ollama VLM Provider
 *
 * Uses local Ollama for vision-language analysis.
 * Requires Ollama to be running with a vision model (e.g., llava, minicpm-v).
 */

import type { VLMProvider } from "./providers";
import type { VLMAnalysisResult } from "../core/media-types";
import { ANALYSIS_PROMPT, parseAnalysisResponse } from "./providers";

const DEFAULT_MODEL = "llava:7b";
const DEFAULT_HOST = "http://localhost:11434";

/**
 * Create an Ollama VLM provider
 */
export async function createOllamaProvider(model?: string): Promise<VLMProvider> {
  const host = process.env.OLLAMA_HOST || DEFAULT_HOST;
  const modelName = model || DEFAULT_MODEL;

  // Verify Ollama is running and model is available
  try {
    const response = await fetch(`${host}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama not responding at ${host}`);
    }
    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const models = data.models?.map((m) => m.name) || [];
    
    // Check if model is available (handle both "llava" and "llava:7b" formats)
    const modelBase = modelName.split(":")[0];
    const hasModel = models.some((m) => m === modelName || m.startsWith(modelBase + ":"));
    
    if (!hasModel) {
      throw new Error(
        `Model "${modelName}" not found in Ollama. Available: ${models.join(", ")}. ` +
        `Run: ollama pull ${modelName}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      throw error;
    }
    throw new Error(
      `Cannot connect to Ollama at ${host}. Ensure Ollama is running: ollama serve`,
    );
  }

  return {
    name: `ollama:${modelName}`,
    supportsVideo: true,

    async analyze(image: Buffer, _mimeType: string): Promise<VLMAnalysisResult> {
      const base64Image = image.toString("base64");

      const response = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          prompt: ANALYSIS_PROMPT,
          images: [base64Image],
          stream: false,
          options: {
            temperature: 0.2,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as { response?: string };
      const text = data.response;
      
      if (!text) {
        throw new Error("No response from Ollama");
      }

      return parseAnalysisResponse(text);
    },
  };
}
