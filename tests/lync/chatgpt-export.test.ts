import { describe, it, expect } from "vitest";
import {
  createLyncLooms,
  createMemoryEventStore,
} from "@deepfates/lync";

import {
  chatGptExportToLooms,
  type ChatGptLoomMeta,
} from "../../src/outputs/lync-chatgpt-export.js";
import {
  deriveTurnText,
  type SessionTurnMeta,
  type SessionTurnPayload,
} from "../../src/outputs/lync-session-loom.js";

/* ----------------------------- Synthetic fixture ---------------------------
 * A hand-authored ChatGPT `conversations.json` — a top-level array of
 * conversations, each with a `mapping` object of parent/children message nodes.
 * Entirely synthetic; no real export content.
 *
 * Conversation A: a client ROOT placeholder (message: null) → a hidden SYSTEM
 *   node (message: null) → user → assistant. Proves placeholder nodes are
 *   counted (never turned), the first real turn roots at null, and the model
 *   slug rides through as the assistant author. Also carries a multimodal user
 *   message (a text part + an image_asset_pointer part) — proves the shared
 *   text derivation keeps the real text and the raw node rides verbatim.
 * Conversation B: a BRANCH — root user node with TWO assistant children (a
 *   regeneration). Proves the mapping graph's branch survives into the loom.
 *   One child is a `code` node (content.text, no parts) — proves that path.
 * Plus a non-object conversation entry (proves skippedConversations).
 */

const MODEL = "gpt-synthetic-1";

/** Conversation A: root → system placeholder → user (multimodal) → assistant. */
const convA = {
  id: "conv-aaaa-0001",
  title: "Rooted Chat",
  mapping: {
    "a-root": {
      id: "a-root",
      message: null, // client root placeholder — no turn
      parent: null,
      children: ["a-system"],
    },
    "a-system": {
      id: "a-system",
      message: null, // hidden system-context placeholder — no turn
      parent: "a-root",
      children: ["a-user"],
    },
    "a-user": {
      id: "a-user",
      message: {
        author: { role: "user" },
        content: {
          content_type: "multimodal_text",
          parts: [
            "What is in this image?",
            { content_type: "image_asset_pointer", asset_pointer: "file-service://synthetic" },
          ],
        },
        metadata: {},
      },
      parent: "a-system",
      children: ["a-assistant"],
    },
    "a-assistant": {
      id: "a-assistant",
      message: {
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["A synthetic diagram of a loom."] },
        metadata: { model_slug: MODEL },
      },
      parent: "a-user",
      children: [],
    },
  },
};

/** Conversation B: user root with TWO assistant children (a branch). */
const convB = {
  id: "conv-bbbb-0002",
  title: "Branched Chat",
  mapping: {
    "b-root": {
      id: "b-root",
      message: null,
      parent: null,
      children: ["b-user"],
    },
    "b-user": {
      id: "b-user",
      message: {
        author: { role: "user" },
        content: { content_type: "text", parts: ["Give me two takes."] },
        metadata: {},
      },
      parent: "b-root",
      children: ["b-child1", "b-child2"],
    },
    "b-child1": {
      id: "b-child1",
      message: {
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["First take."] },
        metadata: { model_slug: MODEL },
      },
      parent: "b-user",
      children: [],
    },
    "b-child2": {
      id: "b-child2",
      message: {
        author: { role: "assistant" },
        // A `code` node: text lives in content.text, no parts.
        content: { content_type: "code", language: "python", text: "print('second take')" },
        metadata: { model_slug: MODEL },
      },
      parent: "b-user",
      children: [],
    },
  },
};

const FIXTURE = JSON.stringify([convA, 42 /* skipped conversation */, convB]);

