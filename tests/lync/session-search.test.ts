import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execa } from "execa";
import { spawn } from "node:child_process";

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
    { timestamp: "2026-01-01T00:00:04.000Z", type: "response_item", payload: { type: "agent_message", content: [{ type: "input_text", text: "modern agent content phrase" }, { type: "encrypted_content", encrypted_content: "private" }] } },
    { timestamp: "2026-01-01T00:00:05.000Z", type: "response_item", payload: { type: "agent_message", content: [{ type: "output_text", text: "" }] } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "legacy envelope phrase" }] },
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

async function waitForSnapshot(output: string): Promise<string> {
  for (let i = 0; i < 5_000; i++) {
    const stages = await fs.readdir(output).catch(() => []);
    for (const stage of stages.filter((name) => name.startsWith(".stage-"))) {
      const dir = path.join(output, stage, "source-snapshots");
      const snapshots = await fs.readdir(dir).catch(() => []);
      const ready = snapshots.find((name) => name.endsWith(".lync"));
      if (ready) return path.join(dir, ready);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for immutable source snapshot");
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
        events: { seen: 9, searchable: 5, nonSearchable: 4, errors: 0 },
        union: { identitiesSeen: 9, unique: 9, identicalDuplicates: 0 },
        messageSegments: 5,
        messages: 5,
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
      expect((await searchSessionIndex(output, "legacy envelope phrase")).map((hit) => ({
        platform: hit.platform,
        role: hit.role,
        line: hit.line,
        text: hit.text,
      }))).toEqual([{
        platform: "codex",
        role: "user",
        line: 7,
        text: "legacy envelope phrase",
      }]);
      expect((await searchSessionIndex(output, "modern agent content phrase")).map((hit) => ({
        platform: hit.platform,
        role: hit.role,
        line: hit.line,
        text: hit.text,
      }))).toEqual([{
        platform: "codex",
        role: "assistant",
        line: 5,
        text: "modern agent content phrase",
      }]);
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
      await fs.mkdir(path.join(output, ".stage-abandoned", "source-snapshots"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(output, ".stage-abandoned", "index.sqlite3"),
        "interrupted build",
      );
      await scaledArchive(archive);
      const first = rebuildSessionSearchIndex(archive, output, { batchRows: 64, batchBytes: 64 * 1024 });
      await waitFor(path.join(output, ".rebuild.lock"));
      await expect(rebuildSessionSearchIndex(archive, output)).rejects.toThrow(/already running/);
      const built = await first;
      expect(built.manifest.messages).toBe(5_000);
      expect(built.manifest.messageSegments).toBe(5_000);
      expect(built.manifest.union).toEqual({
        identitiesSeen: 5_001,
        unique: 5_001,
        identicalDuplicates: 0,
      });
      expect(built.manifest.build.peakBatchRows).toBeLessThanOrEqual(64);
      expect(built.manifest.build.peakBatchBytes).toBeLessThanOrEqual(64 * 1024);
      expect(built.manifest.build.peakIdentityBatchRows).toBeLessThanOrEqual(64);
      expect(built.manifest.build.peakIdentityBatchBytes).toBeLessThanOrEqual(64 * 1024);
      expect(built.manifest.build.messageFlushes).toBeGreaterThan(1);
      expect(built.manifest.build.identityFlushes).toBeGreaterThan(1);
      expect(built.manifest.build.oversizeMessageRows).toBe(0);
      expect(built.manifest.build.staleStagesRemoved).toBe(1);
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
      expect(manifest.errors[0]).toMatchObject({ source: "broken.lync", line: 1, reason: expect.stringMatching(/id must be string|invalid id|invalid at/) });
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

  it("rejects digest damage and cross-file conflicts while identical duplicates union as no-ops", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-integrity-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const good = await rebuildSessionSearchIndex(archive, output);
      const current = await fs.readFile(path.join(output, "CURRENT"), "utf8");

      const damagedFile = path.join(archive, "a-claude.lync");
      const lines = (await fs.readFile(damagedFile, "utf8")).trimEnd().split("\n");
      lines[0] = `${lines[0].slice(0, -1)},"digest":"sha256:${"0".repeat(64)}"}`;
      await fs.writeFile(damagedFile, lines.join("\n") + "\n");
      await expect(rebuildSessionSearchIndex(archive, output)).rejects.toMatchObject({
        manifest: { errors: [expect.objectContaining({ reason: expect.stringMatching(/damaged|digest/i) })] },
      });
      expect(await fs.readFile(path.join(output, "CURRENT"), "utf8")).toBe(current);
      expect(await fs.stat(good.indexPath).then(() => true, () => false)).toBe(true);

      await fs.rm(archive, { recursive: true });
      await fs.mkdir(archive);
      const source = "codex/duplicate.jsonl";
      const jsonl = [
        { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: CODEX_ID } },
        { timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "identical union testimony" } },
      ].map(JSON.stringify).join("\n") + "\n";
      const events = codexSessionToLyncEvents(jsonl, source).events;
      await writeLyncFile(path.join(archive, "one.lync"), [...events, ...events]);
      await writeLyncFile(path.join(archive, "two.lync"), events);
      const duplicateBuild = await rebuildSessionSearchIndex(archive, output);
      expect(await searchSessionIndex(duplicateBuild.indexPath, "identical union testimony")).toHaveLength(1);
      expect(duplicateBuild.manifest.union).toEqual({
        identitiesSeen: 6,
        unique: 2,
        identicalDuplicates: 4,
      });
      expect(duplicateBuild.manifest.messageSegments).toBe(3);
      expect(duplicateBuild.manifest.messages).toBe(1);
      expect(duplicateBuild.manifest.sourceFiles.map((file) => file.messageSegments)).toEqual([2, 1]);
      const duplicateCurrent = await fs.readFile(path.join(output, "CURRENT"), "utf8");

      const conflict = structuredClone(events);
      (conflict[1].payload as Record<string, unknown>).payload = { type: "user_message", message: "conflicting union testimony" };
      await writeLyncFile(path.join(archive, "two.lync"), conflict);
      await expect(rebuildSessionSearchIndex(archive, output)).rejects.toMatchObject({
        message: expect.stringMatching(/union conflict/),
      });
      expect(await fs.readFile(path.join(output, "CURRENT"), "utf8")).toBe(duplicateCurrent);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("hashes and indexes the exact immutable snapshot when authority mutates", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-mutation-"));
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await fs.mkdir(archive);
      await scaledArchive(archive, 20_000);
      const source = path.join(archive, "scale.lync");
      const before = await fs.readFile(source);
      const build = rebuildSessionSearchIndex(archive, output, { batchRows: 64, batchBytes: 64 * 1024 });
      await waitForSnapshot(output);
      const appended = codexSessionToLyncEvents([
        JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "post-snapshot mutation marker" } }),
      ].join("\n") + "\n", "codex/other.jsonl").events;
      const appendFile = path.join(tmp, "append.lync");
      await writeLyncFile(appendFile, appended);
      await fs.appendFile(source, await fs.readFile(appendFile));
      const built = await build;
      expect(built.manifest.sourceFiles[0]).toMatchObject({
        bytes: before.length,
        sha256: createHash("sha256").update(before).digest("hex"),
      });
      expect(createHash("sha256").update(await fs.readFile(source)).digest("hex")).not.toBe(built.manifest.sourceFiles[0].sha256);
      expect(await searchSessionIndex(output, "post-snapshot mutation marker")).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps a slow reader's resolved generation open across a publish", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-search-reader-"));
    let reader: ReturnType<typeof spawn> | null = null;
    try {
      const archive = path.join(tmp, "authority");
      const output = path.join(tmp, "projection");
      await syntheticArchive(archive);
      const first = await rebuildSessionSearchIndex(archive, output);
      reader = spawn("sqlite3", ["-readonly", first.indexPath], { stdio: ["pipe", "pipe", "pipe"] });
      const began = new Promise<void>((resolve, reject) => {
        reader!.stdout!.once("data", () => resolve());
        reader!.once("error", reject);
      });
      reader.stdin!.write("BEGIN; SELECT count(*) FROM messages;\n");
      await began;
      await fs.copyFile(path.join(archive, "a-claude.lync"), path.join(archive, "b-identical.lync"));
      const second = await rebuildSessionSearchIndex(archive, output);
      expect(second.generation).not.toBe(first.generation);
      expect(await fs.stat(first.indexPath).then(() => true, () => false)).toBe(true);
      reader.stdin!.end("SELECT count(*) FROM messages; COMMIT;\n");
      await new Promise<void>((resolve, reject) => {
        reader!.once("close", (code) => code === 0 ? resolve() : reject(new Error(`reader exited ${code}`)));
      });
      reader = null;
      expect(await searchSessionIndex(first.indexPath, "literal needle phrase")).toHaveLength(2);
    } finally {
      if (reader?.exitCode === null) reader.kill();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
