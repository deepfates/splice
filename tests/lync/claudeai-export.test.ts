import { describe, it, expect } from "vitest";
import {
  createLyncLooms,
  createMemoryEventStore,
} from "@deepfates/lync";

import {
  claudeAiExportToLooms,
  type ClaudeAiLoomMeta,
} from "../../src/outputs/lync-claudeai-export.js";
import {
  deriveTurnText,
  type SessionTurnMeta,
  type SessionTurnPayload,
} from "../../src/outputs/lync-session-loom.js";

/* ----------------------------- Synthetic fixture ---------------------------
 * A hand-authored Claude.ai `conversations.json` — a top-level array of
 * conversations. Entirely synthetic; no real export content.
 *
 * Conversation A: LINEAR (older export shape, no per-message parent) —
 *   human → assistant → human → assistant, plus an attachment-only assistant
 *   message (proves a non-blank summary for a text-less turn) and a non-object
 *   message (proves malformed messages are counted, never dropped).
 * Conversation B: PARENT linkage (newer export shape) with a BRANCH — a root
 *   human message with TWO assistant children (proves the branch survives).
 * Plus a non-object conversation entry (proves skippedConversations).
 */

const MODEL = "claude-synthetic-1";

const convA = {
  uuid: "conv-aaaa-0000-4000-8000-000000000001",
  name: "Linear Chat",
  created_at: "2026-01-02T03:04:05.000Z",
  chat_messages: [
    {
      uuid: "msgA-0001",
      sender: "human",
      text: "What is a loom?",
      content: [{ type: "text", text: "What is a loom?" }],
      created_at: "2026-01-02T03:04:05.000Z",
    },
    {
      uuid: "msgA-0002",
      sender: "assistant",
      model: MODEL,
      text: "A branching record of turns.",
      content: [{ type: "text", text: "A branching record of turns." }],
      created_at: "2026-01-02T03:04:06.000Z",
    },
    {
      uuid: "msgA-0003",
      sender: "human",
      text: "Can textile read one?",
      content: [{ type: "text", text: "Can textile read one?" }],
      created_at: "2026-01-02T03:04:07.000Z",
    },
    {
      uuid: "msgA-0004",
      sender: "assistant",
      model: MODEL,
      // Attachment-only: no text at all — must still render non-blank.
      text: "",
      content: [{ type: "tool_use", name: "read_file", input: { path: "x" } }],
      created_at: "2026-01-02T03:04:08.000Z",
    },
    // A non-object message — counted as a skip, never a turn.
    "not-a-message",
  ],
};

const ROOT = "msgB-root";
const convB = {
  uuid: "conv-bbbb-0000-4000-8000-000000000002",
  name: "Branched Chat",
  created_at: "2026-01-03T03:04:05.000Z",
  chat_messages: [
    {
      uuid: ROOT,
      parent_message_uuid: "00000000-0000-4000-8000-000000000000", // root sentinel (outside set)
      sender: "human",
      text: "Give me two takes.",
      created_at: "2026-01-03T03:04:05.000Z",
    },
    {
      uuid: "msgB-child1",
      parent_message_uuid: ROOT,
      sender: "assistant",
      model: MODEL,
      text: "First take.",
      created_at: "2026-01-03T03:04:06.000Z",
    },
    {
      uuid: "msgB-child2",
      parent_message_uuid: ROOT,
      sender: "assistant",
      model: MODEL,
      text: "Second take.",
      created_at: "2026-01-03T03:04:07.000Z",
    },
  ],
};

const FIXTURE = JSON.stringify([convA, 42 /* skipped conversation */, convB]);

