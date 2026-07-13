import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLyncFiles } from "lync-core/events";

import {
  lyncToTrainingData,
  convertLyncToTrainingData,
  rowsToJsonl,
  sftRowToPlain,
  sftRowToMessages,
  preferenceRowToPlain,
  preferenceRowToMessages,
  joinSegmentTexts,
  type LyncSftRow,
} from "../../src/index.js";
import {
  FIXTURE_IDS,
  fixtureEvents,
  splicedLine,
} from "../fixtures/lync-training/make-fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  __dirname,
  "../fixtures/lync-training/fixture.lync",
);

const { A, B, C, D, E, F } = FIXTURE_IDS;
const TEXT_A = "The bear stood at the lip of the falls.";
const TEXT_B = "It did not move for an hour, and the river brought it everything.";
const TEXT_C = "Downstream, the younger bears fought over shallows.";

// Every pure-layer test parses under this one label so the shuffle test can
// prove line order carries no meaning (FORMAT.md rule 2) without the file
// path leaking into meta.files as a difference.
const LABEL = "fixture.lync";

async function fixtureBytes(): Promise<string> {
  return fs.readFile(fixturePath, "utf8");
}

function training(bytes: string) {
  return lyncToTrainingData(parseLyncFiles([{ file: LABEL, bytes }]));
}

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "lync-training-"));
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

describe("committed fixture is a conforming lync file", () => {
  it("regenerates byte-for-byte from make-fixture and parses all-accepted", async () => {
    const bytes = await fixtureBytes();
    const regenerated = fixtureEvents()
      .map((ev) => `${splicedLine(ev)}\n`)
      .join("");
    expect(bytes).toBe(regenerated);

    const result = parseLyncFiles([{ file: LABEL, bytes }]);
    expect(result.lines).toHaveLength(6);
    for (const line of result.lines) expect(line.class).toBe("accepted");
    expect(result.conflictIds).toEqual([]);
    expect(result.viewEligibleIds).toHaveLength(6);
  });
});

describe("SFT rows (the flashcard rule: attributed segments)", () => {
  it("emits one row per scored-or-selected artifact, name tags intact", async () => {
    const { sftRows, stats } = training(await fixtureBytes());

    expect(stats.sft_rows).toBe(2);
    expect(sftRows.map((r) => r.meta.source_event)).toEqual([B, C]);

    const rowB = sftRows[0];
    expect(rowB.prompt).toEqual([
      { actor: "deepfates", via: null, text: TEXT_A, event_id: A },
    ]);
    expect(rowB.completion).toEqual({
      actor: "claude-haiku-4-5",
      via: "textile@0.9",
      text: TEXT_B,
      event_id: B,
    });
    expect(rowB.weight).toBe(0.91);
    expect(rowB.meta).toEqual({
      source_event: B,
      context_events: [A],
      score_events: [D],
      score_count: 1,
      selection_events: [E],
      selection_count: 1,
      selected_count: 1,
      at: "2026-07-06T04:10:09Z",
      files: [LABEL],
    });

    // Scored-but-unselected still becomes a row (owner ruling): score = weight.
    const rowC = sftRows[1];
    expect(rowC.completion.event_id).toBe(C);
    expect(rowC.weight).toBe(0.4);
    expect(rowC.meta.score_events).toEqual([F]);
    expect(rowC.meta.selected_count).toBe(0);
    expect(rowC.meta.selection_count).toBe(1);
  });

  it("selection-only completions become rows with null weight (no number is minted)", async () => {
    const lines = (await fixtureBytes())
      .split("\n")
      .filter((l) => l.length > 0 && !l.includes(D) && !l.includes(F));
    const { sftRows, stats } = training(`${lines.join("\n")}\n`);

    expect(stats.sft_rows).toBe(1);
    const row = sftRows[0];
    expect(row.meta.source_event).toBe(B);
    expect(row.weight).toBeNull();
    expect(row.meta.score_events).toEqual([]);
    expect(row.meta.selected_count).toBe(1);
    // C was shown-but-not-chosen and unscored: no signal, no row.
    expect(sftRows.some((r) => r.meta.source_event === C)).toBe(false);
  });
});

