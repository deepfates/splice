import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TWITTER_ARCHIVE_BROWSER_PROFILE,
  twitterArchiveEntriesToConversation,
  type BrowserArchiveEntry,
} from "../../src/browser.js";

const FIXTURE = join(process.cwd(), "tests/integration/fixtures/archive/data");

function fixtureEntries(): BrowserArchiveEntry[] {
  return ["manifest.js", "account.js", "tweets.js", "like.js"].map((name) => ({
    path: `portable-export/data/${name}`,
    text: readFileSync(join(FIXTURE, name), "utf8"),
  }));
}

describe("browser-local Twitter archive → one reviewable conversation", () => {
  it("keeps every readable record, reply topology, provenance, and accounting", async () => {
    const result = await twitterArchiveEntriesToConversation(fixtureEntries());
    expect(result.stats).toEqual({
      sourceRecords: 3,
      readableRecords: 3,
      tweets: 2,
      retweets: 0,
      likes: 1,
      malformedRecords: 0,
      unresolvedReplies: 0,
      ownerHandle: "testuser",
      accountId: "9999999999",
    });
    expect(result.snapshot.loom.meta).toMatchObject({
      profile: "conversation",
      source: "twitter-archive",
      title: "Twitter archive @testuser",
      archiveProfile: TWITTER_ARCHIVE_BROWSER_PROFILE,
    });
    expect(result.snapshot.turns).toHaveLength(4);
    const corpus = result.snapshot.turns[0];
    const first = result.snapshot.turns.find(
      (turn) => turn.meta?.archiveSource?.recordId === "1000000000000000001",
    );
    const reply = result.snapshot.turns.find(
      (turn) => turn.meta?.archiveSource?.recordId === "1000000000000000002",
    );
    const like = result.snapshot.turns.find(
      (turn) => turn.meta?.archiveSource?.recordId === "1000000000000000003",
    );
    expect(first?.parentId).toBe(corpus.id);
    expect(reply?.parentId).toBe(first?.id);
    expect(reply?.meta?.archiveSource).toMatchObject({
      parentRecordId: "1000000000000000001",
      parentHeld: true,
    });
    expect(like?.parentId).toBe(corpus.id);
    expect(like?.meta?.role).toBe("artifact");
    expect(JSON.stringify(result)).not.toContain("test@example.com");
  });

  it("is deterministic across archive-member permutations", async () => {
    const forward = await twitterArchiveEntriesToConversation(fixtureEntries());
    const reverse = await twitterArchiveEntriesToConversation(fixtureEntries().reverse());
    expect(reverse).toEqual(forward);
  });

  it("rejects an archive without its declared manifest instead of guessing", async () => {
    await expect(twitterArchiveEntriesToConversation([
      { path: "data/tweets.js", text: "window.YTD.tweets.part0 = []" },
    ])).rejects.toThrow(/data\/manifest\.js/);
  });
});
