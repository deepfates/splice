/**
 * Generates fixture.lync for the lync-training exporter tests (dee-lqk3).
 *
 * Six events extending FORMAT.md's worked example (A prose root; B and C as
 * alternative continuations; D scores B 0.91; E selects B over C; F scores C
 * 0.4 — the scored-but-unselected case the owner ruling adds). Ids are fixed
 * UUIDv7-shaped constants chosen so A < B < C < D < E < F in id order, and
 * every line carries a spliced digest per FORMAT.md "Bytes Are Canonical".
 *
 * Rerunning this script reproduces the committed file byte-for-byte:
 *   npx tsx tests/fixtures/lync-training/make-fixture.ts
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeLyncEvent } from "@deepfates/lync/store";
import type { LyncEventBody } from "@deepfates/lync/events";

export const FIXTURE_IDS = {
  A: "0197e6a0-4a00-7000-8000-00000000000a",
  B: "0197e6a0-4a09-7000-8000-00000000000b",
  C: "0197e6a0-4a09-7000-8000-00000000000c",
  D: "0197e6a0-4a0b-7000-8000-00000000000d",
  E: "0197e6a0-4a0f-7000-8000-00000000000e",
  F: "0197e6a0-4a10-7000-8000-00000000000f",
} as const;

export function splicedLine(ev: LyncEventBody): string {
  const body = serializeLyncEvent(ev);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `${body.slice(0, -1)},"digest":"sha256:${digest}"}`;
}

export function fixtureEvents(): LyncEventBody[] {
  const { A, B, C, D, E, F } = FIXTURE_IDS;
  return [
    {
      v: 1,
      id: A,
      kind: "lync/artifact",
      at: "2026-07-06T04:10:00Z",
      author: { actor: "deepfates" },
      parents: [],
      payload: { text: "The bear stood at the lip of the falls." },
    },
    {
      v: 1,
      id: B,
      kind: "lync/artifact",
      at: "2026-07-06T04:10:09Z",
      author: { actor: "claude-haiku-4-5", operator: "deepfates", via: "textile@0.9" },
      parents: [A],
      payload: {
        text: "It did not move for an hour, and the river brought it everything.",
        ordinal: 0,
      },
    },
    {
      v: 1,
      id: C,
      kind: "lync/artifact",
      at: "2026-07-06T04:10:09Z",
      author: { actor: "claude-haiku-4-5", operator: "deepfates", via: "textile@0.9" },
      parents: [A],
      payload: {
        text: "Downstream, the younger bears fought over shallows.",
        ordinal: 1,
      },
    },
    {
      v: 1,
      id: D,
      kind: "lync/annotation",
      at: "2026-07-06T04:10:11Z",
      author: { actor: "witness-panel-v3" },
      parents: [B],
      payload: { label: "score", value: 0.91 },
    },
    {
      v: 1,
      id: E,
      kind: "lync/annotation",
      at: "2026-07-06T04:10:15Z",
      author: { actor: "deepfates" },
      parents: [B, C],
      payload: { label: "selection", chosen: [B], shown: [B, C], basis: "human pick" },
    },
    {
      v: 1,
      id: F,
      kind: "lync/annotation",
      at: "2026-07-06T04:10:17Z",
      author: { actor: "witness-panel-v3" },
      parents: [C],
      payload: { label: "score", value: 0.4 },
    },
  ];
}

export function fixtureBytes(): string {
  return fixtureEvents()
    .map((ev) => `${splicedLine(ev)}\n`)
    .join("");
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture.lync");
  fs.writeFileSync(out, fixtureBytes(), "utf8");
  process.stdout.write(`wrote ${out}\n`);
}
