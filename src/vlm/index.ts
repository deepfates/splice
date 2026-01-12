/**
 * VLM Module Index
 *
 * Re-exports all VLM providers and registers them with the provider system.
 */

import { registerProvider } from "./providers";
import { createGeminiProvider } from "./gemini";
import { createOllamaProvider } from "./ollama";
import { createLmstudioProvider } from "./lmstudio";

// Register built-in providers
registerProvider("gemini", createGeminiProvider);
registerProvider("ollama", createOllamaProvider);
registerProvider("lmstudio", createLmstudioProvider);

// Re-export everything
export * from "./providers";
export { createGeminiProvider } from "./gemini";
export { createOllamaProvider } from "./ollama";
export { createLmstudioProvider } from "./lmstudio";
