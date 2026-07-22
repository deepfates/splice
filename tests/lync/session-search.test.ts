import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { codexSessionToLyncEvents } from "../../src/outputs/lync-codex-session.js";
import { claudeSessionToLyncEvents } from "../../src/outputs/lync-claude-session.js";
import { writeLyncFile } from "../../src/outputs/lync.js";
import {
  rebuildSessionSearchIndex,
  searchSessionIndex,
  SESSION_SEARCH_SCHEMA,
} from "../../src/outputs/lync-session-search.js";

const CODEX_ID = "cccccccc-0000-4000-8000-000000000001";
const CLAUDE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

async function syntheticArchive(root: string): Promise<void> {
  const codexSource = "codex/2026/01/rollout-synthetic.jsonl";
  const codexJsonl = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: { id: CODEX_ID, cli_version: "1.0.0" },
    },
    {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "literal needle phrase from codex" },
    },
    {
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "secret tool needle phrase" },
    },
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "secret system needle phrase" }] },
    },
  ].map(JSON.stringify).join("\n") + "\n";
  const codex = codexSessionToLyncEvents(codexJsonl, codexSource);
  await writeLyncFile(path.join(root, "z-codex.lync"), codex.events);

  const claudeSource = `claude/project/${CLAUDE_ID}.jsonl`;
  const claudeJsonl = [
    {
      parentUuid: null,
      sessionId: CLAUDE_ID,
      version: "1.0.0",
      type: "user",
      message: { role: "user", content: "literal needle phrase from claude" },
      uuid: "aaaaaaaa-0000-4000-8000-000000000011",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      parentUuid: "aaaaaaaa-0000-4000-8000-000000000011",
      sessionId: CLAUDE_ID,
      version: "1.0.0",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning needle phrase" },
          { type: "tool_use", name: "Read", input: { file: "secret needle phrase" } },
          { type: "text", text: "public assistant reply" },
        ],
      },
      uuid: "aaaaaaaa-0000-4000-8000-000000000012",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ].map(JSON.stringify).join("\n") + "\n";
  const claude = claudeSessionToLyncEvents(claudeJsonl, claudeSource);
  await writeLyncFile(path.join(root, "a-claude.lync"), claude.events);
}

describe("private agent-session search projection", () => {
  it("rebuilds deterministically and returns stable native resume coordinates", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const first = await rebuildSessionSearchIndex(archive, output);
      const firstHash = createHash("sha256")
        .update(await fs.readFile(first.indexPath))
        .digest("hex");
      const firstManifest = await fs.readFile(first.manifestPath, "utf8");

      expect(first.manifest).toMatchObject({
        schema: SESSION_SEARCH_SCHEMA,
        authority: "lync",
        privacy: "human-and-assistant-message-text-only",
        files: { discovered: 2, indexed: 2, failed: 0 },
        events: { seen: 6, searchable: 3, nonSearchable: 3, errors: 0 },
        messages: 3,
        errors: [],
      });
      const hits = await searchSessionIndex(first.indexPath, "literal needle phrase");
      expect(hits.map((hit) => ({
        source: hit.source,
        line: hit.line,
        platform: hit.platform,
        sessionId: hit.sessionId,
        resumeArgv: hit.resumeArgv,
      }))).toEqual([
        {
          source: `claude/project/${CLAUDE_ID}.jsonl`,
          line: 1,
          platform: "claude",
          sessionId: CLAUDE_ID,
          resumeArgv: ["claude", "--resume", CLAUDE_ID],
        },
        {
          source: "codex/2026/01/rollout-synthetic.jsonl",
          line: 2,
          platform: "codex",
          sessionId: CODEX_ID,
          resumeArgv: ["codex", "resume", CODEX_ID],
        },
      ]);

      const rebuilt = await rebuildSessionSearchIndex(archive, output);
      expect(await fs.readFile(rebuilt.manifestPath, "utf8")).toBe(firstManifest);
      expect(createHash("sha256").update(await fs.readFile(rebuilt.indexPath)).digest("hex"))
        .toBe(firstHash);
      if (process.platform !== "win32") {
        expect((await fs.stat(output)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(rebuilt.indexPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(rebuilt.manifestPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not project tool, reasoning, or system/developer content", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-private-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const built = await rebuildSessionSearchIndex(archive, output);
      expect(await searchSessionIndex(built.indexPath, "secret tool")).toEqual([]);
      expect(await searchSessionIndex(built.indexPath, "secret system")).toEqual([]);
      expect(await searchSessionIndex(built.indexPath, "secret reasoning")).toEqual([]);
      expect(await searchSessionIndex(built.indexPath, "public assistant reply")).toHaveLength(1);
      // Query text is data, not SQL.
      expect(await searchSessionIndex(built.indexPath, "' OR 1=1 --")).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("accounts malformed source events explicitly instead of dropping them", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-errors-"));
    try {
      const archive = path.join(tmp, "authority");
      await fs.mkdir(archive);
      await fs.writeFile(path.join(archive, "broken.lync"), "{not-json}\n");
      const built = await rebuildSessionSearchIndex(archive, path.join(tmp, "projection"));
      expect(built.manifest.files).toEqual({ discovered: 1, indexed: 0, failed: 1 });
      expect(built.manifest.events).toEqual({
        seen: 1,
        searchable: 0,
        nonSearchable: 0,
        nonSearchableByReason: {},
        errors: 1,
      });
      expect(built.manifest.errors).toEqual([
        { source: "broken.lync", line: 1, reason: expect.stringMatching(/JSON/) },
      ]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails clearly without SQLite and leaves an existing projection intact", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-sqlite-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const built = await rebuildSessionSearchIndex(archive, output);
      const before = await fs.readFile(built.indexPath);
      await expect(
        rebuildSessionSearchIndex(archive, output, {
          sqliteBinary: path.join(tmp, "missing-sqlite3"),
        }),
      ).rejects.toThrow(/missing-sqlite3|ENOENT/);
      expect((await fs.readFile(built.indexPath)).equals(before)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
