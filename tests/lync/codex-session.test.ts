import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CODEX_SESSION_IMPORTER,
  codexLineEventId,
  codexLineageEventId,
  codexSessionToLyncEvents,
  convertCodexSessionToLync,
  convertCodexSessionTreeToLync,
} from "../../src/outputs/lync-codex-session.js";
import { verifyLyncFile } from "../../src/outputs/lync.js";

/* ----------------------------- Synthetic fixture ---------------------------
 * Authored from the codex rollout JSONL shape (see module doc of
 * lync-codex-session.ts). Entirely synthetic — no real session content.
 */

const LOCATOR = "rollout-2026-01-02T03-04-05-cccccccc-0000-4000-8000-000000000001.jsonl";

const sessionMeta = {
  timestamp: "2026-01-02T03:04:05.000Z",
  type: "session_meta",
  payload: {
    id: "cccccccc-0000-4000-8000-000000000001",
    timestamp: "2026-01-02T03:04:05.000Z",
    cwd: "/tmp/synthetic-project",
    originator: "codex_cli_rs",
    cli_version: "0.42.0",
    forked_from_id: "cccccccc-0000-4000-8000-00000000dead",
  },
};
const turnContext = {
  timestamp: "2026-01-02T03:04:06.000Z",
  type: "turn_context",
  payload: { cwd: "/tmp/synthetic-project", model: "codex-synthetic-1" },
};
const userMessage = {
  timestamp: "2026-01-02T03:04:07.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "synthetic hello" },
};
const functionCall = {
  timestamp: "2026-01-02T03:04:08.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "shell",
    arguments: "{}",
    call_id: "call-synthetic-1",
  },
};
const agentMessage = {
  timestamp: "2026-01-02T03:04:09.000Z",
  type: "event_msg",
  payload: { type: "agent_message", message: "synthetic reply" },
};
const functionCallOutput = {
  timestamp: "2026-01-02T03:04:10.000Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: "call-synthetic-1",
    output: "synthetic output",
  },
};
const reasoning = {
  // no timestamp: exercises the recorded deterministic fallback
  type: "response_item",
  payload: { type: "reasoning", summary: [], turn_id: "turn-synthetic-1" },
};

const FIXTURE_LINES = [
  JSON.stringify(sessionMeta), // line 1 (+ lineage pointer)
  JSON.stringify(turnContext), // line 2
  JSON.stringify(userMessage), // line 3
  JSON.stringify(functionCall), // line 4
  JSON.stringify(agentMessage), // line 5
  JSON.stringify(functionCallOutput), // line 6
  JSON.stringify(reasoning), // line 7
  '{"type":"event_msg","payload":', // line 8: malformed JSON — loud skip
  "", // line 9: blank line — explicit skip
  "[]", // line 10: JSON but not an object — explicit skip
];
const FIXTURE = FIXTURE_LINES.join("\n") + "\n";

