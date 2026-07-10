import { describe, it, expect } from "vitest";

import {
  contentItemsToLyncEvents,
  threadsToLyncEvents,
  deterministicLyncId,
  isRfc3339,
  writeLyncFile,
  verifyLyncFile,
  SPLICE_IMPORT_VERSION,
  DEFAULT_OPERATOR,
  type LyncProducerOptions,
} from "../../src/outputs/lync.js";
import type { ContentItem, Thread } from "../../src/core/types.js";

const OPTS: LyncProducerOptions = {
  importer: "twitter",
  sourceRef: "tests/archive",
  via: "twitter-archive@unknown",
};

function tweet(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "1000000000000000001",
    text: "hello world",
    createdAt: "2020-01-01T00:00:00.000Z",
    source: "twitter:tweet",
    raw: { id_str: "1000000000000000001", full_text: "hello world" },
    ...overrides,
  };
}

describe("deterministicLyncId", () => {
  it("is stable and deterministic for the same source id", () => {
    const a = deterministicLyncId("glowfic", "post", "5506", "reply-1739831");
    const b = deterministicLyncId("glowfic", "post", "5506", "reply-1739831");
    expect(a).toBe(b);
  });

  it("differs across namespaces and ids (no separator collisions)", () => {
    expect(deterministicLyncId("a", "bc")).not.toBe(
      deterministicLyncId("ab", "c"),
    );
    expect(deterministicLyncId("glowfic", "post", "1")).not.toBe(
      deterministicLyncId("glowfic", "post", "2"),
    );
    expect(deterministicLyncId("glowfic", "post", "1")).not.toBe(
      deterministicLyncId("glowfic", "thread", "1"),
    );
  });

  it("is UUID-shaped with version 8 and RFC 4122 variant", () => {
    const id = deterministicLyncId("x", "y");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("contentItemsToLyncEvents envelope fields", () => {
  it("maps every envelope field per the fleet convention", () => {
    const { events, stats } = contentItemsToLyncEvents([tweet()], OPTS);
    expect(stats.emitted).toBe(1);
    expect(stats.skipped).toEqual([]);
    const ev = events[0];
    expect(ev.v).toBe(1);
    expect(ev.kind).toBe("twitter/tweet");
    expect(ev.id).toBe(
      deterministicLyncId("twitter", "item", "1000000000000000001"),
    );
    expect(ev.at).toBe("2020-01-01T00:00:00.000Z");
    expect(ev.parents).toEqual([]);
    // payload preserves the full original source object
    expect(ev.payload).toEqual({
      id_str: "1000000000000000001",
      full_text: "hello world",
    });
    // author axes
    expect(ev.author.operator).toBe(DEFAULT_OPERATOR);
    expect(ev.author.via).toBe("twitter-archive@unknown");
    expect(ev.author.imported_by).toBe(
      `splice/twitter@${SPLICE_IMPORT_VERSION}`,
    );
    expect(ev.author.source).toBe("tests/archive:1000000000000000001");
  });

  it("imported_by is NEVER used as actor; actor falls back to unknown", () => {
    const { events } = contentItemsToLyncEvents(
      [tweet({ raw: {}, accountId: null })],
      OPTS,
    );
    const ev = events[0];
    expect(ev.author.actor).toBe("unknown");
    expect(ev.author.actor).not.toContain("splice");
    expect(ev.author.actor).not.toBe(ev.author.imported_by);
  });

  it("derives actor from the source object, not the importer", () => {
    const { events } = contentItemsToLyncEvents(
      [tweet({ raw: { screen_name: "deepfates_bot" } })],
      OPTS,
    );
    expect(events[0].author.actor).toBe("deepfates_bot");
  });

  it("links parents deterministically from parentId", () => {
    const parent = tweet();
    const child = tweet({
      id: "1000000000000000002",
      parentId: parent.id,
    });
    const { events } = contentItemsToLyncEvents([parent, child], OPTS);
    expect(events[1].parents).toEqual([events[0].id]);
  });

  it("skips id-less items with an explicit stats entry, never silently", () => {
    const bad = tweet({ id: "" });
    const { events, stats } = contentItemsToLyncEvents([tweet(), bad], OPTS);
    expect(events).toHaveLength(1);
    expect(stats.sourceRecords).toBe(2);
    expect(stats.emitted).toBe(1);
    expect(stats.skipped).toHaveLength(1);
    expect(stats.skipped[0].index).toBe(1);
    expect(stats.skipped[0].reason).toMatch(/no id/);
    expect(stats.emitted + stats.skipped.length).toBe(stats.sourceRecords);
  });

  it("surfaces timestamp repairs explicitly and always emits RFC 3339 at", () => {
    const { events, stats } = contentItemsToLyncEvents(
      [tweet({ createdAt: "Wed Jan 01 00:00:00 +0000 2020" })],
      OPTS,
    );
    expect(isRfc3339(events[0].at)).toBe(true);
    expect(stats.timestampFallbacks).toHaveLength(1);
    expect(stats.timestampFallbacks[0].original).toBe(
      "Wed Jan 01 00:00:00 +0000 2020",
    );
  });

  it("omits marked by default (deterministic bytes) and sets it when markedAt given", () => {
    const a = contentItemsToLyncEvents([tweet()], OPTS).events[0];
    expect(a.marked).toBeUndefined();
    const b = contentItemsToLyncEvents([tweet()], {
      ...OPTS,
      markedAt: "2026-07-10T00:00:00Z",
    }).events[0];
    expect(b.marked).toBe("2026-07-10T00:00:00Z");
  });
});

describe("threadsToLyncEvents", () => {
  it("chains items to the previous item when no explicit parentId", () => {
    const thread: Thread = {
      id: "t1",
      items: [
        tweet({ id: "1" }),
        tweet({ id: "2" }),
        tweet({ id: "3", parentId: "1" }), // explicit linkage wins
      ],
    };
    const { events, stats } = threadsToLyncEvents([thread], OPTS);
    expect(stats.emitted).toBe(3);
    expect(events[0].parents).toEqual([]);
    expect(events[1].parents).toEqual([events[0].id]);
    expect(events[2].parents).toEqual([events[0].id]);
  });
});

describe("write + verify round trip", () => {
  it("writes a .lync file that lync-core accepts on every line", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-lync-"));
    try {
      const file = path.join(dir, "tweets.lync");
      const { events } = contentItemsToLyncEvents(
        [tweet(), tweet({ id: "2", parentId: "1000000000000000001" })],
        OPTS,
      );
      await writeLyncFile(file, events);
      const verify = await verifyLyncFile(file);
      expect(verify.ok).toBe(true);
      expect(verify.problems).toEqual([]);
      expect(verify.counts.lines).toBe(2);
      expect(verify.counts.accepted).toBe(2);
      expect(verify.counts.events).toBe(2);
      expect(verify.counts.byKind).toEqual({ "twitter/tweet": 2 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("verifyLyncFile reports non-accepted lines explicitly, never silently", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-lync-"));
    try {
      const file = path.join(dir, "garbage.lync");
      await fs.writeFile(file, 'not json at all\n{"v":1}\n', "utf8");
      const verify = await verifyLyncFile(file);
      expect(verify.ok).toBe(false);
      expect(verify.counts.accepted).toBe(0);
      expect(verify.problems).toHaveLength(2);
      for (const p of verify.problems) {
        expect(p.class).toBeTruthy();
        expect(p.reason).toBeTruthy();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