describe("claude.ai export → lync conversation looms", () => {
  it("reconciles counts; skips are counted, never dropped", async () => {
    const { looms, stats } = await claudeAiExportToLooms(FIXTURE);
    expect(looms).toHaveLength(2);
    expect(stats.conversations).toBe(2);
    expect(stats.skippedConversations).toBe(1);
    expect(stats.totalMessages).toBe(5 + 3);
    expect(stats.totalTurns).toBe(4 + 3);
    expect(stats.totalSkippedMessages).toBe(1);

    const a = stats.perConversation[0];
    expect(a.linkage).toBe("linear");
    expect(a.messages).toBe(5);
    expect(a.turns).toBe(4);
    expect(a.skippedMessages).toBe(1);
    // Per-conversation invariant: messages === turns + skippedMessages.
    expect(a.messages).toBe(a.turns + a.skippedMessages);
    expect(a.distinctActors.sort()).toEqual([MODEL, "deepfates"].sort());

    const b = stats.perConversation[1];
    expect(b.linkage).toBe("parent");
    expect(b.messages).toBe(3);
    expect(b.turns).toBe(3);
    expect(b.title).toBe("Branched Chat");
  });

  it("emits snapshots textile opens: conversation profile + folded turns", async () => {
    const { looms } = await claudeAiExportToLooms(FIXTURE);

    /* ---- Conversation A: LINEAR — folds to a straight thread ---- */
    const a = looms[0];
    expect(a.snapshot.loom.meta?.profile).toBe("conversation");
    expect(a.snapshot.loom.meta?.source).toBe("claudeai-export");
    expect(a.snapshot.loom.meta?.conversationUuid).toBe(convA.uuid);

    // IMPORT into a FRESH store and fold through the real API — exactly what
    // textile does. Proves the fold reads what we stamped.
    const storeA = createMemoryEventStore();
    const loomsA = createLyncLooms<
      SessionTurnPayload,
      ClaudeAiLoomMeta,
      SessionTurnMeta
    >({ store: storeA, author: { actor: "textile-test" } });
    const infoA = await loomsA.import(a.snapshot);
    const loomA = await loomsA.open(infoA.id);

    const rootsA = await loomA.childrenOf(null);
    expect(rootsA).toHaveLength(1);
    const rootA = rootsA[0];
    expect(rootA.payload.text).toBe("What is a loom?");
    expect(rootA.meta?.author).toBe("deepfates");
    expect(rootA.meta?.role).toBe("user");

    // Walk down the single linear chain to its leaf (import re-mints ids, so
    // navigate the FRESH loom rather than reuse the source snapshot's ids).
    let leafId = rootA.id;
    for (;;) {
      const kids = await loomA.childrenOf(leafId);
      if (kids.length === 0) break;
      expect(kids).toHaveLength(1);
      leafId = kids[0].id;
    }
    const thread = await loomA.threadTo(leafId);
    expect(thread.map((t) => t.payload.text)).toEqual([
      "What is a loom?",
      "A branching record of turns.",
      "Can textile read one?",
      "[tool_use:read_file]",
    ]);
    const leaf = thread[thread.length - 1];
    expect(leaf.payload.text.length).toBeGreaterThan(0);
    expect(leaf.meta?.author).toBe(MODEL);
    expect(leaf.meta?.role).toBe("assistant");
    loomA.close();

    /* ---- Conversation B: PARENT linkage — branch survives ---- */
    const b = looms[1];
    const storeB = createMemoryEventStore();
    const loomsB = createLyncLooms<
      SessionTurnPayload,
      ClaudeAiLoomMeta,
      SessionTurnMeta
    >({ store: storeB, author: { actor: "textile-test" } });
    const infoB = await loomsB.import(b.snapshot);
    const loomB = await loomsB.open(infoB.id);

    const rootsB = await loomB.childrenOf(null);
    expect(rootsB).toHaveLength(1);
    const rootB = rootsB[0];
    expect(rootB.payload.text).toBe("Give me two takes.");
    expect(rootB.meta?.author).toBe("deepfates");

    const children = await loomB.childrenOf(rootB.id);
    expect(children).toHaveLength(2);
    expect(children.map((t) => t.payload.text).sort()).toEqual([
      "First take.",
      "Second take.",
    ]);
    for (const child of children) {
      expect(child.meta?.author).toBe(MODEL);
      expect(child.meta?.role).toBe("assistant");
    }
    loomB.close();
  });

  it("the raw message rides in payload.message verbatim (reader re-derives)", async () => {
    const { looms } = await claudeAiExportToLooms(FIXTURE);
    const rootTurn = looms[0].snapshot.turns.find((t) => t.parentId === null)!;
    // The whole source chat_message object is preserved, not just its text.
    expect((rootTurn.payload.message as { sender?: string }).sender).toBe("human");
    expect(deriveTurnText(rootTurn.payload.message)).toBe("What is a loom?");
  });

  it("throws loud on non-array / invalid JSON", async () => {
    await expect(claudeAiExportToLooms("not json")).rejects.toThrow(/invalid JSON/);
    await expect(claudeAiExportToLooms('{"not":"array"}')).rejects.toThrow(
      /top-level array/,
    );
  });
});
