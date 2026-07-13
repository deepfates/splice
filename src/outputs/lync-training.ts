/**
 * lync → training data (dee-lqk3): SFT rows + DPO-style preference pairs.
 *
 * This is an EXPORTER under lync/pacts/export.md: a projection of the event
 * log. It never mints new truth — every number and every string in a row is
 * read from events; every exclusion is counted and reported; a partial walk
 * is refused loudly rather than emitted quietly wrong.
 *
 * THE FLASHCARD RULE (owner ruling 2026-07-12): the canonical SFT row is
 * ATTRIBUTED SEGMENTS. `prompt` is an ordered array of
 * {actor, via, text, event_id}; `completion` is one such segment plus weight
 * and provenance. Plain-string and chat-messages renderings are DERIVED from
 * the canonical row deterministically at write time (join texts; or map
 * actors to roles) and offered as render options, never as the stored truth:
 * strip the name tags and you cannot get them back.
 *
 * Who is the model? The completion event's actor is the voice being trained
 * (name tag on the BACK of the card). The messages rendering maps segments
 * whose actor equals the completion's actor to "assistant" and everything
 * else to "user"; the canonical row keeps the real names.
 *
 * Row sources (owner rulings, superseding the older spec where they differ):
 * - Scored events become SFT rows: weight = score mean (recomputed by summing
 *   in sorted-annotation-id order so float addition order is pinned).
 * - Selected events become SFT rows even when unscored: an explicit selection
 *   is the strongest signal. Their weight is null — the file carries no
 *   number, and an exporter never invents one; selection provenance rides in
 *   meta for the trainer to weigh.
 * - Preference pairs: for each selection annotation, chosen × (shown −
 *   chosen), both sides eligible artifacts sharing the same first parent.
 *
 * Eligibility (both outputs) starts from view-eligible events (accepted +
 * nonconforming, minus conflict variants, critical suppression applied) and
 * further excludes — dropped AND counted, never silent:
 * - suppressed payloads (tombstoned), as completion OR anywhere on the
 *   assembled context path (a prompt with a silent hole misrepresents what
 *   the model saw);
 * - `no-train` targets, as completion or in the assembled prompt text;
 * - rows whose context walk is partial (dangling parent, cycle,
 *   unavailable-due-to-conflict).
 *
 * Determinism: same input bytes (in any line order) → byte-identical output
 * files. All iteration is in sorted-id order, JSON keys are emitted in fixed
 * order, no wall clock appears anywhere in rows or stats.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseLyncFiles } from "@deepfates/lync/events";
import type {
  LyncEventBody,
  LyncLineDiagnostic,
  LyncObstacle,
  LyncParseResult,
} from "@deepfates/lync/events";
import { lyncLeaderboardView, lyncTranscriptView } from "@deepfates/lync/views";
import type { LyncLeaderboardEntry, LyncScoreReference } from "@deepfates/lync/views";

/* --------------------------------- Types ---------------------------------- */

/** One attributed segment: the name tag stays on the text. */
export interface LyncTrainingSegment {
  /** The voice that produced this text (author.actor, verbatim). */
  actor: string;
  /** The mediating tool (author.via), null when the event carries none. */
  via: string | null;
  text: string;
  event_id: string;
}

export interface LyncSftRowMeta {
  source_event: string;
  /** Ids of the prompt segments, in prompt order. */
  context_events: string[];
  /** Sorted ids of the score annotations aggregated into weight. */
  score_events: string[];
  score_count: number;
  /** Sorted ids of the selection annotations that showed this event. */
  selection_events: string[];
  selection_count: number;
  selected_count: number;
  at: string;
  /** Sorted source file paths that contributed any event in this row. */
  files: string[];
}

/** Canonical SFT row: attributed segments, weight, provenance. */
export interface LyncSftRow {
  prompt: LyncTrainingSegment[];
  completion: LyncTrainingSegment;
  /** Score mean, verbatim scale; null for selection-only rows (no number in the file). */
  weight: number | null;
  meta: LyncSftRowMeta;
}

