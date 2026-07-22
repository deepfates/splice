import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

import { codexSessionToLyncEvents } from "../../src/outputs/lync-codex-session.js";
import { writeLyncFile } from "../../src/outputs/lync.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cli = path.join(projectRoot, "splice.ts");
const SESSION_ID = "dddddddd-0000-4000-8000-000000000001";

describe("splice session-search CLI", () => {
  it("rebuilds and finds a resumable session with machine-readable output", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-cli-"));
    try {
      const archive = path.join(tmp, "lync");
      const projection = path.join(tmp, "search");
      const source = "codex/rollout.jsonl";
      const input = [
        { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: SESSION_ID } },
        { timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "cold agent searchable phrase" } },
      ].map(JSON.stringify).join("\n") + "\n";
      await writeLyncFile(path.join(archive, "codex.lync"), codexSessionToLyncEvents(input, source).events);

      const rebuilt = await execa(tsx, [cli, "session-search", "rebuild", "--source", archive, "--out", projection], { reject: false });
      expect(rebuilt.exitCode).toBe(0);
      const rebuildReport = JSON.parse(rebuilt.stdout);
      expect(rebuildReport.command).toBe("session-search rebuild");
      expect(rebuildReport.manifest.messages).toBe(1);

      const found = await execa(tsx, [cli, "session-search", "find", "--index", projection, "--query", "searchable phrase"], { reject: false });
      expect(found.exitCode).toBe(0);
      const findReport = JSON.parse(found.stdout);
      expect(findReport).toMatchObject({ command: "session-search find", count: 1 });
      expect(findReport.hits[0]).toMatchObject({
        source,
        line: 2,
        sessionId: SESSION_ID,
        resumeArgv: ["codex", "resume", SESSION_ID],
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an absent index without creating it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-cli-ro-"));
    try {
      const missing = path.join(tmp, "missing.sqlite3");
      const result = await execa(tsx, [cli, "session-search", "find", "--index", missing, "--query", "needle"], { reject: false });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error).toMatch(/does not exist/);
      expect(await fs.stat(missing).then(() => true, () => false)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