describe("preference pairs", () => {
  it("emits chosen × (shown − chosen) with judge, basis, and score means on record", async () => {
    const { preferenceRows, stats } = training(await fixtureBytes());

    expect(stats.preference_rows).toBe(1);
    const row = preferenceRows[0];
    expect(row.prompt).toEqual([
      { actor: "deepfates", via: null, text: TEXT_A, event_id: A },
    ]);
    expect(row.chosen.event_id).toBe(B);
    expect(row.chosen.text).toBe(TEXT_B);
    expect(row.rejected.event_id).toBe(C);
    expect(row.rejected.text).toBe(TEXT_C);
    expect(row.meta).toEqual({
      selection_event: E,
      chosen_event: B,
      rejected_event: C,
      context_events: [A],
      judge: { actor: "deepfates" },
      basis: "human pick",
      chosen_score_mean: 0.91,
      rejected_score_mean: 0.4,
      files: [LABEL],
    });
  });
});

describe("provenance closure", () => {
  it("every id in every row's meta resolves to a view-eligible event", async () => {
    const bytes = await fixtureBytes();
    const result = parseLyncFiles([{ file: LABEL, bytes }]);
    const eligible = new Set(result.viewEligibleIds);
    const { sftRows, preferenceRows } = lyncToTrainingData(result);

    for (const row of sftRows) {
      const ids = [
        row.meta.source_event,
        ...row.meta.context_events,
        ...row.meta.score_events,
        ...row.meta.selection_events,
      ];
      for (const id of ids) expect(eligible.has(id)).toBe(true);
    }
    for (const row of preferenceRows) {
      const ids = [
        row.meta.selection_event,
        row.meta.chosen_event,
        row.meta.rejected_event,
        ...row.meta.context_events,
      ];
      for (const id of ids) expect(eligible.has(id)).toBe(true);
    }
  });

  it("reassembling the prompt from context_events reproduces the plain rendering exactly", async () => {
    const { sftRows } = training(await fixtureBytes());
    for (const row of sftRows) {
      expect(row.prompt.map((s) => s.event_id)).toEqual(row.meta.context_events);
      expect(sftRowToPlain(row).prompt).toBe(joinSegmentTexts(row.prompt));
    }
  });
});

describe("determinism", () => {
  it("double-run through the converter is byte-identical", async () => {
    const out1 = await tmpdir();
    const out2 = await tmpdir();
    const opts = { renderings: ["plain", "messages"] as ("plain" | "messages")[] };
    const run1 = await convertLyncToTrainingData([fixturePath], out1, opts);
    const run2 = await convertLyncToTrainingData([fixturePath], out2, opts);

    expect(run1.written).toEqual(run2.written);
    expect(run1.written).toEqual([
      "preferences.jsonl",
      "preferences.messages.jsonl",
      "preferences.plain.jsonl",
      "sft.jsonl",
      "sft.messages.jsonl",
      "sft.plain.jsonl",
      "stats.json",
    ]);
    for (const name of run1.written) {
      expect(await sha256(path.join(out1, name))).toBe(
        await sha256(path.join(out2, name)),
      );
    }
  });

  it("a line-shuffled copy produces byte-identical sft.jsonl and preferences.jsonl", async () => {
    const bytes = await fixtureBytes();
    const shuffled = `${bytes.split("\n").filter((l) => l.length > 0).reverse().join("\n")}\n`;
    expect(shuffled).not.toBe(bytes);

    const straight = training(bytes);
    const reversed = training(shuffled);
    expect(rowsToJsonl(reversed.sftRows)).toBe(rowsToJsonl(straight.sftRows));
    expect(rowsToJsonl(reversed.preferenceRows)).toBe(
      rowsToJsonl(straight.preferenceRows),
    );
  });
});

