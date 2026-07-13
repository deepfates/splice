import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CLAUDE_SESSION_IMPORTER,
  claudeLineEventId,
  claudeRecordEventId,
  claudeSessionToLyncEvents,
  convertClaudeSessionToLync,
  convertClaudeSessionTreeToLync,
} from "../../src/outputs/lync-claude-session.js";
import { verifyLyncFile } from "../../src/outputs/lync.js";

/* ----------------------------- Synthetic fixture ---------------------------
 * Authored from the Claude Code session JSONL shape (see module doc of
 * lync-claude-session.ts). Entirely synthetic — no real session content.
 */

const USER_UUID = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSISTANT_UUID = "aaaaaaaa-0000-4000-8000-000000000002";
const SESSION_ID = "aaaaaaaa-0000-4000-8000-00000000feed";
const LOCATOR = `${SESSION_ID}.jsonl`;

const userRecord = {
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  cwd: "/tmp/synthetic-project",
  sessionId: SESSION_ID,
  version: "9.9.9",
  gitBranch: "main",
  type: "user",
  message: { role: "user", content: "synthetic hello" },
  uuid: USER_UUID,
  timestamp: "2026-01-02T03:04:05.678Z",
};

const assistantRecord = {
  parentUuid: USER_UUID,
  isSidechain: false,
  userType: "external",
  cwd: "/tmp/synthetic-project",
  sessionId: SESSION_ID,
  version: "9.9.9",
  gitBranch: "main",
  type: "assistant",
  message: {
    role: "assistant",
    model: "claude-synthetic-1",
    content: [{ type: "text", text: "synthetic reply" }],
  },
  requestId: "req_synthetic_1",
  uuid: ASSISTANT_UUID,
  timestamp: "2026-01-02T03:04:06.789Z",
};

// uuid-less sidecars: a pointer type and an annotation type, no timestamps.
const aiTitleRecord = {
  type: "ai-title",
  aiTitle: "Synthetic Title",
  sessionId: SESSION_ID,
};
const snapshotRecord = {
  type: "file-history-snapshot",
  messageId: "msg_synthetic_1",
  snapshot: { files: [] },
  isSnapshotUpdate: false,
};

const FIXTURE_LINES = [
  JSON.stringify(userRecord),
  JSON.stringify(assistantRecord),
  JSON.stringify(aiTitleRecord),
  JSON.stringify(snapshotRecord),
  '{"type":"user","uuid":"broken', // malformed JSON — must be a loud skip
  "", // blank line — explicit skip, never silent
  "42", // valid JSON, not an object — explicit skip
];
const FIXTURE = FIXTURE_LINES.join("\n") + "\n";