export interface LyncPreferenceRowMeta {
  selection_event: string;
  chosen_event: string;
  rejected_event: string;
  context_events: string[];
  /** The selection annotation's whole author object, verbatim (axes stay axes). */
  judge: LyncEventBody["author"];
  basis?: unknown;
  chosen_score_mean: number | null;
  rejected_score_mean: number | null;
  files: string[];
}

/** Canonical preference pair: attributed segments on all three faces. */
export interface LyncPreferenceRow {
  prompt: LyncTrainingSegment[];
  chosen: LyncTrainingSegment;
  rejected: LyncTrainingSegment;
  meta: LyncPreferenceRowMeta;
}

export type LyncSftSkipCategory =
  | "ineligible"
  | "suppressed"
  | "no_train"
  | "partial_context";

export type LyncPairSkipCategory =
  | "ineligible"
  | "no_train"
  | "context_mismatch"
  | "partial_context";

/** One SFT candidate that did not become a row — explicit, never silent. */
export interface LyncSftSkip {
  event_id: string;
  category: LyncSftSkipCategory;
  reason: string;
  /** Ids of the events that caused the skip (tombstones, no-train annotations). */
  by: string[];
}

/** One preference pair that did not become a row — explicit, never silent. */
export interface LyncPairSkip {
  selection_event: string;
  chosen_event: string;
  rejected_event: string;
  category: LyncPairSkipCategory;
  reason: string;
  by: string[];
}

export interface LyncTrainingStats {
  files: string[];
  lines_total: number;
  accepted: number;
  nonconforming: number;
  garbage: number;
  damaged: number;
  conflict_variants: number;
  view_eligible: number;
  suppressed_payloads: number;
  sft_rows: number;
  sft_skipped_ineligible: number;
  sft_skipped_suppressed: number;
  sft_skipped_no_train: number;
  sft_skipped_partial_context: number;
  preference_rows: number;
  pairs_skipped_ineligible: number;
  pairs_skipped_no_train: number;
  pairs_skipped_context_mismatch: number;
  pairs_skipped_partial_context: number;
  annotations_ignored: number;
  obstacles: LyncObstacle[];
  /** Envelope-level provenance for every exclusion. Nothing is invisible. */
  detail: {
    sft_skips: LyncSftSkip[];
    pair_skips: LyncPairSkip[];
    ignored_annotation_ids: string[];
    suppressed_payload_ids: string[];
  };
}

export interface LyncTrainingResult {
  sftRows: LyncSftRow[];
  preferenceRows: LyncPreferenceRow[];
  stats: LyncTrainingStats;
}

/* ------------------------------- Internals -------------------------------- */

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface EligibleEvent {
  id: string;
  event: LyncEventBody;
  line: LyncLineDiagnostic;
  payloadSuppressed: boolean;
}

/** First held line per view-eligible id (mirrors views.ts eligibleEventIndex). */
function eligibleIndex(result: LyncParseResult): Map<string, EligibleEvent> {
  const eligible = new Set(result.viewEligibleIds);
  const suppressed = new Set(result.suppression.suppressedPayloadIds);
  const index = new Map<string, EligibleEvent>();
  for (const line of result.lines) {
    if (!line.id || !line.event || !eligible.has(line.id) || index.has(line.id)) {
      continue;
    }
    index.set(line.id, {
      id: line.id,
      event: line.event,
      line,
      payloadSuppressed: suppressed.has(line.id),
    });
  }
  return index;
}

/** An artifact for training purposes: any eligible event with string payload.text. */
function artifactText(ev: EligibleEvent): string | undefined {
  const text = ev.event.payload["text"];
  return typeof text === "string" ? text : undefined;
}

function toSegment(ev: EligibleEvent, text: string): LyncTrainingSegment {
  const via = ev.event.author["via"];
  return {
    actor: ev.event.author.actor,
    via: typeof via === "string" && via.length > 0 ? via : null,
    text,
    event_id: ev.id,
  };
}

