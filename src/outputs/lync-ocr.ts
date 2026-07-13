/**
 * OCR text page sets → lync (dee-b8zk).
 *
 * Source shape (deep-space/data/signal-ocr): a directory of page files
 * `page-NNN.txt` (OCR'd text) with optional `page-NNN.desc.txt` sidecars
 * (visual description of the page), plus optional combined `*.md` documents.
 *
 * Event mapping:
 * - 1 `ocr/set` event per directory: the set-level anchor. Payload carries the
 *   set locator, page count, page-number range, gaps, and file inventory.
 * - 1 `ocr/page` event per page NUMBER: payload carries the OCR text, the
 *   matching description sidecar (when present), the page number, byte sizes,
 *   and the source file names. The first page parents to the set event; page N
 *   parents to the previous page event (ordering-as-parents, same convention
 *   as glowfic posts).
 * - 1 `ocr/document` event per combined markdown file, parented to the set.
 *
 * Fleet author-envelope convention (dee-mb0n): actor = "ocr" (the OCR process
 * is the source identity; override via opts.actor when the tool is known),
 * operator = "deepfates", imported_by = "splice/ocr-text-import@0.1" — the
 * importer is NEVER the actor.
 *
 * Ids are deterministic UUIDv8 from (set locator, page number) so re-imports
 * union as duplicates. The source files carry no timestamps at all, so every
 * event's `at` is a single explicit fallback (opts.markedAt when given, else
 * the epoch) recorded once in stats.atFallback — deterministic, never silent,
 * and never machine-dependent (no mtimes).
 *
 * ZERO SILENT DROPS: every file in the directory is either consumed by an
 * event (page text, description sidecar, document) or lands in an explicit
 * `skipped` entry (unrecognized name, orphan sidecar, duplicate page number).
 * Gaps in page numbering and empty files are surfaced in stats, and the
 * file-accounting invariant is checked loudly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LyncEventBody } from "@deepfates/lync/events";

import {
  DEFAULT_OPERATOR,
  SPLICE_IMPORT_VERSION,
  deterministicLyncId,
  writeLyncFile,
  verifyLyncFile,
  type LyncAuthor,
  type LyncProducerOptions,
  type LyncSkippedRecord,
  type LyncVerifyResult,
} from "./lync.js";

/* --------------------------------- Types ---------------------------------- */

/** One OCR page: text file plus optional description sidecar. */
export interface OcrPage {
  /** Page number parsed from the filename (e.g. 41 from "page-041.txt"). */
  number: number;
  /** Basename of the page text file. */
  textFile: string;
  /** Full OCR text content, preserved verbatim. */
  text: string;
  /** Basename of the description sidecar, when present. */
  descFile: string | null;
  /** Full description content, when present. */
  description: string | null;
}

/** One combined document file (e.g. "signal-ocr-combined.md"). */
export interface OcrDocument {
  file: string;
  text: string;
}

/** The scanned source directory, before mapping to events. */
export interface OcrPageSetScan {
  dir: string;
  /** Pages sorted by page number. */
  pages: OcrPage[];
  /** Combined documents sorted by filename. */
  documents: OcrDocument[];
  /** Every regular file seen in the directory. */
  sourceFiles: number;
  /** Files that could not be consumed — explicit, never silent. */
  skipped: LyncSkippedRecord[];
  /** Page numbers missing between the min and max observed numbers. */
  gaps: number[];
  /** Page numbers whose text file has no description sidecar. */
  missingDescriptions: number[];
  /** Files whose content is empty/whitespace-only (still emitted). */
  emptyFiles: string[];
}

export interface OcrLyncStats {
  sourceFiles: number;
  setEvents: number;
  pageEvents: number;
  documentEvents: number;
  emitted: number;
  skipped: LyncSkippedRecord[];
  gaps: number[];
  missingDescriptions: number[];
  emptyFiles: string[];
  /** The single explicit timestamp fallback: source files carry no timestamps. */
  atFallback: { used: string; reason: string };
}

export interface OcrLyncResult {
  events: LyncEventBody[];
  setEventId: string;
  stats: OcrLyncStats;
}

export interface OcrLyncOptions extends Partial<LyncProducerOptions> {
  /**
   * Stable identity of the page set, used in every deterministic id. Defaults
   * to the directory basename (e.g. "signal-ocr") so ids do not depend on
   * where the checkout lives on disk.
   */
  setLocator?: string;
}

/* ------------------------------ Deterministic ids ------------------------- */

export function ocrSetEventId(setLocator: string): string {
  return deterministicLyncId("ocr", "set", setLocator);
}

export function ocrPageEventId(
  setLocator: string,
  pageNumber: number,
): string {
  return deterministicLyncId("ocr", "page", setLocator, String(pageNumber));
}

export function ocrDocumentEventId(
  setLocator: string,
  fileName: string,
): string {
  return deterministicLyncId("ocr", "document", setLocator, fileName);
}

/* --------------------------------- Scan ----------------------------------- */

