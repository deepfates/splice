/**
 * lync markdown export — splice as a lync READER (dee-5xu4).
 *
 * One `.lync` file → one human-readable markdown document: the main thread as
 * prose, branches as footnoted alternatives, annotations as attributed
 * blockquotes, damage surfaced honestly at the end. A reader should be able to
 * enjoy the document without knowing what lync is.
 *
 * This is an EXPORT under lync/pacts/export.md: a projection of the event log,
 * never a mutation, never new truth. The document asserts nothing the events
 * do not contain; everything excluded is reported in Diagnostics, never
 * silently dropped.
 *
 * Main-thread rule (owner ruling 2026-07-12, dee-5xu4 notes — supersedes the
 * leaderboard-then-longest placeholder in the spec): SELECTIONS FIRST. Where
 * explicit selection events exist, follow the selected path — the curator's
 * hand is the truth. Fall back to leaderboard rank, then longest subtree, then
 * smallest id, only where nobody has selected.
 *
 * Determinism: same event set (in any line order) → byte-identical markdown.
 * All iteration is over id-sorted lists, all times are event `at` values, no
 * wall clock, no RNG. Line-order-dependent diagnostics (file:line) appear only
 * for lines that are themselves order-independent facts of the file.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseLyncFiles } from "@deepfates/lync/events";
import type { LyncParseResult } from "@deepfates/lync/events";
import {
  lyncBranchTreeView,
  lyncLeaderboardView,
  lyncTranscriptView,
} from "@deepfates/lync/views";
import type {
  LyncBranchTreeNode,
  LyncLeaderboardEntry,
} from "@deepfates/lync/views";

/* --------------------------------- Types ---------------------------------- */

export interface LyncMarkdownOptions {
  /** Override the main-thread head (must be a view-eligible event id). */
  head?: string;
  /** Document title. Defaults to the source file's basename. */
  title?: string;
}

/** Everything the projection excluded or could not walk — never silent. */
export interface LyncMarkdownStats {
  files: string[];
  lines_total: number;
  accepted: number;
  nonconforming: number;
  garbage: number;
  damaged: number;
  conflict_variants: number;
  view_eligible: number;
  suppressed_payloads: number;
  thread_steps: number;
  footnote_alternatives: number;
  branch_sections: number;
  annotations_rendered: number;
  annotations_ignored: number;
  annotations_unattached: number;
  events_rendered: number;
  obstacles: number;
  partial: boolean;
}

export interface LyncMarkdownRender {
  markdown: string;
  /** Head of the main thread, or null when nothing is view-eligible. */
  headId: string | null;
  /** Root→head event ids of the rendered main thread. */
  mainThread: string[];
  /** Which rule chose the main thread (stated in the document header too). */
  rule: string;
  stats: LyncMarkdownStats;
}

export interface LyncMarkdownConversion extends LyncMarkdownRender {
  outputPath: string;
}

