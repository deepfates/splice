import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  windowedConversationsFromGlowficThread,
  validateConversation,
  segmentedConversationsFromGlowficThread,
  isAssistantPost,
  postSpeaker,
  NARRATOR,
  type GlowThread,
  type GlowPost,
} from "../src/sources/glowfic.js";

function post(character: string | null, content: string): GlowPost {
  return {
    post_id: `p-${Math.random()}`,
    author: "author",
    character_display_name: character,
    character_handle: null,
    icon_url: null,
    timestamp: "2024-01-01T00:00:00Z",
    content: `<p>${content}</p>`,
  } as GlowPost;
}

/** A scene with three speakers, alternating the way real threads do. */
function thread(): GlowThread {
  return {
    id: 1,
    title: "test thread",
    url: "https://glowfic.com/posts/1",
    description: null,
    authors: [],
    posts: [
      post(null, "The tavern door bangs open."),
      post("Alice", "Alice looks up from her drink."),
      post("Bob", "Bob does not look up."),
      post("Alice", "Alice raises an eyebrow at him."),
      post(null, "Rain gusts in from the street."),
      post("Alice", "Alice closes the door with her foot."),
    ],
  } as GlowThread;
}

describe("windowedConversationsFromGlowficThread", () => {
  it("keeps speaker identity on user turns instead of merging them", () => {
    const [conv] = windowedConversationsFromGlowficThread(thread(), "Alice", {
      windowWords: 10_000,
    });

    const users = conv.filter((m) => m.role === "user");
    expect(users.map((m) => m.name)).toEqual([NARRATOR, "Bob", NARRATOR]);
    // No speaker prefix leaks into the text — the name is structural.
    for (const m of users) expect(m.content).not.toMatch(/^[A-Za-z ]+:/);
  });

  it("produces multi-turn conversations rather than user/assistant pairs", () => {
    const windowed = windowedConversationsFromGlowficThread(thread(), "Alice", {
      windowWords: 10_000,
    });
    expect(windowed).toHaveLength(1);
    const assistantTurns = windowed[0].filter((m) => m.role === "assistant");
    expect(assistantTurns.length).toBe(3);

    // The existing builder emits one two-message conversation per reply.
    const segmented = segmentedConversationsFromGlowficThread(
      thread(),
      "Alice",
    );
    expect(segmented.every((c) => c.length === 2)).toBe(true);
  });

  it("closes a window on an assistant turn once the budget is reached", () => {
    const convs = windowedConversationsFromGlowficThread(thread(), "Alice", {
      windowWords: 1,
    });
    expect(convs.length).toBeGreaterThan(1);
    for (const c of convs) {
      expect(c[c.length - 1].role).toBe("assistant");
      expect(c.some((m) => m.role === "user")).toBe(true);
    }
  });

  it("can target the unattributed narrator, which has no name to match", () => {
    const convs = windowedConversationsFromGlowficThread(
      thread(),
      { narrator: true },
      { windowWords: 10_000 },
    );
    const assistants = convs.flat().filter((m) => m.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants[0].content).toContain("Rain gusts in");
    // Selecting the narrator by display name is not possible.
    expect(isAssistantPost(post(null, "x"), "narrator")).toBe(false);
    expect(isAssistantPost(post(null, "x"), { narrator: true })).toBe(true);
  });

  it("drops names when merging consecutive same-role turns", () => {
    const [conv] = windowedConversationsFromGlowficThread(thread(), "Bob", {
      windowWords: 10_000,
    });
    for (let i = 1; i < conv.length; i++) {
      expect(conv[i].role).not.toBe(conv[i - 1].role);
    }
    const merged = conv.find(
      (m) => m.role === "user" && m.content.includes("\n\n"),
    );
    expect(merged?.name).toBeUndefined();
  });

  it("omits names when includeNames is false", () => {
    const [conv] = windowedConversationsFromGlowficThread(thread(), "Alice", {
      windowWords: 10_000,
      includeNames: false,
    });
    expect(conv.every((m) => m.name === undefined)).toBe(true);
  });

  // Regression: a post that cleans to empty is dropped, which can leave two
  // of the target's posts adjacent. That produced consecutive assistant turns
  // and a record every training framework rejects.
  it("never emits consecutive assistant turns when a post cleans to empty", () => {
    const t = {
      id: 2,
      title: "empty post between two assistant posts",
      url: "https://glowfic.com/posts/2",
      description: null,
      authors: [],
      posts: [
        post("Bob", "Bob says something."),
        post("Alice", "Alice replies."),
        post("Bob", "   "),
        post("Alice", "Alice keeps going."),
      ],
    } as GlowThread;

    const convs = windowedConversationsFromGlowficThread(t, "Alice", {
      windowWords: 10_000,
    });
    expect(convs.length).toBeGreaterThan(0);
    for (const c of convs) expect(validateConversation(c)).toEqual([]);
  });

  it("emits only valid conversations over the real fixture thread", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "fixtures/glowfic-export/thread.json",
        ),
        "utf8",
      ),
    ) as GlowThread;

    const speakers = new Set((fixture.posts || []).map(postSpeaker));
    expect(speakers.size).toBeGreaterThan(1);

    for (const target of [...speakers, NARRATOR]) {
      const convs = windowedConversationsFromGlowficThread(
        fixture,
        target === NARRATOR ? { narrator: true } : target,
        { windowWords: 300 },
      );
      for (const c of convs) {
        expect(validateConversation(c), `target ${target}`).toEqual([]);
      }
    }
  });

  it("reports the narrator sentinel for unattributed posts", () => {
    expect(postSpeaker(post(null, "x"))).toBe(NARRATOR);
    expect(postSpeaker(post("Alice", "x"))).toBe("Alice");
  });
});

describe("extractUniqueCharacters", () => {
  // Regression: glowfic handles identify an icon/mood, not a person. Keying on
  // them split Carissa Sevar into three "characters" on a real board.
  it("collapses one character across its icon handles", async () => {
    const { extractUniqueCharacters } =
      await import("../src/sources/glowfic.js");
    const withHandle = (display: string, handle: string, author: string) =>
      ({
        post_id: `p-${Math.random()}`,
        author,
        character_display_name: display,
        character_handle: handle,
        icon_url: null,
        timestamp: "2024-01-01T00:00:00Z",
        content: "<p>x</p>",
      }) as GlowPost;

    const t = {
      id: 3,
      title: "one character, three moods, two authors",
      url: "https://glowfic.com/posts/3",
      description: null,
      authors: [],
      posts: [
        withHandle("Carissa Sevar", "to-let-you-in", "lintamande"),
        withHandle("Carissa Sevar", "loves-her-strings", "lintamande"),
        withHandle("Carissa Sevar", "abide-the-twin-damnation", "someone-else"),
        withHandle("Keltham", "lawful chaotic", "Iarwain"),
      ],
    } as GlowThread;

    const chars = extractUniqueCharacters([t]);
    const carissa = chars.filter((c) => c.displayName === "Carissa Sevar");
    expect(carissa).toHaveLength(1);
    expect(carissa[0].postCount).toBe(3);
    expect(chars).toHaveLength(2);
  });
});
