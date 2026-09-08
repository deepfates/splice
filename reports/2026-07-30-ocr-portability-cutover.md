# OCR portability cutover (2026-07-30)

This report retains the observation and exercise behind portable OCR identity.
Current usage lives in the [CLI reference](../docs/cli.md#lync-commands).

## Defect and remedy

A local rehearsal used a portable `--source-ref`, but `ocr/set` still carried
the absolute scan directory and exposed it through downstream Markdown. Changing
only the body under the old deterministic IDs would have created conflicts.

The remedy introduced the disjoint `splice/ocr-portable-v2` set/page/document
graph, removed the directory payload, declared the identity scheme, and changed
the importer label to `splice/ocr-text-import-portable@0.1`.

## Exercised result

The closed ticket [`.tickets/Hac-xv48.md`](../.tickets/Hac-xv48.md) records this
bounded 2026-07-30 exercise:

- 192 tests and the TypeScript build passed.
- A real 201-file, 100-page archive produced 102 verifier-accepted events.
- Neither the 592,763-byte Lync file nor 471,831-byte Markdown contained the
  physical source path.
- Replay and generated legacy/v2 union checks passed with disjoint graphs and
  zero conflict variants.
- The provider-free corpus loop reached verified Markdown and training export;
  temporary artifacts were removed and nothing was uploaded or published.

These measurements describe that exercise, not every OCR corpus.

## Recovery rule

Regenerate and replace unversioned path-bearing files when possible. If legacy
and v2 files are unioned, Lync can retain both without ID conflicts, but they
represent one source twice rather than two observations. Keep `--set-locator`
and portable `--source-ref` stable across reruns.

Evidence coordinates include ticket `Hac-xv48`, commit `ea2ecb0`,
`src/outputs/lync-ocr.ts`, and OCR tests under `tests/lync/` and
`tests/integration/`.
