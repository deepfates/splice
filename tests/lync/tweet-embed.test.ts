import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  tweetEmbedCacheToLyncEvents,
  convertTweetEmbedCacheToLync,
  tweetEmbedEventId,
  archiveTweetEventId,
  extractTweetId,
  snowflakeToIso,
  htmlAnchorDateToIso,
  actorForEmbed,
  verifyLyncFile,
  isRfc3339,
  TWEET_EMBED_KIND,
  type TweetEmbedCacheFile,
} from "../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// The REAL deep-space embed cache (dee-jklg acceptance: counts reconcile
// against the observed cache dir). Located via env var or as a sibling
// checkout; the committed 3-file fixture dir (byte-identical copies of real
// cache files) is the fallback so the e2e path is exercised everywhere.
const fixtureDir = path.resolve(projectRoot, "tests/fixtures/tweet-embed-cache");
const realDirCandidates = [
  process.env.SPLICE_DEEPSPACE_EMBED_CACHE,
  path.resolve(projectRoot, "../deep-space/.embed-cache/tweets"),
].filter((p): p is string => typeof p === "string" && p.length > 0);
const realDir = realDirCandidates.find((p) => fssync.existsSync(p));
const cacheDir = realDir ?? fixtureDir;
if (!realDir) {
  console.warn(
    `[tweet-embed.test] real deep-space cache not found (tried: ${realDirCandidates.join(", ")}) — e2e runs against the 3-file fixture; set SPLICE_DEEPSPACE_EMBED_CACHE to the tweets cache dir to run it for real`,
  );
}

async function loadFixture(name: string): Promise<TweetEmbedCacheFile> {
  return { file: name, text: await fs.readFile(path.join(fixtureDir, name), "utf8") };
}

const OPTS = { sourceRef: "tests/embed-cache" };

describe("tweet id extraction", () => {
  it("takes the id from the oEmbed url, cross-checked against the filename", () => {
    expect(
      extractTweetId("123-light.json", {
        url: "https://twitter.com/a/status/123",
      }).id,
    ).toBe("123");
    expect(extractTweetId("123-light.json", {}).id).toBe("123");
    expect(
      extractTweetId("notes.json", { url: "https://x.com/a/status/456" }).id,
    ).toBe("456");
  });

  it("refuses to guess when url and filename disagree", () => {
    const r = extractTweetId("111-light.json", {
      url: "https://twitter.com/a/status/222",
    });
    expect(r.id).toBeUndefined();
    expect(r.reason).toMatch(/ambiguity/);
  });
});

describe("timestamp ladder", () => {
  it("decodes snowflake ids to millisecond-precise UTC instants", () => {
    // 1094686272155602944 → (id >> 22) + 1288834974657 ms
    expect(snowflakeToIso("1094686272155602944")).toBe(
      "2019-02-10T19:55:20.226Z",
    );
  });

  it("treats pre-snowflake sequential ids as not-snowflake", () => {
    // real tweet from Feb 2009 — decoding it as snowflake would claim 2010
    expect(snowflakeToIso("1234567890")).toBeUndefined();
    expect(snowflakeToIso("not-a-number")).toBeUndefined();
  });

  it("parses the oEmbed HTML anchor date as UTC midnight, TZ-independent", () => {
    const html =
      '<a href="https://twitter.com/x/status/9?ref_src=twsrc%5Etfw">February 21, 2009</a>';
    expect(htmlAnchorDateToIso(html)).toBe("2009-02-21T00:00:00.000Z");
    expect(htmlAnchorDateToIso("no date here")).toBeUndefined();
    expect(htmlAnchorDateToIso(undefined)).toBeUndefined();
  });
});

describe("actor extraction (never the importer)", () => {
  it("reads the handle from author_url for twitter.com and x.com", () => {
    expect(actorForEmbed({ author_url: "https://twitter.com/visakanv" })).toBe(
      "visakanv",
    );
    expect(
      actorForEmbed({ author_url: "https://x.com/inflammateomnia" }),
    ).toBe("inflammateomnia");
  });

  it("falls back to the (@handle) in the HTML, then author_name, then unknown", () => {
    expect(
      actorForEmbed({
        html: "&mdash; PKD&#39;s Head (@pkd_head) <a>x</a>",
      }),
    ).toBe("pkd_head");
    expect(actorForEmbed({ author_name: "Some Name" })).toBe("Some Name");
    expect(actorForEmbed({})).toBe("unknown");
  });
});

