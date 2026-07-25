---
id: Hac-xv48
status: open
deps: []
links: []
created: 2026-07-25T17:41:52Z
type: bug
priority: 1
assignee: deepfates
tags: [corpus, splice, ocr, privacy, identity]
---
# Splice: make OCR Lync imports portable without identity conflicts

A real heterogeneous local rehearsal ran 'splice lync ocr --source /absolute/path --source-ref fixture://signal-ocr --set-locator signal-ocr-fixture'. The emitted ocr/set payload still contained scan.dir as the absolute source directory, so Textile and Splice Markdown exposed the workstation path despite the portable author.source override. The source path was detected before browser import and the generated corpus stayed local. Repair must address deterministic identity: changing the body under the existing set/page ids would make old and new imports same-id conflicts.

## Acceptance Criteria

An OCR import with an explicit portable source reference contains no absolute source/check-out path in any event or downstream Markdown; unchanged inputs still rerun byte-identically; the identity/migration contract for pre-fix OCR output is explicit and tested so old and new files cannot be silently unioned into conflicts; the full OCR importer and corpus loop gates pass.