describe("claude session JSONL → lync mapping", () => {
  it("maps records to claude/* events and sidecars to lore/*; counts reconcile", () => {
    const { events, stats } = claudeSessionToLyncEvents(FIXTURE, LOCATOR);

    expect(stats.sourceLines).toBe(7);
    expect(stats.emitted).toBe(4);
    expect(stats.uuidRecords).toBe(2);
    expect(stats.derivedRecords).toBe(2);
    expect(stats.skipped).toHaveLength(3);
    expect(stats.emitted + stats.skipped.length).toBe(stats.sourceLines);
    expect(stats.byKind).toEqual({
      "claude/user": 1,
      "claude/assistant": 1,
      "lore/pointer": 1,
      "lore/annotation": 1,
    });

    // every skip carries the 1-based line number and a reason
    expect(stats.skipped.map((s) => s.index)).toEqual([5, 6, 7]);
    expect(stats.skipped[0].reason).toMatch(/invalid JSON/);
    expect(stats.skipped[1].reason).toBe("blank line");
    expect(stats.skipped[2].reason).toBe("line is not a JSON object");

    const [user, assistant, pointer, annotation] = events;
    expect(user.kind).toBe("claude/user");
    expect(assistant.kind).toBe("claude/assistant");
    expect(pointer.kind).toBe("lore/pointer"); // ai-title is a pointer type
    expect(annotation.kind).toBe("lore/annotation");
  });

  it("ids are deterministic UUIDv8 from source identity; parents survive the recipe", () => {
    const { events } = claudeSessionToLyncEvents(FIXTURE, LOCATOR);
    const [user, assistant, pointer, annotation] = events;

    // uuid records derive from ("claude","record",<uuid>) — NOT the raw uuid
    expect(user.id).toBe(claudeRecordEventId(USER_UUID));
    expect(user.id).not.toBe(USER_UUID);
    expect(assistant.id).toBe(claudeRecordEventId(ASSISTANT_UUID));
    // v8 stamp: version nibble 8, RFC 4122 variant
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // parentUuid maps through the SAME recipe, so linkage resolves
    expect(user.parents).toEqual([]);
    expect(assistant.parents).toEqual([user.id]);

    // uuid-less sidecars derive from (locator, line) — deterministic, no minting
    expect(pointer.id).toBe(claudeLineEventId(LOCATOR, 3));
    expect(annotation.id).toBe(claudeLineEventId(LOCATOR, 4));
    expect(pointer.parents).toEqual([]);
  });

  it("author envelope: original actor stays the actor; the importer never is", () => {
    const { events } = claudeSessionToLyncEvents(FIXTURE, LOCATOR);
    const [user, assistant, pointer, annotation] = events;

    expect(user.author.actor).toBe("deepfates");
    expect(assistant.author.actor).toBe("claude-synthetic-1");
    expect(pointer.author.actor).toBe("unknown");
    expect(annotation.author.actor).toBe("unknown");

    for (const [i, ev] of events.entries()) {
      expect(ev.author.operator).toBe("deepfates");
      expect(ev.author.imported_by).toBe(
        `splice/${CLAUDE_SESSION_IMPORTER}@0.1`,
      );
      expect(ev.author.actor).not.toBe(ev.author.imported_by);
      expect(ev.author.source).toBe(`${LOCATOR}:${i + 1}`);
    }
    expect(user.author.via).toBe("claude-code@9.9.9");
    expect(pointer.author.via).toBe("claude-code@unknown"); // sidecar has no version
  });

  it("payload preserves everything: message verbatim, ids in source, rest in extra", () => {
    const { events } = claudeSessionToLyncEvents(FIXTURE, LOCATOR);
    const [user, , pointer] = events;

    expect(user.payload.message).toEqual(userRecord.message);
    expect(user.payload.source).toEqual({
      path: LOCATOR,
      line: 1,
      sessionId: SESSION_ID,
      isSidechain: false, // false is a value, only null/absent are dropped
    });
    // extra = every field not transcribed into the envelope
    expect(user.payload.extra).toEqual({
      isSidechain: false,
      userType: "external",
      cwd: "/tmp/synthetic-project",
      sessionId: SESSION_ID,
      version: "9.9.9",
      gitBranch: "main",
    });
    // envelope-transcribed fields do NOT reappear in extra
    expect(user.payload.extra).not.toHaveProperty("uuid");
    expect(user.payload.extra).not.toHaveProperty("message");

    // pointer payload names the source record type and keeps the whole record
    expect(pointer.payload.label).toBe("claude/ai-title");
    expect(pointer.payload.target).toBe(SESSION_ID);
    expect(pointer.payload.record).toEqual({
      aiTitle: "Synthetic Title",
      sessionId: SESSION_ID,
    });
  });

  it("timestamps: RFC 3339 passes verbatim; missing ones take a recorded deterministic fallback", () => {
    const { events, stats } = claudeSessionToLyncEvents(FIXTURE, LOCATOR);

    expect(events[0].at).toBe("2026-01-02T03:04:05.678Z"); // byte-verbatim
    // sidecars carry no timestamp → epoch fallback, recorded, never "now"
    expect(events[2].at).toBe(new Date(0).toISOString());
    expect(stats.timestampFallbacks.map((f) => f.index)).toEqual([3, 4]);
    expect(stats.timestampFallbacks[0].reason).toMatch(/missing or unparseable/);
    // marked is OPT-IN: absent unless the caller passes markedAt
    for (const ev of events) expect(ev.marked).toBeUndefined();

    const opted = claudeSessionToLyncEvents(FIXTURE, LOCATOR, {
      markedAt: "2026-07-12T00:00:00Z",
    });
    expect(opted.events[0].marked).toBe("2026-07-12T00:00:00Z");
    expect(opted.events[2].at).toBe("2026-07-12T00:00:00Z");
  });

  it("re-import is a byte-identical no-op and ids ignore where the file lives", async () => {
    const a = claudeSessionToLyncEvents(FIXTURE, LOCATOR);
    const b = claudeSessionToLyncEvents(FIXTURE, LOCATOR);
    expect(a.events).toEqual(b.events);
    expect(a.stats).toEqual(b.stats);

    // end-to-end double run: written bytes identical
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-"));
    try {
      const input = path.join(dir, LOCATOR);
      await fs.writeFile(input, FIXTURE);
      const out1 = path.join(dir, "run1.lync");
      const out2 = path.join(dir, "run2.lync");
      await convertClaudeSessionToLync(input, out1, { sourceRef: LOCATOR });
      await convertClaudeSessionToLync(input, out2, { sourceRef: LOCATOR });
      const [bytes1, bytes2] = await Promise.all([
        fs.readFile(out1),
        fs.readFile(out2),
      ]);
      expect(bytes1.equals(bytes2)).toBe(true);
      expect(bytes1.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("end-to-end: written file is 100% accepted by lync-core", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-"));
    try {
      const input = path.join(dir, LOCATOR);
      await fs.writeFile(input, FIXTURE);
      const out = path.join(dir, "session.lync");
      const result = await convertClaudeSessionToLync(input, out);

      expect(result.verify.ok).toBe(true);
      expect(result.verify.problems).toEqual([]);
      expect(result.verify.counts.lines).toBe(4);
      expect(result.verify.counts.accepted).toBe(4);
      expect(result.verify.counts.byKind).toEqual(result.stats.byKind);

      const reverify = await verifyLyncFile(out);
      expect(reverify.ok).toBe(true);
      expect(reverify.counts.accepted).toBe(4);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("claude session tree batch: zero silent drops at the file level", () => {
  // chmod 000 is a no-op on Windows, so "discoverable but unreadable" cannot
  // be staged there; the unreadable leg runs on the POSIX matrix legs and
  // skips loudly here (totals logic is platform-independent and covered).
  it.skipIf(process.platform === "win32")("unreadable and non-jsonl files are counted and named; totals reconcile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-tree-"));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-out-"));
    const locked = path.join(root, "project-a", "locked.jsonl");
    try {
      await fs.mkdir(path.join(root, "project-a"), { recursive: true });
      await fs.writeFile(path.join(root, "project-a", LOCATOR), FIXTURE);
      await fs.writeFile(locked, FIXTURE);
      await fs.chmod(locked, 0o000); // unreadable-file case
      await fs.writeFile(path.join(root, "project-a", "notes.txt"), "ignore me");

      const result = await convertClaudeSessionTreeToLync(root, outDir);

      expect(result.filesDiscovered).toBe(2);
      expect(result.filesConverted).toBe(1);
      expect(result.filesUnreadable).toHaveLength(1);
      expect(result.filesUnreadable[0].file).toBe(
        path.join("project-a", "locked.jsonl"),
      );
      expect(result.filesUnreadable[0].reason).toMatch(/permission denied|EACCES/i);
      expect(result.filesIgnored).toEqual([path.join("project-a", "notes.txt")]);
      expect(result.filesConverted + result.filesUnreadable.length).toBe(
        result.filesDiscovered,
      );

      // per-file and aggregate stats reconcile: lines = emitted + skipped
      expect(result.totalSourceLines).toBe(7);
      expect(result.totalEmitted).toBe(4);
      expect(result.totalSkipped).toBe(3);
      expect(result.totalAccepted).toBe(result.totalEmitted);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].emitted + result.files[0].skipped).toBe(
        result.files[0].sourceLines,
      );

      // output mirrors the tree and verifies clean
      const verify = await verifyLyncFile(result.files[0].outputPath);
      expect(verify.ok).toBe(true);
      expect(result.files[0].outputPath).toBe(
        path.join(outDir, "project-a", `${SESSION_ID}.lync`),
      );
    } finally {
      await fs.chmod(locked, 0o600).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("batch ids derive from file identity, not from where the tree lives", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-b-"));
    const outA = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-oa-"));
    const outB = await fs.mkdtemp(path.join(os.tmpdir(), "splice-claude-ob-"));
    try {
      for (const root of [rootA, rootB]) {
        await fs.mkdir(path.join(root, "p"), { recursive: true });
        await fs.writeFile(path.join(root, "p", LOCATOR), FIXTURE);
      }
      const a = await convertClaudeSessionTreeToLync(rootA, outA);
      const b = await convertClaudeSessionTreeToLync(rootB, outB);
      const [bytesA, bytesB] = await Promise.all([
        fs.readFile(a.files[0].outputPath),
        fs.readFile(b.files[0].outputPath),
      ]);
      expect(bytesA.equals(bytesB)).toBe(true); // byte-identical across trees
    } finally {
      for (const d of [rootA, rootB, outA, outB]) {
        await fs.rm(d, { recursive: true, force: true });
      }
    }
  });
});
