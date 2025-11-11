import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("splice CLI integration", () => {
  const projectRoot = path.resolve(__dirname, "../.."); // repo root
  const fixtureArchive = path.resolve(
    projectRoot,
    "tests/integration/fixtures/archive",
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
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-int-"));
  });

  afterAll(async () => {
    if (outDir && outDir.startsWith(os.tmpdir())) {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("converts a minimal archive to Markdown threads and OAI JSONL, honoring system message", async () => {
    // Ensure tsx exists for running the TS entry
    expect(fssync.existsSync(tsxBin)).toBe(true);
    expect(fssync.existsSync(cliEntry)).toBe(true);
    expect(
      fssync.existsSync(path.join(fixtureArchive, "data", "manifest.js")),
    ).toBe(true);

    const systemMsg = "Integration system message ✅";

    const { exitCode } = await execa(
      tsxBin,
      [
        cliEntry,
        "--source",
        fixtureArchive,
        "--out",
        outDir,
        "--system",
        systemMsg,
        "--format",
        "markdown",
        "oai",
        "json",
        "--log-level",
        "warn",
      ],
      { cwd: projectRoot },
    );

    expect(exitCode).toBe(0);

    // Check Markdown outputs
    const threadsDir = path.join(outDir, "threads");
    const tweetsByDateDir = path.join(outDir, "tweets_by_date");
    const imagesDir = path.join(outDir, "images");

    // Directories should exist
    expect(fssync.existsSync(threadsDir)).toBe(true);
    expect(fssync.existsSync(tweetsByDateDir)).toBe(true);
    expect(fssync.existsSync(imagesDir)).toBe(true);

    // We expect exactly one thread file from the 2-tweet self-reply chain
    const threadFiles = await fs.readdir(threadsDir);
    expect(threadFiles.filter((f) => f.endsWith(".md")).length).toBe(1);

    const threadMdPath = path.join(
      threadsDir,
      threadFiles.find((f) => f.endsWith(".md")) as string,
    );
    const threadContent = await fs.readFile(threadMdPath, "utf8");

    // Frontmatter date is derived from first tweet createdAt (2025-01-01T12:00:00Z)
    expect(threadContent).toContain("---");
    expect(threadContent).toContain("Date: 2025-01-01");
    // Includes link back to Twitter with the top tweet id
    expect(threadContent).toContain("View on Twitter");
    expect(threadContent).toContain("1000000000000000001");

    // No non-thread tweets in this fixture, so the per-day directory should be empty or contain no .md files
    const byDateFiles = await fs.readdir(tweetsByDateDir);
    expect(byDateFiles.filter((f) => f.endsWith(".md")).length).toBe(0);

    // Check OAI JSONL output and system message handling
    const oaiPath = path.join(outDir, "conversations_oai.jsonl");
    expect(fssync.existsSync(oaiPath)).toBe(true);

    const oaiRaw = await fs.readFile(oaiPath, "utf8");
    const lines = oaiRaw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const firstRecord = JSON.parse(lines[0]);
    expect(Array.isArray(firstRecord.messages)).toBe(true);
    expect(firstRecord.messages[0]).toEqual({
      role: "system",
      content: systemMsg,
    });

    // Ensure cleaned text removed t.co, @mentions, and #hashtags in non-system messages
    const nonSystem = firstRecord.messages.slice(1);
    expect(nonSystem.length).toBeGreaterThan(0);
    for (const m of nonSystem) {
      expect(typeof m.content).toBe("string");
      expect(m.content).not.toMatch(/t\.co/);
      expect(m.content).not.toMatch(/#\w+/);
      expect(m.content).not.toMatch(/@\w+/);
    }

    // Check normalized items JSONL output
    const normPath = path.join(outDir, "normalized_items.jsonl");
    expect(fssync.existsSync(normPath)).toBe(true);
    const normRaw = await fs.readFile(normPath, "utf8");
    const normLines = normRaw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(normLines.length).toBeGreaterThan(0);
    const firstItem = JSON.parse(normLines[0]);
    expect(typeof firstItem.id).toBe("string");
    expect(typeof firstItem.text).toBe("string");
    expect(typeof firstItem.createdAt).toBe("string");
    expect(typeof firstItem.source).toBe("string");
  }, 30_000);

  it("excludes replies from others (non-self-replies) from threads", async () => {
    // Create a fixture with a thread that has a reply from another user
    const tempFixture = await fs.mkdtemp(
      path.join(os.tmpdir(), "splice-thread-test-"),
    );

    try {
      const dataDir = path.join(tempFixture, "data");
      await fs.mkdir(dataDir, { recursive: true });

      // Create manifest.js
      await fs.writeFile(
        path.join(dataDir, "manifest.js"),
        `window.YTD.manifest.part0 = {
  "dataTypes": {
    "tweets": {
      "files": [{ "fileName": "data/tweets.js" }]
    }
  }
};`,
      );

      // Create account.js with owner ID
      await fs.writeFile(
        path.join(dataDir, "account.js"),
        `window.YTD.account.part0 = [{
  "account": {
    "accountId": "1111111111",
    "username": "owner"
  }
}];`,
      );

      // Create tweets.js with:
      // - Root tweet by owner
      // - Self-reply by owner (should be in thread)
      // - Reply from someone else (should NOT be in thread)
      await fs.writeFile(
        path.join(dataDir, "tweets.js"),
        `window.YTD.tweets.part0 = [
  {
    tweet: {
      id: "100",
      full_text: "Root tweet by owner",
      createdAt: "2025-01-01T10:00:00.000Z"
    }
  },
  {
    tweet: {
      id: "101",
      full_text: "Self reply by owner",
      createdAt: "2025-01-01T10:01:00.000Z",
      in_reply_to_status_id: "100",
      in_reply_to_user_id: "1111111111"
    }
  },
  {
    tweet: {
      id: "102",
      full_text: "Reply from someone else",
      createdAt: "2025-01-01T10:02:00.000Z",
      in_reply_to_status_id: "101",
      in_reply_to_user_id: "2222222222"
    }
  }
];`,
      );

      const tempOut = await fs.mkdtemp(
        path.join(os.tmpdir(), "splice-thread-out-"),
      );

      try {
        const { exitCode } = await execa(
          tsxBin,
          [
            cliEntry,
            "--source",
            tempFixture,
            "--out",
            tempOut,
            "--format",
            "markdown",
            "json",
            "--log-level",
            "warn",
          ],
          { cwd: projectRoot },
        );

        expect(exitCode).toBe(0);

        // Check that we have exactly one thread (root + self-reply only)
        const threadsDir = path.join(tempOut, "threads");
        const threadFiles = await fs.readdir(threadsDir);
        const mdFiles = threadFiles.filter((f) => f.endsWith(".md"));
        expect(mdFiles.length).toBe(1);

        // Read the thread content
        const threadContent = await fs.readFile(
          path.join(threadsDir, mdFiles[0]),
          "utf8",
        );

        // Should contain the root tweet and self-reply
        expect(threadContent).toContain("Root tweet by owner");
        expect(threadContent).toContain("Self reply by owner");

        // Should NOT contain the reply from someone else
        expect(threadContent).not.toContain("Reply from someone else");

        // Check normalized items to verify the reply from others is still captured
        const normPath = path.join(tempOut, "normalized_items.jsonl");
        const normRaw = await fs.readFile(normPath, "utf8");
        const normLines = normRaw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        // All 3 tweets should be in normalized items
        expect(normLines.length).toBe(3);

        // Verify the reply from others has the correct inReplyToUserId
        const items = normLines.map((l) => JSON.parse(l));
        const replyFromOther = items.find((i) => i.id === "102");
        expect(replyFromOther).toBeDefined();
        expect(replyFromOther?.inReplyToUserId).toBe("2222222222");
      } finally {
        if (tempOut.startsWith(os.tmpdir())) {
          await fs
            .rm(tempOut, { recursive: true, force: true })
            .catch(() => {});
        }
      }
    } finally {
      if (tempFixture.startsWith(os.tmpdir())) {
        await fs
          .rm(tempFixture, { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }, 30_000);
});