const PAGE_TEXT_RE = /^page-(\d+)\.txt$/;
const PAGE_DESC_RE = /^page-(\d+)\.desc\.txt$/;
const DOCUMENT_RE = /\.md$/;

/**
 * Read an OCR page-set directory into a structured scan. Every file is
 * classified: page text, description sidecar, combined document, or an
 * explicit skipped entry. Nothing vanishes.
 */
export async function scanOcrPageDir(dir: string): Promise<OcrPageSetScan> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const texts = new Map<number, { file: string; content: string }>();
  const descs = new Map<number, { file: string; content: string }>();
  const documents: OcrDocument[] = [];
  const skipped: LyncSkippedRecord[] = [];
  const emptyFiles: string[] = [];

  for (const [index, name] of files.entries()) {
    const content = await fs.readFile(path.join(dir, name), "utf8");
    if (content.trim().length === 0) emptyFiles.push(name);

    const descMatch = name.match(PAGE_DESC_RE);
    if (descMatch) {
      const n = Number.parseInt(descMatch[1], 10);
      const existing = descs.get(n);
      if (existing) {
        skipped.push({
          index,
          reason: `duplicate description for page ${n} (already have ${existing.file})`,
          value: name,
        });
      } else {
        descs.set(n, { file: name, content });
      }
      continue;
    }

    const textMatch = name.match(PAGE_TEXT_RE);
    if (textMatch) {
      const n = Number.parseInt(textMatch[1], 10);
      const existing = texts.get(n);
      if (existing) {
        skipped.push({
          index,
          reason: `duplicate page number ${n} (already have ${existing.file})`,
          value: name,
        });
      } else {
        texts.set(n, { file: name, content });
      }
      continue;
    }

    if (DOCUMENT_RE.test(name)) {
      documents.push({ file: name, text: content });
      continue;
    }

    skipped.push({
      index,
      reason:
        "unrecognized file name (not page-N.txt, page-N.desc.txt, or *.md)",
      value: name,
    });
  }

  const pages: OcrPage[] = [...texts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, t]) => {
      const d = descs.get(number);
      return {
        number,
        textFile: t.file,
        text: t.content,
        descFile: d?.file ?? null,
        description: d?.content ?? null,
      };
    });

  // Orphan sidecars: a description with no matching page text is a skip, not
  // a page — there is no page event to attach it to.
  for (const [n, d] of [...descs.entries()].sort(([a], [b]) => a - b)) {
    if (!texts.has(n)) {
      skipped.push({
        index: files.indexOf(d.file),
        reason: `description sidecar for page ${n} has no matching page text file`,
        value: d.file,
      });
    }
  }

  // Gaps in numbering must surface, not vanish.
  const gaps: number[] = [];
  if (pages.length > 0) {
    const nums = new Set(pages.map((p) => p.number));
    const min = pages[0].number;
    const max = pages[pages.length - 1].number;
    for (let n = min + 1; n < max; n++) {
      if (!nums.has(n)) gaps.push(n);
    }
  }

  const missingDescriptions = pages
    .filter((p) => p.descFile === null)
    .map((p) => p.number);

  return {
    dir,
    pages,
    documents,
    sourceFiles: files.length,
    skipped,
    gaps,
    missingDescriptions,
    emptyFiles,
  };
}

/* -------------------------------- Mapping ---------------------------------- */

function ocrAuthor(
  actor: string,
  producer: LyncProducerOptions,
  locator: string,
): LyncAuthor {
  const author: LyncAuthor = {
    actor,
    operator: producer.operator ?? DEFAULT_OPERATOR,
    imported_by: `splice/${producer.importer}@${SPLICE_IMPORT_VERSION}`,
    source: `${producer.sourceRef}:${locator}`,
  };
  if (producer.via && producer.via.length > 0) author.via = producer.via;
  return author;
}

/**
 * Map a scanned OCR page set to lync events:
 * - 1 `ocr/set` anchor (parents []),
 * - 1 `ocr/page` per page, first page → set, page N → page N-1,
 * - 1 `ocr/document` per combined markdown file → set.
 *
 * Counts reconcile against the source directory and the invariant is checked
 * loudly: every file is consumed by an event or named in `skipped`.
 */
