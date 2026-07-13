import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { serializeLyncEvent } from "@deepfates/lync/store";
import type { LyncEventBody } from "@deepfates/lync/events";

import {
  convertSessionFileToLync,
  scanSessionTree,
  splitSessionJsonl,
  verifyLyncFileStreaming,
} from "../../src/outputs/lync-session-batch.js";
import { createCodexSessionLineMapper } from "../../src/outputs/lync-codex-session.js";
import {
  deterministicLyncId,
  verifyLyncFile,
  writeLyncFile,
} from "../../src/outputs/lync.js";

function syntheticEvent(n: number, payloadPad = 0): LyncEventBody {
  return {
    v: 1,
    id: deterministicLyncId("test", "session-batch", String(n)),
    kind: "test/event",
    at: "2026-01-02T03:04:05.000Z",
    author: {
      actor: "synthetic",
      operator: "deepfates",
      imported_by: "splice/test@0.1",
      source: `test:${n}`,
    } as unknown as LyncEventBody["author"],
    parents: [],
    payload: payloadPad > 0 ? { n, pad: "x".repeat(payloadPad) } : { n },
  };
}

describe("splitSessionJsonl", () => {
  it("counts every line; trailing LF does not invent a phantom line", () => {
    expect(splitSessionJsonl("")).toEqual([]);
    expect(splitSessionJsonl("a\nb\n")).toEqual([
      { lineNo: 1, text: "a" },
      { lineNo: 2, text: "b" },
    ]);
    expect(splitSessionJsonl("a\n\nb")).toEqual([
      { lineNo: 1, text: "a" },
      { lineNo: 2, text: "" },
      { lineNo: 3, text: "b" },
    ]);
  });
});

describe("verifyLyncFileStreaming", () => {
  it("agrees with verifyLyncFile on a clean file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-vfs-"));
    try {
      const file = path.join(dir, "clean.lync");
      await writeLyncFile(file, [syntheticEvent(1), syntheticEvent(2)]);
      const whole = await verifyLyncFile(file);
      const streamed = await verifyLyncFileStreaming(file);
      expect(streamed.ok).toBe(true);
      expect(streamed.ok).toBe(whole.ok);
      expect(streamed.counts).toEqual(whole.counts);
      expect(streamed.problems).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("flags same-id different-body conflicts across the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-vfs-"));
    try {
      const file = path.join(dir, "conflict.lync");
      const a = syntheticEvent(1);
      const b = { ...syntheticEvent(1), at: "2026-01-02T03:04:06.000Z" };
      await fs.writeFile(
        file,
        `${serializeLyncEvent(a)}\n${serializeLyncEvent(b)}\n`,
      );
      const streamed = await verifyLyncFileStreaming(file);
      expect(streamed.ok).toBe(false);
      expect(
        streamed.problems.some((p) => p.class === "conflict-variant"),
      ).toBe(true);
      // the whole-file verifier agrees this file is not clean
      const whole = await verifyLyncFile(file);
      expect(whole.ok).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("treats identical duplicate lines as one event seen twice (union no-op)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-vfs-"));
    try {
      const file = path.join(dir, "dup.lync");
      const a = syntheticEvent(1);
      await fs.writeFile(
        file,
        `${serializeLyncEvent(a)}\n${serializeLyncEvent(a)}\n`,
      );
      const streamed = await verifyLyncFileStreaming(file);
      const whole = await verifyLyncFile(file);
      expect(streamed.ok).toBe(whole.ok);
      expect(streamed.counts.accepted).toBe(whole.counts.accepted);
      expect(streamed.counts.events).toBe(whole.counts.events);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "crosses chunk boundaries: a file larger than one 32MB chunk verifies clean",
    { timeout: 60_000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-vfs-big-"));
      try {
        const file = path.join(dir, "big.lync");
        // ~40 events x ~1MB pad ≈ 40MB → at least two chunks, with a line
        // straddling the first chunk boundary carried over correctly.
        const events = Array.from({ length: 40 }, (_, i) =>
          syntheticEvent(i, 1024 * 1024),
        );
        await writeLyncFile(file, events);
        const streamed = await verifyLyncFileStreaming(file);
        expect(streamed.ok).toBe(true);
        expect(streamed.counts.lines).toBe(40);
        expect(streamed.counts.accepted).toBe(40);
        expect(streamed.counts.events).toBe(40);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "single event line larger than one 32MB chunk verifies clean (carry stays O(line), dee-07pu)",
    { timeout: 60_000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-vfs-line-"));
      try {
        const file = path.join(dir, "giant-line.lync");
        // One ~33MB payload → a single serialized line past VERIFY_CHUNK_BYTES:
        // the carry buffer must accumulate parts without re-copying the whole
        // accumulated line per read (the O(line²/chunk) shape this guards).
        await writeLyncFile(file, [syntheticEvent(0, 33 * 1024 * 1024)]);
        const streamed = await verifyLyncFileStreaming(file);
        expect(streamed.ok).toBe(true);
        expect(streamed.counts.lines).toBe(1);
        expect(streamed.counts.accepted).toBe(1);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("superlinear regression (dee-07pu)", () => {
  it(
    "codex function-call ladder at CI scale converts + verifies inside a fixed budget",
    { timeout: 60_000 },
    async () => {
      // 10k function_call/function_call_output pairs = 20k events whose
      // parent edges form a ladder (output → [previous, its call]). The
      // pre-fix @deepfates/lync cycle scan was an unmemoized per-event DFS —
      // exponential on exactly this shape (a ~200-event real rollout ran for
      // hours); anything quadratic in events also blows the budget here.
      // Fixed pipeline: a few seconds. Synthetic content only.
      const PAIRS = 10_000;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ladder-"));
      try {
        const input = path.join(dir, "ladder.jsonl");
        const lines: string[] = [];
        for (let i = 0; i < PAIRS; i++) {
          lines.push(
            JSON.stringify({
              timestamp: "2026-01-02T03:04:05.000Z",
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: `call-${i}`,
                name: "shell",
                arguments: "{}",
              },
            }),
            JSON.stringify({
              timestamp: "2026-01-02T03:04:06.000Z",
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: `call-${i}`,
                output: "ok",
              },
            }),
          );
        }
        await fs.writeFile(input, `${lines.join("\n")}\n`, "utf8");
        const out = path.join(dir, "ladder.lync");
        const converted = await convertSessionFileToLync(
          input,
          out,
          createCodexSessionLineMapper("ladder.jsonl", {
            sourceRef: "ladder.jsonl",
          }),
        );
        expect(converted.verify.ok).toBe(true);
        expect(converted.stats.emitted).toBe(PAIRS * 2);
        expect(converted.verify.counts.accepted).toBe(PAIRS * 2);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("scanSessionTree", () => {
  it("classifies every file: jsonl vs ignored, sorted, recursive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-scan-"));
    try {
      await fs.mkdir(path.join(dir, "b", "c"), { recursive: true });
      await fs.writeFile(path.join(dir, "b", "c", "x.jsonl"), "");
      await fs.writeFile(path.join(dir, "a.jsonl"), "");
      await fs.writeFile(path.join(dir, "b", "readme.md"), "");
      const scan = await scanSessionTree(dir);
      expect(scan.jsonlFiles).toEqual([
        "a.jsonl",
        path.join("b", "c", "x.jsonl"),
      ]);
      expect(scan.ignoredFiles).toEqual([path.join("b", "readme.md")]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