/**
 * Sum scores in sorted-annotation-id order so float addition order is pinned
 * (lyncLeaderboardView sums in encounter order, which line order could vary).
 */
function pinnedScoreMean(scores: LyncScoreReference[]): number | null {
  if (scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => compareIds(a.annotationId, b.annotationId));
  let total = 0;
  for (const s of sorted) total += s.value;
  return total / sorted.length;
}

interface AssembledContext {
  segments: LyncTrainingSegment[];
  contextIds: string[];
  partial: boolean;
  /** Ids of walked-path entries whose payload is suppressed. */
  suppressedOnPath: string[];
}

/**
 * Assemble the prompt for a completion whose first parent is `head` (or no
 * parent: empty context). The walk is the library's own deterministic
 * candidates[0] transcript walk; entries without string text (annotations,
 * pointers, tool records) are not prompt text and are skipped without error.
 */
function assembleContext(
  result: LyncParseResult,
  index: Map<string, EligibleEvent>,
  head: string | undefined,
): AssembledContext {
  if (head === undefined) {
    return { segments: [], contextIds: [], partial: false, suppressedOnPath: [] };
  }
  const view = lyncTranscriptView(result, head);
  const segments: LyncTrainingSegment[] = [];
  const contextIds: string[] = [];
  const suppressedOnPath: string[] = [];
  for (const entry of view.entries) {
    const ev = index.get(entry.id);
    if (!ev) continue;
    if (ev.payloadSuppressed) {
      suppressedOnPath.push(ev.id);
      continue;
    }
    const text = artifactText(ev);
    if (text === undefined) continue;
    segments.push(toSegment(ev, text));
    contextIds.push(ev.id);
  }
  return { segments, contextIds, partial: view.partial, suppressedOnPath };
}

/** no-train targets: target id → sorted ids of the no-train annotations. */
function noTrainTargets(index: Map<string, EligibleEvent>): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const id of [...index.keys()].sort(compareIds)) {
    const ev = index.get(id)!;
    if (ev.event.kind !== "lync/annotation" || ev.payloadSuppressed) continue;
    if (ev.event.payload["label"] !== "no-train") continue;
    for (const parent of ev.event.parents) {
      const list = targets.get(parent) ?? [];
      if (!list.includes(id)) list.push(id);
      targets.set(parent, list);
    }
  }
  return targets;
}

/** Tombstone provenance: accepted critical events whose parents include `target`. */
function tombstonesFor(index: Map<string, EligibleEvent>, target: string): string[] {
  const ids: string[] = [];
  for (const ev of index.values()) {
    if (ev.event.critical === true && ev.event.parents.includes(target)) {
      ids.push(ev.id);
    }
  }
  return ids.sort(compareIds);
}

/** file paths (first-held-line) contributing any of the given event ids. */
function filesForIds(
  index: Map<string, EligibleEvent>,
  ids: Iterable<string>,
): string[] {
  const files = new Set<string>();
  for (const id of ids) {
    const ev = index.get(id);
    if (ev) files.add(ev.line.file);
  }
  return [...files].sort();
}

function stringSetSorted(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string"))].sort(
    compareIds,
  );
}

/* -------------------------------- Projection ------------------------------- */

/**
 * Project a parsed lync event set into canonical SFT rows and preference
 * pairs. Pure: no filesystem, no clock, no RNG. Same LyncParseResult in
 * (regardless of line order), same rows out.
 */
