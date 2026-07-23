#!/usr/bin/env -S tsx
/**
 * Thin forwarder to the modular CLI.
 * This ensures `npx tsx splice.ts` runs the latest CLI (including checkpoints).
 *
 * In dev: loads TypeScript entry at src/cli/splice.ts.
 * In source-free package layouts: loads compiled dist/cli/splice.js.
 *
 * Do not catch an entrypoint's runtime failure and try the other one: doing so
 * can mask a missing dependency or broken subcommand behind unrelated help.
 */

import * as fs from "node:fs/promises";

let hasSource = true;
try {
  await fs.access(new URL("./src/cli/splice.ts", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
    throw error;
  }
  hasSource = false;
}

if (hasSource) {
  await import("./src/cli/splice.ts");
} else {
  await import("./dist/cli/splice.js");
}
