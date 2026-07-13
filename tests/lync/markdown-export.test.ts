import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLyncFiles } from "lync-core/events";

import {
  renderLyncMarkdown,
  convertLyncToMarkdown,
} from "../../src/outputs/lync-markdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../fixtures/lync-md");
const fixturePath = path.join(fixtureDir, "loom.lync");
const expectedPath = path.join(fixtureDir, "loom.expected.md");

// Fixture cast (see loom.lync): a loom with branches, a selection, a score, a
// generic annotation, a tombstoned alternative, a non-text tool record, and a
// same-id conflict with a stranded child.
const A = "019800aa-0000-7000-8000-000000000001"; // root prose
const B = "019800ab-0000-7000-8000-000000000002"; // selected continuation
const C = "019800ac-0000-7000-8000-000000000003"; // shown-not-chosen, extended
const D = "019800ad-0000-7000-8000-000000000004"; // score 0.91 on B
const E = "019800ae-0000-7000-8000-000000000005"; // selection B over C
const F = "019800af-0000-7000-8000-000000000006"; // child of C, hostile markdown
const G = "019800b0-0000-7000-8000-000000000007"; // main thread step 3
const H = "019800b1-0000-7000-8000-000000000008"; // tombstoned alternative
const T = "019800b2-0000-7000-8000-000000000009"; // tombstone on H
const J = "019800b3-0000-7000-8000-00000000000a"; // non-text tool record (head)
const K = "019800b4-0000-7000-8000-00000000000b"; // decision annotation on G
const X = "019800b5-0000-7000-8000-00000000000c"; // conflicted id (2 variants)
const Y = "019800b6-0000-7000-8000-00000000000d"; // child of the conflict

async function renderFixture(opts?: { head?: string; title?: string }) {
  const bytes = await fs.readFile(fixturePath);
  const result = parseLyncFiles([{ file: "loom.lync", bytes }]);
  return renderLyncMarkdown(result, { title: "loom.lync", ...opts });
}

describe("lync → markdown golden fixture", () => {
  it("renders the committed expected document byte-for-byte", async () => {
    const expected = await fs.readFile(expectedPath, "utf8");
    const render = await renderFixture();
    expect(render.markdown).toBe(expected);
  });

  it("main thread is the selections-first path (owner ruling 2026-07-12)", async () => {
    const render = await renderFixture();
    // At the A fork the curator selected B (annotation E) even though C is
    // also extended; at the B fork nothing is selected or scored, so the
    // longest subtree (G → J) wins over the tombstoned leaf H.
    expect(render.mainThread).toEqual([A, B, G, J]);
    expect(render.headId).toBe(J);
    expect(render.rule).toBe("selections-first path");
  });

  it("stats reconcile: nothing excluded is invisible", async () => {
    const render = await renderFixture();
    expect(render.stats).toEqual({
      files: ["loom.lync"],
      lines_total: 14,
      accepted: 12,
      nonconforming: 0,
      garbage: 0,
      damaged: 0,
      conflict_variants: 2,
      view_eligible: 12,
      suppressed_payloads: 1,
      thread_steps: 4,
      footnote_alternatives: 2,
      branch_sections: 2,
      annotations_rendered: 3,
      annotations_ignored: 0,
      annotations_unattached: 0,
      events_rendered: 8, // A B G J on the thread, C F Y in sections, H in a footnote
      obstacles: 1, // Y's walk is stopped by the conflict on X
      partial: true, // and the document says so
    });
  });

  it("fixture parses as expected: 12 accepted lines, one same-id conflict", async () => {
    const bytes = await fs.readFile(fixturePath);
    const result = parseLyncFiles([{ file: "loom.lync", bytes }]);
    const classes = result.lines.map((l) => l.class);
    expect(classes.filter((c) => c === "accepted")).toHaveLength(12);
    expect(classes.filter((c) => c === "conflict-variant")).toHaveLength(2);
    expect(result.conflictIds).toEqual([X]);
    expect(result.viewEligibleIds).toHaveLength(12);
    expect(result.suppression.suppressedPayloadIds).toEqual([H]);
  });
});