export function lyncToTrainingData(result: LyncParseResult): LyncTrainingResult {
  const index = eligibleIndex(result);
  const leaderboard = lyncLeaderboardView(result);
  const noTrain = noTrainTargets(index);
  const entriesById = new Map<string, LyncLeaderboardEntry>(
    leaderboard.entries.map((e) => [e.targetId, e]),
  );

  const sftRows: LyncSftRow[] = [];
  const sftSkips: LyncSftSkip[] = [];
  const skip = (
    event_id: string,
    category: LyncSftSkipCategory,
    reason: string,
    by: string[] = [],
  ) => {
    sftSkips.push({ event_id, category, reason, by });
  };

  /* ------------------------------- SFT rows ------------------------------- */

  const candidates = leaderboard.entries
    .filter((e) => e.scoreCount > 0 || e.selectedCount > 0)
    .sort((a, b) => compareIds(a.targetId, b.targetId));

  for (const entry of candidates) {
    const id = entry.targetId;
    const ev = index.get(id);
    if (!ev) {
      skip(
        id,
        "ineligible",
        "target is not view-eligible (missing, damaged, garbage, or a same-id conflict variant)",
      );
      continue;
    }
    if (ev.payloadSuppressed) {
      skip(
        id,
        "suppressed",
        "completion payload suppressed by tombstone",
        tombstonesFor(index, id),
      );
      continue;
    }
    const text = artifactText(ev);
    if (text === undefined) {
      skip(id, "ineligible", "target has no string payload.text (not an artifact)");
      continue;
    }
    if (noTrain.has(id)) {
      skip(id, "no_train", "completion is a no-train target", noTrain.get(id)!);
      continue;
    }
    const ctx = assembleContext(result, index, ev.event.parents[0]);
    if (ctx.partial) {
      skip(
        id,
        "partial_context",
        "context walk is partial (dangling parent, cycle, or unavailable-due-to-conflict)",
      );
      continue;
    }
    if (ctx.suppressedOnPath.length > 0) {
      skip(
        id,
        "suppressed",
        "context contains suppressed payloads; refusing to emit a prompt with silent holes",
        ctx.suppressedOnPath.flatMap((s) => tombstonesFor(index, s)).sort(compareIds),
      );
      continue;
    }
    const noTrainInContext = ctx.contextIds.filter((c) => noTrain.has(c));
    if (noTrainInContext.length > 0) {
      skip(
        id,
        "no_train",
        "context contains no-train targets",
        noTrainInContext.flatMap((c) => noTrain.get(c)!).sort(compareIds),
      );
      continue;
    }

    const scoreEvents = entry.scores.map((s) => s.annotationId).sort(compareIds);
    const selectionEvents = [
      ...new Set(entry.selections.map((s) => s.annotationId)),
    ].sort(compareIds);
    sftRows.push({
      prompt: ctx.segments,
      completion: toSegment(ev, text),
      weight: pinnedScoreMean(entry.scores),
      meta: {
        source_event: id,
        context_events: ctx.contextIds,
        score_events: scoreEvents,
        score_count: entry.scoreCount,
        selection_events: selectionEvents,
        selection_count: entry.selectionCount,
        selected_count: entry.selectedCount,
        at: ev.event.at,
        files: filesForIds(index, [id, ...ctx.contextIds, ...scoreEvents, ...selectionEvents]),
      },
    });
  }

  /* --------------------------- Preference pairs --------------------------- */

  const preferenceRows: LyncPreferenceRow[] = [];
  const pairSkips: LyncPairSkip[] = [];
  const ignored = new Set(leaderboard.ignoredAnnotationIds);

  for (const annotationId of [...index.keys()].sort(compareIds)) {
    const annotation = index.get(annotationId)!;
    if (annotation.event.kind !== "lync/annotation" || annotation.payloadSuppressed) {
      continue;
    }
    if (annotation.event.payload["label"] !== "selection") continue;
    // Malformed selections (empty chosen/shown) are the leaderboard's
    // ignoredAnnotationIds — counted under annotations_ignored, never guessed.
    if (ignored.has(annotationId)) continue;

    const chosen = stringSetSorted(annotation.event.payload["chosen"]);
    const shownRaw = stringSetSorted(annotation.event.payload["shown"]);
    const shown =
      shownRaw.length > 0
        ? shownRaw
        : [...new Set(annotation.event.parents)].sort(compareIds);
    const chosenSet = new Set(chosen);
    const rejected = shown.filter((s) => !chosenSet.has(s));

    for (const c of chosen) {
      for (const r of rejected) {
        const skipPair = (
          category: LyncPairSkipCategory,
          reason: string,
          by: string[] = [],
        ) => {
          pairSkips.push({
            selection_event: annotationId,
            chosen_event: c,
            rejected_event: r,
            category,
            reason,
            by,
          });
        };
        const cEv = index.get(c);
        const rEv = index.get(r);
        if (!cEv || !rEv) {
          skipPair(
            "ineligible",
            `${!cEv ? "chosen" : "rejected"} event is not view-eligible (missing, damaged, garbage, or a same-id conflict variant)`,
          );
          continue;
        }
        if (cEv.payloadSuppressed || rEv.payloadSuppressed) {
          const suppressedId = cEv.payloadSuppressed ? c : r;
          skipPair(
            "ineligible",
            `${cEv.payloadSuppressed ? "chosen" : "rejected"} payload suppressed by tombstone`,
            tombstonesFor(index, suppressedId),
          );
          continue;
        }
        const cText = artifactText(cEv);
        const rText = artifactText(rEv);
        if (cText === undefined || rText === undefined) {
          skipPair(
            "ineligible",
            `${cText === undefined ? "chosen" : "rejected"} event has no string payload.text (not an artifact)`,
          );
          continue;
        }
        const noTrainHits = [c, r].filter((id) => noTrain.has(id));
        if (noTrainHits.length > 0) {
          skipPair(
            "no_train",
            "chosen or rejected is a no-train target",
            noTrainHits.flatMap((id) => noTrain.get(id)!).sort(compareIds),
          );
          continue;
        }
        const cHead = cEv.event.parents[0];
        const rHead = rEv.event.parents[0];
        if ((cHead ?? null) !== (rHead ?? null)) {
          skipPair(
            "context_mismatch",
            "chosen and rejected do not share the same first parent; a preference between completions of different prompts is not a DPO pair",
          );
          continue;
        }
        const ctx = assembleContext(result, index, cHead);
        if (ctx.partial) {
          skipPair(
            "partial_context",
            "context walk is partial (dangling parent, cycle, or unavailable-due-to-conflict)",
          );
          continue;
        }
        if (ctx.suppressedOnPath.length > 0) {
          skipPair(
            "ineligible",
            "context contains suppressed payloads; refusing to emit a prompt with silent holes",
            ctx.suppressedOnPath
              .flatMap((s) => tombstonesFor(index, s))
              .sort(compareIds),
          );
          continue;
        }
        const noTrainInContext = ctx.contextIds.filter((id) => noTrain.has(id));
        if (noTrainInContext.length > 0) {
          skipPair(
            "no_train",
            "context contains no-train targets",
            noTrainInContext.flatMap((id) => noTrain.get(id)!).sort(compareIds),
          );
          continue;
        }

        const basis = annotation.event.payload["basis"];
        const meta: LyncPreferenceRowMeta = {
          selection_event: annotationId,
          chosen_event: c,
          rejected_event: r,
          context_events: ctx.contextIds,
          judge: annotation.event.author,
          ...(basis !== undefined ? { basis } : {}),
          chosen_score_mean: pinnedScoreMean(entriesById.get(c)?.scores ?? []),
          rejected_score_mean: pinnedScoreMean(entriesById.get(r)?.scores ?? []),
          files: filesForIds(index, [annotationId, c, r, ...ctx.contextIds]),
        };
        preferenceRows.push({
          prompt: ctx.segments,
          chosen: toSegment(cEv, cText),
          rejected: toSegment(rEv, rText),
          meta,
        });
      }
    }
  }

  /* --------------------------------- Stats -------------------------------- */

  const byClass = { accepted: 0, nonconforming: 0, garbage: 0, damaged: 0, "conflict-variant": 0 };
  for (const line of result.lines) byClass[line.class] += 1;

  const countCategory = (skips: { category: string }[], category: string) =>
    skips.filter((s) => s.category === category).length;

  const stats: LyncTrainingStats = {
    files: [...new Set(result.lines.map((l) => l.file))].sort(),
    lines_total: result.lines.length,
    accepted: byClass.accepted,
    nonconforming: byClass.nonconforming,
    garbage: byClass.garbage,
    damaged: byClass.damaged,
    conflict_variants: byClass["conflict-variant"],
    view_eligible: result.viewEligibleIds.length,
    suppressed_payloads: result.suppression.suppressedPayloadIds.length,
    sft_rows: sftRows.length,
    sft_skipped_ineligible: countCategory(sftSkips, "ineligible"),
    sft_skipped_suppressed: countCategory(sftSkips, "suppressed"),
    sft_skipped_no_train: countCategory(sftSkips, "no_train"),
    sft_skipped_partial_context: countCategory(sftSkips, "partial_context"),
    preference_rows: preferenceRows.length,
    pairs_skipped_ineligible: countCategory(pairSkips, "ineligible"),
    pairs_skipped_no_train: countCategory(pairSkips, "no_train"),
    pairs_skipped_context_mismatch: countCategory(pairSkips, "context_mismatch"),
    pairs_skipped_partial_context: countCategory(pairSkips, "partial_context"),
    annotations_ignored: leaderboard.ignoredAnnotationIds.length,
    obstacles: result.graphDiagnostics,
    detail: {
      sft_skips: sftSkips,
      pair_skips: pairSkips,
      ignored_annotation_ids: leaderboard.ignoredAnnotationIds,
      suppressed_payload_ids: [...result.suppression.suppressedPayloadIds],
    },
  };

  // Reconciliation invariant: every SFT candidate became a row or a skip.
  if (sftRows.length + sftSkips.length !== candidates.length) {
    throw new Error(
      `lync training: SFT counts do not reconcile: ${sftRows.length} rows + ${sftSkips.length} skips !== ${candidates.length} candidates`,
    );
  }

  return { sftRows, preferenceRows, stats };
}

