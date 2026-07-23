import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { verifyLyncFile } from "../../src/outputs/lync.js";
import { archiveTweetEventId } from "../../src/outputs/lync-tweet-embed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "../.."); // repo root
const tsxBin = path.resolve(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const cliEntry = path.resolve(projectRoot, "splice.ts");

const archiveFixture = path.resolve(
  projectRoot,
  "tests/integration/fixtures/archive",
);
const glowficFixture = path.resolve(
  projectRoot,
  "tests/fixtures/glowfic-export/thread.json",
);
const embedCacheFixture = path.resolve(
  projectRoot,
  "tests/fixtures/tweet-embed-cache",
);
const markdownFixture = path.resolve(projectRoot, "tests/fixtures/lync-md/loom.lync");
const trainingFixture = path.resolve(
  projectRoot,
  "tests/fixtures/lync-training/fixture.lync",
);

// Real archives via the existing ../deep-space convention (see
// tests/lync/ocr-pages.test.ts and tweet-embed.test.ts); the real-archive
// specs are skipped when the checkout is absent, everything else always runs.
const realOcrDir =
  process.env.SPLICE_SIGNAL_OCR_DIR ??
  path.resolve(projectRoot, "../deep-space/data/signal-ocr");
const realEmbedCandidates = [
  process.env.SPLICE_DEEPSPACE_EMBED_CACHE,
  path.resolve(projectRoot, "../deep-space/.embed-cache/tweets"),
].filter((p): p is string => typeof p === "string" && p.length > 0);
const realEmbedDir = realEmbedCandidates.find((p) => fssync.existsSync(p));

async function runCli(args: string[]) {
  return execa(tsxBin, [cliEntry, ...args], {
    cwd: projectRoot,
    reject: false,
  });
}

/** Run a lync command expecting success; returns the parsed stdout report. */
async function runLyncOk(args: string[]) {
  const { exitCode, stdout } = await runCli([
    "lync",
    ...args,
    "--log-level",
    "warn",
  ]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

describe("splice lync CLI", () => {
  let outDir: string;

  beforeAll(async () => {
    expect(fssync.existsSync(tsxBin)).toBe(true);
    expect(fssync.existsSync(cliEntry)).toBe(true);
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-lync-cli-"));
  });

  afterAll(async () => {
    if (outDir && outDir.startsWith(os.tmpdir())) {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("help and errors", () => {
    it("`splice lync --help` names every command and the stats contract", async () => {
      const { exitCode, stderr } = await runCli(["lync", "--help"]);
      expect(exitCode).toBe(0);
      for (const cmd of [
        "archive",
        "glowfic",
        "ocr",
        "tweet-embed",
        "markdown",
        "training",
        "session-loom",
        "claudeai-export",
        "chatgpt-export",
      ]) {
        expect(stderr).toContain(cmd);
      }
      for (const flag of [
        "--source",
        "--out",
        "--out-dir",
        "--operator",
        "--via",
        "--source-ref",
        "--marked-at",
        "--set-locator",
        "--archive-ids-file",
        "--user-actor",
        "--assistant-actor",
        "--title",
        "--head",
        "--render",
        "--dry-run",
      ]) {
        expect(stderr).toContain(flag);
      }
      expect(stderr).toContain("stdout");
      expect(stderr).toContain("Nothing is dropped silently");
    });

    it("top-level `splice --help` mentions the lync subcommand", async () => {
      const { exitCode, stderr } = await runCli(["--help"]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("splice lync <command>");
      expect(stderr).toContain("splice lync --help");
    });

    it("usage errors exit 2: bare `lync`, unknown command, missing flags, unknown flag, bad --marked-at", async () => {
      expect((await runCli(["lync"])).exitCode).toBe(2);

      const unknown = await runCli(["lync", "nope"]);
      expect(unknown.exitCode).toBe(2);
      expect(unknown.stderr).toContain('Unknown lync command "nope"');

      const missingOut = await runCli(["lync", "ocr", "--source", "x"]);
      expect(missingOut.exitCode).toBe(2);
      expect(missingOut.stderr).toContain("requires --out");

      const badFlag = await runCli([
        "lync",
        "glowfic",
        "--source",
        "x",
        "--out",
        "y",
        "--set-locator",
        "z",
      ]);
      expect(badFlag.exitCode).toBe(2);
      expect(badFlag.stderr).toContain(
        "Unknown flag --set-locator for `splice lync glowfic`",
      );

      const badMarked = await runCli([
        "lync",
        "ocr",
        "--source",
        "x",
        "--out",
        "y",
        "--marked-at",
        "yesterday",
      ]);
      expect(badMarked.exitCode).toBe(2);
      expect(badMarked.stderr).toContain("--marked-at must be RFC 3339");
    }, 30_000);

    it("runtime errors exit 1 with the reason on stderr", async () => {
      const r = await runCli([
        "lync",
        "ocr",
        "--source",
        "/nonexistent-splice-dir",
        "--out",
        path.join(os.tmpdir(), "never-written.lync"),
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("[error]");
    });
  });

  describe("raw lync exports", () => {
    it("projects raw events to Markdown without minting a loom", async () => {
      const out = path.join(outDir, "corpus.md");
      const report = await runLyncOk([
        "markdown",
        "--source",
        markdownFixture,
        "--out",
        out,
      ]);
      expect(report.command).toBe("lync markdown");
      expect(report.stats.accepted).toBe(12);
      expect(report.mainThread.length).toBeGreaterThan(0);
      expect(await fs.readFile(out, "utf8")).toContain(report.headId.slice(0, 8));
    });

    it("projects raw events and standard selections to training rows", async () => {
      const target = path.join(outDir, "training-export");
      const report = await runLyncOk([
        "training",
        "--source",
        trainingFixture,
        "--out-dir",
        target,
        "--render",
        "messages",
      ]);
      expect(report.command).toBe("lync training");
      expect(report.stats.sft_rows).toBe(2);
      expect(report.stats.preference_rows).toBe(1);
      expect(report.written).toContain("sft.messages.jsonl");
      expect(await fs.readFile(path.join(target, "preferences.jsonl"), "utf8"))
        .toContain('"selection_event"');
    });
  });

  describe("lync archive (twitter fixture)", () => {
    it("converts the archive end-to-end: stats on stdout, verifier-clean file", async () => {
      const out = path.join(outDir, "twitter.lync");
      const report = await runLyncOk([
        "archive",
        "--source",
        archiveFixture,
        "--out",
        out,
      ]);

      expect(report.command).toBe("lync archive");
      expect(report.detected).toBe("twitter");
      expect(report.dryRun).toBe(false);
      // fixture: 2 tweets (a self-reply chain) + 1 like, nothing skipped
      expect(report.stats.sourceRecords).toBe(3);
      expect(report.stats.emitted).toBe(3);
      expect(report.stats.skipped).toEqual([]);
      expect(report.verify.ok).toBe(true);
      expect(report.verify.counts.accepted).toBe(3);
      expect(report.verify.counts.byKind).toEqual({
        "twitter/tweet": 2,
        "twitter/like": 1,
      });

      // independent re-parse of the written file agrees
      const reverify = await verifyLyncFile(out);
      expect(reverify.ok).toBe(true);
      expect(reverify.counts.accepted).toBe(3);

      // the reply tweet parents its root via deterministic ids
      const lines = (await fs.readFile(out, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const byId = new Map(lines.map((e) => [e.id, e]));
      const reply = lines.find(
        (e) => e.payload?.id === "1000000000000000002",
      );
      expect(reply.parents).toHaveLength(1);
      expect(byId.get(reply.parents[0])?.payload?.id).toBe(
        "1000000000000000001",
      );
    }, 30_000);

    it("double-run produces byte-identical output", async () => {
      const outA = path.join(outDir, "twitter-a.lync");
      const outB = path.join(outDir, "twitter-b.lync");
      await runLyncOk(["archive", "--source", archiveFixture, "--out", outA]);
      await runLyncOk(["archive", "--source", archiveFixture, "--out", outB]);
      const [a, b] = await Promise.all([fs.readFile(outA), fs.readFile(outB)]);
      expect(a.equals(b)).toBe(true);
      expect(a.length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe("lync glowfic (thread.json fixture)", () => {
    it("converts the export end-to-end with explicit timestamp repairs", async () => {
      const out = path.join(outDir, "glowfic.lync");
      const report = await runLyncOk([
        "glowfic",
        "--source",
        glowficFixture,
        "--out",
        out,
      ]);

      expect(report.command).toBe("lync glowfic");
      expect(typeof report.threadEventId).toBe("string");
      expect(report.stats.threadEvents).toBe(1);
      expect(report.stats.postEvents).toBe(30);
      expect(report.stats.emitted).toBe(31);
      expect(report.stats.skipped).toEqual([]);
      // the fixture's non-RFC3339 timestamps are repaired loudly, not silently
      expect(report.stats.timestampFallbacks.length).toBeGreaterThan(0);
      expect(report.verify.ok).toBe(true);
      expect(report.verify.counts.byKind).toEqual({
        "glowfic/thread": 1,
        "glowfic/post": 30,
      });
    }, 30_000);

    it("double-run produces byte-identical output", async () => {
      const outA = path.join(outDir, "glowfic-a.lync");
      const outB = path.join(outDir, "glowfic-b.lync");
      await runLyncOk(["glowfic", "--source", glowficFixture, "--out", outA]);
      await runLyncOk(["glowfic", "--source", glowficFixture, "--out", outB]);
      const [a, b] = await Promise.all([fs.readFile(outA), fs.readFile(outB)]);
      expect(a.equals(b)).toBe(true);
    }, 30_000);
  });

  describe("lync ocr (synthetic page set)", () => {
    let srcDir: string;

    beforeAll(async () => {
      srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-lync-ocr-"));
      await fs.writeFile(path.join(srcDir, "page-001.txt"), "page one text");
      await fs.writeFile(path.join(srcDir, "page-001.desc.txt"), "page one desc");
      await fs.writeFile(path.join(srcDir, "page-002.txt"), "page two text");
      await fs.writeFile(path.join(srcDir, "combined.md"), "# all pages");
      // unrecognized file: must surface as an explicit skip
      await fs.writeFile(path.join(srcDir, "notes.backup"), "not a page");
    });

    afterAll(async () => {
      if (srcDir && srcDir.startsWith(os.tmpdir())) {
        await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("converts the page set; the skip and its reason are on stdout", async () => {
      const out = path.join(outDir, "ocr.lync");
      const report = await runLyncOk([
        "ocr",
        "--source",
        srcDir,
        "--out",
        out,
        "--set-locator",
        "cli-set",
      ]);

      expect(report.command).toBe("lync ocr");
      expect(report.stats.sourceFiles).toBe(5);
      expect(report.stats.pageEvents).toBe(2);
      expect(report.stats.documentEvents).toBe(1);
      expect(report.stats.emitted).toBe(4); // set + 2 pages + 1 doc
      expect(report.stats.skipped).toHaveLength(1);
      expect(report.stats.skipped[0].value).toBe("notes.backup");
      expect(report.stats.skipped[0].reason).toMatch(/unrecognized/);
      expect(report.verify.ok).toBe(true);
      expect(report.verify.counts.byKind).toEqual({
        "ocr/set": 1,
        "ocr/page": 2,
        "ocr/document": 1,
      });
    }, 30_000);

    it("--dry-run reports the same stats and writes nothing", async () => {
      const out = path.join(outDir, "ocr-dry.lync");
      const report = await runLyncOk([
        "ocr",
        "--source",
        srcDir,
        "--out",
        out,
        "--set-locator",
        "cli-set",
        "--dry-run",
      ]);
      expect(report.dryRun).toBe(true);
      expect(report.stats.emitted).toBe(4);
      expect(report.stats.skipped).toHaveLength(1);
      expect(report.verify).toBeUndefined();
      expect(fssync.existsSync(out)).toBe(false);
    }, 30_000);

    it("double-run produces byte-identical output", async () => {
      const outA = path.join(outDir, "ocr-a.lync");
      const outB = path.join(outDir, "ocr-b.lync");
      const args = ["ocr", "--source", srcDir, "--set-locator", "cli-set"];
      await runLyncOk([...args, "--out", outA]);
      await runLyncOk([...args, "--out", outB]);
      const [a, b] = await Promise.all([fs.readFile(outA), fs.readFile(outB)]);
      expect(a.equals(b)).toBe(true);
    }, 30_000);
  });

  describe("lync tweet-embed (fixture cache)", () => {
    it("converts the cache with the timestamp ladder visible in stats", async () => {
      const out = path.join(outDir, "embeds.lync");
      const report = await runLyncOk([
        "tweet-embed",
        "--source",
        embedCacheFixture,
        "--out",
        out,
      ]);

      expect(report.command).toBe("lync tweet-embed");
      expect(report.stats.sourceFiles).toBe(3);
      expect(report.stats.emitted).toBe(3);
      expect(report.stats.skipped).toEqual([]);
      // 2 snowflake ids + 1 pre-snowflake id repaired via the HTML anchor date
      expect(report.stats.atSources).toEqual({
        snowflake: 2,
        htmlDate: 1,
        cachedAt: 0,
        fallback: 0,
      });
      // no ids file: matching is reported as not provided, never assumed
      expect(report.stats.archiveMatching).toEqual({
        provided: false,
        matched: 0,
        unmatched: 3,
      });
      expect(report.verify.ok).toBe(true);
      expect(report.verify.counts.byKind).toEqual({
        "twitter/tweet-embed": 3,
      });
    }, 30_000);

    it("--archive-ids-file parents matched embeds to archive tweet events", async () => {
      const idsFile = path.join(outDir, "archive-ids.txt");
      await fs.writeFile(idsFile, "1094686272155602944\n");
      const out = path.join(outDir, "embeds-matched.lync");
      const report = await runLyncOk([
        "tweet-embed",
        "--source",
        embedCacheFixture,
        "--out",
        out,
        "--archive-ids-file",
        idsFile,
      ]);

      expect(report.stats.archiveMatching).toEqual({
        provided: true,
        matched: 1,
        unmatched: 2,
      });
      const lines = (await fs.readFile(out, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const matched = lines.find(
        (e) => e.payload.tweet_id === "1094686272155602944",
      );
      expect(matched.parents).toEqual([
        archiveTweetEventId("1094686272155602944"),
      ]);
    }, 30_000);

    it("double-run produces byte-identical output", async () => {
      const outA = path.join(outDir, "embeds-a.lync");
      const outB = path.join(outDir, "embeds-b.lync");
      await runLyncOk(["tweet-embed", "--source", embedCacheFixture, "--out", outA]);
      await runLyncOk(["tweet-embed", "--source", embedCacheFixture, "--out", outB]);
      const [a, b] = await Promise.all([fs.readFile(outA), fs.readFile(outB)]);
      expect(a.equals(b)).toBe(true);
    }, 30_000);
  });

  // Conversation-loom commands write .loom.json snapshots (not .lync), then
  // re-open each through the real Looms API. Fixtures are SYNTHETIC.
  describe("lync loom commands (synthetic conversation fixtures)", () => {
    let loomSrc: string;

    beforeAll(async () => {
      loomSrc = await fs.mkdtemp(path.join(os.tmpdir(), "splice-lync-loom-"));
      // Claude Code session: 2 user + 2 assistant, last assistant is tool-only.
      await fs.writeFile(
        path.join(loomSrc, "session.jsonl"),
        [
          `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-07-13T00:00:00Z","message":{"role":"user","content":"synthetic greeting"}}`,
          `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-07-13T00:00:01Z","message":{"role":"assistant","model":"claude-synthetic","content":[{"type":"text","text":"synthetic reply"}]}}`,
          `{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-07-13T00:00:02Z","message":{"role":"user","content":"synthetic follow up"}}`,
          `{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-07-13T00:00:03Z","message":{"role":"assistant","model":"claude-synthetic","content":[{"type":"tool_use","name":"synth_tool","id":"t1","input":{}}]}}`,
        ].join("\n") + "\n",
      );
      // Claude.ai export: one parent-linked chat, one linkage-less (linear) chat.
      await fs.writeFile(
        path.join(loomSrc, "claudeai.json"),
        JSON.stringify([
          {
            uuid: "conv-a",
            name: "Synthetic chat A",
            chat_messages: [
              { uuid: "m1", sender: "human", text: "synthetic human A" },
              {
                uuid: "m2",
                parent_message_uuid: "m1",
                sender: "assistant",
                model: "claude-synthetic",
                text: "synthetic assistant A",
              },
            ],
          },
          {
            uuid: "conv-b",
            name: "Synthetic chat B",
            chat_messages: [
              { uuid: "n1", sender: "human", text: "synthetic human B" },
              { uuid: "n2", sender: "assistant", text: "synthetic assistant B" },
            ],
          },
        ]),
      );
      // ChatGPT export: a mapping graph with a message-less root placeholder.
      await fs.writeFile(
        path.join(loomSrc, "chatgpt.json"),
        JSON.stringify([
          {
            conversation_id: "cg-1",
            title: "Synthetic ChatGPT chat",
            mapping: {
              root: { id: "root", parent: null, children: ["c1"], message: null },
              c1: {
                id: "c1",
                parent: "root",
                children: ["c2"],
                message: {
                  id: "c1",
                  author: { role: "user" },
                  content: { content_type: "text", parts: ["synthetic prompt"] },
                  create_time: 1760000000,
                },
              },
              c2: {
                id: "c2",
                parent: "c1",
                children: [],
                message: {
                  id: "c2",
                  author: { role: "assistant" },
                  metadata: { model_slug: "gpt-synthetic" },
                  content: { content_type: "text", parts: ["synthetic answer"] },
                  create_time: 1760000001,
                },
              },
            },
          },
        ]),
      );
      // Twitter/X archive DIR: a self-thread with a FORK + a standalone tweet +
      // a retweet, plus a like in a separate data type. Synthetic; the `.js`
      // files carry the `window.YTD.* = ` prefix a real archive uses.
      const twArchive = path.join(loomSrc, "twitter-archive");
      const twData = path.join(twArchive, "data");
      await fs.mkdir(twData, { recursive: true });
      await fs.writeFile(
        path.join(twData, "manifest.js"),
        "window.__THAR_CONFIG = " +
          JSON.stringify({
            dataTypes: {
              tweets: { files: [{ fileName: "data/tweets.js" }] },
              like: { files: [{ fileName: "data/like.js" }] },
            },
          }),
      );
      await fs.writeFile(
        path.join(twData, "account.js"),
        "window.YTD.account.part0 = " +
          JSON.stringify([{ account: { accountId: "111", username: "owner_handle" } }]),
      );
      const tw = (t: Record<string, unknown>) => ({ tweet: t });
      await fs.writeFile(
        path.join(twData, "tweets.js"),
        "window.YTD.tweets.part0 = " +
          JSON.stringify([
            tw({ id: "s1", id_str: "s1", full_text: "synthetic opener", created_at: "Wed Jul 01 00:00:00 +0000 2026" }),
            tw({ id: "s2", id_str: "s2", full_text: "synthetic self-reply A", in_reply_to_status_id: "s1", in_reply_to_status_id_str: "s1", created_at: "Wed Jul 01 00:01:00 +0000 2026" }),
            tw({ id: "s3", id_str: "s3", full_text: "synthetic self-reply B (fork)", in_reply_to_status_id: "s1", in_reply_to_status_id_str: "s1", created_at: "Wed Jul 01 00:02:00 +0000 2026" }),
            tw({ id: "s4", id_str: "s4", full_text: "synthetic standalone", created_at: "Wed Jul 01 00:03:00 +0000 2026" }),
            tw({ id: "s5", id_str: "s5", full_text: "RT @someone: synthetic retweet", created_at: "Wed Jul 01 00:04:00 +0000 2026" }),
          ]),
      );
      await fs.writeFile(
        path.join(twData, "like.js"),
        "window.YTD.like.part0 = " +
          JSON.stringify([{ like: { tweetId: "L1", fullText: "a synthetic liked tweet" } }]),
      );
    });

    afterAll(async () => {
      if (loomSrc && loomSrc.startsWith(os.tmpdir())) {
        await fs.rm(loomSrc, { recursive: true, force: true }).catch(() => {});
      }
    });

    /** A written .loom.json opens as a conversation-profile snapshot. */
    async function readSnapshot(p: string) {
      return JSON.parse(await fs.readFile(p, "utf8"));
    }

    it("session-loom: one conversation loom, verified openable", async () => {
      const out = path.join(outDir, "session.loom.json");
      const report = await runLyncOk([
        "session-loom",
        "--source",
        path.join(loomSrc, "session.jsonl"),
        "--out",
        out,
        "--title",
        "Synthetic Session",
      ]);

      expect(report.command).toBe("lync session-loom");
      expect(report.stats.turns).toBe(4);
      expect(report.stats.nonTurnEvents).toEqual({});
      // full line-level accounting carried through, nothing dropped
      expect(report.stats.session.skipped).toEqual([]);
      expect(report.stats.session.emitted).toBe(4);
      expect(report.verify).toHaveLength(1);
      expect(report.verify[0].ok).toBe(true);
      expect(report.verify[0].profile).toBe("conversation");
      expect(report.verify[0].turns).toBe(4);

      const snapshot = await readSnapshot(out);
      expect(snapshot.loom.meta.profile).toBe("conversation");
      expect(snapshot.loom.meta.source).toBe("claude-session");
      expect(snapshot.loom.meta.title).toBe("Synthetic Session");
      expect(snapshot.turns).toHaveLength(4);
    }, 30_000);

    it("session-loom --dry-run reports stats and writes nothing", async () => {
      const out = path.join(outDir, "session-dry.loom.json");
      const report = await runLyncOk([
        "session-loom",
        "--source",
        path.join(loomSrc, "session.jsonl"),
        "--out",
        out,
        "--dry-run",
      ]);
      expect(report.dryRun).toBe(true);
      expect(report.stats.turns).toBe(4);
      expect(report.outputs).toEqual([]);
      expect(report.verify).toBeUndefined();
      expect(fssync.existsSync(out)).toBe(false);
    }, 30_000);

    it("claudeai-export: one loom per chat, both linkage modes surfaced", async () => {
      const dir = path.join(outDir, "claudeai");
      const report = await runLyncOk([
        "claudeai-export",
        "--source",
        path.join(loomSrc, "claudeai.json"),
        "--out-dir",
        dir,
      ]);

      expect(report.command).toBe("lync claudeai-export");
      expect(report.stats.conversations).toBe(2);
      expect(report.stats.skippedConversations).toBe(0);
      expect(report.stats.totalTurns).toBe(4);
      expect(report.stats.perConversation.map((c: any) => c.linkage)).toEqual([
        "parent",
        "linear",
      ]);
      expect(report.outputs).toHaveLength(2);
      expect(report.verify).toHaveLength(2);
      for (const v of report.verify) {
        expect(v.ok).toBe(true);
        expect(v.profile).toBe("conversation");
      }
      for (const o of report.outputs) {
        const snapshot = await readSnapshot(o.outputPath);
        expect(snapshot.loom.meta.profile).toBe("conversation");
        expect(snapshot.loom.meta.source).toBe("claudeai-export");
      }
    }, 30_000);

    it("chatgpt-export: mapping graph → loom, placeholder counted not dropped", async () => {
      const dir = path.join(outDir, "chatgpt");
      const report = await runLyncOk([
        "chatgpt-export",
        "--source",
        path.join(loomSrc, "chatgpt.json"),
        "--out-dir",
        dir,
      ]);

      expect(report.command).toBe("lync chatgpt-export");
      expect(report.stats.conversations).toBe(1);
      expect(report.stats.totalTurns).toBe(2);
      // the message-less root node is a counted placeholder, never a silent drop
      expect(report.stats.totalPlaceholderNodes).toBe(1);
      expect(report.stats.totalMalformedNodes).toBe(0);
      expect(report.outputs).toHaveLength(1);
      expect(report.verify[0].ok).toBe(true);
      expect(report.verify[0].profile).toBe("conversation");

      const snapshot = await readSnapshot(report.outputs[0].outputPath);
      expect(snapshot.loom.meta.profile).toBe("conversation");
      expect(snapshot.loom.meta.source).toBe("chatgpt-export");
      expect(snapshot.turns).toHaveLength(2);
    }, 30_000);

    it("twitter-threads: archive dir → looms, fork survives, RT+like counted", async () => {
      const dir = path.join(outDir, "twitter");
      const report = await runLyncOk([
        "twitter-threads",
        "--source",
        path.join(loomSrc, "twitter-archive"),
        "--out-dir",
        dir,
      ]);

      expect(report.command).toBe("lync twitter-threads");
      // Two threads: the 3-tweet self-thread (with fork) + the standalone.
      expect(report.stats.threads).toBe(2);
      expect(report.stats.standaloneThreads).toBe(1);
      expect(report.stats.totalTurns).toBe(4);
      // The retweet and the like are counted, never silently dropped.
      expect(report.stats.retweets).toBe(1);
      expect(report.stats.likes).toBe(1);
      expect(report.stats.malformed).toBe(0);
      // sourceRecords = 5 tweets + 1 like = 6; reconciles.
      expect(report.stats.sourceRecords).toBe(
        report.stats.totalTurns +
          report.stats.retweets +
          report.stats.likes +
          report.stats.malformed,
      );

      expect(report.outputs).toHaveLength(2);
      for (const v of report.verify) {
        expect(v.ok).toBe(true);
        expect(v.profile).toBe("conversation");
      }

      // The self-thread snapshot: owner tweets (deepfates/user), fork preserved.
      const treeOut = report.outputs.find((o: any) => o.turns === 3)!;
      const snapshot = await readSnapshot(treeOut.outputPath);
      expect(snapshot.loom.meta.profile).toBe("conversation");
      expect(snapshot.loom.meta.source).toBe("twitter-threads");
      expect(snapshot.turns).toHaveLength(3);
      // s2 and s3 both reply to s1 → both branched under the same parent turn.
      const s1 = snapshot.turns.find((t: any) => t.parentId === null);
      const kids = snapshot.turns.filter((t: any) => t.parentId === s1.id);
      expect(kids).toHaveLength(2);
    }, 30_000);

    it("loom commands reject flags they do not wire (no silent drops)", async () => {
      // --via/--marked-at/--actor are not accepted on loom commands.
      const badVia = await runCli([
        "lync",
        "session-loom",
        "--source",
        path.join(loomSrc, "session.jsonl"),
        "--out",
        path.join(outDir, "never.loom.json"),
        "--via",
        "x@1",
      ]);
      expect(badVia.exitCode).toBe(2);
      expect(badVia.stderr).toContain(
        "Unknown flag --via for `splice lync session-loom`",
      );

      // export commands require --out-dir, not --out
      const missingDir = await runCli([
        "lync",
        "claudeai-export",
        "--source",
        path.join(loomSrc, "claudeai.json"),
      ]);
      expect(missingDir.exitCode).toBe(2);
      expect(missingDir.stderr).toContain("requires --out-dir");
    }, 30_000);
  });

  describe.skipIf(!fssync.existsSync(realOcrDir))(
    "lync ocr against the REAL signal-ocr archive",
    () => {
      it("converts all 100 pages + combined doc, verifier-clean", async () => {
        const out = path.join(outDir, "signal-ocr-real.lync");
        const report = await runLyncOk([
          "ocr",
          "--source",
          realOcrDir,
          "--out",
          out,
        ]);
        expect(report.stats.sourceFiles).toBe(201);
        expect(report.stats.pageEvents).toBe(100);
        expect(report.stats.documentEvents).toBe(1);
        expect(report.stats.emitted).toBe(102);
        expect(report.stats.skipped).toEqual([]);
        expect(report.verify.ok).toBe(true);
        expect(report.verify.counts.accepted).toBe(102);
      }, 60_000);
    },
  );

  describe.skipIf(!realEmbedDir)(
    "lync tweet-embed against the REAL deep-space cache",
    () => {
      it("counts reconcile and every written line verifies", async () => {
        const out = path.join(outDir, "embeds-real.lync");
        const report = await runLyncOk([
          "tweet-embed",
          "--source",
          realEmbedDir as string,
          "--out",
          out,
        ]);
        expect(report.stats.sourceFiles).toBeGreaterThan(0);
        expect(
          report.stats.emitted + report.stats.skipped.length,
        ).toBe(report.stats.sourceFiles);
        expect(report.verify.ok).toBe(true);
        expect(report.verify.counts.accepted).toBe(report.stats.emitted);
      }, 60_000);
    },
  );
});
