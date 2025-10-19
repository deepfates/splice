#!/usr/bin/env -S tsx
/**
 * Thin forwarder to the modular CLI.
 * This ensures `npx tsx splice.ts` runs the latest CLI (including checkpoints).
 *
 * In dev: loads TypeScript entry at src/cli/splice.ts
 * In build: falls back to compiled dist/cli/splice.js
 */

try {
  // Prefer TypeScript entry during development
  await import("./src/cli/splice.ts");
} catch (errTs) {
  try {
    // Fallback to compiled JavaScript entry after build
    await import("./dist/cli/splice.js");
  } catch (errJs) {
    const msgTs = (errTs && (errTs as Error).message) || String(errTs);
    const msgJs = (errJs && (errJs as Error).message) || String(errJs);
    console.error("[error] Failed to load CLI entry.");
    console.error("  TS entry error:", msgTs);
    console.error("  JS entry error:", msgJs);
    process.exit(1);
  }
}
