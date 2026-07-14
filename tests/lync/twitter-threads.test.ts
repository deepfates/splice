import { describe, it, expect } from "vitest";
import {
  createLyncLooms,
  createMemoryEventStore,
} from "@deepfates/lync";

import {
  twitterThreadsToLooms,
  contentItemsToTwitterRecords,
  OWNER_SENTINEL,
  type TwitterRecord,
  type TwitterThreadLoomMeta,
} from "../../src/outputs/lync-twitter-threads.js";
import type {
  SessionTurnMeta,
  SessionTurnPayload,
} from "../../src/outputs/lync-session-loom.js";
import type { ContentItem } from "../../src/core/types.js";

/* ----------------------------- Synthetic fixture ---------------------------
 * A hand-authored, MIXED set of Twitter/X archive records — the owner
 * ("deepfates", handle @owner) plus one counterparty (@friend). Entirely
 * synthetic; no real archive content.
 *
 * The reply thread (all connected through in_reply_to):
 *   t1 (owner, root)
 *   ├─ t2 (friend, replies to t1)
 *   │   ├─ t3 (owner, replies to t2)   ┐ FORK: t2 answered by
 *   │   └─ t4 (owner, replies to t2)   ┘ two owner tweets
 * Plus:
 *   t5  a standalone owner tweet (no reply in or out) → its own 1-turn thread
 *   rt1 a RETWEET (RT @…) → counted, never a turn
 *   lk1 a LIKE → counted, never a turn
 *
 * Proves: fork survives (t2 → t3 + t4), owner→deepfates/user & friend→@friend/
 * assistant, text/parents fold correctly, standalone → own loom, and the
 * retweet + like are counted (never dropped), counts reconcile.
 */

const OWNER = "owner";
const FRIEND = "friend";

const records: TwitterRecord[] = [
  { id: "t1", kind: "tweet", text: "opening take", parentId: null, authorHandle: OWNER, createdAt: "2026-07-01T00:00:00Z" },
  { id: "t2", kind: "tweet", text: "friendly counter", parentId: "t1", authorHandle: FRIEND, createdAt: "2026-07-01T00:01:00Z" },
  { id: "t3", kind: "tweet", text: "fork A", parentId: "t2", authorHandle: OWNER, createdAt: "2026-07-01T00:02:00Z" },
  { id: "t4", kind: "tweet", text: "fork B", parentId: "t2", authorHandle: OWNER, createdAt: "2026-07-01T00:03:00Z" },
  { id: "t5", kind: "tweet", text: "a lone thought", parentId: null, authorHandle: OWNER, createdAt: "2026-07-01T00:04:00Z" },
  { id: "rt1", kind: "retweet", text: "RT @someone: not mine", parentId: null, authorHandle: OWNER, createdAt: "2026-07-01T00:05:00Z" },
  { id: "lk1", kind: "like", text: "a liked tweet", parentId: null, authorHandle: FRIEND, createdAt: "2026-07-01T00:06:00Z" },
];

