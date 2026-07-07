# REPORT: dee-splc README truth pass

## Branch

`readme-truth`

## Changes

- Pointed newcomers at `tests/integration/fixtures/archive/` with copy-paste CLI commands.
- Updated README output layout to match the default fixture run: `threads/20250101/`, empty leaf `tweets/`, `images/`, `conversations_oai.jsonl`, `normalized_items.jsonl`, and `.splice/`.
- Transcribed the fixture output tree from `find out -maxdepth 4 -print` after running the documented fixture command.
- Documented the `.splice` content-addressed store: `objects/<sha256>.json|jsonl` and `checkpoints/<checkpoint-id>.json`.
- Fixed empty checkpoint IDs so the default manifest no longer saves as `.splice/checkpoints/.json` or logs `Saved checkpoint  in`.
- Corrected CLI usage text to say the actual default format set is `markdown oai json`.
- Added integration coverage for default outputs, opt-in `sharegpt.json`/`stats.json`, content-addressed object filenames, and named checkpoint files.
- Loop on `spl-0oly`: this README correction addresses the discovered issue that the default fixture layout overstated an empty `out/tweets/YYYYMMDD/` directory. I did not close the ticket.

## Reproduce Commands

```sh
git checkout readme-truth
npm run start -- --source tests/integration/fixtures/archive --out ./out
find out -maxdepth 4 -print
npm test
npm run build
```

Notes:
- In the managed sandbox, the first `npm run start -- --source tests/integration/fixtures/archive --out ./out` attempt failed before project code ran because `tsx` could not create its temp IPC pipe (`listen EPERM`). Rerunning the same command with approved escalation passed.
- The same sandbox IPC restriction can affect `npm test`; rerun with approved escalation if it fails before assertions.

## Evidence

```sh
npm run start -- --source tests/integration/fixtures/archive --out ./out
find out -maxdepth 4 -print
```

Result: the fixture run produced `out/tweets` with no dated child directory, plus `out/threads/20250101/Top_tweet_with_link_httpstcoabc123.md`, `out/images`, `out/conversations_oai.jsonl`, `out/normalized_items.jsonl`, and `.splice/{checkpoints,objects}`.

```sh
npm test
```

Result: 2 test files passed, 4 tests passed.

```sh
npm run build
```

Result: TypeScript build completed successfully.

## Tickets Filed

None. Existing discovered ticket `spl-0oly` is addressed by this README correction but not closed.
