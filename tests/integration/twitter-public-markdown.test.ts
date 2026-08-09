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
    expect(report.filesWritten).toBe(8);
    expect(report.dailyFiles).toBe(1);
    expect(report.replyFiles).toBe(1);
    expect(report.threadFiles).toBe(3);
    expect(report.articleFiles).toBe(1);
    expect(report.noteFiles).toBe(1);
    expect(report.communityFiles).toBe(1);
    expect(report.mediaCopied).toBe(1);
    expect(report.stats.skipped.retweets).toBe(1);
    expect(report.stats.skipped.articleDrafts).toBe(1);
    expect(report.stats.skipped.deletedTweets).toBe(1);
    expect(report.stats.totals).toEqual({ source: 15, emitted: 12, skipped: 3, reconciled: true });

    const daily = await fs.readFile(path.join(out, "tweets_by_date", "2025-01-01.md"), "utf8");
    expect(daily).toContain("*[05:00 AM](https://x.com/archive_author/status/1004)*  \nFirst standalone post");
    expect(daily).toContain("\n\n---\n\n");
    expect(daily).toContain("*[06:00 AM](https://x.com/archive_author/status/1005)*  \nSecond standalone post");
    expect(daily).not.toContain("twitter_id:");
    expect(daily).not.toContain("A reply to somebody else");

    const replies = await fs.readFile(path.join(out, "replies_by_date", "2025-01-01.md"), "utf8");
    expect(replies).toContain("A reply to somebody else");

    const threadFiles = await fs.readdir(path.join(out, "threads"));
    expect(threadFiles).toHaveLength(3);
    expect(new Set(threadFiles.map((name) => name.toLocaleLowerCase("en-US"))).size).toBe(3);
    expect(threadFiles).toContain("All_I_want_to_do--1010.md");
    expect(threadFiles).toContain("all_i_want_to_do--1020.md");
    const primaryThread = threadFiles.find((name) => name.includes("Same_opening_words")) as string;
    const thread = await fs.readFile(path.join(out, "threads", primaryThread), "utf8");
    expect(thread).toContain("Date: 2025-01-01");
    expect(thread).toContain("#Same opening words @friend https://example.com/a");
    expect(thread).not.toContain("https://t.co/media");
    expect(thread).toContain("#Same opening words @friend with a reply");
    expect(thread).toContain("../images/_1001-image.jpg");
    expect(thread).toContain("[View on Twitter](https://x.com/archive_author/status/1001)");
    expect(thread).not.toContain("twitter_id:");

    const articleFiles = await fs.readdir(path.join(out, "articles"));
    expect(articleFiles).toHaveLength(1);
    const article = await fs.readFile(
      path.join(out, "articles", articleFiles[0]),
      "utf8",
    );
    expect(article).toContain("# Published article");
    expect(article).toContain("First paragraph.\n\nSecond paragraph.");
    expect(article).not.toContain("Do not export");

    expect(await fs.readFile(path.join(out, "README.md"), "utf8")).not.toContain("private");
    const index = (await fs.readFile(path.join(out, "export-index.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(index).toHaveLength(12);
    expect(index.find((entry) => entry.id === "1001")?.file).toBe(
      index.find((entry) => entry.id === "1002")?.file,
    );
    expect(index.find((entry) => entry.id === "1004")?.file).toBe("tweets_by_date/2025-01-01.md");
    expect(index.find((entry) => entry.id === "1006")?.file).toBe("replies_by_date/2025-01-01.md");
    expect(JSON.parse(await fs.readFile(path.join(out, "export-report.json"), "utf8"))).toEqual(report);
  });
});
