import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  glowficExportToLyncEvents,
  glowficThreadEventId,
  glowficPostEventId,
  convertGlowficExportToLync,
  verifyLyncFile,
  isRfc3339,
  type GlowficExportThread,
} from "../../src/outputs/lync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// The real glowfic-dl JSON export sample (dee-944x acceptance). The fixture is
// a byte-identical copy of glowfic-dl/out/thread.json; prefer the live file
// when this repo sits next to the glowfic-dl checkout.
const externalSample = path.resolve(
  projectRoot,
  "../glowfic-dl/out/thread.json",
);
const fixtureSample = path.resolve(
  projectRoot,
  "tests/fixtures/glowfic-export/thread.json",
);
const samplePath = fssync.existsSync(externalSample)
  ? externalSample
  : fixtureSample;

async function loadSample(): Promise<GlowficExportThread> {
  return JSON.parse(await fs.readFile(samplePath, "utf8"));
}

describe("glowfic JSON export → lync (real sample, 30 posts)", () => {
  it("emits 1 glowfic/thread + one glowfic/post per post; counts reconcile", async () => {
    const thread = await loadSample();
    expect(thread.posts).toHaveLength(30);

    const { events, threadEventId, stats } = glowficExportToLyncEvents(thread);

    // 1 thread + 30 posts, zero skipped
    expect(stats.threadEvents).toBe(1);
    expect(stats.postEvents).toBe(30);
    expect(stats.skipped).toEqual([]);
    expect(events).toHaveLength(31);
    expect(stats.postEvents + stats.skipped.length).toBe(thread.posts.length);

    // thread event: metadata payload, no parents
    const threadEvent = events[0];
    expect(threadEvent.id).toBe(threadEventId);
    expect(threadEvent.kind).toBe("glowfic/thread");
    expect(threadEvent.parents).toEqual([]);
    expect(threadEvent.payload.id).toBe("5506");
    expect(threadEvent.payload.title).toBe(
      "take this report back and bring her a better report",
    );
    expect(threadEvent.payload.posts).toBeUndefined();

    // post parentage: first post → thread event; post N → post N-1
    const posts = events.slice(1);
    expect(posts[0].parents).toEqual([threadEventId]);
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i].parents).toEqual([posts[i - 1].id]);
    }

    // every post is a source-namespaced kind with the full source object
    for (let i = 0; i < posts.length; i++) {
      const source = thread.posts[i] as Record<string, unknown>;
      expect(posts[i].kind).toBe("glowfic/post");
      expect(posts[i].payload).toEqual(source);
      expect(isRfc3339(posts[i].at)).toBe(true);
      // actor is the character/author, never the importer
      expect(posts[i].author.imported_by).toBe("splice/glowfic-json@0.1");
      expect(posts[i].author.actor).not.toBe(posts[i].author.imported_by);
      expect(["Carissa Sevar", "Abrogail Thrune II", "Iarwain"]).toContain(
        posts[i].author.actor,
      );
      expect(posts[i].author.source).toBe(
        `https://glowfic.com/posts/5506:${source.post_id}`,
      );
    }

    // 29 of the 30 sample timestamps are not RFC 3339; repairs are explicit
    expect(stats.timestampFallbacks).toHaveLength(29);
    for (const f of stats.timestampFallbacks) {
      expect(isRfc3339(f.used)).toBe(true);
    }
  });

  it("mints deterministic ids: same input, same events", async () => {
    const thread = await loadSample();
    const a = glowficExportToLyncEvents(thread);
    const b = glowficExportToLyncEvents(
      JSON.parse(await fs.readFile(samplePath, "utf8")),
    );
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(a.events[5].id).toBe(glowficPostEventId("5506", "reply-1739834"));
    expect(a.threadEventId).toBe(glowficThreadEventId("5506"));
  });

  it("end-to-end: converts the sample file and the written .lync is verifier-clean", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-glowfic-"));
    try {
      const outFile = path.join(dir, "thread-5506.lync");
      const result = await convertGlowficExportToLync(samplePath, outFile);

      // counts reconcile: 1 thread + 30 posts
      expect(result.stats.threadEvents).toBe(1);
      expect(result.stats.postEvents).toBe(30);
      expect(result.stats.skipped).toEqual([]);

      // verifier-clean: ALL lines accepted, zero problems
      expect(result.verify.ok).toBe(true);
      expect(result.verify.problems).toEqual([]);
      expect(result.verify.counts.lines).toBe(31);
      expect(result.verify.counts.accepted).toBe(31);
      expect(result.verify.counts.events).toBe(31);
      expect(result.verify.counts.byKind).toEqual({
        "glowfic/thread": 1,
        "glowfic/post": 30,
      });

      // independent re-parse of the file agrees
      const reverify = await verifyLyncFile(outFile);
      expect(reverify.ok).toBe(true);
      expect(reverify.counts.accepted).toBe(31);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("zero silent drops", () => {
  it("a malformed post produces an explicit skipped entry, not silence", async () => {
    const thread = await loadSample();
    const malformed = [...thread.posts];
    malformed[3] = { author: "Iarwain", content: "no post_id here" };
    malformed[7] = "not even an object";

    const { events, stats } = glowficExportToLyncEvents({
      ...thread,
      posts: malformed,
    });

    // nothing vanished: emitted + skipped === source posts
    expect(stats.postEvents).toBe(28);
    expect(stats.skipped).toHaveLength(2);
    expect(stats.postEvents + stats.skipped.length).toBe(malformed.length);
    expect(events).toHaveLength(29); // 1 thread + 28 posts

    // each skip names the index, the reason, and carries the offending value
    const byIndex = new Map(stats.skipped.map((s) => [s.index, s]));
    expect(byIndex.get(3)?.reason).toMatch(/post_id/);
    expect(byIndex.get(3)?.value).toEqual(malformed[3]);
    expect(byIndex.get(7)?.reason).toMatch(/not an object/);
    expect(byIndex.get(7)?.value).toBe("not even an object");
  });

  it("throws loudly on a structurally broken export instead of guessing", () => {
    expect(() =>
      glowficExportToLyncEvents({ title: "no id", posts: [] } as never),
    ).toThrow(/no id/);
    expect(() =>
      glowficExportToLyncEvents({ id: "5506", posts: "nope" } as never),
    ).toThrow(/not an array/);
  });
});
