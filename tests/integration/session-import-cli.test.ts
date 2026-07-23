import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cli = path.join(projectRoot, "splice.ts");
const distCli = path.join(projectRoot, "dist", "cli", "splice.js");

async function run(args: string[]) {
  return execa(tsx, [cli, ...args], { cwd: projectRoot, reject: false });
}

describe("splice session-import CLI", () => {
  it("imports a Codex tree with complete accounting, private modes, and deterministic reruns", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-intake-"));
    try {
      const source = path.join(tmp, "source");
      const out = path.join(tmp, "out");
      await fs.mkdir(path.join(source, "2026", "07", "22"), { recursive: true });
      await fs.writeFile(path.join(source, "README.txt"), "ignored but accounted");
      await fs.writeFile(
        path.join(source, "2026", "07", "22", "rollout.jsonl"),
        [
          { timestamp: "2026-07-22T00:00:00.000Z", type: "session_meta", payload: { id: "aaaaaaaa-0000-4000-8000-000000000001" } },
          { timestamp: "2026-07-22T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "private synthetic prompt" } },
        ].map(JSON.stringify).join("\n") + "\n",
      );

      const first = await run(["session-import", "codex", "--source", source, "--out", out]);
      expect(first.exitCode).toBe(0);
      const report = JSON.parse(first.stdout);
      expect(report).toMatchObject({
        command: "session-import codex",
        filesDiscovered: 1,
        filesConverted: 1,
        filesUnreadable: [],
        filesIgnored: ["README.txt"],
        totalSourceLines: 2,
        totalSkipped: 0,
      });
      expect(report.totalAccepted).toBe(report.totalEmitted);
      const output = path.join(out, "2026", "07", "22", "rollout.lync");
      const bytes = await fs.readFile(output);

      const second = await run(["session-import", "codex", "--source", source, "--out", out]);
      expect(second.exitCode).toBe(0);
      expect((await fs.readFile(output)).equals(bytes)).toBe(true);
      if (process.platform !== "win32") {
        expect((await fs.stat(out)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("imports a Claude tree, reports malformed lines, and accounts for symlinks without following them", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-intake-"));
    try {
      const source = path.join(tmp, "source");
      const out = path.join(tmp, "out");
      await fs.mkdir(path.join(source, "project"), { recursive: true });
      await fs.writeFile(
        path.join(source, "project", "session.jsonl"),
        [
          JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-07-22T00:00:00Z", message: { role: "user", content: "synthetic hello" } }),
          "not-json",
        ].join("\n") + "\n",
      );
      if (process.platform !== "win32") {
        await fs.symlink(path.join(source, "project", "session.jsonl"), path.join(source, "session-link.jsonl"));
      }

      const result = await run(["session-import", "claude", "--source", source, "--out", out]);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        command: "session-import claude",
        filesDiscovered: 1,
        filesConverted: 1,
        totalSourceLines: 2,
        totalEmitted: 1,
        totalSkipped: 1,
        totalAccepted: 1,
      });
      if (process.platform !== "win32") expect(report.filesIgnored).toEqual(["session-link.jsonl"]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous or unsafe invocation without creating output", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-intake-errors-"));
    try {
      const source = path.join(tmp, "source");
      await fs.mkdir(source);
      const overlap = path.join(source, "generated");
      const unsafe = await run(["session-import", "codex", "--source", source, "--out", overlap]);
      expect(unsafe.exitCode).toBe(1);
      expect(JSON.parse(unsafe.stderr).error).toMatch(/must not overlap/);
      expect(await fs.stat(overlap).then(() => true, () => false)).toBe(false);

      const typo = await run(["session-import", "claude", "--source", source, "--out", path.join(tmp, "out"), "--sorce", "x"]);
      expect(typo.exitCode).toBe(1);
      expect(JSON.parse(typo.stderr).error).toMatch(/unknown flag --sorce/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("the compiled Node ESM entrypoint starts directly and exposes session intake", async () => {
    const sourceFirstLine = (await fs.readFile(path.join(projectRoot, "src", "cli", "splice.ts"), "utf8")).split("\n")[0];
    expect(sourceFirstLine).toBe("#!/usr/bin/env node");
    const result = await execa(process.execPath, [distCli, "session-import", "--help"], {
      cwd: projectRoot,
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("splice session-import");

    const commandHelp = await run(["session-import", "codex", "--help"]);
    expect(commandHelp.exitCode).toBe(0);
    expect(commandHelp.stderr).toContain("session-import codex");
  });
});