describe("damage honesty", () => {
  it("a digest-failing line is excluded, counted, and never silently half-emits a pair", async () => {
    const bytes = await fixtureBytes();
    // Corrupt one byte of C's payload text: digest verification fails, the
    // line is damaged, and C's content must appear nowhere in the output.
    const corrupted = bytes.replace("younger bears", "youngest bears");
    expect(corrupted).not.toBe(bytes);

    const { sftRows, preferenceRows, stats } = training(corrupted);
    expect(stats.damaged).toBe(1);
    expect(stats.view_eligible).toBe(5);
    expect(stats.sft_rows).toBe(1);
    expect(sftRows[0].meta.source_event).toBe(B);
    // F's score targets damaged C: an explicit ineligible skip, not a row.
    expect(stats.sft_skipped_ineligible).toBe(1);
    expect(stats.detail.sft_skips[0].event_id).toBe(C);
    // The B-over-C pair loses its rejected side: skipped loudly, not emitted.
    expect(stats.preference_rows).toBe(0);
    expect(stats.pairs_skipped_ineligible).toBe(1);
    expect(preferenceRows).toEqual([]);
    const emitted = rowsToJsonl(sftRows) + rowsToJsonl(preferenceRows);
    expect(emitted).not.toContain("bears fought");
  });
});

describe("conflict honesty", () => {
  it("a same-id variant removes the id from every role; no winner is picked", async () => {
    const bytes = await fixtureBytes();
    const events = fixtureEvents();
    const variantB = {
      ...events[1],
      payload: { text: "A different history for the same id.", ordinal: 0 },
    };
    const withConflict = `${bytes}${splicedLine(variantB)}\n`;

    const { sftRows, preferenceRows, stats } = training(withConflict);
    expect(stats.conflict_variants).toBeGreaterThanOrEqual(1);
    expect(stats.view_eligible).toBe(5);
    // B appears in no row in any role: completion, chosen, rejected, or context.
    const rows = rowsToJsonl(sftRows) + rowsToJsonl(preferenceRows);
    expect(rows).not.toContain(B);
    expect(rows).not.toContain(TEXT_B);
    expect(rows).not.toContain("different history");
    expect(stats.sft_rows).toBe(1);
    expect(sftRows[0].meta.source_event).toBe(C);
    expect(stats.sft_skipped_ineligible).toBe(1);
    expect(stats.preference_rows).toBe(0);
    expect(stats.pairs_skipped_ineligible).toBe(1);
  });
});

describe("suppression respected", () => {
  const TOMBSTONE_ID = "0197e6a0-4a11-7000-8000-0000000000aa";

  async function withTombstone(): Promise<string> {
    const bytes = await fixtureBytes();
    const tombstone = splicedLine({
      v: 1,
      id: TOMBSTONE_ID,
      kind: "lync/tombstone",
      at: "2026-07-06T04:11:00Z",
      author: { actor: "deepfates" },
      parents: [B],
      payload: { reason: "retracted" },
      critical: true,
    });
    return `${bytes}${tombstone}\n`;
  }

  it("a critical tombstone on B removes B-derived rows and names the tombstone", async () => {
    const { sftRows, preferenceRows, stats } = training(await withTombstone());

    expect(stats.suppressed_payloads).toBe(1);
    expect(stats.detail.suppressed_payload_ids).toEqual([B]);
    expect(stats.sft_rows).toBe(1);
    expect(sftRows[0].meta.source_event).toBe(C);
    expect(stats.sft_skipped_suppressed).toBe(1);
    const skip = stats.detail.sft_skips.find((s) => s.event_id === B);
    expect(skip?.category).toBe("suppressed");
    expect(skip?.by).toEqual([TOMBSTONE_ID]);
    // Chosen side suppressed → the pair is refused, with the tombstone named.
    expect(stats.preference_rows).toBe(0);
    expect(stats.pairs_skipped_ineligible).toBe(1);
    expect(stats.detail.pair_skips[0].by).toEqual([TOMBSTONE_ID]);
    // The suppressed payload leaks nowhere.
    const rows = rowsToJsonl(sftRows) + rowsToJsonl(preferenceRows);
    expect(rows).not.toContain(TEXT_B);
  });
});