export function ocrPageSetToLyncEvents(
  scan: OcrPageSetScan,
  opts?: OcrLyncOptions,
): OcrLyncResult {
  const setLocator = opts?.setLocator ?? path.basename(scan.dir);
  const producer: LyncProducerOptions = {
    importer: opts?.importer ?? "ocr-text-import",
    sourceRef: opts?.sourceRef ?? scan.dir,
    via: opts?.via ?? `${setLocator}@unknown`,
    operator: opts?.operator,
    markedAt: opts?.markedAt,
  };
  const actor = opts?.actor ?? "ocr";

  // The source files carry no timestamps; use one explicit deterministic
  // fallback for every event (see module doc — mtimes would break determinism).
  const fallbackAt = producer.markedAt ?? new Date(0).toISOString();
  const atFallback = {
    used: fallbackAt,
    reason:
      "source files carry no timestamps; all events use the deterministic fallback (markedAt when provided, else epoch)",
  };

  const events: LyncEventBody[] = [];
  const setEventId = ocrSetEventId(setLocator);

  const setEvent: LyncEventBody = {
    v: 1,
    id: setEventId,
    kind: "ocr/set",
    at: fallbackAt,
    author: ocrAuthor(
      actor,
      producer,
      setLocator,
    ) as unknown as LyncEventBody["author"],
    parents: [],
    payload: {
      locator: setLocator,
      dir: scan.dir,
      source_files: scan.sourceFiles,
      pages: scan.pages.length,
      page_range:
        scan.pages.length > 0
          ? {
              min: scan.pages[0].number,
              max: scan.pages[scan.pages.length - 1].number,
            }
          : null,
      gaps: scan.gaps,
      documents: scan.documents.map((d) => d.file),
    },
  };
  if (producer.markedAt !== undefined) setEvent.marked = producer.markedAt;
  events.push(setEvent);

  let previousPageEventId: string | undefined;
  for (const page of scan.pages) {
    const ev: LyncEventBody = {
      v: 1,
      id: ocrPageEventId(setLocator, page.number),
      kind: "ocr/page",
      at: fallbackAt,
      author: ocrAuthor(
        actor,
        producer,
        page.textFile,
      ) as unknown as LyncEventBody["author"],
      parents: [previousPageEventId ?? setEventId],
      payload: {
        page: page.number,
        text: page.text,
        description: page.description,
        text_file: page.textFile,
        desc_file: page.descFile,
        text_bytes: Buffer.byteLength(page.text, "utf8"),
        desc_bytes:
          page.description === null
            ? null
            : Buffer.byteLength(page.description, "utf8"),
      },
    };
    if (producer.markedAt !== undefined) ev.marked = producer.markedAt;
    events.push(ev);
    previousPageEventId = ev.id;
  }

  for (const doc of scan.documents) {
    const ev: LyncEventBody = {
      v: 1,
      id: ocrDocumentEventId(setLocator, doc.file),
      kind: "ocr/document",
      at: fallbackAt,
      author: ocrAuthor(
        actor,
        producer,
        doc.file,
      ) as unknown as LyncEventBody["author"],
      parents: [setEventId],
      payload: {
        file: doc.file,
        text: doc.text,
        bytes: Buffer.byteLength(doc.text, "utf8"),
      },
    };
    if (producer.markedAt !== undefined) ev.marked = producer.markedAt;
    events.push(ev);
  }

  // File-accounting invariant: every file in the directory is consumed by an
  // event or named in skipped. Fail loudly rather than miscount silently.
  const descFilesConsumed = scan.pages.filter(
    (p) => p.descFile !== null,
  ).length;
  const filesAccounted =
    scan.pages.length + // one .txt per page event
    descFilesConsumed + // matched sidecars folded into page events
    scan.documents.length + // one file per document event
    scan.skipped.length; // everything else, explicitly
  if (filesAccounted !== scan.sourceFiles) {
    throw new Error(
      `ocr page set: counts do not reconcile: ${scan.pages.length} pages + ${descFilesConsumed} sidecars + ${scan.documents.length} documents + ${scan.skipped.length} skipped !== ${scan.sourceFiles} source files`,
    );
  }

  return {
    events,
    setEventId,
    stats: {
      sourceFiles: scan.sourceFiles,
      setEvents: 1,
      pageEvents: scan.pages.length,
      documentEvents: scan.documents.length,
      emitted: events.length,
      skipped: scan.skipped,
      gaps: scan.gaps,
      missingDescriptions: scan.missingDescriptions,
      emptyFiles: scan.emptyFiles,
      atFallback,
    },
  };
}

/* ------------------------------ End-to-end wire ---------------------------- */

export interface OcrLyncConversion {
  outputPath: string;
  setEventId: string;
  stats: OcrLyncStats;
  verify: LyncVerifyResult;
}

/**
 * End-to-end: scan an OCR page-set directory, map to lync events, write a
 * `.lync` file, then verify the written file with @deepfates/lync. Throws loudly
 * when the verifier finds any non-accepted line or counts drift.
 */
export async function convertOcrPagesToLync(
  inputDir: string,
  outputPath: string,
  opts?: OcrLyncOptions,
): Promise<OcrLyncConversion> {
  const scan = await scanOcrPageDir(inputDir);
  const mapped = ocrPageSetToLyncEvents(scan, opts);
  await writeLyncFile(outputPath, mapped.events);
  const verify = await verifyLyncFile(outputPath);
  if (!verify.ok) {
    throw new Error(
      `lync verify failed for ${outputPath}: ${JSON.stringify(verify.problems)}`,
    );
  }
  if (verify.counts.accepted !== mapped.events.length) {
    throw new Error(
      `lync verify count mismatch for ${outputPath}: wrote ${mapped.events.length}, accepted ${verify.counts.accepted}`,
    );
  }
  return {
    outputPath,
    setEventId: mapped.setEventId,
    stats: mapped.stats,
    verify,
  };
}
