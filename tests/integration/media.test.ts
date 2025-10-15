import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("splice CLI media handling", () => {
  const projectRoot = path.resolve(__dirname, "../.."); // repo root
  const fixtureArchive = path.resolve(
    projectRoot,
    "tests/integration/fixtures/archive_with_media",
  );
  const tsxBin = path.resolve(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const cliEntry = path.resolve(projectRoot, "splice.ts");

  let outDir: string;

  beforeAll(async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-media-int-"));
  });

  afterAll(async () => {
    if (outDir && outDir.startsWith(os.tmpdir())) {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(
    "copies media files and includes links in thread markdown",
    async () => {
      // Ensure tooling and fixtures exist
      expect(fssync.existsSync(tsxBin)).toBe(true);
      expect(fssync.existsSync(cliEntry)).toBe(true);
      expect(
        fssync.existsSync(path.join(fixtureArchive, "data", "manifest.js")),
      ).toBe(true);
      // Dummy media file that should be detected and copied (_ prefix on copy)
      const sourceMediaBasename = "2000000000000000001-test.jpg";
      const sourceMediaPath = path.join(
        fixtureArchive,
        "data",
        "tweets_media",
        sourceMediaBasename,
      );
      expect(fssync.existsSync(sourceMediaPath)).toBe(true);
      const sourceMediaStat = await fs.stat(sourceMediaPath);
      expect(sourceMediaStat.size).toBeGreaterThan(0);

      // Run CLI for markdown only (focus on threads + media)
      const { exitCode } = await execa(
        tsxBin,
        [
          cliEntry,
          "--source",
          fixtureArchive,
          "--out",
          outDir,
          "--format",
          "markdown",
          "--log-level",
          "warn",
        ],
        { cwd: projectRoot },
      );

      expect(exitCode).toBe(0);

      const threadsDir = path.join(outDir, "threads");
      const imagesDir = path.join(outDir, "images");

      expect(fssync.existsSync(threadsDir)).toBe(true);
      expect(fssync.existsSync(imagesDir)).toBe(true);

      // Verify the media file was copied with the "_" prefix
      const copiedMediaBasename = `_${sourceMediaBasename}`;
      const copiedMediaPath = path.join(imagesDir, copiedMediaBasename);
      expect(fssync.existsSync(copiedMediaPath)).toBe(true);
      const copiedStat = await fs.stat(copiedMediaPath);
      expect(copiedStat.size).toBeGreaterThan(0);

      // Find the generated thread markdown and assert the image link is present
      const threadFiles = await fs.readdir(threadsDir);
      const mdFiles = threadFiles.filter((f) => f.endsWith(".md"));
      expect(mdFiles.length).toBeGreaterThan(0);

      // Read first thread file
      const threadMdPath = path.join(threadsDir, mdFiles[0]);
      const threadContent = await fs.readFile(threadMdPath, "utf8");

      // Threads are saved under out/threads, so images are linked as ../images/_<basename>
      const expectedMdImage =
        `![${sourceMediaBasename}](../images/${copiedMediaBasename})`;

      expect(threadContent).toContain(expectedMdImage);
    },
    30_000,
  );
});