describe("no-train respected", () => {
  const NO_TRAIN_ID = "0197e6a0-4a12-7000-8000-0000000000ab";

  it("a no-train annotation on B removes B-derived rows via its own counter", async () => {
    const bytes = await fixtureBytes();
    const noTrain = splicedLine({
      v: 1,
      id: NO_TRAIN_ID,
      kind: "lync/annotation",
      at: "2026-07-06T04:12:00Z",
      author: { actor: "deepfates" },
      parents: [B],
      payload: { label: "no-train" },
    });
    const { sftRows, preferenceRows, stats } = training(`${bytes}${noTrain}\n`);

    expect(stats.sft_rows).toBe(1);
    expect(sftRows[0].meta.source_event).toBe(C);
    expect(stats.sft_skipped_no_train).toBe(1);
    const skip = stats.detail.sft_skips.find((s) => s.event_id === B);
    expect(skip?.category).toBe("no_train");
    expect(skip?.by).toEqual([NO_TRAIN_ID]);
    expect(stats.preference_rows).toBe(0);
    expect(stats.pairs_skipped_no_train).toBe(1);
    const rows = rowsToJsonl(sftRows) + rowsToJsonl(preferenceRows);
    expect(rows).not.toContain(TEXT_B);
  });

  it("a no-train target anywhere in the assembled prompt poisons the row", async () => {
    const bytes = await fixtureBytes();
    const noTrainOnA = splicedLine({
      v: 1,
      id: NO_TRAIN_ID,
      kind: "lync/annotation",
      at: "2026-07-06T04:12:00Z",
      author: { actor: "deepfates" },
      parents: [A],
      payload: { label: "no-train" },
    });
    const { stats } = training(`${bytes}${noTrainOnA}\n`);

    // A is context for both completions and for the pair: everything drops.
    expect(stats.sft_rows).toBe(0);
    expect(stats.sft_skipped_no_train).toBe(2);
    expect(stats.preference_rows).toBe(0);
    expect(stats.pairs_skipped_no_train).toBe(1);
  });
});

describe("partial context refused", () => {
  it("a dangling prompt head yields zero rows and a dangling obstacle", async () => {
    const bytes = await fixtureBytes();
    const withoutA = `${bytes
      .split("\n")
      .filter((l) => l.length > 0 && !l.includes(`"id":"${A}"`))
      .join("\n")}\n`;

    const { sftRows, preferenceRows, stats } = training(withoutA);
    expect(stats.sft_rows).toBe(0);
    expect(stats.sft_skipped_partial_context).toBe(2);
    expect(stats.preference_rows).toBe(0);
    expect(stats.pairs_skipped_partial_context).toBe(1);
    expect(stats.pairs_skipped_context_mismatch).toBe(0);
    expect(stats.pairs_skipped_ineligible).toBe(0);
    expect(
      stats.obstacles.some((o) => o.class === "dangling" && o.missing === A),
    ).toBe(true);
    expect(sftRows).toEqual([]);
    expect(preferenceRows).toEqual([]);
  });
});

describe("stats block", () => {
  it("reports the full taxonomy for the clean fixture", async () => {
    const { stats } = training(await fixtureBytes());
    expect(stats).toMatchObject({
      files: [LABEL],
      lines_total: 6,
      accepted: 6,
      nonconforming: 0,
      garbage: 0,
      damaged: 0,
      conflict_variants: 0,
      view_eligible: 6,
      suppressed_payloads: 0,
      sft_rows: 2,
      sft_skipped_ineligible: 0,
      sft_skipped_suppressed: 0,
      sft_skipped_no_train: 0,
      sft_skipped_partial_context: 0,
      preference_rows: 1,
      pairs_skipped_ineligible: 0,
      pairs_skipped_no_train: 0,
      pairs_skipped_context_mismatch: 0,
      pairs_skipped_partial_context: 0,
      annotations_ignored: 0,
      obstacles: [],
    });
  });

  it("counts malformed annotations as ignored, never guessed at", async () => {
    const bytes = await fixtureBytes();
    const malformed = splicedLine({
      v: 1,
      id: "0197e6a0-4a13-7000-8000-0000000000ac",
      kind: "lync/annotation",
      at: "2026-07-06T04:13:00Z",
      author: { actor: "deepfates" },
      parents: [B],
      payload: { label: "score", value: "not a number" },
    });
    const { stats } = training(`${bytes}${malformed}\n`);
    expect(stats.annotations_ignored).toBe(1);
    expect(stats.detail.ignored_annotation_ids).toEqual([
      "0197e6a0-4a13-7000-8000-0000000000ac",
    ]);
    // The well-formed signal still flows.
    expect(stats.sft_rows).toBe(2);
    expect(stats.preference_rows).toBe(1);
  });
});