describe("mapping real fixture files (byte-identical cache copies)", () => {
  it("maps the full envelope per the fleet convention", async () => {
    const file = await loadFixture("1094686272155602944-light.json");
    const original = JSON.parse(file.text);
    const { events, stats } = tweetEmbedCacheToLyncEvents([file], OPTS);

    expect(stats.emitted).toBe(1);
    expect(stats.skipped).toEqual([]);
    const ev = events[0];
    expect(ev.v).toBe(1);
    expect(ev.kind).toBe(TWEET_EMBED_KIND);
    expect(ev.id).toBe(tweetEmbedEventId("1094686272155602944"));
    // at = the tweet's own (snowflake) time, not the cache time
    expect(ev.at).toBe("2019-02-10T19:55:20.226Z");
    expect(stats.atSources.snowflake).toBe(1);
    expect(stats.timestampFallbacks).toEqual([]);
    // author envelope: actor = tweet author, importer NEVER the actor
    expect(ev.author.actor).toBe("visakanv");
    expect(ev.author.operator).toBe("deepfates");
    expect(ev.author.via).toBe("deep-space-embed-cache@unknown");
    expect(ev.author.imported_by).toBe("splice/twitter-embed-cache@0.1");
    expect(ev.author.actor).not.toBe(ev.author.imported_by);
    expect(ev.author.source).toBe(
      "tests/embed-cache:1094686272155602944-light.json",
    );
    // payload preserves the raw cache object plus file metadata
    expect(ev.payload.embed).toEqual(original);
    expect(ev.payload.file).toBe("1094686272155602944-light.json");
    expect(ev.payload.tweet_id).toBe("1094686272155602944");
    // marked is opt-in: absent by default for deterministic bytes
    expect(ev.marked).toBeUndefined();
    expect(ev.parents).toEqual([]);
  });

  it("uses the HTML anchor date for a pre-snowflake tweet, explicitly", async () => {
    const file = await loadFixture("1234567890-light.json");
    const { events, stats } = tweetEmbedCacheToLyncEvents([file], OPTS);
    expect(events[0].at).toBe("2009-02-21T00:00:00.000Z");
    expect(events[0].author.actor).toBe("pathfinderSport");
    expect(stats.atSources.htmlDate).toBe(1);
    expect(stats.timestampFallbacks).toHaveLength(1);
    expect(stats.timestampFallbacks[0].file).toBe("1234567890-light.json");
    expect(stats.timestampFallbacks[0].reason).toMatch(/pre-snowflake/);
  });

  it("handles X-provider (x.com) records identically", async () => {
    const file = await loadFixture("1757466793835122812-light.json");
    const { events } = tweetEmbedCacheToLyncEvents([file], OPTS);
    expect(events[0].kind).toBe(TWEET_EMBED_KIND);
    expect(events[0].author.actor).toBe("inflammateomnia");
    expect((events[0].payload.embed as Record<string, unknown>).provider_name).toBe("X");
  });

  it("mints deterministic ids and bytes: same input, same events", async () => {
    const files = await Promise.all([
      loadFixture("1094686272155602944-light.json"),
      loadFixture("1234567890-light.json"),
    ]);
    const a = tweetEmbedCacheToLyncEvents(files, OPTS);
    const b = tweetEmbedCacheToLyncEvents(files, OPTS);
    expect(a.events).toEqual(b.events);
  });
});

describe("archive matching (reported, never assumed)", () => {
  it("without an id set: provided=false, everything unmatched, no parents", async () => {
    const files = await Promise.all([
      loadFixture("1094686272155602944-light.json"),
      loadFixture("1234567890-light.json"),
    ]);
    const { events, stats } = tweetEmbedCacheToLyncEvents(files, OPTS);
    expect(stats.archiveMatching).toEqual({
      provided: false,
      matched: 0,
      unmatched: 2,
    });
    for (const ev of events) expect(ev.parents).toEqual([]);
  });

  it("with an id set: matches parent to the archive tweet event id", async () => {
    const files = await Promise.all([
      loadFixture("1094686272155602944-light.json"),
      loadFixture("1234567890-light.json"),
    ]);
    const { events, stats } = tweetEmbedCacheToLyncEvents(files, {
      ...OPTS,
      archiveTweetIds: ["1094686272155602944", "999"],
    });
    expect(stats.archiveMatching).toEqual({
      provided: true,
      matched: 1,
      unmatched: 1,
    });
    expect(events[0].parents).toEqual([
      archiveTweetEventId("1094686272155602944"),
    ]);
    expect(events[1].parents).toEqual([]);
  });
});

