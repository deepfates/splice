import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execa } from "execa";

import { codexSessionToLyncEvents } from "../../src/outputs/lync-codex-session.js";
import { claudeSessionToLyncEvents } from "../../src/outputs/lync-claude-session.js";
import { writeLyncFile } from "../../src/outputs/lync.js";
import {
  rebuildSessionSearchIndex,
  searchSessionIndex,
  SessionSearchBuildError,
  SESSION_SEARCH_SCHEMA,
} from "../../src/outputs/lync-session-search.js";

const CODEX_ID = "cccccccc-0000-4000-8000-000000000001";
const CLAUDE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

async function syntheticArchive(root: string): Promise<void> {
  const codexSource = "codex/2026/01/rollout-synthetic.jsonl";
  const codexJsonl = [
    { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: CODEX_ID, cli_version: "1.0.0" } },
    { timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "literal needle phrase from codex" } },
    { timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call_output", output: "secret tool needle phrase" } },
    { timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "secret system needle phrase" }] } },
  ].map(JSON.stringify).join("\n") + "\n";
  await writeLyncFile(
    path.join(root, "z-codex.lync"),
    codexSessionToLyncEvents(codexJsonl, codexSource).events,
  );

  const claudeSource = `claude/project/${CLAUDE_ID}.jsonl`;
  const claudeJsonl = [
    {
      parentUuid: null, sessionId: CLAUDE_ID, version: "1.0.0", type: "user",
      message: { role: "user", content: "literal needle phrase from claude" },
      uuid: "aaaaaaaa-0000-4000-8000-000000000011", timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      parentUuid: "aaaaaaaa-0000-4000-8000-000000000011", sessionId: CLAUDE_ID,
      version: "1.0.0", type: "assistant",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "secret reasoning needle phrase" },
        { type: "tool_use", name: "Read", input: { file: "secret needle phrase" } },
        { type: "text", text: "public assistant reply" },
      ] },
      uuid: "aaaaaaaa-0000-4000-8000-000000000012", timestamp: "2026-01-01T00:00:01.000Z",
    },
  ].map(JSON.stringify).join("\n") + "\n";
  await writeLyncFile(
    path.join(root, "a-claude.lync"),
    claudeSessionToLyncEvents(claudeJsonl, claudeSource).events,
  );
}

async function scaledArchive(root: string, messages = 5_000): Promise<void> {
  const source = "codex/scale.jsonl";
  const lines: unknown[] = [
    { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: CODEX_ID } },
  ];
  for (let i = 0; i < messages; i++) {
    lines.push({
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: `bounded-scale-message-${String(i).padStart(5, "0")}-payload` },
    });
  }
  const jsonl = lines.map(JSON.stringify).join("\n") + "\n";
  await writeLyncFile(path.join(root, "scale.lync"), codexSessionToLyncEvents(jsonl, source).events);
}