/* -------------------------------- Renderings ------------------------------- */

/**
 * Derived renderings of the canonical rows. One deterministic step, applied
 * at write time, never stored as the source of truth: the plain rendering
 * joins texts with "\n\n" (name tags stripped — recoverable only because the
 * canonical row keeps them); the messages rendering maps actors to ChatML
 * roles, where the completion's actor (the voice being trained) is
 * "assistant" and every other actor is "user".
 */
export type LyncTrainingRendering = "plain" | "messages";

export interface LyncSftPlainRow {
  prompt: string;
  completion: string;
  weight: number | null;
  meta: LyncSftRowMeta;
}

export interface LyncChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LyncSftMessagesRow {
  messages: LyncChatMessage[];
  weight: number | null;
  meta: LyncSftRowMeta;
}

export interface LyncPreferencePlainRow {
  prompt: string;
  chosen: string;
  rejected: string;
  meta: LyncPreferenceRowMeta;
}

export interface LyncPreferenceMessagesRow {
  messages: LyncChatMessage[];
  chosen: string;
  rejected: string;
  meta: LyncPreferenceRowMeta;
}

export function joinSegmentTexts(segments: LyncTrainingSegment[]): string {
  return segments.map((s) => s.text).join("\n\n");
}

export function sftRowToPlain(row: LyncSftRow): LyncSftPlainRow {
  return {
    prompt: joinSegmentTexts(row.prompt),
    completion: row.completion.text,
    weight: row.weight,
    meta: row.meta,
  };
}