describe("zero silent drops", () => {
  it("every malformed file lands in stats with its filename and reason", async () => {
    const good = await loadFixture("1094686272155602944-light.json");
    const files: TweetEmbedCacheFile[] = [
      good,
      { file: "broken-light.json", text: "{not json" },
      { file: "array.json", text: "[1,2,3]" },
      { file: "no-id.json", text: '{"url":"https://twitter.com/a"}' },
      {
        file: "111-light.json",
        text: '{"url":"https://twitter.com/a/status/222"}',
      },
    ];
    const { events, stats } = tweetEmbedCacheToLyncEvents(files, OPTS);

    expect(stats.sourceFiles).toBe(5);
    expect(stats.emitted).toBe(1);
    expect(stats.skipped).toHaveLength(4);
    expect(stats.emitted + stats.skipped.length).toBe(stats.sourceFiles);
    expect(events).toHaveLength(1);

    const byFile = new Map(stats.skipped.map((s) => [s.file, s]));
    expect(byFile.get("broken-light.json")?.reason).toMatch(/invalid JSON/);
    expect(byFile.get("array.json")?.reason).toMatch(/not a JSON object/);
    expect(byFile.get("no-id.json")?.reason).toMatch(/no tweet id/);
    expect(byFile.get("111-light.json")?.reason).toMatch(/ambiguity/);
  });

  it("cached_at and last-resort rungs are explicit in stats", () => {
    const { events, stats } = tweetEmbedCacheToLyncEvents(
      [
        {
          file: "50-light.json",
          text: '{"url":"https://twitter.com/a/status/50","cached_at":"2026-01-23T09:54:09.701Z"}',
        },
        { file: "60-light.json", text: '{"url":"https://twitter.com/a/status/60"}' },
      ],
      OPTS,
    );
    expect(events[0].at).toBe("2026-01-23T09:54:09.701Z");
    expect(stats.atSources.cachedAt).toBe(1);
    expect(stats.atSources.fallback).toBe(1);
    expect(stats.timestampFallbacks).toHaveLength(2);
    expect(stats.timestampFallbacks[0].reason).toMatch(/cached_at/);
    expect(stats.timestampFallbacks[1].reason).toMatch(/no tweet timestamp/);
    for (const ev of events) expect(isRfc3339(ev.at)).toBe(true);
  });

  it("marked is set only when markedAt is given (opt-in import time)", async () => {
    const file = await loadFixture("1094686272155602944-light.json");
    const withMark = tweetEmbedCacheToLyncEvents([file], {
      ...OPTS,
      markedAt: "2026-07-10T00:00:00Z",
    });
    expect(withMark.events[0].marked).toBe("2026-07-10T00:00:00Z");
  });
});

describe(`end-to-end against ${realDir ? "the REAL deep-space cache" : "the fixture cache (set SPLICE_DEEPSPACE_EMBED_CACHE for the real cache)"}`, () => {
  it("counts reconcile exactly: files in = events out + explicit skips; verifier-clean", async () => {
    const jsonFiles = (await fs.readdir(cacheDir)).filter((f) =>
      f.endsWith(".json"),
    );
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-embed-"));
    try {
      const outFile = path.join(dir, "tweet-embeds.lync");
      const result = await convertTweetEmbedCacheToLync(cacheDir, outFile);

      // reconciliation against the observed dir — the acceptance invariant
      expect(result.stats.sourceFiles).toBe(jsonFiles.length);
      expect(result.stats.emitted + result.stats.skipped.length).toBe(
        jsonFiles.length,
      );
      if (realDir) {
        expect(result.stats.skipped).toEqual([]);
      }

      // verifier-clean: ALL lines accepted by @deepfates/lync, zero problems
      expect(result.verify.ok).toBe(true);
      expect(result.verify.problems).toEqual([]);
      expect(result.verify.counts.lines).toBe(result.stats.emitted);
      expect(result.verify.counts.accepted).toBe(result.stats.emitted);
      expect(result.verify.counts.events).toBe(result.stats.emitted);
      expect(result.verify.counts.byKind).toEqual({
        [TWEET_EMBED_KIND]: result.stats.emitted,
      });

      // matching was not assumed: no archive ids given, all unmatched
      expect(result.stats.archiveMatching.provided).toBe(false);
      expect(result.stats.archiveMatching.matched).toBe(0);
      expect(result.stats.archiveMatching.unmatched).toBe(
        result.stats.emitted,
      );

      // every timestamp rung is accounted for
      const { snowflake, htmlDate, cachedAt, fallback } =
        result.stats.atSources;
      expect(snowflake + htmlDate + cachedAt + fallback).toBe(
        result.stats.emitted,
      );

      // originals preserved: re-read a source file, find its event
      const sample = jsonFiles[0];
      const original = JSON.parse(
        await fs.readFile(path.join(cacheDir, sample), "utf8"),
      );
      const lines = (await fs.readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l));
      const hit = lines.find((l) => l.payload.file === sample);
      expect(hit).toBeDefined();
      expect(hit.payload.embed).toEqual(original);
      expect(hit.author.actor).not.toBe(hit.author.imported_by);

      // deterministic re-import: converting again yields identical bytes
      const outFile2 = path.join(dir, "tweet-embeds-again.lync");
      await convertTweetEmbedCacheToLync(cacheDir, outFile2);
      const [a, b] = await Promise.all([
        fs.readFile(outFile),
        fs.readFile(outFile2),
      ]);
      expect(a.equals(b)).toBe(true);

      // independent re-parse of the written file agrees
      const reverify = await verifyLyncFile(outFile);
      expect(reverify.ok).toBe(true);
      expect(reverify.counts.accepted).toBe(result.stats.emitted);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