describe("codex rollout JSONL → lync mapping", () => {
  it("maps lines to codex/* events plus lineage pointers; counts reconcile", () => {
    const { events, stats } = codexSessionToLyncEvents(FIXTURE, LOCATOR);

    expect(stats.sourceLines).toBe(10);
    expect(stats.recordEvents).toBe(7);
    expect(stats.lineagePointers).toBe(1);
    expect(stats.emitted).toBe(8);
    expect(stats.skipped).toHaveLength(3);
    expect(stats.recordEvents + stats.skipped.length).toBe(stats.sourceLines);
    expect(stats.emitted).toBe(stats.recordEvents + stats.lineagePointers);
    expect(stats.functionPairs).toBe(1);
    expect(stats.turns).toBe(1);
    expect(stats.byKind).toEqual({
      "codex/session_meta": 1, // payload has no .type → top-level type
      "codex/turn_context": 1,
      "codex/user_message": 1,
      "codex/function_call": 1,
      "codex/agent_message": 1,
      "codex/function_call_output": 1,
      "codex/reasoning": 1,
      "lore/pointer": 1,
    });

    expect(stats.skipped.map((s) => s.index)).toEqual([8, 9, 10]);
    expect(stats.skipped[0].reason).toMatch(/invalid JSON/);
    expect(stats.skipped[1].reason).toBe("blank line");
    expect(stats.skipped[2].reason).toBe("line is not a JSON object");
  });

  it("ids are deterministic UUIDv8 from (file identity, line) — never minted", () => {
    const { events } = codexSessionToLyncEvents(FIXTURE, LOCATOR);
    const meta = events[0];
    const pointer = events[1];

    expect(meta.id).toBe(codexLineEventId(LOCATOR, 1));
    expect(pointer.id).toBe(codexLineageEventId(LOCATOR, 1, "forked_from_id"));
    expect(events[2].id).toBe(codexLineEventId(LOCATOR, 2));
    for (const ev of events) {
      expect(ev.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("parents: sequence chain through pointers, plus function_call pairing by call_id", () => {
    const { events } = codexSessionToLyncEvents(FIXTURE, LOCATOR);
    const [meta, pointer, turnCtx, user, call, agent, callOutput] = events;

    expect(meta.parents).toEqual([]);
    expect(pointer.parents).toEqual([meta.id]); // lineage → its session_meta
    expect(turnCtx.parents).toEqual([pointer.id]); // chain advances through pointers
    expect(user.parents).toEqual([turnCtx.id]);
    expect(call.parents).toEqual([user.id]);
    expect(agent.parents).toEqual([call.id]);
    // output parents to the previous event AND its function_call
    expect(callOutput.parents).toEqual([agent.id, call.id]);
  });

  it("author envelope: original actor stays the actor; the importer never is", () => {
    const { events } = codexSessionToLyncEvents(FIXTURE, LOCATOR);
    const [meta, pointer, turnCtx, user, call] = events;

    expect(meta.author.actor).toBe("codex"); // environment counts as actor
    expect(pointer.author.actor).toBe("codex");
    expect(turnCtx.author.actor).toBe("codex-synthetic-1"); // payload.model
    expect(user.author.actor).toBe("deepfates"); // user_message
    expect(call.author.actor).toBe("codex");

    for (const ev of events) {
      expect(ev.author.operator).toBe("deepfates");
      expect(ev.author.imported_by).toBe(
        `splice/${CODEX_SESSION_IMPORTER}@0.1`,
      );
      expect(ev.author.actor).not.toBe(ev.author.imported_by);
    }
    expect(meta.author.via).toBe("codex@0.42.0"); // cli_version on session_meta
    expect(user.author.via).toBe("codex@unknown"); // per-record, like the reference
    expect(user.author.source).toBe(`${LOCATOR}:3`);
  });

  it("payload preserves the original record verbatim; turn_id is hoisted; lineage names its key", () => {
    const { events, stats } = codexSessionToLyncEvents(FIXTURE, LOCATOR);
    const [meta, pointer] = events;
    const reasoningEv = events[7];

    expect(meta.payload).toEqual({
      record_type: "session_meta",
      payload: sessionMeta.payload,
      source: { path: LOCATOR, line: 1 },
    });
    expect(pointer.payload).toEqual({
      name: "codex/forked_from_id",
      target: "cccccccc-0000-4000-8000-00000000dead",
      source_event: meta.id,
    });
    expect(reasoningEv.payload.turn_id).toBe("turn-synthetic-1");

    // timestamps: verbatim when RFC 3339; deterministic recorded fallback otherwise
    expect(meta.at).toBe("2026-01-02T03:04:05.000Z");
    expect(reasoningEv.at).toBe(new Date(0).toISOString());
    expect(stats.timestampFallbacks.map((f) => f.index)).toEqual([7]);
    for (const ev of events) expect(ev.marked).toBeUndefined(); // marked OPT-IN
  });

  it("re-import is a byte-identical no-op", async () => {
    const a = codexSessionToLyncEvents(FIXTURE, LOCATOR);
    const b = codexSessionToLyncEvents(FIXTURE, LOCATOR);
    expect(a.events).toEqual(b.events);
    expect(a.stats).toEqual(b.stats);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-"));
    try {
      const input = path.join(dir, LOCATOR);
      await fs.writeFile(input, FIXTURE);
      const out1 = path.join(dir, "run1.lync");
      const out2 = path.join(dir, "run2.lync");
      await convertCodexSessionToLync(input, out1, { sourceRef: LOCATOR });
      await convertCodexSessionToLync(input, out2, { sourceRef: LOCATOR });
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

  it("end-to-end: written file is 100% accepted by @deepfates/lync", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-"));
    try {
      const input = path.join(dir, LOCATOR);
      await fs.writeFile(input, FIXTURE);
      const out = path.join(dir, "rollout.lync");
      const result = await convertCodexSessionToLync(input, out);

      expect(result.verify.ok).toBe(true);
      expect(result.verify.problems).toEqual([]);
      expect(result.verify.counts.lines).toBe(8);
      expect(result.verify.counts.accepted).toBe(8);
      expect(result.verify.counts.byKind).toEqual(result.stats.byKind);

      const reverify = await verifyLyncFile(out);
      expect(reverify.ok).toBe(true);
      expect(reverify.counts.accepted).toBe(8);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("codex session tree batch: zero silent drops at the file level", () => {
  // chmod 000 is a no-op on Windows, so "discoverable but unreadable" cannot
  // be staged there; the unreadable leg runs on the POSIX matrix legs and
  // skips loudly here (totals logic is platform-independent and covered).
  it.skipIf(process.platform === "win32")("unreadable files are counted and named; totals reconcile; outputs verify clean", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-tree-"));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-out-"));
    const locked = path.join(root, "2026", "01", "02", "locked.jsonl");
    try {
      await fs.mkdir(path.join(root, "2026", "01", "02"), { recursive: true });
      await fs.writeFile(path.join(root, "2026", "01", "02", LOCATOR), FIXTURE);
      await fs.writeFile(locked, FIXTURE);
      await fs.chmod(locked, 0o000); // unreadable-file case

      const result = await convertCodexSessionTreeToLync(root, outDir);

      expect(result.filesDiscovered).toBe(2);
      expect(result.filesConverted).toBe(1);
      expect(result.filesUnreadable).toHaveLength(1);
      expect(result.filesUnreadable[0].file).toBe(
        path.join("2026", "01", "02", "locked.jsonl"),
      );
      expect(result.filesUnreadable[0].reason).toMatch(/permission denied|EACCES/i);
      expect(result.filesConverted + result.filesUnreadable.length).toBe(
        result.filesDiscovered,
      );

      expect(result.totalSourceLines).toBe(10);
      expect(result.totalEmitted).toBe(8);
      expect(result.totalSkipped).toBe(3);
      expect(result.totalAccepted).toBe(result.totalEmitted);
      expect(result.byKind["lore/pointer"]).toBe(1);

      const verify = await verifyLyncFile(result.files[0].outputPath);
      expect(verify.ok).toBe(true);
      expect(verify.counts.accepted).toBe(8);
    } finally {
      await fs.chmod(locked, 0o600).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("batch ids derive from file identity, not from where the tree lives", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-b-"));
    const outA = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-oa-"));
    const outB = await fs.mkdtemp(path.join(os.tmpdir(), "splice-codex-ob-"));
    try {
      for (const root of [rootA, rootB]) {
        await fs.mkdir(path.join(root, "2026", "01"), { recursive: true });
        await fs.writeFile(path.join(root, "2026", "01", LOCATOR), FIXTURE);
      }
      const a = await convertCodexSessionTreeToLync(rootA, outA);
      const b = await convertCodexSessionTreeToLync(rootB, outB);
      const [bytesA, bytesB] = await Promise.all([
        fs.readFile(a.files[0].outputPath),
        fs.readFile(b.files[0].outputPath),
      ]);
      expect(bytesA.equals(bytesB)).toBe(true);
    } finally {
      for (const d of [rootA, rootB, outA, outB]) {
        await fs.rm(d, { recursive: true, force: true });
      }
    }
  });
});
