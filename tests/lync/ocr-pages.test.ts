import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanOcrPageDir,
  ocrPageSetToLyncEvents,
  convertOcrPagesToLync,
  ocrSetEventId,
  ocrPageEventId,
  ocrDocumentEventId,
} from "../../src/outputs/lync-ocr.js";
import { verifyLyncFile } from "../../src/outputs/lync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// The real signal-ocr archive (dee-b8zk acceptance source): 100 page pairs
// (page-NNN.txt + page-NNN.desc.txt) plus signal-ocr-combined.md = 201 files.
// Found via SPLICE_SIGNAL_OCR_DIR when set (worktrees), else the sibling
// deep-space checkout; the real-archive suite is skipped LOUDLY when neither
// exists (the synthetic suites below always run).
const realDir =
  process.env.SPLICE_SIGNAL_OCR_DIR ??
  path.resolve(projectRoot, "../deep-space/data/signal-ocr");
const hasRealDir = fssync.existsSync(realDir);
if (!hasRealDir) {
  console.warn(
    `[ocr-pages.test] real-archive suite SKIPPED (4 tests): no archive at ${realDir} — set SPLICE_SIGNAL_OCR_DIR to the signal-ocr dir to run it`,
  );
}

describe.skipIf(!hasRealDir)(
  hasRealDir
    ? "signal-ocr real archive → lync (100 pages + combined doc)"
    : "signal-ocr real archive → lync — SKIPPED: set SPLICE_SIGNAL_OCR_DIR to enable",
  () => {
    it("scan: every one of the 201 files is classified, zero skipped, zero gaps", async () => {
      const scan = await scanOcrPageDir(realDir);
      expect(scan.sourceFiles).toBe(201);
      expect(scan.pages).toHaveLength(100);
      expect(scan.documents.map((d) => d.file)).toEqual([
        "signal-ocr-combined.md",
      ]);
      expect(scan.skipped).toEqual([]);
      expect(scan.gaps).toEqual([]);
      expect(scan.missingDescriptions).toEqual([]);
      expect(scan.emptyFiles).toEqual([]);
      // pages are in strict page order with both halves present
      expect(scan.pages[0]).toMatchObject({
        number: 1,
        textFile: "page-001.txt",
        descFile: "page-001.desc.txt",
      });
      expect(scan.pages[99]).toMatchObject({
        number: 100,
        textFile: "page-100.txt",
        descFile: "page-100.desc.txt",
      });
    });

    it("end-to-end: N pages in dir = N page events, verifier-clean, counts reconcile", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ocr-"));
      try {
        const outFile = path.join(dir, "signal-ocr.lync");
        const result = await convertOcrPagesToLync(realDir, outFile);

        // counts reconcile exactly against the source dir
        expect(result.stats.sourceFiles).toBe(201);
        expect(result.stats.setEvents).toBe(1);
        expect(result.stats.pageEvents).toBe(100);
        expect(result.stats.documentEvents).toBe(1);
        expect(result.stats.emitted).toBe(102);
        expect(result.stats.skipped).toEqual([]);
        expect(result.stats.gaps).toEqual([]);
        expect(result.stats.emptyFiles).toEqual([]);

        // verifier-clean: ALL written lines accepted by @deepfates/lync
        expect(result.verify.ok).toBe(true);
        expect(result.verify.problems).toEqual([]);
        expect(result.verify.counts.lines).toBe(102);
        expect(result.verify.counts.accepted).toBe(102);
        expect(result.verify.counts.events).toBe(102);
        expect(result.verify.counts.byKind).toEqual({
          "ocr/set": 1,
          "ocr/page": 100,
          "ocr/document": 1,
        });

        // independent re-parse of the file agrees
        const reverify = await verifyLyncFile(outFile);
        expect(reverify.ok).toBe(true);
        expect(reverify.counts.accepted).toBe(102);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("pages parent in page order under the set; payload preserves the originals", async () => {
      const scan = await scanOcrPageDir(realDir);
      const { events, setEventId } = ocrPageSetToLyncEvents(scan);

      const setEvent = events[0];
      expect(setEvent.kind).toBe("ocr/set");
      expect(setEvent.id).toBe(setEventId);
      expect(setEvent.id).toBe(ocrSetEventId("signal-ocr"));
      expect(setEvent.parents).toEqual([]);
      expect(setEvent.payload.pages).toBe(100);
      expect(setEvent.payload.gaps).toEqual([]);

      // first page → set; page N → page N-1; strict page order
      const pages = events.filter((e) => e.kind === "ocr/page");
      expect(pages).toHaveLength(100);
      expect(pages[0].parents).toEqual([setEventId]);
      for (let i = 1; i < pages.length; i++) {
        expect(pages[i].parents).toEqual([pages[i - 1].id]);
        expect(pages[i].payload.page).toBe(i + 1);
      }

      // payload preserves the original text + description byte-for-byte
      const text1 = await fs.readFile(
        path.join(realDir, "page-001.txt"),
        "utf8",
      );
      const desc1 = await fs.readFile(
        path.join(realDir, "page-001.desc.txt"),
        "utf8",
      );
      expect(pages[0].payload).toEqual({
        page: 1,
        text: text1,
        description: desc1,
        text_file: "page-001.txt",
        desc_file: "page-001.desc.txt",
        text_bytes: Buffer.byteLength(text1, "utf8"),
        desc_bytes: Buffer.byteLength(desc1, "utf8"),
      });

      // combined markdown → ocr/document parented to the set
      const docs = events.filter((e) => e.kind === "ocr/document");
      expect(docs).toHaveLength(1);
      expect(docs[0].parents).toEqual([setEventId]);
      expect(docs[0].payload.file).toBe("signal-ocr-combined.md");

      // author envelope: actor is the source identity, never the importer
      for (const ev of events) {
        expect(ev.author.actor).toBe("ocr");
        expect(ev.author.operator).toBe("deepfates");
        expect(ev.author.imported_by).toBe("splice/ocr-text-import@0.1");
        expect(ev.author.actor).not.toBe(ev.author.imported_by);
      }
      expect(pages[40].author.source).toBe(`${realDir}:page-041.txt`);
    });

    it("mints deterministic ids: same source, same events; re-import is a union no-op", async () => {
      const a = ocrPageSetToLyncEvents(await scanOcrPageDir(realDir));
      const b = ocrPageSetToLyncEvents(await scanOcrPageDir(realDir));
      expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
      expect(a.events).toEqual(b.events); // byte-identical, not just same ids
      expect(a.events[1].id).toBe(ocrPageEventId("signal-ocr", 1));
      expect(a.setEventId).toBe(ocrSetEventId("signal-ocr"));
    });
  },
);

/* ------------------------- Synthetic sources (always run) ------------------ */

async function makeSyntheticDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ocr-src-"));
  await fs.writeFile(path.join(dir, "page-001.txt"), "page one text");
  await fs.writeFile(path.join(dir, "page-001.desc.txt"), "page one desc");
  await fs.writeFile(path.join(dir, "page-002.txt"), "page two text");
  // page 3 is MISSING: a numbering gap
  await fs.writeFile(path.join(dir, "page-004.txt"), "page four text");
  await fs.writeFile(path.join(dir, "page-004.desc.txt"), "page four desc");
  // empty page file: emitted but surfaced in stats
  await fs.writeFile(path.join(dir, "page-005.txt"), "");
  // orphan sidecar: description with no matching page text
  await fs.writeFile(path.join(dir, "page-009.desc.txt"), "orphan desc");
  // unrecognized file name
  await fs.writeFile(path.join(dir, "notes.backup"), "not a page");
  // combined document
  await fs.writeFile(path.join(dir, "combined.md"), "# all pages");
  return dir;
}

describe("gaps, malformed and empty files surface in stats — nothing vanishes", () => {
  it("scan classifies every file; gaps, orphans, and empties are explicit", async () => {
    const dir = await makeSyntheticDir();
    try {
      const scan = await scanOcrPageDir(dir);
      expect(scan.sourceFiles).toBe(9);
      expect(scan.pages.map((p) => p.number)).toEqual([1, 2, 4, 5]);
      expect(scan.gaps).toEqual([3]);
      expect(scan.missingDescriptions).toEqual([2, 5]);
      expect(scan.emptyFiles).toEqual(["page-005.txt"]);
      expect(scan.documents.map((d) => d.file)).toEqual(["combined.md"]);

      // both unconsumable files are named with reasons
      expect(scan.skipped).toHaveLength(2);
      const reasons = new Map(
        scan.skipped.map((s) => [s.value as string, s.reason]),
      );
      expect(reasons.get("notes.backup")).toMatch(/unrecognized/);
      expect(reasons.get("page-009.desc.txt")).toMatch(
        /no matching page text/,
      );

      // file accounting: 4 texts + 2 sidecars + 1 doc + 2 skipped = 9 files
      const sidecars = scan.pages.filter((p) => p.descFile !== null).length;
      expect(
        scan.pages.length + sidecars + scan.documents.length +
          scan.skipped.length,
      ).toBe(scan.sourceFiles);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("end-to-end on the messy dir: verifier-clean and stats carry the defects", async () => {
    const dir = await makeSyntheticDir();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ocr-out-"));
    try {
      const outFile = path.join(outDir, "messy.lync");
      const result = await convertOcrPagesToLync(dir, outFile, {
        setLocator: "messy-set",
      });

      expect(result.stats.pageEvents).toBe(4);
      expect(result.stats.documentEvents).toBe(1);
      expect(result.stats.emitted).toBe(6); // set + 4 pages + 1 doc
      expect(result.stats.gaps).toEqual([3]);
      expect(result.stats.emptyFiles).toEqual(["page-005.txt"]);
      expect(result.stats.skipped).toHaveLength(2);
      expect(result.stats.missingDescriptions).toEqual([2, 5]);
      // timestamp provenance is explicit: no source timestamps exist
      expect(result.stats.atFallback.reason).toMatch(/no timestamps/);

      expect(result.verify.ok).toBe(true);
      expect(result.verify.counts.accepted).toBe(6);
      expect(result.verify.counts.byKind).toEqual({
        "ocr/set": 1,
        "ocr/page": 4,
        "ocr/document": 1,
      });

      // the gap is also visible to lync consumers via the set payload
      const scan = await scanOcrPageDir(dir);
      const { events } = ocrPageSetToLyncEvents(scan, {
        setLocator: "messy-set",
      });
      expect(events[0].payload.gaps).toEqual([3]);
      expect(events[0].payload.page_range).toEqual({ min: 1, max: 5 });

      // parenting skips over the gap but preserves page order
      const pages = events.filter((e) => e.kind === "ocr/page");
      expect(pages.map((p) => p.payload.page)).toEqual([1, 2, 4, 5]);
      expect(pages[2].parents).toEqual([pages[1].id]); // page 4 → page 2
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("duplicate page numbers: first wins, the duplicate is an explicit skip", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ocr-dup-"));
    try {
      await fs.writeFile(path.join(dir, "page-001.txt"), "canonical");
      await fs.writeFile(path.join(dir, "page-01.txt"), "duplicate");
      const scan = await scanOcrPageDir(dir);
      expect(scan.pages).toHaveLength(1);
      expect(scan.pages[0].textFile).toBe("page-001.txt");
      expect(scan.skipped).toHaveLength(1);
      expect(scan.skipped[0].reason).toMatch(/duplicate page number 1/);
      expect(scan.skipped[0].value).toBe("page-01.txt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ids derive from (set locator, page number), not from where the dir lives", async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ocr-a-"));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "splice-ocr-b-"));
    try {
      for (const d of [dirA, dirB]) {
        await fs.writeFile(path.join(d, "page-001.txt"), "same text");
      }
      const opts = { setLocator: "signal-ocr", sourceRef: "signal-ocr" };
      const a = ocrPageSetToLyncEvents(await scanOcrPageDir(dirA), opts);
      const b = ocrPageSetToLyncEvents(await scanOcrPageDir(dirB), opts);
      expect(a.events[1].id).toBe(b.events[1].id);
      expect(a.events[1].id).toBe(ocrPageEventId("signal-ocr", 1));
      expect(a.setEventId).toBe(b.setEventId);
      expect(ocrDocumentEventId("signal-ocr", "x.md")).toBe(
        ocrDocumentEventId("signal-ocr", "x.md"),
      );
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });
});