/* -------------------------------- Utilities -------------------------------- */

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inline code span that survives backticks inside the value. */
function inlineCode(value: string): string {
  let run = 0;
  let longest = 0;
  for (const ch of value) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * Escape payload text only where it would break document structure: a leading
 * `#` would become a heading, a leading fence would swallow the rest of the
 * document. Everything else rides verbatim — the document is for reading, not
 * round-tripping.
 */
function escapeProseLine(line: string): string {
  let out = line;
  if (/^ {0,3}#/.test(out)) out = out.replace("#", "\\#");
  const fence = out.match(/^ {0,3}(`{3,}|~{3,})/);
  if (fence) {
    out = out.replace(fence[1], `\\${fence[1][0]}${fence[1].slice(1)}`);
  }
  return out;
}

function escapeProse(text: string): string {
  return text.split("\n").map(escapeProseLine).join("\n");
}

/** Fenced JSON block whose fence outruns any backtick run in the body. */
function jsonBlock(value: unknown): string[] {
  const body = JSON.stringify(value, null, 2);
  let run = 0;
  let longest = 0;
  for (const ch of body) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}json`, ...body.split("\n"), fence];
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string"));
}

/* ------------------------------ The projection ----------------------------- */

interface Section {
  headId: string;
  /** Fork parent (null for separate roots / detached / sweep sections). */
  parentId: string | null;
  /** The sibling the containing thread continued with (fork sections). */
  chosenSiblingId: string | null;
  kind: "branch" | "root" | "detached" | "sweep";
}

const RULE_LABEL: Record<string, string> = {
  selection: "selections-first path",
  score: "leaderboard rank",
  longest: "longest thread",
  only: "single path",
  override: "head override",
};

const RULE_PRIORITY = ["selection", "score", "longest", "only"] as const;

export function renderLyncMarkdown(
  result: LyncParseResult,
  opts: LyncMarkdownOptions = {},
): LyncMarkdownRender {
  const tree = lyncBranchTreeView(result);
  const board = lyncLeaderboardView(result);
  const nodes = new Map<string, LyncBranchTreeNode>(
    tree.nodes.map((n) => [n.id, n]),
  );
  const boardById = new Map<string, LyncLeaderboardEntry>(
    board.entries.map((e) => [e.targetId, e]),
  );
  const ignoredAnnotations = new Set(board.ignoredAnnotationIds);
  const suppressedIds = new Set(result.suppression.suppressedPayloadIds);
  const files = [...new Set(result.lines.map((l) => l.file))].sort();

  /* ---- short ids: first 8 chars, widened to the full id on collision ---- */
  const allIds = [...nodes.keys()].sort(compareIds);
  const shortCounts = new Map<string, number>();
  for (const id of allIds) {
    const s = id.slice(0, 8);
    shortCounts.set(s, (shortCounts.get(s) ?? 0) + 1);
  }
  const shortId = (id: string): string => {
    const s = id.slice(0, 8);
    return (shortCounts.get(s) ?? 0) > 1 ? id : s;
  };

  /* ---- content vs annotation-role events ------------------------------- */
  // Annotations, tombstones, and critical retractions never sit ON a thread;
  // they attach to it (blockquotes, withheld notes). Everything else — prose,
  // tool records, pointers — is thread material, text or not.
  const isAnnotationLike = (node: LyncBranchTreeNode): boolean =>
    node.event.kind === "lync/annotation" ||
    node.event.kind === "lync/tombstone" ||
    node.event.critical === true;

  const contentIds = allIds.filter((id) => !isAnnotationLike(nodes.get(id)!));
  const contentSet = new Set(contentIds);
  const contentChildren = new Map<string, string[]>(
    contentIds.map((id) => [
      id,
      nodes.get(id)!.children.filter((c) => contentSet.has(c)),
    ]),
  );

  /* ---- longest-path-below depth per content node (cycle-safe) ----------- */
  const depths = new Map<string, number>();
  for (const start of contentIds) {
    if (depths.has(start)) continue;
    const stack: Array<{ id: string; childIndex: number }> = [
      { id: start, childIndex: 0 },
    ];
    const onStack = new Set<string>([start]);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const kids = contentChildren.get(frame.id) ?? [];
      if (frame.childIndex < kids.length) {
        const child = kids[frame.childIndex++];
        if (depths.has(child) || onStack.has(child)) continue;
        stack.push({ id: child, childIndex: 0 });
        onStack.add(child);
      } else {
        let d = 0;
        for (const child of kids) d = Math.max(d, 1 + (depths.get(child) ?? 0));
        depths.set(frame.id, d);
        stack.pop();
        onStack.delete(frame.id);
      }
    }
  }

  /* ---- main-thread choice: selections first (owner ruling 2026-07-12) --- */
  const selectedCount = (id: string) => boardById.get(id)?.selectedCount ?? 0;
  const scoreCount = (id: string) => boardById.get(id)?.scoreCount ?? 0;
  const rankOf = (id: string) =>
    boardById.get(id)?.rank ?? Number.MAX_SAFE_INTEGER;
  const depthOf = (id: string) => depths.get(id) ?? 0;

  function pickChild(candidates: string[]): { id: string; rule: string } {
    if (candidates.length === 1) return { id: candidates[0], rule: "only" };
    const selected = candidates.filter((id) => selectedCount(id) > 0);
    if (selected.length > 0) {
      const best = [...selected].sort(
        (a, b) =>
          selectedCount(b) - selectedCount(a) ||
          rankOf(a) - rankOf(b) ||
          depthOf(b) - depthOf(a) ||
          compareIds(a, b),
      )[0];
      return { id: best, rule: "selection" };
    }
    const scored = candidates.filter((id) => scoreCount(id) > 0);
    if (scored.length > 0) {
      const best = [...scored].sort(
        (a, b) =>
          rankOf(a) - rankOf(b) ||
          depthOf(b) - depthOf(a) ||
          compareIds(a, b),
      )[0];
      return { id: best, rule: "score" };
    }
    const best = [...candidates].sort(
      (a, b) => depthOf(b) - depthOf(a) || compareIds(a, b),
    )[0];
    return { id: best, rule: "longest" };
  }

  function walkForward(start: string): { path: string[]; rules: string[] } {
    const walked = [start];
    const visited = new Set([start]);
    const rules: string[] = [];
    let current = start;
    for (;;) {
      const kids = (contentChildren.get(current) ?? []).filter(
        (k) => !visited.has(k),
      );
      if (kids.length === 0) break;
      const pick = pickChild(kids);
      rules.push(pick.rule);
      walked.push(pick.id);
      visited.add(pick.id);
      current = pick.id;
    }
    return { path: walked, rules };
  }

  const roots = contentIds.filter(
    (id) => nodes.get(id)!.event.parents.length === 0,
  );
  const detachedHeads = contentIds.filter((id) => {
    const node = nodes.get(id)!;
    return (
      node.event.parents.length > 0 &&
      node.event.parents.every((p) => !nodes.has(p))
    );
  });

  let mainPath: string[] = [];
  let ruleUsed = "only";
  if (opts.head !== undefined) {
    if (!nodes.has(opts.head)) {
      throw new Error(
        `lync markdown: head override ${opts.head} is not a view-eligible event`,
      );
    }
    const transcript = lyncTranscriptView(result, opts.head);
    mainPath = transcript.entries.map((e) => e.id);
    ruleUsed = "override";
  } else {
    const startCandidates =
      roots.length > 0
        ? roots
        : detachedHeads.length > 0
          ? detachedHeads
          : contentIds.slice(0, 1);
    if (startCandidates.length > 0) {
      const rootPick = pickChild(startCandidates);
      const walk = walkForward(rootPick.id);
      mainPath = walk.path;
      const rules = [rootPick.rule, ...walk.rules].filter((r) => r !== "only");
      ruleUsed =
        RULE_PRIORITY.find((r) => rules.includes(r)) ??
        (mainPath.length > 0 ? "only" : "only");
    }
  }
  const headId = mainPath.length > 0 ? mainPath[mainPath.length - 1] : null;
  const mainTranscript =
    headId !== null ? lyncTranscriptView(result, headId) : null;
  const mainStepById = new Map(mainPath.map((id, i) => [id, i + 1]));

  /* ---- annotation attachment maps --------------------------------------- */
  const genericByTarget = new Map<string, string[]>();
  const ignoredByTarget = new Map<string, string[]>();
  const suppressorsByTarget = new Map<string, string[]>();
  for (const id of allIds) {
    const node = nodes.get(id)!;
    const ev = node.event;
    if (ev.critical === true) {
      for (const target of ev.parents) {
        const list = suppressorsByTarget.get(target) ?? [];
        list.push(id);
        suppressorsByTarget.set(target, list);
      }
    }
    if (ev.kind !== "lync/annotation" || node.payloadSuppressed) continue;
    const label = ev.payload["label"];
    const bucket = ignoredAnnotations.has(id)
      ? ignoredByTarget
      : label === "score" || label === "selection"
        ? null // interpreted by the leaderboard view; rendered from its refs
        : genericByTarget;
    if (!bucket) continue;
    for (const target of ev.parents) {
      const list = bucket.get(target) ?? [];
      list.push(id);
      bucket.set(target, list);
    }
  }
  for (const list of genericByTarget.values()) list.sort(compareIds);
  for (const list of ignoredByTarget.values()) list.sort(compareIds);
  for (const list of suppressorsByTarget.values()) list.sort(compareIds);

  /* ---- renderers --------------------------------------------------------- */
  const renderedContent = new Set<string>();
  const annotationsRendered = new Set<string>();
  const footnotes: string[][] = [];
  const sections: Section[] = [];
  let footnoteCounter = 0;

  function authorAxes(ev: LyncBranchTreeNode["event"]): string {
    const parts: string[] = [];
    const author = ev.author as Record<string, unknown>;
    if (typeof author.operator === "string") {
      parts.push(`operator: ${author.operator}`);
    }
    if (typeof author.via === "string") parts.push(`via ${author.via}`);
    if (typeof author.imported_by === "string") {
      parts.push(`imported by ${author.imported_by}`);
    }
    if (typeof author.source === "string") {
      parts.push(`source ${author.source}`);
    }
    for (const key of Object.keys(author).sort()) {
      if (["actor", "operator", "via", "imported_by", "source"].includes(key)) {
        continue;
      }
      parts.push(`${key}: ${JSON.stringify(author[key])}`);
    }
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  }

  function attributionLine(node: LyncBranchTreeNode, markers = ""): string {
    const ev = node.event;
    return `**${ev.author.actor}**${authorAxes(ev)} · ${ev.at} · ${inlineCode(shortId(node.id))}${markers}`;
  }

  function basisSuffix(basis: unknown): string {
    if (basis === undefined) return "";
    if (typeof basis === "string") return ` ("${basis}")`;
    return ` (basis: ${JSON.stringify(basis)})`;
  }

  function withheldNote(id: string): string {
    const suppressors = suppressorsByTarget.get(id) ?? [];
    if (suppressors.length === 0) {
      return "*(content withheld — retracted by a critical event not held in this file)*";
    }
    const names = suppressors
      .map((sid) => {
        const kind = nodes.get(sid)?.event.kind;
        const noun = kind === "lync/tombstone" ? "tombstone" : "critical event";
        return `${noun} ${inlineCode(shortId(sid))}`;
      })
      .join(", ");
    return `*(content withheld — retracted by ${names})*`;
  }

  /** Blockquote lines for every annotation attached to `id`. */
  function annotationQuotes(id: string): string[] {
    const quotes: string[] = [];
    const entry = boardById.get(id);
    if (entry) {
      for (const score of [...entry.scores].sort((a, b) =>
        compareIds(a.annotationId, b.annotationId),
      )) {
        annotationsRendered.add(score.annotationId);
        quotes.push(
          `> **score ${score.value}** — ${score.author.actor}, ${score.at}${basisSuffix(score.basis)} · ${inlineCode(shortId(score.annotationId))}`,
        );
      }
      for (const sel of [...entry.selections].sort((a, b) =>
        compareIds(a.annotationId, b.annotationId),
      )) {
        annotationsRendered.add(sel.annotationId);
        const annEvent = nodes.get(sel.annotationId)?.event;
        let alternatives = 0;
        if (annEvent) {
          const chosen = stringSet(annEvent.payload["chosen"]);
          const shown = stringSet(annEvent.payload["shown"]);
          const targets = shown.size > 0 ? shown : new Set(annEvent.parents);
          alternatives = [...targets].filter((t) => !chosen.has(t)).length;
        }
        quotes.push(
          sel.selected
            ? `> **selected** over ${plural(alternatives, "alternative")} — ${sel.author.actor}, ${sel.at}${basisSuffix(sel.basis)} · ${inlineCode(shortId(sel.annotationId))}`
            : `> **shown, not chosen** — ${sel.author.actor}, ${sel.at}${basisSuffix(sel.basis)} · ${inlineCode(shortId(sel.annotationId))}`,
        );
      }
    }
    for (const annId of genericByTarget.get(id) ?? []) {
      annotationsRendered.add(annId);
      const ev = nodes.get(annId)!.event;
      const { label, ...rest } = ev.payload;
      const name = typeof label === "string" ? label : "annotation";
      const restJson =
        Object.keys(rest).length > 0 ? ` · ${inlineCode(JSON.stringify(rest))}` : "";
      quotes.push(
        `> **${name}** — ${ev.author.actor}, ${ev.at}${restJson} · ${inlineCode(shortId(annId))}`,
      );
    }
    for (const annId of ignoredByTarget.get(id) ?? []) {
      annotationsRendered.add(annId);
      const ev = nodes.get(annId)!.event;
      const label =
        typeof ev.payload["label"] === "string" ? ev.payload["label"] : "annotation";
      quotes.push(
        `> **${label} (not interpreted)** — ${ev.author.actor}, ${ev.at} · ${inlineCode(JSON.stringify(ev.payload))} · ${inlineCode(shortId(annId))}`,
      );
    }
    return quotes;
  }

  /** Context notes for a thread that starts mid-history. */
  function startObstacleNotes(id: string): string[] {
    const node = nodes.get(id)!;
    const notes: string[] = [];
    for (const p of node.conflictedParents) {
      notes.push(
        `*Earlier context unavailable due to conflict on ${inlineCode(shortId(p))}; the thread below starts mid-conversation.*`,
      );
    }
    for (const p of node.missingParents) {
      notes.push(
        `*This thread starts mid-conversation; parent ${inlineCode(p.slice(0, 8))}… is not in this file.*`,
      );
    }
    return notes;
  }

  /** Footnote for a single-event alternative; returns the marker. */
  function footnoteSingle(sibId: string): string {
    const label = `alt-${++footnoteCounter}`;
    const node = nodes.get(sibId)!;
    const ev = node.event;
    const lines: string[] = [
      `[^${label}]: Alternative at this point (not taken), by ${ev.author.actor}${authorAxes(ev)}, ${ev.at} · ${inlineCode(shortId(sibId))}:`,
    ];
    if (node.payloadSuppressed) {
      lines.push(`    ${withheldNote(sibId)}`);
    } else if (typeof ev.payload["text"] === "string") {
      const quoted = escapeProse(ev.payload["text"]).split("\n");
      lines.push(`    "${quoted.join("\n    ")}"`);
    } else {
      lines.push(`    ${inlineCode(JSON.stringify(ev.payload))}`);
    }
    for (const quote of annotationQuotes(sibId)) {
      lines.push(`    — ${quote.replace(/^> /, "")}`);
    }
    footnotes.push(lines);
    renderedContent.add(sibId);
    return `[^${label}]`;
  }

  /** Footnote stub for an alternative that heads a deeper subtree. */
  function footnoteStub(sibId: string, alreadyRendered: boolean): string {
    const label = `alt-${++footnoteCounter}`;
    const ev = nodes.get(sibId)!.event;
    footnotes.push([
      alreadyRendered
        ? `[^${label}]: Alternative at this point (not taken), by ${ev.author.actor} — rendered elsewhere in this document as ${inlineCode(shortId(sibId))}.`
        : `[^${label}]: A deeper alternative branch starts here, by ${ev.author.actor} (${plural(depthOf(sibId) + 1, "event")} on its longest path) — see "Not on the main thread", branch ${inlineCode(shortId(sibId))}.`,
    ]);
    return `[^${label}]`;
  }

  /** Render one thread (main or branch section) into `out`. */
  function renderThread(out: string[], threadPath: string[]): void {
    threadPath.forEach((id, i) => {
      const node = nodes.get(id)!;
      let markers = "";
      if (i > 0) {
        const siblings = (contentChildren.get(threadPath[i - 1]) ?? []).filter(
          (s) => s !== id,
        );
        for (const sib of siblings) {
          const sibKids = contentChildren.get(sib) ?? [];
          if (renderedContent.has(sib)) {
            markers += footnoteStub(sib, true);
          } else if (sibKids.length === 0) {
            markers += footnoteSingle(sib);
          } else {
            markers += footnoteStub(sib, false);
            sections.push({
              headId: sib,
              parentId: threadPath[i - 1],
              chosenSiblingId: id,
              kind: "branch",
            });
          }
        }
      }
      out.push(attributionLine(node, markers), "");
      if (node.payloadSuppressed) {
        out.push(withheldNote(id), "");
      } else if (typeof node.event.payload["text"] === "string") {
        out.push(escapeProse(node.event.payload["text"]), "");
      } else {
        out.push(...jsonBlock(node.event.payload), "");
      }
      const quotes = annotationQuotes(id);
      if (quotes.length > 0) out.push(...quotes, "");
      renderedContent.add(id);
    });
  }

  /* ---- document assembly -------------------------------------------------- */
  const title = opts.title ?? files.join(", ");
  const doc: string[] = [`# ${title}`, ""];

  const eligibleEvents = allIds.map((id) => nodes.get(id)!.event);
  const ats = eligibleEvents.map((e) => e.at).sort();
  const contentLeaves = contentIds.filter(
    (id) => (contentChildren.get(id) ?? []).length === 0,
  );
  const otherLeaves = contentLeaves.filter((id) => id !== headId);

  if (headId === null) {
    doc.push(
      `*${plural(allIds.length, "view-eligible event")} across ${plural(result.lines.length, "line")} — nothing renderable as a thread.*`,
      "",
    );
  } else {
    const leafNote =
      otherLeaves.length > 0
        ? `; other leaves: ${otherLeaves
            .slice(0, 6)
            .map((id) => inlineCode(shortId(id)))
            .join(", ")}${otherLeaves.length > 6 ? ` and ${otherLeaves.length - 6} more` : ""}`
        : "";
    doc.push(
      `*${plural(allIds.length, "event")} across ${plural(result.lines.length, "line")} · earliest ${ats[0]} → latest ${ats[ats.length - 1]} · main thread: ${plural(mainPath.length, "step")} to leaf ${inlineCode(shortId(headId))} (${RULE_LABEL[ruleUsed]}${leafNote})*`,
      "",
    );
  }

  doc.push("## Thread", "");
  if (headId === null) {
    doc.push("*No view-eligible events; nothing to render.*", "");
  } else {
    const startNotes = startObstacleNotes(mainPath[0]);
    if (startNotes.length > 0) doc.push(...startNotes, "");
    renderThread(doc, mainPath);
  }

  // Branch sections: forks off rendered threads first (discovery order), then
  // separate roots, then detached heads, then a sweep for anything eligible
  // still unrendered (cycles, children of annotations) — nothing content-like
  // is unreachable from the document.
  for (const rootId of roots) {
    if (!mainStepById.has(rootId)) {
      sections.push({ headId: rootId, parentId: null, chosenSiblingId: null, kind: "root" });
    }
  }
  for (const id of detachedHeads) {
    if (!mainStepById.has(id)) {
      sections.push({ headId: id, parentId: null, chosenSiblingId: null, kind: "detached" });
    }
  }

  const sectionBodies: string[] = [];
  let branchSections = 0;
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    if (renderedContent.has(section.headId)) continue;
    branchSections++;
    const short = inlineCode(shortId(section.headId));
    if (section.kind === "branch" && section.parentId !== null) {
      const step = mainStepById.get(section.parentId);
      const from =
        step !== undefined
          ? `step ${step}`
          : inlineCode(shortId(section.parentId));
      sectionBodies.push(`### Branching from ${from} — branch ${short}`, "");
      if (section.chosenSiblingId !== null) {
        sectionBodies.push(
          `*Not taken; that thread continued with ${inlineCode(shortId(section.chosenSiblingId))}.*`,
          "",
        );
      }
    } else if (section.kind === "root") {
      sectionBodies.push(`### Separate root ${short}`, "");
    } else if (section.kind === "detached") {
      sectionBodies.push(`### Detached thread ${short}`, "");
    } else {
      sectionBodies.push(`### Not reachable from a root ${short}`, "");
    }
    const notes = startObstacleNotes(section.headId);
    if (notes.length > 0) sectionBodies.push(...notes, "");
    renderThread(sectionBodies, walkForward(section.headId).path);
    // sweep continues below; renderThread may have queued nested branches
  }
  // Final sweep: any eligible content event still unrendered gets its own
  // honest section rather than vanishing.
  for (const id of contentIds) {
    if (renderedContent.has(id)) continue;
    branchSections++;
    sectionBodies.push(
      `### Not reachable from a root ${inlineCode(shortId(id))}`,
      "",
    );
    const notes = startObstacleNotes(id);
    if (notes.length > 0) sectionBodies.push(...notes, "");
    renderThread(sectionBodies, walkForward(id).path);
  }

  if (sectionBodies.length > 0) {
    doc.push("## Not on the main thread", "", ...sectionBodies);
  }

  for (const lines of footnotes) doc.push(...lines, "");

  /* ---- diagnostics: says what it dropped ---------------------------------- */
  const classCounts = { accepted: 0, nonconforming: 0, garbage: 0, damaged: 0, "conflict-variant": 0 };
  for (const line of result.lines) classCounts[line.class]++;

  doc.push("## Diagnostics", "");
  doc.push(
    `- ${plural(result.lines.length, "line")}: ${classCounts.accepted} accepted, ${classCounts.nonconforming} nonconforming, ${classCounts.garbage} garbage, ${classCounts.damaged} damaged, ${classCounts["conflict-variant"]} conflict variants.`,
  );
  /* Annotations that never attached to rendered content: their payloads are
     shown below, never dropped (export pact: the projection says what it
     could not place). */
  const unattachedAnnotationIds = allIds.filter((id) => {
    const node = nodes.get(id)!;
    return (
      node.event.kind === "lync/annotation" &&
      !node.payloadSuppressed &&
      !annotationsRendered.has(id)
    );
  });

  const cleanGraph =
    result.graphDiagnostics.length === 0 &&
    result.conflictIds.length === 0 &&
    classCounts.garbage === 0 &&
    classCounts.damaged === 0 &&
    classCounts.nonconforming === 0 &&
    board.ignoredAnnotationIds.length === 0 &&
    unattachedAnnotationIds.length === 0 &&
    result.pendingOverflowCount === 0;
  if (cleanGraph) {
    doc.push("- No dangling parents, cycles, or conflicts on the rendered threads.");
  }
  for (const line of result.lines) {
    if (line.class === "damaged") {
      doc.push(
        `- **Damaged** ${inlineCode(`${line.file}:${line.line}`)} — ${line.reason}; this line is someone's copy of an event and is excluded from the views above.`,
      );
    } else if (line.class === "garbage") {
      doc.push(`- **Garbage** ${inlineCode(`${line.file}:${line.line}`)} — ${line.reason}.`);
    } else if (line.class === "nonconforming") {
      doc.push(
        `- **Nonconforming** ${inlineCode(`${line.file}:${line.line}`)} — ${line.reason} (still shown above).`,
      );
    }
  }
  for (const conflictId of [...result.conflictIds].sort(compareIds)) {
    const variants = result.conflictVariants.filter((v) => v.id === conflictId);
    doc.push(
      `- **Conflict** on id ${inlineCode(conflictId)}: ${plural(variants.length, "variant")} seen; none is shown above.`,
    );
  }
  for (const obstacle of result.graphDiagnostics) {
    if (obstacle.class === "dangling") {
      doc.push(
        `- **Missing parent** ${inlineCode(obstacle.missing ?? "unknown")} — referenced but not in this file.`,
      );
    } else if (obstacle.class === "cycle") {
      doc.push(
        `- **Cycle** through ${(obstacle.ids ?? []).map((id) => inlineCode(shortId(id))).join(", ")} — ancestry is not well-founded.`,
      );
    } else {
      doc.push(
        `- **Unavailable due to conflict**: ${inlineCode(obstacle.id ?? obstacle.missing ?? "unknown")}.`,
      );
    }
  }
  for (const annId of board.ignoredAnnotationIds) {
    doc.push(
      `- **Annotation not interpreted** ${inlineCode(shortId(annId))} — malformed score/selection payload; shown verbatim where its target is rendered.`,
    );
  }
  for (const annId of unattachedAnnotationIds) {
    const ev = nodes.get(annId)!.event;
    const label = typeof ev.payload["label"] === "string" ? ev.payload["label"] : "annotation";
    const targets =
      ev.parents.length > 0
        ? `on ${ev.parents.map((p) => inlineCode(shortId(p))).join(", ")} (not rendered above)`
        : "with no target";
    doc.push(
      `- **Annotation on unrendered target** ${inlineCode(shortId(annId))} — **${label}** by ${ev.author.actor}, ${ev.at}, ${targets}: ${inlineCode(JSON.stringify(ev.payload))}`,
    );
  }
  if (suppressedIds.size > 0) {
    doc.push(
      `- **Withheld** ${[...suppressedIds].sort(compareIds).map((id) => inlineCode(shortId(id))).join(", ")} — payload suppressed by a critical retraction; envelope shown above.`,
    );
  }
  if (result.pendingOverflowCount > 0) {
    doc.push(
      `- **Pending overflow**: ${result.pendingOverflowCount} buffered lines were dropped by the reader's cap; this document is partial.`,
    );
  }
  doc.push("");

  /* ---- id table: full ids for every view-eligible event ------------------- */
  doc.push(
    "<details>",
    `<summary>Event ids (${plural(allIds.length, "view-eligible event")})</summary>`,
    "",
    "| short | kind | actor | at | full id |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const id of allIds) {
    const ev = nodes.get(id)!.event;
    doc.push(
      `| ${inlineCode(shortId(id))} | ${escapeTableCell(ev.kind)} | ${escapeTableCell(ev.author.actor)} | ${ev.at} | ${inlineCode(id)} |`,
    );
  }
  doc.push("", "</details>", "");

  const markdown = doc.join("\n");
  const stats: LyncMarkdownStats = {
    files,
    lines_total: result.lines.length,
    accepted: classCounts.accepted,
    nonconforming: classCounts.nonconforming,
    garbage: classCounts.garbage,
    damaged: classCounts.damaged,
    conflict_variants: classCounts["conflict-variant"],
    view_eligible: allIds.length,
    suppressed_payloads: suppressedIds.size,
    thread_steps: mainPath.length,
    footnote_alternatives: footnoteCounter,
    branch_sections: branchSections,
    annotations_rendered: annotationsRendered.size,
    annotations_ignored: board.ignoredAnnotationIds.length,
    annotations_unattached: unattachedAnnotationIds.length,
    events_rendered: renderedContent.size,
    obstacles: result.graphDiagnostics.length,
    partial:
      tree.partial ||
      (mainTranscript?.partial ?? false) ||
      result.pendingOverflowCount > 0,
  };

  return { markdown, headId, mainThread: mainPath, rule: RULE_LABEL[ruleUsed], stats };
}

/* ------------------------------ File conversion ---------------------------- */

/**
 * End-to-end: read one `.lync` file, render the markdown projection, write it.
 * The parse is keyed by the file's basename so diagnostics (and therefore the
 * document bytes) do not depend on where the file happens to live.
 */
export async function convertLyncToMarkdown(
  inputPath: string,
  outputPath: string,
  opts: LyncMarkdownOptions = {},
): Promise<LyncMarkdownConversion> {
  const bytes = await fs.readFile(inputPath);
  const result = parseLyncFiles([{ file: path.basename(inputPath), bytes }]);
  const render = renderLyncMarkdown(result, {
    title: opts.title ?? path.basename(inputPath),
    head: opts.head,
  });
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, render.markdown, "utf8");
  return { outputPath, ...render };
}
