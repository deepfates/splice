---
id: Hac-xv48
status: closed
deps: []
links: []
created: 2026-07-25T17:41:52Z
closed: 2026-07-30T09:36:42Z
type: bug
priority: 1
assignee: deepfates
tags: [corpus, splice, ocr, privacy, identity]
---
# Splice: make OCR Lync imports portable without identity conflicts

A real heterogeneous local rehearsal ran 'splice lync ocr --source /absolute/path --source-ref fixture://signal-ocr --set-locator signal-ocr-fixture'. The emitted ocr/set payload still contained scan.dir as the absolute source directory, so Textile and Splice Markdown exposed the workstation path despite the portable author.source override. The source path was detected before browser import and the generated corpus stayed local. Repair must address deterministic identity: changing the body under the existing set/page ids would make old and new imports same-id conflicts.

## Acceptance Criteria

An OCR import with an explicit portable source reference contains no absolute source/check-out path in any event or downstream Markdown; unchanged inputs still rerun byte-identically; the identity/migration contract for pre-fix OCR output is explicit and tested so old and new files cannot be silently unioned into conflicts; the full OCR importer and corpus loop gates pass.

## Resolution

The versioned `splice/ocr-portable-v2` recipe remints the complete
set/page/document chain, removes `ocr/set.payload.dir`, and declares the scheme
in the set payload and conversion stats. Legacy-id helpers and a generated
legacy/v2 union regression prove the two graphs are disjoint with zero conflict
variants; documentation warns that coexistence is duplicate representation,
not two observations.

Exercised on 2026-07-30:

- 192/192 Splice tests and TypeScript build passed, including the real local
  201-file/100-page OCR archive and deterministic double-run checks.
- The ordinary CLI emitted 102 verifier-accepted events from that archive with
  `--source-ref archive://signal-ocr`; both the 592,763-byte `.lync` and
  471,831-byte Markdown had zero occurrences of the physical source path.
- Textile's provider-free cross-repository corpus loop passed through Splice
  ingest/export, Lync verify/merge, Curare clustering, Textile keep/note, and
  deterministic Markdown/training export. Temporary local artifacts were
  removed; no corpus data was uploaded or published.
