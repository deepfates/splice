import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  portableMediaBasename,
  writeTwitterPublicMarkdown,
} from "../../src/outputs/twitter-public-markdown.js";
import { ingestTwitterPublicWriting } from "../../src/sources/twitter-public-writing.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsxBin = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const cliEntry = path.join(projectRoot, "splice.ts");

function wrapped(name: string, value: unknown): string {
  return `window.YTD.${name}.part0 = ${JSON.stringify(value, null, 2)}\n`;
}

describe("splice twitter-markdown", () => {
  let temp: string;
  let archive: string;
  let out: string;

  beforeAll(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-twitter-markdown-"));
    archive = path.join(temp, "archive");
    out = path.join(temp, "vault");
    const data = path.join(archive, "data");
    await fs.mkdir(path.join(data, "tweets_media"), { recursive: true });
    await fs.mkdir(path.join(data, "community_tweet_media"), { recursive: true });
    await fs.writeFile(
      path.join(data, "manifest.js"),
      wrapped("manifest", {
        dataTypes: {
          account: { files: [{ fileName: "data/account.js" }] },
          tweets: { files: [{ fileName: "data/tweets.js" }] },
          communityTweet: { files: [{ fileName: "data/community-tweet.js" }] },
          noteTweet: { files: [{ fileName: "data/note-tweet.js" }] },
          article: { files: [{ fileName: "data/article.js" }] },
          articleMetadata: { files: [{ fileName: "data/article-metadata.js" }] },
          deletedTweets: { files: [{ fileName: "data/deleted-tweets.js" }] },
          like: { files: [{ fileName: "data/like.js" }] },
          directMessages: { files: [{ fileName: "data/direct-messages.js" }] },
        },
      }),
    );
    await fs.writeFile(
      path.join(data, "account.js"),
      wrapped("account", [{ account: { username: "archive_author", accountId: "owner-1" } }]),
    );
    await fs.writeFile(
      path.join(data, "tweets.js"),
      wrapped("tweets", [
        {
          tweet: {
            id_str: "1001",
            full_text: "#Same opening words @friend https://t.co/a https://t.co/media",
            created_at: "Wed Jan 01 12:00:00 +0000 2025",
            entities: {
              urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/a" }],
              media: [{ url: "https://t.co/media" }],
            },
          },
        },
        {
          tweet: {
            id_str: "1002",
            full_text: "#Same opening words @friend with a reply",
            created_at: "Wed Jan 01 12:01:00 +0000 2025",
            in_reply_to_status_id_str: "1001",
            in_reply_to_user_id_str: "owner-1",
          },
        },
        {
          tweet: {
            id_str: "1003",
            full_text: "RT @someone: not authored writing",
            created_at: "Wed Jan 01 12:02:00 +0000 2025",
          },
        },
        {
          tweet: {
            id_str: "1004",
            full_text: "First standalone post",
            created_at: "Wed Jan 01 13:00:00 +0000 2025",
          },
        },
        {
          tweet: {
            id_str: "1005",
            full_text: "Second standalone post",
            created_at: "Wed Jan 01 14:00:00 +0000 2025",
          },
        },
        {
          tweet: {
            id_str: "1006",
            full_text: "A reply to somebody else",
            created_at: "Wed Jan 01 15:00:00 +0000 2025",
            in_reply_to_status_id_str: "9999",
            in_reply_to_user_id_str: "other-1",
            in_reply_to_screen_name: "somebody_else",
          },
        },
        {
          tweet: {
            id_str: "1010",
            full_text: "All I want to do",
            created_at: "Wed Jan 01 16:00:00 +0000 2025",
          },
        },
        {
          tweet: {
            id_str: "1011",
            full_text: "First case-collision thread reply",
            created_at: "Wed Jan 01 16:01:00 +0000 2025",
            in_reply_to_status_id_str: "1010",
            in_reply_to_user_id_str: "owner-1",
          },
        },
        {
          tweet: {
            id_str: "1012",
            full_text: "Second branch reply in another year",
            created_at: "Thu Jan 01 17:02:00 +0000 2026",
            in_reply_to_status_id_str: "1010",
            in_reply_to_user_id_str: "owner-1",
          },
        },
        {
          tweet: {
            id_str: "1020",
            full_text: "all i want to do",
            created_at: "Wed Jan 01 17:00:00 +0000 2025",
          },
        },
        {
          tweet: {
            id_str: "1021",
            full_text: "Second case-collision thread reply",
            created_at: "Wed Jan 01 17:01:00 +0000 2025",
            in_reply_to_status_id_str: "1020",
            in_reply_to_user_id_str: "owner-1",
          },
        },
        {
          tweet: {
            id_str: "1007",
            full_text: "A quote reference https://t.co/quote",
            created_at: "Wed Jan 01 18:00:00 +0000 2025",
            entities: {
              urls: [{ url: "https://t.co/quote", expanded_url: "https://t.co/quote" }],
            },
          },
        },
        {
          tweet: {
            id_str: "1008",
            full_text: "Reply to a deleted archived parent",
            created_at: "Wed Jan 01 19:00:00 +0000 2025",
            in_reply_to_status_id_str: "5001",
            in_reply_to_user_id_str: "owner-1",
          },
        },
        {
          tweet: {
            id_str: "1009",
            full_text: "Reply to an unavailable parent",
            created_at: "Wed Jan 01 20:00:00 +0000 2025",
            in_reply_to_status_id_str: "7777",
            in_reply_to_user_id_str: "other-2",
            in_reply_to_screen_name: "unavailable_author",
          },
        },
      ]),
    );
    await fs.writeFile(
      path.join(data, "community-tweet.js"),
      wrapped("community_tweet", [{
        tweet: {
          id_str: "2001",
          full_text: "A community post",
          created_at: "Thu Jan 02 12:00:00 +0000 2025",
          community_id_str: "200000",
        },
      }]),
    );
    await fs.writeFile(
      path.join(data, "note-tweet.js"),
      wrapped("note_tweet", [{
        noteTweet: {
          noteTweetId: "3001",
          createdAt: "2025-01-03T12:00:00.000Z",
          core: { text: "A long-form Note Tweet" },
        },
      }]),
    );
    await fs.writeFile(
      path.join(data, "article.js"),
      wrapped("article", [
        { article: { id: "4001", title: "Published article", content: { blocks: [{ text: "First paragraph." }, { text: "Second paragraph." }] } } },
        { article: { id: "4002", title: "Private draft", content: { blocks: [{ text: "Do not export." }] } } },
        { article: { id: "4003", title: "Body unavailable article", content: { blocks: [] } } },
      ]),
    );
    await fs.writeFile(
      path.join(data, "article-metadata.js"),
      wrapped("article_metadata", [
        { articleMetadata: { firstPublishedAtMs: "1735992000000", tweetId: "4000", lifecycleState: { lifecycle: { name: "Published" } } } },
        { articleMetadata: { createdAtMs: "1736078400000", lifecycleState: { lifecycle: { name: "Draft" } } } },
        { articleMetadata: { firstPublishedAtMs: "1736164800000", tweetId: "4003", lifecycleState: { lifecycle: { name: "Published" } } } },
      ]),
    );
    await fs.writeFile(
      path.join(data, "direct-messages.js"),
      wrapped("direct_messages", [{ dmConversation: { messages: [{ text: "private" }] } }]),
    );
    await fs.writeFile(
      path.join(data, "like.js"),
      wrapped("like", [
        {
          like: {
            tweetId: "9999",
            fullText: "The parent post recovered from likes… with a second line.",
            expandedUrl: "https://twitter.com/i/web/status/9999",
          },
        },
        {
          like: {
            tweetId: "7777",
            fullText: "This Post is unavailable.",
            expandedUrl: "https://twitter.com/i/web/status/7777",
          },
        },
        {
          like: {
            tweetId: "8888",
            fullText: "An unrelated liked post that must not be exported.",
            expandedUrl: "https://twitter.com/i/web/status/8888",
          },
        },
      ]),
    );
    await fs.writeFile(
      path.join(data, "deleted-tweets.js"),
      wrapped("deleted_tweets", [{
        tweet: {
          id_str: "5001",
          full_text: "Recently deleted",
          created_at: "Mon Jan 06 12:00:00 +0000 2025",
          deleted_at: "Mon Jan 06 13:00:00 +0000 2025",
        },
      }]),
    );
    await fs.writeFile(path.join(data, "tweets_media", "1001-image.jpg"), "image");
    await fs.writeFile(path.join(data, "tweets_media", "1001-a]b).jpg"), "image");
  });

  afterAll(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });

  it("writes a reconciled, collision-free, portable public-writing vault", async () => {
    const result = await execa(
      tsxBin,
      [cliEntry, "twitter-markdown", "--source", archive, "--out", out, "--quiet"],
      { cwd: projectRoot },
    );
    const report = JSON.parse(result.stdout);
    expect(report.records).toBe(17);
    expect(report.notesWritten).toBe(17);
    expect(report.notesByKind).toEqual({
      tweet: 13,
      "community-tweet": 1,
      "note-tweet": 1,
      article: 2,
      "deleted-tweet": 0,
    });
    expect(report.replies).toBe(7);
    expect(report.replyContext).toEqual({
      authored: 4,
      deleted: 1,
      liked: 1,
      unavailable: 1,
      missing: 0,
    });
    expect(report.authoredParentLinks).toBe(4);
    expect(report.authoredChildLinks).toBe(4);
    expect(report.mediaCopied).toBe(2);
    expect(report.stats.skipped.retweets).toBe(1);
    expect(report.stats.skipped.articleDrafts).toBe(1);
    expect(report.stats.skipped.deletedTweets).toBe(1);
    expect(report.stats.totals).toEqual({ source: 20, emitted: 17, skipped: 3, reconciled: true });
    expect(report.stats.replyContext).toEqual({
      parentIdsAbsentFromAuthoredArchive: 3,
      likeRecordsScanned: 3,
      recoveredFromDeletedTweets: 1,
      recoveredFromLikes: 1,
      unavailableFromLikes: 1,
      stillMissing: 0,
      coverage: 2 / 3,
      unavailableLikeFiles: 0,
    });

    const index = (await fs.readFile(path.join(out, ".splice", "export-index.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(index).toHaveLength(17);
    expect(new Set(index.map((entry) => entry.file)).size).toBe(17);
    const entry = (id: string) => index.find((value) => value.id === id);
    const note = async (id: string) => fs.readFile(path.join(out, entry(id)?.file), "utf8");

    const root = await note("1001");
    expect(root).toContain('type: "tweet"');
    expect(root).toContain('id: "1001"');
    expect(root).toContain("\\#Same opening words @friend https://example.com/a");
    expect(root).not.toContain("https://t.co/media");
    expect(root).toContain("../../../media/1001/1001-image.jpg");
    expect(root).toContain("![1001-a\\]b).jpg](../../../media/1001/1001-a_b_.jpg)");
    expect(root).toContain("### Replies in this archive");
    expect(root).toContain(entry("1002")?.file.split("/").at(-1));

    const authoredReply = await note("1002");
    expect(authoredReply).toContain('reply_context: "authored"');
    expect(authoredReply).toContain("> [In reply to an archived post]");
    expect(authoredReply).toContain("> \\#Same opening words @friend https://example.com/a");
    expect(authoredReply).toContain("#Same opening words @friend with a reply");

    const externalReply = await note("1006");
    expect(externalReply).toContain('reply_context: "liked"');
    expect(externalReply).toContain("> [In reply to @somebody_else](https://twitter.com/i/web/status/9999)");
    expect(externalReply).toContain("> The parent post recovered from likes… with a second line.");
    expect(externalReply).toContain("A reply to somebody else");
    expect(externalReply).not.toContain("An unrelated liked post");

    expect(entry("1004")?.file).toMatch(/^tweets\/2025\/01\/2025-01-01--.*--1004\.md$/);
    expect(entry("1005")?.file).toMatch(/^tweets\/2025\/01\/2025-01-01--.*--1005\.md$/);
    expect(entry("1010")?.file.toLocaleLowerCase("en-US")).not.toBe(
      entry("1020")?.file.toLocaleLowerCase("en-US"),
    );
    expect(entry("2001")?.file).toMatch(/^community-tweets\/200000\/2025\/01\//);
    expect(entry("2001")?.communityId).toBe("200000");

    expect(await note("1007")).toContain("A quote reference https://t.co/quote");

    const deletedParentReply = await note("1008");
    expect(deletedParentReply).toContain('reply_context: "deleted"');
    expect(deletedParentReply).toContain("recovered from a deleted-tweet record");
    expect(deletedParentReply).toContain("> Recently deleted");

    const unavailableReply = await note("1009");
    expect(unavailableReply).toContain('reply_context: "unavailable"');
    expect(unavailableReply).toContain("parent text is unavailable");
    expect(unavailableReply).not.toContain("> This Post is unavailable");

    const article = await note("4001");
    expect(article).toContain("# Published article");
    expect(article).toContain("First paragraph.\n\nSecond paragraph.");
    expect(article).not.toContain("Do not export");
    expect(await note("4003")).toContain("*Article body was not present in the archive.*");

    const readme = await fs.readFile(path.join(out, "README.md"), "utf8");
    expect(readme).not.toContain("private");
    expect(readme).toContain("liked-post text is used only for matched reply context");
    expect(await fs.stat(path.join(out, "threads")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(out, "replies_by_date")).catch(() => null)).toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(out, ".splice", "export-report.json"), "utf8"))).toEqual(report);
  });

  it("retains resolvable reciprocal links across branches and directories", async () => {
    const index = (await fs.readFile(path.join(out, ".splice", "export-index.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const byId = new Map(index.map((entry) => [entry.id, entry]));

    for (const entry of index) {
      const markdown = await fs.readFile(path.join(out, entry.file), "utf8");
      for (const match of markdown.matchAll(/!?\[(?:\\.|[^\]])*\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^[a-z]+:/i.test(target)) continue;
        const absolute = path.resolve(out, path.dirname(entry.file), decodeURI(target));
        expect(await fs.stat(absolute).then(() => true).catch(() => false), `${entry.file}: ${target}`).toBe(true);
      }

      if (!entry.parentId) continue;
      const parent = byId.get(entry.parentId);
      if (!parent) continue;
      const parentMarkdown = await fs.readFile(path.join(out, parent.file), "utf8");
      const parentLink = encodeURI(path.posix.relative(path.posix.dirname(entry.file), parent.file));
      const childLink = encodeURI(path.posix.relative(path.posix.dirname(parent.file), entry.file));
      expect(markdown).toContain(`](${parentLink})`);
      expect(parentMarkdown).toContain(`](${childLink})`);
    }

    const branch = index.filter((entry) => entry.parentId === "1010");
    expect(branch).toHaveLength(2);
    expect(new Set(branch.map((entry) => entry.file.split("/")[1]))).toEqual(new Set(["2025", "2026"]));
  });

  it("includes authored deleted records when requested", async () => {
    const deletedOut = path.join(temp, "deleted-vault");
    const result = await execa(
      tsxBin,
      [cliEntry, "twitter-markdown", "--source", archive, "--out", deletedOut, "--include-deleted", "--quiet"],
      { cwd: projectRoot },
    );
    const report = JSON.parse(result.stdout);
    expect(report.records).toBe(18);
    expect(report.notesByKind["deleted-tweet"]).toBe(1);
    expect(report.stats.skipped.deletedTweets).toBe(0);
    expect(report.replyContext.authored).toBe(5);
    expect(report.replyContext.deleted).toBe(0);
    const index = (await fs.readFile(path.join(deletedOut, ".splice", "export-index.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const deleted = index.find((entry) => entry.id === "5001");
    expect(deleted.file).toMatch(/^deleted-tweets\/2025\/01\//);
    const deletedNote = await fs.readFile(path.join(deletedOut, deleted.file), "utf8");
    expect(deletedNote).toContain('deleted_at: "2025-01-06T13:00:00.000Z"');
    expect(deletedNote).toContain("Recently deleted");
  });

  it("makes --no-media an honest text-focused export", async () => {
    const textOut = path.join(temp, "text-vault");
    const result = await execa(
      tsxBin,
      [cliEntry, "twitter-markdown", "--source", archive, "--out", textOut, "--no-media", "--quiet"],
      { cwd: projectRoot },
    );
    const report = JSON.parse(result.stdout);
    expect(report.mediaReferenced).toBe(0);
    expect(report.mediaCopied).toBe(0);
    expect(await fs.stat(path.join(textOut, "media")).catch(() => null)).toBeNull();
    const index = (await fs.readFile(path.join(textOut, ".splice", "export-index.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const mediaTweet = index.find((entry) => entry.id === "1001");
    expect(await fs.readFile(path.join(textOut, mediaTweet.file), "utf8")).not.toContain("1001-image.jpg");
  });

  it("rejects nonnumeric archive identifiers before writing", async () => {
    const result = await ingestTwitterPublicWriting(archive, () => undefined);
    result.records[0].id = "x/../../../../../escaped-owned";
    await expect(
      writeTwitterPublicMarkdown(result, path.join(temp, "unsafe-vault"), () => undefined, { dryRun: true }),
    ).rejects.toThrow("invalid record id");
    expect(await fs.stat(path.join(temp, "escaped-owned.md")).catch(() => null)).toBeNull();

    const communityResult = await ingestTwitterPublicWriting(archive, () => undefined);
    const community = communityResult.records.find((record) => record.kind === "community-tweet");
    if (!community) throw new Error("fixture community tweet missing");
    community.communityId = "../../escaped-community";
    await expect(
      writeTwitterPublicMarkdown(
        communityResult,
        path.join(temp, "unsafe-community-vault"),
        () => undefined,
        { dryRun: true },
      ),
    ).rejects.toThrow("invalid community id");
  });

  it("does not finalize a vault when a planned media copy fails", async () => {
    const result = await ingestTwitterPublicWriting(archive, () => undefined);
    const mediaRecord = result.records.find((record) => record.id === "1001");
    if (!mediaRecord?.media[0]) throw new Error("fixture media missing");
    mediaRecord.media[0].sourcePath = path.join(temp, "does-not-exist.jpg");
    const failedOut = path.join(temp, "failed-media-vault");
    await expect(
      writeTwitterPublicMarkdown(result, failedOut, () => undefined),
    ).rejects.toThrow("could not copy media");
    expect(await fs.stat(failedOut).catch(() => null)).toBeNull();
    expect(await fs.stat(`${failedOut}.partial-${process.pid}`)).not.toBeNull();
  });

  it("rejects manifest members outside the selected archive boundary", async () => {
    const traversalRoot = path.join(temp, "traversal-archive");
    await fs.mkdir(path.join(traversalRoot, "data"), { recursive: true });
    await fs.writeFile(path.join(temp, "outside.js"), wrapped("outside", []));
    await fs.writeFile(
      path.join(traversalRoot, "data", "manifest.js"),
      wrapped("manifest", { dataTypes: { tweets: { files: [{ fileName: "../outside.js" }] } } }),
    );
    await expect(ingestTwitterPublicWriting(traversalRoot, () => undefined)).rejects.toThrow(
      "archive member escapes selected directory",
    );

    const likeTraversalRoot = path.join(temp, "like-traversal-archive");
    await fs.mkdir(path.join(likeTraversalRoot, "data"), { recursive: true });
    await fs.writeFile(path.join(likeTraversalRoot, "data", "tweets.js"), wrapped("tweets", []));
    await fs.writeFile(
      path.join(likeTraversalRoot, "data", "manifest.js"),
      wrapped("manifest", {
        dataTypes: {
          tweets: { files: [{ fileName: "data/tweets.js" }] },
          like: { files: [{ fileName: "../outside-like.js" }] },
        },
      }),
    );
    await expect(ingestTwitterPublicWriting(likeTraversalRoot, () => undefined)).rejects.toThrow(
      "archive member escapes selected directory",
    );
  });

  it("normalizes media basenames for portable vaults", async () => {
    expect(portableMediaBasename("1001-a:b.jpg")).toBe("1001-a_b.jpg");
    expect(portableMediaBasename("CON")).toBe("_CON");
    expect(portableMediaBasename("LPT1.png")).toBe("_LPT1.png");
    expect(portableMediaBasename("1001-trailing.")).toBe("1001-trailing");
    expect(portableMediaBasename("1001-question?.png")).toBe("1001-question_.png");
    expect(portableMediaBasename("1001-a]b)#c.jpg")).toBe("1001-a_b__c.jpg");
    expect(portableMediaBasename(`1001-long.${"x".repeat(220)}`).length).toBeLessThanOrEqual(180);

    const collision = await ingestTwitterPublicWriting(archive, () => undefined);
    const mediaRecord = collision.records.find((record) => record.id === "1001");
    if (!mediaRecord) throw new Error("fixture media tweet missing");
    mediaRecord.media = [
      { sourcePath: path.join(temp, "1001-a:b.jpg"), alt: "first", type: "photo" },
      { sourcePath: path.join(temp, "1001-a?b.jpg"), alt: "second", type: "photo" },
    ];
    await expect(
      writeTwitterPublicMarkdown(collision, path.join(temp, "media-collision-vault"), () => undefined, {
        dryRun: true,
      }),
    ).rejects.toThrow("media collision");
  });
});
