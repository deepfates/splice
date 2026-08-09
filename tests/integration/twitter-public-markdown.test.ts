import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

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
      ]),
    );
    await fs.writeFile(
      path.join(data, "community-tweet.js"),
      wrapped("community_tweet", [{
        tweet: {
          id_str: "2001",
          full_text: "A community post",
          created_at: "Thu Jan 02 12:00:00 +0000 2025",
          community_id_str: "community-1",
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
      ]),
    );
    await fs.writeFile(
      path.join(data, "article-metadata.js"),
      wrapped("article_metadata", [
        { articleMetadata: { firstPublishedAtMs: "1735992000000", tweetId: "4000", lifecycleState: { lifecycle: { name: "Published" } } } },
        { articleMetadata: { createdAtMs: "1736078400000", lifecycleState: { lifecycle: { name: "Draft" } } } },
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
            fullText: "The parent post recovered from likes.\nWith a second line.",
            expandedUrl: "https://twitter.com/i/web/status/9999",
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
        },
      }]),
    );
    await fs.writeFile(path.join(data, "tweets_media", "1001-image.jpg"), "image");
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
    expect(report.records).toBe(12);
    expect(report.notesWritten).toBe(12);
    expect(report.notesByKind).toEqual({
      tweet: 9,
      "community-tweet": 1,
      "note-tweet": 1,
      article: 1,
      "deleted-tweet": 0,
    });
    expect(report.replies).toBe(4);
    expect(report.replyContext).toEqual({
      authored: 3,
      liked: 1,
      "liked-truncated": 0,
      unavailable: 0,
      missing: 0,
    });
    expect(report.authoredParentLinks).toBe(3);
    expect(report.authoredChildLinks).toBe(3);
    expect(report.mediaCopied).toBe(1);
    expect(report.stats.skipped.retweets).toBe(1);
    expect(report.stats.skipped.articleDrafts).toBe(1);
    expect(report.stats.skipped.deletedTweets).toBe(1);
    expect(report.stats.totals).toEqual({ source: 15, emitted: 12, skipped: 3, reconciled: true });
    expect(report.stats.replyContext).toEqual({
      parentIdsAbsentFromAuthoredArchive: 1,
      likeRecordsScanned: 2,
      recoveredFromLikes: 1,
      stillMissing: 0,
      coverage: 1,
      unavailableLikeFiles: 0,
    });

    const index = (await fs.readFile(path.join(out, ".splice", "export-index.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(index).toHaveLength(12);
    expect(new Set(index.map((entry) => entry.file)).size).toBe(12);
    const entry = (id: string) => index.find((value) => value.id === id);
    const note = async (id: string) => fs.readFile(path.join(out, entry(id)?.file), "utf8");

    const root = await note("1001");
    expect(root).toContain('type: "tweet"');
    expect(root).toContain('id: "1001"');
    expect(root).toContain("\\#Same opening words @friend https://example.com/a");
    expect(root).not.toContain("https://t.co/media");
    expect(root).toContain("../../../media/1001/1001-image.jpg");
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
    expect(externalReply).toContain("> The parent post recovered from likes.\n> With a second line.");
    expect(externalReply).toContain("A reply to somebody else");
    expect(externalReply).not.toContain("An unrelated liked post");

    expect(entry("1004")?.file).toMatch(/^tweets\/2025\/01\/2025-01-01--.*--1004\.md$/);
    expect(entry("1005")?.file).toMatch(/^tweets\/2025\/01\/2025-01-01--.*--1005\.md$/);
    expect(entry("1010")?.file.toLocaleLowerCase("en-US")).not.toBe(
      entry("1020")?.file.toLocaleLowerCase("en-US"),
    );
    expect(entry("2001")?.file).toMatch(/^community-tweets\/community-1\/2025\/01\//);
    expect(entry("2001")?.communityId).toBe("community-1");

    const article = await note("4001");
    expect(article).toContain("# Published article");
    expect(article).toContain("First paragraph.\n\nSecond paragraph.");
    expect(article).not.toContain("Do not export");

    const readme = await fs.readFile(path.join(out, "README.md"), "utf8");
    expect(readme).not.toContain("private");
    expect(readme).toContain("liked-post text is used only for matched reply context");
    expect(await fs.stat(path.join(out, "threads")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(out, "replies_by_date")).catch(() => null)).toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(out, ".splice", "export-report.json"), "utf8"))).toEqual(report);
  });
});
