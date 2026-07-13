import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { serializeLyncEvent } from "lync-core/store";
import type { LyncEventBody } from "lync-core/events";

import {
  scanSessionTree,
  splitSessionJsonl,
  verifyLyncFileStreaming,
} from "../../src/outputs/lync-session-batch.js";
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

  it("crosses chunk boundaries: a file larger than one 32MB chunk verifies clean", async () => {
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
  });
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