async function waitFor(pathname: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (await fs.stat(pathname).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${pathname}`);
}

describe("private agent-session search projection", () => {
  it("publishes a deterministic immutable generation with sorted source digests", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const first = await rebuildSessionSearchIndex(archive, output);
      const indexHash = createHash("sha256").update(await fs.readFile(first.indexPath)).digest("hex");
      const manifestBytes = await fs.readFile(first.manifestPath, "utf8");
      expect(first.manifest).toMatchObject({
        schema: SESSION_SEARCH_SCHEMA,
        files: { discovered: 2, indexed: 2, failed: 0 },
        events: { seen: 6, searchable: 3, nonSearchable: 3, errors: 0 },
        messages: 3,
      });
      expect(first.manifest.sourceFiles.map((file) => file.locator)).toEqual([
        "a-claude.lync", "z-codex.lync",
      ]);
      for (const file of first.manifest.sourceFiles) {
        const bytes = await fs.readFile(path.join(archive, file.locator));
        expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(file.bytes).toBe(bytes.length);
      }
      expect(await fs.readFile(path.join(output, "CURRENT"), "utf8")).toBe(first.generation + "\n");

      const second = await rebuildSessionSearchIndex(archive, output);
      expect(second.generation).toBe(first.generation);
      expect(await fs.readFile(second.manifestPath, "utf8")).toBe(manifestBytes);
      expect(createHash("sha256").update(await fs.readFile(second.indexPath)).digest("hex")).toBe(indexHash);
      if (process.platform !== "win32") {
        expect((await fs.stat(output)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(second.indexPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(second.manifestPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("uses trigram FTS candidates, returns stable native resume coordinates, and hides internals", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-fts-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const built = await rebuildSessionSearchIndex(archive, output);
      const hits = await searchSessionIndex(output, "literal needle phrase");
      expect(hits.map(({ source, line, platform, sessionId, resumeArgv }) => ({ source, line, platform, sessionId, resumeArgv }))).toEqual([
        { source: `claude/project/${CLAUDE_ID}.jsonl`, line: 1, platform: "claude", sessionId: CLAUDE_ID, resumeArgv: ["claude", "--resume", CLAUDE_ID] },
        { source: "codex/2026/01/rollout-synthetic.jsonl", line: 2, platform: "codex", sessionId: CODEX_ID, resumeArgv: ["codex", "resume", CODEX_ID] },
      ]);
      expect(await searchSessionIndex(output, "secret tool")).toEqual([]);
      expect(await searchSessionIndex(output, "secret system")).toEqual([]);
      expect(await searchSessionIndex(output, "secret reasoning")).toEqual([]);
      expect(await searchSessionIndex(output, "Literal needle phrase")).toEqual([]);
      expect(await searchSessionIndex(output, "' OR 1=1 --")).toEqual([]);
      await expect(searchSessionIndex(output, "ab")).rejects.toThrow(/at least 3/);
      const plan = await execa("sqlite3", ["-readonly", built.indexPath,
        "EXPLAIN QUERY PLAN WITH candidates AS (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"literal needle phrase\"') SELECT m.id FROM candidates c JOIN messages m ON m.id=c.rowid WHERE instr(m.text,'literal needle phrase')>0;",
      ]);
      expect(plan.stdout).toMatch(/VIRTUAL TABLE INDEX/);
      expect(plan.stdout).toMatch(/SEARCH m USING INTEGER PRIMARY KEY/);
      expect(plan.stdout).not.toMatch(/SCAN m\b/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps batching bounded at meaningful scale and serializes same-output rebuilds", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-scale-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await fs.mkdir(archive);
      await scaledArchive(archive);
      const first = rebuildSessionSearchIndex(archive, output, { batchRows: 64, batchBytes: 64 * 1024 });
      await waitFor(path.join(output, ".rebuild.lock"));
      await expect(rebuildSessionSearchIndex(archive, output)).rejects.toThrow(/already running/);
      const built = await first;
      expect(built.manifest.messages).toBe(5_000);
      expect(built.manifest.build.peakBatchRows).toBeLessThanOrEqual(64);
      expect(built.manifest.build.peakBatchBytes).toBeLessThanOrEqual(64 * 1024);
      expect(await fs.stat(path.join(output, ".rebuild.lock")).then(() => true, () => false)).toBe(false);
      expect((await fs.readdir(output)).some((name) => name.startsWith(".stage-"))).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("treats malformed safe messages as explicit failure and preserves CURRENT", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-errors-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const good = await rebuildSessionSearchIndex(archive, output);
      const currentBefore = await fs.readFile(path.join(output, "CURRENT"), "utf8");
      await fs.rm(archive, { recursive: true });
      await fs.mkdir(archive);
      await fs.writeFile(path.join(archive, "broken.lync"), JSON.stringify({
        v: 1,
        kind: "claude/user",
        at: "not-a-time",
        payload: { message: { role: "user", content: "unsafe to silently drop" }, source: { path: "x.jsonl", line: 1, sessionId: CLAUDE_ID } },
      }) + "\n");
      let failure: unknown;
      try {
        await rebuildSessionSearchIndex(archive, output);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SessionSearchBuildError);
      const manifest = (failure as SessionSearchBuildError).manifest;
      expect(manifest.files).toEqual({ discovered: 1, indexed: 0, failed: 1 });
      expect(manifest.events.errors).toBe(1);
      expect(manifest.errors[0]).toMatchObject({ source: "broken.lync", line: 1, reason: expect.stringMatching(/invalid id|invalid at/) });
      expect(await fs.readFile(path.join(output, "CURRENT"), "utf8")).toBe(currentBefore);
      expect(await fs.stat(good.indexPath).then(() => true, () => false)).toBe(true);
      expect((await fs.readdir(output)).some((name) => name.startsWith(".stage-") || name === ".rebuild.lock")).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("opens search indexes read-only and cleans discovery/prerequisite failures", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-readonly-"));
    try {
      const missing = path.join(tmp, "missing.sqlite3");
      await expect(searchSessionIndex(missing, "needle")).rejects.toThrow(/does not exist/);
      expect(await fs.stat(missing).then(() => true, () => false)).toBe(false);
      const wrong = path.join(tmp, "wrong.sqlite3");
      await fs.writeFile(wrong, "not sqlite");
      const wrongBefore = await fs.readFile(wrong);
      await expect(searchSessionIndex(wrong, "needle")).rejects.toThrow();
      expect((await fs.readFile(wrong)).equals(wrongBefore)).toBe(true);

      const output = path.join(tmp, "projection");
      await expect(rebuildSessionSearchIndex(path.join(tmp, "missing-source"), output)).rejects.toThrow();
      expect((await fs.readdir(output)).some((name) => name.startsWith(".stage-") || name === ".rebuild.lock")).toBe(false);
      await expect(rebuildSessionSearchIndex(tmp, output, { sqliteBinary: path.join(tmp, "missing-sqlite3") })).rejects.toThrow(/missing-sqlite3|ENOENT/);
      expect((await fs.readdir(output)).some((name) => name.startsWith(".stage-") || name === ".rebuild.lock")).toBe(false);

      const archive = path.join(tmp, "valid-authority");
      const poisoned = path.join(tmp, "poisoned-projection");
      await syntheticArchive(archive);
      await fs.mkdir(path.join(poisoned, "CURRENT"), { recursive: true });
      await expect(rebuildSessionSearchIndex(archive, poisoned)).rejects.toThrow();
      const poisonEntries = await fs.readdir(poisoned);
      expect(poisonEntries.some((name) => name.startsWith(".stage-") || name.startsWith(".CURRENT-") || name === ".rebuild.lock")).toBe(false);
      expect(await fs.readdir(path.join(poisoned, "generations"))).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