describe("derived renderings (never the stored truth)", () => {
  it("plain joins texts with \\n\\n; the canonical row keeps the name tags", async () => {
    const { sftRows, preferenceRows } = training(await fixtureBytes());
    const plain = sftRowToPlain(sftRows[0]);
    expect(plain.prompt).toBe(TEXT_A);
    expect(plain.completion).toBe(TEXT_B);
    expect(plain.weight).toBe(0.91);

    const prefPlain = preferenceRowToPlain(preferenceRows[0]);
    expect(prefPlain.prompt).toBe(TEXT_A);
    expect(prefPlain.chosen).toBe(TEXT_B);
    expect(prefPlain.rejected).toBe(TEXT_C);
  });

  it("messages maps the completion's actor to assistant, all others to user", async () => {
    const { sftRows, preferenceRows } = training(await fixtureBytes());
    expect(sftRowToMessages(sftRows[0]).messages).toEqual([
      { role: "user", content: TEXT_A },
      { role: "assistant", content: TEXT_B },
    ]);
    expect(preferenceRowToMessages(preferenceRows[0]).messages).toEqual([
      { role: "user", content: TEXT_A },
    ]);
  });

  it("prompt segments by the trained voice itself render as assistant turns", () => {
    const row: LyncSftRow = {
      prompt: [
        { actor: "narrator", via: null, text: "scene", event_id: "x" },
        { actor: "voice", via: null, text: "earlier line", event_id: "y" },
      ],
      completion: { actor: "voice", via: null, text: "next line", event_id: "z" },
      weight: null,
      meta: {
        source_event: "z",
        context_events: ["x", "y"],
        score_events: [],
        score_count: 0,
        selection_events: [],
        selection_count: 0,
        selected_count: 0,
        at: "2026-07-06T04:10:00Z",
        files: [],
      },
    };
    expect(sftRowToMessages(row).messages).toEqual([
      { role: "user", content: "scene" },
      { role: "assistant", content: "earlier line" },
      { role: "assistant", content: "next line" },
    ]);
  });
});

describe("end-to-end converter", () => {
  it("writes canonical files plus stats and returns reconciled counts", async () => {
    const out = await tmpdir();
    const conversion = await convertLyncToTrainingData([fixturePath], out);

    expect(conversion.written).toEqual([
      "preferences.jsonl",
      "sft.jsonl",
      "stats.json",
    ]);
    const sftLines = (await fs.readFile(path.join(out, "sft.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(sftLines).toHaveLength(2);
    for (const line of sftLines) expect(() => JSON.parse(line)).not.toThrow();

    const stats = JSON.parse(
      await fs.readFile(path.join(out, "stats.json"), "utf8"),
    );
    expect(stats.sft_rows).toBe(2);
    expect(stats.preference_rows).toBe(1);
    expect(stats.files).toEqual([fixturePath]);

    // meta.files carries the real source path when run through the converter.
    expect(conversion.sftRows[0].meta.files).toEqual([fixturePath]);
  });

  it("refuses empty input and unreadable files loudly", async () => {
    const out = await tmpdir();
    await expect(convertLyncToTrainingData([], out)).rejects.toThrow(
      /no input files/,
    );
    await expect(
      convertLyncToTrainingData([path.join(out, "missing.lync")], out),
    ).rejects.toThrow();
  });
});
