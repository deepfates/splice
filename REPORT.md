# REPORT: dee-zhyc story-machine converter

## Branch

`convert-story-machine`

## Changes

- Added `lore-tools/story_machine_import.py`, a standalone LORE-V0 importer for:
  - story-machine loom snapshots (`loom` + `turns`)
  - story-machine optimizer-run JSON (`runId`, `front`, `best`, `trajectories`)
- Minted UUIDv7 event ids and digest-spliced each JSONL line.
- Preserved original source records under `payload.original`.
- Kept importer identity in `author.imported_by`; actors come from source turn authors or optimizer roles.
- Converted loom turn lineage into ordered lore parents.
- Special-cased composition/splice turns so ordered `meta.references` become ordered `parents`.
- Converted optimizer candidates, score cells, reconstructed/snapshot fronts, and choice context into events.
- Added synthetic fixtures covering:
  - ordered splice parent reconstruction
  - per-witness scores
  - reconstructed `front[]`
  - accepted/rejected `lore/selection` events

## Ground Truth Notes

- Loom snapshots are JSON objects with `loom` metadata and a `turns[]` array. Turn records carry `id`, `parentId`, `createdAt`, `payload`, and `meta`.
- Optimizer-run files are JSON objects with `runId`, `front[]`, `best`, and sometimes `trajectories[]`.
- For current trajectory-bearing optimizer outputs, final `front[]` can be reconstructed from accepted trajectory score maps using the story-machine Pareto rule: keep candidates that are best on at least one score dimension, with insertion-order tie behavior.
- Older optimizer runs without `trajectories[]` are admitted as snapshot fronts via `payload.front_kind = "snapshot"`.

## Reproduce Commands

```sh
git checkout convert-story-machine
python3 lore-tools/story_machine_import.py \
  tests/fixtures/story-machine/loom.json \
  tests/fixtures/story-machine/optimizer-run.json \
  -o /tmp/story-machine-fixture.lore \
  --stats-json
python3 ../portfolio-audit-20260701/lore-tools/verify.py /tmp/story-machine-fixture.lore
python3 lore-tools/story_machine_import.py \
  ../story-machine/looms/2026-05-01T01-40-36-841-97049_opt.json \
  ../story-machine/optimizer-runs/2026-05-01T02-52-31-995-69488.json \
  -o /tmp/story-machine-real-sample.lore \
  --stats-json
python3 ../portfolio-audit-20260701/lore-tools/verify.py /tmp/story-machine-real-sample.lore
npm run build
npm test
```

## Evidence

- Fixture conversion wrote 16 events. Canonical verifier result: 16 accepted lines, 16 digests OK, unique ids.
- Fixture stress checks: composition event had 2 ordered parents; optimizer front was reconstructed as `["seed0001", "child001"]`; 4 `lore/selection` events were emitted.
- Real sample conversion wrote 210 events: 113 loom events and 97 optimizer events.
- Real sample optimizer front was reconstructed from trajectory-level scores.
- Canonical verifier result for the real sample: 210 accepted lines, 210 digests OK, unique ids.
- `npm run build` passed.
- `npm test` passed with approved sandbox escalation. The un-escalated run failed before project assertions because `tsx` could not create its temp IPC pipe (`listen EPERM`).
- An accidental `npm test -- --runInBand` run failed because Vitest does not support Jest's `--runInBand`; the actual project test command is `npm test`.

## Tickets Filed

None.
