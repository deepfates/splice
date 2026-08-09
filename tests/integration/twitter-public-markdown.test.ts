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
      wrapped("account", [{ account: { username: "archive_author" } }]),
    );
    await fs.writeFile(
      path.join(data, "tweets.js"),
      wrapped("tweets", [
        {
          tweet: {
            id_str: "1001",
            full_text: "#Same opening words @friend https://t.co/a",
            created_at: "Wed Jan 01 12:00:00 +0000 2025",
            entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/a" }] },
          },
        },
        {
          tweet: {
            id_str: "1002",
            full_text: "#Same opening words @friend with a reply",
            created_at: "Wed Jan 01 12:01:00 +0000 2025",
            in_reply_to_status_id_str: "1001",
          },
        },
        {
          tweet: {
            id_str: "1003",
            full_text: "RT @someone: not authored writing",
            created_at: "Wed Jan 01 12:02:00 +0000 2025",
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
    expect(report.records).toBe(5);
    expect(report.notesWritten).toBe(5);
    expect(report.mediaCopied).toBe(1);
    expect(report.stats.skipped.retweets).toBe(1);
    expect(report.stats.skipped.articleDrafts).toBe(1);
    expect(report.stats.skipped.deletedTweets).toBe(1);
    expect(report.stats.totals).toEqual({ source: 8, emitted: 5, skipped: 3, reconciled: true });

    const tweetDir = path.join(out, "tweets", "2025", "01");
    const tweetFiles = (await fs.readdir(tweetDir)).filter((name) => name.endsWith(".md"));
    expect(tweetFiles).toHaveLength(2);
    expect(tweetFiles.some((name) => name.includes("1001"))).toBe(true);
    expect(tweetFiles.some((name) => name.includes("1002"))).toBe(true);

    const first = await fs.readFile(
      path.join(tweetDir, tweetFiles.find((name) => name.includes("1001")) as string),
      "utf8",
    );
    expect(first).toContain('type: "twitter/tweet"');
    expect(first).toContain("\\#Same opening words @friend https://example.com/a");
    expect(first).toContain("../../../attachments/twitter/tweets_media/1001-image.jpg");

    const reply = await fs.readFile(
      path.join(tweetDir, tweetFiles.find((name) => name.includes("1002")) as string),
      "utf8",
    );
    expect(reply).toContain('in_reply_to: "1001"');
    expect(reply).toMatch(/\[Replying to archived tweet 1001\]\([^)]*1001\.md\)/);

    const articleFiles = await fs.readdir(path.join(out, "articles", "2025", "01"));
    expect(articleFiles).toHaveLength(1);
    const article = await fs.readFile(
      path.join(out, "articles", "2025", "01", articleFiles[0]),
      "utf8",
    );
    expect(article).toContain("# Published article");
    expect(article).toContain("First paragraph.\n\nSecond paragraph.");
    expect(article).not.toContain("Do not export");

    expect(await fs.readFile(path.join(out, "README.md"), "utf8")).not.toContain("private");
    expect(JSON.parse(await fs.readFile(path.join(out, "export-report.json"), "utf8"))).toEqual(report);
  });
});