export function sftRowToMessages(row: LyncSftRow): LyncSftMessagesRow {
  return {
    messages: [
      ...row.prompt.map(
        (s): LyncChatMessage => ({
          role: s.actor === row.completion.actor ? "assistant" : "user",
          content: s.text,
        }),
      ),
      { role: "assistant", content: row.completion.text },
    ],
    weight: row.weight,
    meta: row.meta,
  };
}

export function preferenceRowToPlain(row: LyncPreferenceRow): LyncPreferencePlainRow {
  return {
    prompt: joinSegmentTexts(row.prompt),
    chosen: row.chosen.text,
    rejected: row.rejected.text,
    meta: row.meta,
  };
}

/** Roles keyed to the CHOSEN side's actor: the liked response is the voice being trained. */
export function preferenceRowToMessages(
  row: LyncPreferenceRow,
): LyncPreferenceMessagesRow {
  return {
    messages: row.prompt.map(
      (s): LyncChatMessage => ({
        role: s.actor === row.chosen.actor ? "assistant" : "user",
        content: s.text,
      }),
    ),
    chosen: row.chosen.text,
    rejected: row.rejected.text,
    meta: row.meta,
  };
}

/* ------------------------------ Write + wire ------------------------------- */

export function rowsToJsonl(rows: unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

export interface LyncTrainingConvertOptions {
  /**
   * Derived renderings to write beside the canonical files:
   * "plain" → sft.plain.jsonl / preferences.plain.jsonl,
   * "messages" → sft.messages.jsonl / preferences.messages.jsonl.
   */
  renderings?: LyncTrainingRendering[];
}

export interface LyncTrainingConversion {
  outDir: string;
  /** Every file written, sorted, relative to outDir. */
  written: string[];
  stats: LyncTrainingStats;
  sftRows: LyncSftRow[];
  preferenceRows: LyncPreferenceRow[];
}

/**
 * End-to-end: read one or more `.lync` files (merged by union via
 * parseLyncFiles), project to training rows, and write `sft.jsonl`,
 * `preferences.jsonl`, and `stats.json` (plus any requested renderings) to
 * `outDir`. An unreadable input file is a loud error, never a silent skip;
 * malformed lines inside readable files are classified and counted by the
 * parser and reported in stats.
 */
export async function convertLyncToTrainingData(
  inputPaths: string[],
  outDir: string,
  opts?: LyncTrainingConvertOptions,
): Promise<LyncTrainingConversion> {
  if (inputPaths.length === 0) {
    throw new Error("lync training: no input files given");
  }
  const inputs: { file: string; bytes: Uint8Array }[] = [];
  for (const file of [...inputPaths].sort()) {
    inputs.push({ file, bytes: await fs.readFile(file) });
  }
  const result = parseLyncFiles(inputs);
  const training = lyncToTrainingData(result);

  await fs.mkdir(path.resolve(outDir), { recursive: true });
  const written: string[] = [];
  const write = async (name: string, content: string) => {
    await fs.writeFile(path.join(outDir, name), content, "utf8");
    written.push(name);
  };

  await write("sft.jsonl", rowsToJsonl(training.sftRows));
  await write("preferences.jsonl", rowsToJsonl(training.preferenceRows));
  for (const rendering of [...new Set(opts?.renderings ?? [])].sort()) {
    if (rendering === "plain") {
      await write("sft.plain.jsonl", rowsToJsonl(training.sftRows.map(sftRowToPlain)));
      await write(
        "preferences.plain.jsonl",
        rowsToJsonl(training.preferenceRows.map(preferenceRowToPlain)),
      );
    } else if (rendering === "messages") {
      await write(
        "sft.messages.jsonl",
        rowsToJsonl(training.sftRows.map(sftRowToMessages)),
      );
      await write(
        "preferences.messages.jsonl",
        rowsToJsonl(training.preferenceRows.map(preferenceRowToMessages)),
      );
    }
  }
  await write("stats.json", `${JSON.stringify(training.stats, null, 2)}\n`);

  return {
    outDir,
    written: written.sort(),
    stats: training.stats,
    sftRows: training.sftRows,
    preferenceRows: training.preferenceRows,
  };
}