describe("chatgpt export → lync conversation looms", () => {
  it("reconciles counts; placeholders + malformed are counted, never dropped", async () => {
    const { looms, stats } = await chatGptExportToLooms(FIXTURE);
    expect(looms).toHaveLength(2);
    expect(stats.conversations).toBe(2);
    expect(stats.skippedConversations).toBe(1);
    expect(stats.totalNodes).toBe(4 + 4);
    expect(stats.totalTurns).toBe(2 + 3);
    expect(stats.totalPlaceholderNodes).toBe(2 + 1);
    expect(stats.totalMalformedNodes).toBe(0);

    const a = stats.perConversation[0];
    expect(a.nodes).toBe(4);
    expect(a.turns).toBe(2);
    expect(a.placeholderNodes).toBe(2);
    // Per-conversation invariant: nodes === turns + placeholders + malformed.
    expect(a.nodes).toBe(a.turns + a.placeholderNodes + a.malformedNodes);
    expect(a.branchedTurns).toBe(0);
    expect(a.distinctActors.sort()).toEqual([MODEL, "deepfates"].sort());

    const b = stats.perConversation[1];
    expect(b.nodes).toBe(4);
    expect(b.turns).toBe(3);
    expect(b.placeholderNodes).toBe(1);
    expect(b.nodes).toBe(b.turns + b.placeholderNodes + b.malformedNodes);
    // The two assistant children share a parent → both branched.
    expect(b.branchedTurns).toBe(2);
    expect(b.title).toBe("Branched Chat");
  });

  it("emits snapshots textile opens: conversation profile + folded turns", async () => {
    const { looms } = await chatGptExportToLooms(FIXTURE);

    /* ---- Conversation A: root/system placeholders skipped, real turns fold ---- */
    const a = looms[0];
    expect(a.snapshot.loom.meta?.profile).toBe("conversation");
    expect(a.snapshot.loom.meta?.source).toBe("chatgpt-export");
    expect(a.snapshot.loom.meta?.conversationId).toBe(convA.id);

    // IMPORT into a FRESH store and fold through the real API — exactly what
    // textile does. Proves the fold reads what we stamped.
    const storeA = createMemoryEventStore();
    const loomsA = createLyncLooms<
      SessionTurnPayload,
      ChatGptLoomMeta,
      SessionTurnMeta
    >({ store: storeA, author: { actor: "textile-test" } });
    const infoA = await loomsA.import(a.snapshot);
    const loomA = await loomsA.open(infoA.id);

    // The first REAL message roots at null (placeholders produced no turn).
    const rootsA = await loomA.childrenOf(null);
    expect(rootsA).toHaveLength(1);
    const rootA = rootsA[0];
    // Multimodal user turn: the real text is kept (image part not fabricated).
    expect(rootA.payload.text).toBe("What is in this image?");
    expect(rootA.meta?.author).toBe("deepfates");
    expect(rootA.meta?.role).toBe("user");

    const kidsA = await loomA.childrenOf(rootA.id);
    expect(kidsA).toHaveLength(1);
    const asstA = kidsA[0];
    expect(asstA.payload.text).toBe("A synthetic diagram of a loom.");
    expect(asstA.meta?.author).toBe(MODEL);
    expect(asstA.meta?.role).toBe("assistant");
    loomA.close();

    /* ---- Conversation B: the branch survives ---- */
    const b = looms[1];
    const storeB = createMemoryEventStore();
    const loomsB = createLyncLooms<
      SessionTurnPayload,
      ChatGptLoomMeta,
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
    expect(children).toHaveLength(2); // branch preserved
    expect(children.map((t) => t.payload.text).sort()).toEqual([
      "First take.",
      "print('second take')", // the `code` node's content.text
    ]);
    for (const child of children) {
      expect(child.meta?.author).toBe(MODEL);
      expect(child.meta?.role).toBe("assistant");
    }
    loomB.close();
  });

  it("the raw node.message rides in payload.message verbatim (reader re-derives)", async () => {
    const { looms } = await chatGptExportToLooms(FIXTURE);
    // Conversation A's root user turn.
    const rootTurn = looms[0].snapshot.turns.find((t) => t.parentId === null)!;
    const message = rootTurn.payload.message as {
      author?: { role?: string };
      content?: { parts?: unknown[] };
    };
    // The whole source node.message object is preserved, incl. the image part.
    expect(message.author?.role).toBe("user");
    expect(message.content?.parts).toHaveLength(2);
    // A text-less block-only message still renders non-blank via the shared derive.
    expect(
      deriveTurnText({ content: [{ type: "image_asset_pointer" }] }),
    ).toBe("[image_asset_pointer]");
  });

  it("throws loud on non-array / invalid JSON", async () => {
    await expect(chatGptExportToLooms("not json")).rejects.toThrow(/invalid JSON/);
    await expect(chatGptExportToLooms('{"not":"array"}')).rejects.toThrow(
      /top-level array/,
    );
  });
});