describe("twitter threads → lync conversation looms", () => {
  it("reconciles counts; retweets + likes counted, never dropped", async () => {
    const { looms, stats } = await twitterThreadsToLooms(records, {
      ownerHandle: OWNER,
    });
    // Two threads: the reply-tree (4 tweets) + the standalone (1 tweet).
    expect(looms).toHaveLength(2);
    expect(stats.threads).toBe(2);
    expect(stats.standaloneThreads).toBe(1);
    expect(stats.totalTurns).toBe(5);
    expect(stats.retweets).toBe(1);
    expect(stats.likes).toBe(1);
    expect(stats.malformed).toBe(0);
    // The reconciliation invariant is the whole point of "nothing dropped".
    expect(stats.sourceRecords).toBe(
      stats.totalTurns + stats.retweets + stats.likes + stats.malformed,
    );
    expect(stats.sourceRecords).toBe(records.length);

    const tree = stats.perThread.find((t) => t.turns === 4)!;
    expect(tree.threadId).toBe("t1");
    expect(tree.branchedTurns).toBe(2); // t3 + t4 share parent t2
    expect(tree.roots).toBe(1);
    expect(tree.distinctActors.sort()).toEqual(["deepfates", FRIEND].sort());

    const lone = stats.perThread.find((t) => t.turns === 1)!;
    expect(lone.threadId).toBe("t5");
    expect(lone.branchedTurns).toBe(0);
  });

  it("emits snapshots textile opens: conversation profile + folded fork", async () => {
    const { looms } = await twitterThreadsToLooms(records, {
      ownerHandle: OWNER,
    });
    const tree = looms.find((l) => l.stats.turns === 4)!;
    expect(tree.snapshot.loom.meta?.profile).toBe("conversation");
    expect(tree.snapshot.loom.meta?.source).toBe("twitter-threads");
    expect(tree.snapshot.loom.meta?.threadId).toBe("t1");

    // IMPORT into a FRESH store and fold through the real API — exactly what
    // textile does. Proves the fold reads what we stamped.
    const store = createMemoryEventStore();
    const looms2 = createLyncLooms<
      SessionTurnPayload,
      TwitterThreadLoomMeta,
      SessionTurnMeta
    >({ store, author: { actor: "textile-test" } });
    const info = await looms2.import(tree.snapshot);
    const loom = await looms2.open(info.id);

    // Root: the owner's opening tweet, roots at null.
    const roots = await loom.childrenOf(null);
    expect(roots).toHaveLength(1);
    const root = roots[0];
    expect(root.payload.text).toBe("opening take");
    expect(root.meta?.author).toBe("deepfates");
    expect(root.meta?.role).toBe("user");

    // The friend's reply.
    const kids = await loom.childrenOf(root.id);
    expect(kids).toHaveLength(1);
    const friendTurn = kids[0];
    expect(friendTurn.payload.text).toBe("friendly counter");
    expect(friendTurn.meta?.author).toBe(FRIEND);
    expect(friendTurn.meta?.role).toBe("assistant");

    // THE FORK survives: t2 answered by two owner tweets.
    const forks = await loom.childrenOf(friendTurn.id);
    expect(forks).toHaveLength(2);
    expect(forks.map((t) => t.payload.text).sort()).toEqual(["fork A", "fork B"]);
    for (const f of forks) {
      expect(f.meta?.author).toBe("deepfates");
      expect(f.meta?.role).toBe("user");
    }
    loom.close();
  });

  it("the raw tweet rides in payload.message verbatim", async () => {
    const withRaw: TwitterRecord[] = [
      {
        id: "r1",
        kind: "tweet",
        text: "raw carrier",
        parentId: null,
        authorHandle: OWNER,
        raw: { id_str: "r1", full_text: "raw carrier", entities: { hashtags: [] } },
      },
    ];
    const { looms } = await twitterThreadsToLooms(withRaw, { ownerHandle: OWNER });
    const turn = looms[0].snapshot.turns.find((t) => t.parentId === null)!;
    const message = turn.payload.message as { id_str?: string; entities?: unknown };
    expect(message.id_str).toBe("r1");
    expect(message.entities).toBeDefined();
    // text is still the derived, non-empty display string.
    expect(turn.payload.text).toBe("raw carrier");
  });

  it("groups parallel replies to the same absent external tweet into one thread", async () => {
    // Two owner tweets both reply to ext-999 (not in the set) → one thread,
    // two roots, no fabricated turn for the missing external tweet.
    const parallel: TwitterRecord[] = [
      { id: "p1", kind: "tweet", text: "reply one", parentId: "ext-999", authorHandle: OWNER },
      { id: "p2", kind: "tweet", text: "reply two", parentId: "ext-999", authorHandle: OWNER },
    ];
    const { looms, stats } = await twitterThreadsToLooms(parallel, {
      ownerHandle: OWNER,
    });
    expect(stats.threads).toBe(1);
    expect(looms[0].stats.roots).toBe(2);
    expect(looms[0].stats.turns).toBe(2);
  });

  it("normalizes ingestTwitter ContentItems: likes + RTs classified, owner handle applied", () => {
    const items: ContentItem[] = [
      { id: "a", text: "hello", parentId: null, source: "twitter:tweet", createdAt: "2026-07-01T00:00:00Z" },
      { id: "b", text: "RT @x: echo", parentId: null, source: "twitter:tweet", createdAt: "2026-07-01T00:01:00Z" },
      { id: "c", text: "liked", parentId: null, source: "twitter:like", createdAt: "2026-07-01T00:02:00Z" },
    ];
    const recs = contentItemsToTwitterRecords(items, OWNER_SENTINEL);
    expect(recs.map((r) => r.kind)).toEqual(["tweet", "retweet", "like"]);
    expect(recs.every((r) => r.authorHandle === OWNER_SENTINEL)).toBe(true);
  });
});
