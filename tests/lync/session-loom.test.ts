import { describe, it, expect } from "vitest";
import {
  createLyncLooms,
  createMemoryEventStore,
} from "@deepfates/lync";

import {
  claudeSessionToLoom,
  deriveTurnText,
  type SessionLoomMeta,
  type SessionTurnMeta,
  type SessionTurnPayload,
} from "../../src/outputs/lync-session-loom.js";

/* ----------------------------- Synthetic fixture ---------------------------
 * A hand-authored Claude Code session in the JSONL shape (see the module doc
 * of lync-claude-session.ts). Entirely synthetic — no real session content.
 * It carries: a user root, an assistant reply, a user follow-up, a tool-only
 * assistant record (proves a non-blank summary for a text-less turn), a
 * SECOND child of the root (proves the branch survives), and a uuid-less
 * ai-title sidecar (proves sidecars are counted, never turned into a turn).
 */

const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A1 = "aaaaaaaa-0000-4000-8000-000000000002";
const U2 = "aaaaaaaa-0000-4000-8000-000000000003";
const A2 = "aaaaaaaa-0000-4000-8000-000000000004";
const A1B = "aaaaaaaa-0000-4000-8000-000000000005";
const SESSION_ID = "aaaaaaaa-0000-4000-8000-00000000feed";
const LOCATOR = `${SESSION_ID}.jsonl`;
const MODEL = "claude-synthetic-1";

const base = {
  isSidechain: false,
  userType: "external",
  cwd: "/tmp/synthetic-project",
  sessionId: SESSION_ID,
  version: "9.9.9",
  gitBranch: "main",
};

const rows: Record<string, unknown>[] = [
  {
    ...base,
    parentUuid: null,
    type: "user",
    message: { role: "user", content: "What is a loom?" },
    uuid: U1,
    timestamp: "2026-01-02T03:04:05.000Z",
  },
  {
    ...base,
    parentUuid: U1,
    type: "assistant",
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: "A branching record of turns." }],
    },
    uuid: A1,
    timestamp: "2026-01-02T03:04:06.000Z",
  },
  {
    ...base,
    parentUuid: A1,
    type: "user",
    message: { role: "user", content: "Can textile read one?" },
    uuid: U2,
    timestamp: "2026-01-02T03:04:07.000Z",
  },
  {
    ...base,
    parentUuid: U2,
    type: "assistant",
    // Tool-only content: no text block at all — must still render non-blank.
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "tool_use", name: "read_file", input: { path: "x" } }],
    },
    uuid: A2,
    timestamp: "2026-01-02T03:04:08.000Z",
  },
  {
    ...base,
    parentUuid: U1, // a SECOND child of the root — a branch
    type: "assistant",
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: "A loom is a tree of continuations." }],
    },
    uuid: A1B,
    timestamp: "2026-01-02T03:04:09.000Z",
  },
  // uuid-less sidecar → lore/pointer, NOT a conversation turn.
  { type: "ai-title", aiTitle: "Synthetic Chat", sessionId: SESSION_ID },
];

const FIXTURE = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("claude session → lync conversation loom", () => {
  it("deriveTurnText mirrors the reader and never yields blank", () => {
    expect(deriveTurnText("hi")).toBe("hi");
    expect(deriveTurnText({ role: "user", content: "block text" })).toBe(
      "block text",
    );
    expect(
      deriveTurnText({ content: [{ type: "text", text: "one " }, { type: "text", text: "two" }] }),
    ).toBe("one two");
    // A tool-only message has no text — a compact faithful summary, not blank.
    const summary = deriveTurnText({
      content: [{ type: "tool_use", name: "read_file" }],
    });
    expect(summary).toBe("[tool_use:read_file]");
    expect(summary.length).toBeGreaterThan(0);
    // Truly empty falls back to a marker, never "".
    expect(deriveTurnText("")).toBe("(empty message)");
    expect(deriveTurnText({ content: [] })).toBe("(no text content)");
  });

  it("maps conversation records to turns; sidecars counted, never turned", async () => {
    const { stats } = await claudeSessionToLoom(FIXTURE, LOCATOR);
    expect(stats.turns).toBe(5);
    expect(stats.distinctActors.sort()).toEqual([MODEL, "deepfates"].sort());
    // The ai-title sidecar is a lore/pointer, not a turn — counted, not dropped.
    expect(stats.nonTurnEvents).toEqual({ "lore/pointer": 1 });
    // The whole file is accounted for at the line level too.
    expect(stats.session.sourceLines).toBe(6);
    expect(stats.session.emitted).toBe(6);
  });

  it("the emitted snapshot folds to turns with actor + message + parents", async () => {
    const { snapshot } = await claudeSessionToLoom(FIXTURE, LOCATOR, {
      title: "Synthetic Chat",
    });

    // The loom carries conversation-profile meta.
    expect(snapshot.loom.meta?.profile).toBe("conversation");
    expect(snapshot.loom.meta?.source).toBe("claude-session");

    // IMPORT the snapshot into a FRESH store and fold it through the real API —
    // this is exactly what textile does, and it proves the fold reads what we
    // stamped (actor in meta.author, text in payload, parents linked).
    const store = createMemoryEventStore();
    const looms = createLyncLooms<
      SessionTurnPayload,
      SessionLoomMeta,
      SessionTurnMeta
    >({ store, author: { actor: "textile-test" } });
    const info = await looms.import(snapshot);
    const loom = await looms.open(info.id);

    // Root: the user question, actor deepfates, role user.
    const roots = await loom.childrenOf(null);
    expect(roots).toHaveLength(1);
    const root = roots[0];
    expect(deriveTurnText(root.payload.message)).toBe("What is a loom?");
    expect(root.payload.text).toBe("What is a loom?");
    expect(root.meta?.author).toBe("deepfates");
    expect(root.meta?.role).toBe("user");

    // The root has TWO children — the branch survived the round-trip.
    const rootChildren = await loom.childrenOf(root.id);
    expect(rootChildren).toHaveLength(2);
    const texts = rootChildren.map((t) => t.payload.text).sort();
    expect(texts).toEqual(
      ["A branching record of turns.", "A loom is a tree of continuations."].sort(),
    );
    for (const child of rootChildren) {
      expect(child.meta?.author).toBe(MODEL);
      expect(child.meta?.role).toBe("assistant");
    }

    // Walk the main thread down to the tool-only assistant leaf.
    const mainReply = rootChildren.find(
      (t) => t.payload.text === "A branching record of turns.",
    )!;
    const [followUp] = await loom.childrenOf(mainReply.id);
    expect(followUp.payload.text).toBe("Can textile read one?");
    expect(followUp.meta?.author).toBe("deepfates");

    const [toolTurn] = await loom.childrenOf(followUp.id);
    // A text-less assistant turn renders a faithful, non-blank summary.
    expect(toolTurn.payload.text).toBe("[tool_use:read_file]");
    expect(toolTurn.payload.text.length).toBeGreaterThan(0);
    expect(toolTurn.meta?.author).toBe(MODEL);

    // threadTo reconstructs the full parent chain: user → assistant → user → tool.
    const thread = await loom.threadTo(toolTurn.id);
    expect(thread.map((t) => t.payload.text)).toEqual([
      "What is a loom?",
      "A branching record of turns.",
      "Can textile read one?",
      "[tool_use:read_file]",
    ]);
    loom.close();
  });
});