describe("determinism (export pact: regenerable)", () => {
  it("two consecutive runs produce byte-identical markdown", async () => {
    const a = await renderFixture();
    const b = await renderFixture();
    expect(a.markdown).toBe(b.markdown);
  });

  it("a line-shuffled copy produces byte-identical markdown", async () => {
    const original = await fs.readFile(fixturePath, "utf8");
    const lines = original.split("\n").filter((l) => l.length > 0);
    const shuffled = [...lines].reverse().join("\n") + "\n";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-lyncmd-"));
    try {
      // same basename so the parse diagnostics key identically
      const shuffledPath = path.join(dir, "loom.lync");
      await fs.writeFile(shuffledPath, shuffled, "utf8");
      const outA = path.join(dir, "a.md");
      const outB = path.join(dir, "b.md");
      await convertLyncToMarkdown(fixturePath, outA);
      await convertLyncToMarkdown(shuffledPath, outB);
      const bytesA = await fs.readFile(outA);
      const bytesB = await fs.readFile(outB);
      expect(bytesA.equals(bytesB)).toBe(true);
      expect(bytesA.equals(await fs.readFile(expectedPath))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("nothing eligible is silently absent", () => {
  it("every view-eligible event id appears in the document", async () => {
    const bytes = await fs.readFile(fixturePath);
    const result = parseLyncFiles([{ file: "loom.lync", bytes }]);
    const render = renderLyncMarkdown(result, { title: "loom.lync" });
    for (const id of result.viewEligibleIds) {
      expect(render.markdown).toContain(id.slice(0, 8));
      expect(render.markdown).toContain(id); // full id in the id table
    }
  });

  it("every quoted passage is attributed to its actor", async () => {
    const bytes = await fs.readFile(fixturePath);
    const result = parseLyncFiles([{ file: "loom.lync", bytes }]);
    const render = renderLyncMarkdown(result, { title: "loom.lync" });
    const eligible = new Set(result.viewEligibleIds);
    const suppressed = new Set(result.suppression.suppressedPayloadIds);
    let checked = 0;
    for (const line of result.lines) {
      if (!line.id || !line.event || !eligible.has(line.id)) continue;
      if (suppressed.has(line.id)) continue;
      const text = line.event.payload["text"];
      if (typeof text !== "string") continue;
      const firstLine = text.split("\n")[0];
      // the passage is present (modulo structural escaping) ...
      expect(render.markdown).toContain(firstLine.replace(/^#/, "\\#"));
      // ... and its actor + short id ride on an attribution line
      expect(render.markdown).toContain(
        `**${line.event.author.actor}**`,
      );
      expect(render.markdown).toContain(`\`${line.id.slice(0, 8)}\``);
      checked++;
    }
    // A, B, C, F, G, Y — H is suppressed, J has no text, X is conflicted
    expect(checked).toBe(6);
  });
});

describe("branches, annotations, suppression, conflicts", () => {
  it("the not-taken selected-against branch renders as a section with its annotation", async () => {
    const render = await renderFixture();
    expect(render.markdown).toContain("## Not on the main thread");
    expect(render.markdown).toContain("### Branching from step 1 — branch `019800ac`");
    expect(render.markdown).toContain(
      "Downstream, the younger bears fought over shallows.",
    );
    expect(render.markdown).toContain("> **shown, not chosen** — deepfates");
    expect(render.markdown).toContain("> **selected** over 1 alternative — deepfates");
    expect(render.markdown).toContain("> **score 0.91** — witness-panel-v3");
    expect(render.markdown).toContain('("human pick")');
  });

  it("generic annotations render as attributed blockquotes, payload shown", async () => {
    const render = await renderFixture();
    expect(render.markdown).toContain(
      '> **decision** — deepfates, 2026-07-06T04:15:00Z · `{"note":"canon; the loom continues from here"}`',
    );
  });

  it("the tombstoned alternative withholds its payload and names the tombstone", async () => {
    const render = await renderFixture();
    expect(render.markdown).not.toContain("The hidden ending the author took back.");
    expect(render.markdown).toContain(
      "*(content withheld — retracted by tombstone `019800b2`)*",
    );
    // envelope still visible: actor and at of the suppressed event
    expect(render.markdown).toContain("2026-07-06T04:12:05Z · `019800b1`");
  });

  it("conflict variants are never rendered; the conflict is named honestly", async () => {
    const render = await renderFixture();
    expect(render.markdown).not.toContain("A conflicting account, first variant.");
    expect(render.markdown).not.toContain("A conflicting account, second variant.");
    expect(render.markdown).toContain(
      `- **Conflict** on id \`${X}\`: 2 variants seen; none is shown above.`,
    );
    // the stranded child says inline why its context is missing
    expect(render.markdown).toContain(
      "*Earlier context unavailable due to conflict on `019800b5`; the thread below starts mid-conversation.*",
    );
  });

  it("non-text payloads render as fenced JSON, shown not elided", async () => {
    const render = await renderFixture();
    expect(render.markdown).toContain('"salmon_per_hour": 41');
    expect(render.markdown).toContain('"gauge": "USGS 12181000"');
  });

  it("markdown-hostile payload text is escaped, fences stay balanced", async () => {
    const render = await renderFixture();
    expect(render.markdown).toContain("\\# Not a heading, just the river talking.");
    expect(render.markdown).toContain("\\```");
    // the only unescaped fences are the tool record's json block (one pair)
    const rawFences = render.markdown
      .split("\n")
      .filter((l) => /^`{3,}/.test(l));
    expect(rawFences).toEqual(["```json", "```"]);
  });
});

describe("head override and degenerate inputs", () => {
  it("--head override renders the chosen path and says so", async () => {
    const render = await renderFixture({ head: F });
    expect(render.mainThread).toEqual([A, C, F]);
    expect(render.rule).toBe("head override");
    expect(render.markdown).toContain("(head override");
    // B now heads a deeper not-taken branch; its subtree still renders
    expect(render.markdown).toContain(
      "It did not move for an hour, and the river brought it everything.",
    );
    expect(render.markdown).toContain('"salmon_per_hour": 41');
  });

  it("an unknown head override fails loudly, never silently", async () => {
    await expect(
      renderFixture({ head: "not-a-real-id" }),
    ).rejects.toThrow(/not a view-eligible event/);
  });

  it("an empty file renders an honest empty document", () => {
    const result = parseLyncFiles([{ file: "empty.lync", bytes: "" }]);
    const render = renderLyncMarkdown(result, { title: "empty.lync" });
    expect(render.headId).toBeNull();
    expect(render.markdown).toContain("*No view-eligible events; nothing to render.*");
    expect(render.stats.lines_total).toBe(0);
    expect(render.stats.events_rendered).toBe(0);
  });
});

describe("damage honesty (generated variants, not committed)", () => {
  it("a digest-damaged line is surfaced with file, line, and reason; its content vanishes from the body", async () => {
    const original = await fs.readFile(fixturePath, "utf8");
    const lines = original.split("\n").filter((l) => l.length > 0);
    // splice a failing digest into event G's line (body + bogus digest)
    const gIndex = lines.findIndex((l) => l.includes(G));
    const damaged = `${lines[gIndex].slice(0, -1)},"digest":"sha256:${"0".repeat(64)}"}`;
    const mutated = [...lines];
    mutated[gIndex] = damaged;
    const result = parseLyncFiles([
      { file: "loom.lync", bytes: mutated.join("\n") + "\n" },
    ]);
    const render = renderLyncMarkdown(result, { title: "loom.lync" });
    expect(render.stats.damaged).toBe(1);
    expect(render.markdown).toContain(
      `- **Damaged** \`loom.lync:${gIndex + 1}\` — sha256 mismatch`,
    );
    expect(render.markdown).not.toContain(
      "By morning the falls had nothing left to teach it.",
    );
    // the thread routes around the damage rather than crashing
    expect(render.headId).not.toBeNull();
  });

  it("a garbage line is surfaced with file, line, and reason", async () => {
    const original = await fs.readFile(fixturePath, "utf8");
    const result = parseLyncFiles([
      { file: "loom.lync", bytes: original + "this is not an event\n" },
    ]);
    const render = renderLyncMarkdown(result, { title: "loom.lync" });
    expect(render.stats.garbage).toBe(1);
    expect(render.markdown).toContain("- **Garbage** `loom.lync:15` —");
  });

  it("malformed score/selection annotations are reported, never guessed at", async () => {
    const original = await fs.readFile(fixturePath, "utf8");
    const badAnn = JSON.stringify({
      v: 1,
      id: "019800b7-0000-7000-8000-00000000000e",
      kind: "lync/annotation",
      at: "2026-07-06T04:18:00Z",
      author: { actor: "confused-judge" },
      parents: [B],
      payload: { label: "score", value: "very good" },
    });
    const result = parseLyncFiles([
      { file: "loom.lync", bytes: original + badAnn + "\n" },
    ]);
    const render = renderLyncMarkdown(result, { title: "loom.lync" });
    expect(render.stats.annotations_ignored).toBe(1);
    expect(render.markdown).toContain(
      "- **Annotation not interpreted** `019800b7`",
    );
    // shown verbatim at its rendered target, flagged as uninterpreted
    expect(render.markdown).toContain(
      "> **score (not interpreted)** — confused-judge",
    );
  });
});

describe("FORMAT.md worked example (five events, real ids)", () => {
  const WA = "01980100-0000-7000-8000-0000000000aa";
  const WB = "01980101-0000-7000-8000-0000000000ab";
  const WC = "01980102-0000-7000-8000-0000000000ac";
  const WD = "01980103-0000-7000-8000-0000000000ad";
  const WE = "01980104-0000-7000-8000-0000000000ae";

  function workedExample(): string {
    const events = [
      { v: 1, id: WA, kind: "lync/artifact", at: "2026-07-06T04:10:00Z", author: { actor: "deepfates" }, parents: [], payload: { text: "The bear stood at the lip of the falls." } },
      { v: 1, id: WB, kind: "lync/artifact", at: "2026-07-06T04:10:09Z", author: { actor: "claude-haiku-4-5", operator: "deepfates", via: "textile@0.9" }, parents: [WA], payload: { text: "It did not move for an hour, and the river brought it everything.", ordinal: 0 } },
      { v: 1, id: WC, kind: "lync/artifact", at: "2026-07-06T04:10:09Z", author: { actor: "claude-haiku-4-5", operator: "deepfates", via: "textile@0.9" }, parents: [WA], payload: { text: "Downstream, the younger bears fought over shallows.", ordinal: 1 } },
      { v: 1, id: WD, kind: "lync/annotation", at: "2026-07-06T04:10:11Z", author: { actor: "witness-panel-v3" }, parents: [WB], payload: { label: "score", value: 0.91 } },
      { v: 1, id: WE, kind: "lync/annotation", at: "2026-07-06T04:10:15Z", author: { actor: "deepfates" }, parents: [WB, WC], payload: { label: "selection", chosen: [WB], shown: [WB, WC], basis: "human pick" } },
    ];
    return events.map((e) => JSON.stringify(e) + "\n").join("");
  }

  it("thread is A then B; C is a footnoted alternative; D and E are blockquotes under B", () => {
    const result = parseLyncFiles([
      { file: "worked.lync", bytes: workedExample() },
    ]);
    const render = renderLyncMarkdown(result, { title: "worked.lync" });
    expect(render.mainThread).toEqual([WA, WB]);
    expect(render.rule).toBe("selections-first path");
    expect(render.markdown).toContain("The bear stood at the lip of the falls.");
    expect(render.markdown).toContain(
      "It did not move for an hour, and the river brought it everything.",
    );
    expect(render.markdown).toContain("> **score 0.91** — witness-panel-v3");
    expect(render.markdown).toContain(
      '> **selected** over 1 alternative — deepfates, 2026-07-06T04:10:15Z ("human pick")',
    );
    // C renders fully inside its footnote, attributed, marked not chosen
    expect(render.markdown).toContain(
      "[^alt-1]: Alternative at this point (not taken), by claude-haiku-4-5",
    );
    expect(render.markdown).toContain(
      '"Downstream, the younger bears fought over shallows."',
    );
    expect(render.markdown).toContain("— **shown, not chosen** — deepfates");
    expect(render.stats.footnote_alternatives).toBe(1);
    expect(render.stats.branch_sections).toBe(0);
    // clean file, clean diagnostics
    expect(render.markdown).toContain(
      "- 5 lines: 5 accepted, 0 nonconforming, 0 garbage, 0 damaged, 0 conflict variants.",
    );
    expect(render.markdown).toContain(
      "- No dangling parents, cycles, or conflicts on the rendered threads.",
    );
  });
});

describe("annotations on unrendered targets are never silently dropped", () => {
  // Refutation repro (dee-5xu4 adversarial review, 2026-07-12): a revision
  // annotation on another annotation, a decision annotation on a conflicted
  // id, and a parentless score. All three are view-eligible but attach to
  // nothing the document renders — their payloads must still appear.
  const R1 = "019800c0-0000-7000-8000-0000000000e1"; // revision on annotation D
  const R2 = "019800c1-0000-7000-8000-0000000000e2"; // decision on conflicted X
  const R3 = "019800c2-0000-7000-8000-0000000000e3"; // parentless score

  const extraLines =
    [
      `{"v":1,"id":"${R1}","kind":"lync/annotation","at":"2026-07-12T00:00:01Z","author":{"actor":"reviewer"},"parents":["${D}"],"payload":{"label":"revision","note":"SECRET-NOTE-ON-ANNOTATION"}}`,
      `{"v":1,"id":"${R2}","kind":"lync/annotation","at":"2026-07-12T00:00:02Z","author":{"actor":"reviewer"},"parents":["${X}"],"payload":{"label":"decision","note":"conflict stands"}}`,
      `{"v":1,"id":"${R3}","kind":"lync/annotation","at":"2026-07-12T00:00:03Z","author":{"actor":"reviewer"},"parents":[],"payload":{"label":"score","value":0.5}}`,
    ].join("\n") + "\n";

  async function renderWithUnattached() {
    const base = await fs.readFile(fixturePath, "utf8");
    const bytes = new TextEncoder().encode(base + extraLines);
    const result = parseLyncFiles([{ file: "loom.lync", bytes }]);
    return renderLyncMarkdown(result, { title: "loom.lync" });
  }

  it("every unattached payload appears in the document, with a count", async () => {
    const render = await renderWithUnattached();
    expect(render.markdown).toContain("SECRET-NOTE-ON-ANNOTATION");
    expect(render.markdown).toContain("conflict stands");
    for (const id of [R1, R2, R3]) {
      expect(render.markdown).toContain(id.slice(0, 8));
    }
    const sweepLines = render.markdown
      .split("\n")
      .filter((l) => l.includes("**Annotation on unrendered target**"));
    expect(sweepLines).toHaveLength(3);
    expect(render.stats.annotations_unattached).toBe(3);
  });

  it("the base fixture has zero unattached annotations (golden unchanged)", async () => {
    const render = await renderFixture();
    expect(render.stats.annotations_unattached).toBe(0);
    expect(render.markdown).not.toContain("Annotation on unrendered target");
  });
});
