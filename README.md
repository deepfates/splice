# 🫚 splice

Convert social/chat archives into normalized threads and export to Markdown, OAI JSONL, JSON (normalized items), and ShareGPT. Modular TypeScript CLI and library with extensible sources → transforms → outputs.

- Idiomatic CLI (clig.dev principles)
- Modular architecture:
  - sources: Twitter/X archives and Bluesky repo CAR exports (text-first; blobs soon), ChatGPT, etc. next
  - transforms: filtering, grouping into threads/conversations, text cleaning
  - outputs: Markdown, OAI JSONL, JSONL (normalized items), ShareGPT
- Library API to compose your own pipeline or plug in proprietary adapters
- Copies referenced media into an images/ folder
- JSONL artifacts for easy inspection and future checkpointing

## Why

Turn your archives into:
- Readable Markdown
- OAI-compatible JSONL for training/eval
- A normalized JSONL dump for inspection and reuse

Today it supports:

- **Twitter/X** — Local archive exports (ZIP extracted)
- **Bluesky** — AT Protocol CAR file exports with optional API enrichment
- **Glowfic** — Collaborative fiction threads, sections, or boards via URL

Next: ChatGPT, Reddit, Hugging Face datasets.

This library started life as a Python script. This is a TypeScript rewrite where development will continue. It has powered projects like [deeperfates.com](https://deeperfates.com), [keltham.lol](https://keltham.lol), and [youaretheassistantnow.com](https://youaretheassistantnow.com).

More context: https://deepfates.com/convert-your-twitter-archive-into-training-data

## Quick start (CLI)

Requirements:
- Node.js 18+ (tested with recent LTS)
- For direct execution: `tsx` (installed automatically with `npx`)

Run with tsx (no build needed):

    npx tsx splice.ts --source /path/to/twitter-archive --out ./out

Run the published CLI (after install):

    npx splice --source /path/to/twitter-archive --out ./out

Build then run with Node:

    npm install
    npm run build
    node dist/cli/splice.js --source /path/to/twitter-archive --out ./out

Dev/watch mode:

    npm run dev -- --source /path/to/twitter-archive --out ./out

Try the checked-in fixture archive:

    npm install
    npm run start -- --source tests/integration/fixtures/archive --out ./out

## Usage

Help (equivalent to `--help`):

    splice — convert a Twitter archive to Markdown, OAI JSONL, and/or JSON

    Usage:
      splice --source <path> --out <dir> [--format markdown oai json sharegpt] [--system-message <text>]
             [--since <iso>] [--until <iso>] [--min-length <n>] [--exclude-rt] [--only-threads] [--with-media]
             [--enrich] [--dry-run] [--stats-json] [--log-level <level>] [--json-stdout] [--quiet|-q] [--verbose] [--version|-V]

      splice --glowfic <url> --out <dir> --assistant <name> [--assistant-regex <pattern>]
      splice --glowfic-board <url> --out <dir> --all-characters [--min-posts <n>]
      splice lync <command> --source <path> --out <file.lync>   (see "lync output" below)

    Options:
      --source <path>            Path to Twitter archive directory or Bluesky .car file
      --out <dir>                Output directory
      --format <fmt...>          One or more formats: markdown, oai, json, sharegpt (default: markdown oai json)
      --system-message <text>    System message for OAI JSONL (default: "You have been uploaded to the internet")
                                 Alias: --system
      --since <iso>              Include items on/after this ISO date
      --until <iso>              Include items on/before this ISO date
      --min-length <n>           Minimum text length
      --exclude-rt               Exclude retweets (RT ...)
      --only-threads             Output threads only
      --with-media               Only include items that have media
      --enrich                   Fetch thread context from API (Bluesky only)
      --dry-run, -n              Plan only; don't write files
      --stats-json               Write a stats.json summary
      --log-level <level>        debug|info|warn|error (default: info)
      --json-stdout              Emit normalized items JSONL to stdout; logs to stderr
      --quiet, -q                Errors only
      --verbose                  Debug logging
      --version, -V              Show version
      --help, -h                 Show help

    Glowfic Options:
      --glowfic <url>            Glowfic thread/section/board URL to ingest
      --assistant <name>         Character name for assistant role (case-insensitive)
      --assistant-regex <pat>    Regex pattern for assistant matching
      --glowfic-board <url>      Board URL for multi-character export
      --all-characters           Export datasets for all characters on board
      --min-posts <n>            Minimum posts for character inclusion (default: 10)

    Environment:
      SPLICE_SYSTEM_MESSAGE      Alternative way to set the OAI system message
                                 (flag value takes precedence)

Exit codes:
- 0: success
- 1: runtime error
- 2: invalid arguments or source detection failed

Stdout/Stderr:
- Primary logs go to stderr (so you can safely pipe stdout)
- Data files are written to the output directory

## Examples

Convert to both Markdown and OAI JSONL:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out

Markdown only:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format markdown

OAI only with custom system message:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format oai --system-message "You are helpful."

JSON only (normalized items):

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format json

All formats:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format markdown oai json sharegpt

Filters and selection:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format markdown --since 2024-01-01 --until 2024-12-31 --min-length 40 --exclude-rt --only-threads --with-media

Stats JSON summary:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format oai --stats-json

Stream normalized items to stdout:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --json-stdout | head -n 5

Use environment variable for system message:

    SPLICE_SYSTEM_MESSAGE="Be concise." npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format oai

Dry run with debug logs (no files written):

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --dry-run --log-level debug

Bluesky CAR export:

    npx tsx splice.ts --source ~/Downloads/my-bsky-repo.car --out ./out

Bluesky with thread context enrichment (fetches parent posts from API):

    npx tsx splice.ts --source ~/Downloads/my-bsky-repo.car --out ./out --enrich

Glowfic thread (single character as assistant):

    npx tsx splice.ts --glowfic https://glowfic.com/posts/5506 --out ./out --assistant "Carissa"

Glowfic board (all characters, HuggingFace dataset format):

    npx tsx splice.ts --glowfic-board https://glowfic.com/boards/215 --out ./out --all-characters --min-posts 20

## lync output (CLI)

`splice lync <command>` converts archives into append-only `.lync` event files
(the lync FORMAT.md envelope). Every command writes the file, re-verifies it
with @deepfates/lync (every line must classify `accepted`), and prints the full
stats block — emitted/skipped counts with per-record reasons, timestamp
fallbacks, verify counts — as JSON to stdout. Logs stay on stderr. Nothing is
dropped silently.

Commands:

    splice lync archive     --source <twitter-dir|bsky.car>  --out <file.lync>
    splice lync glowfic     --source <thread.json>           --out <file.lync>
    splice lync ocr         --source <page-set-dir>          --out <file.lync>
    splice lync tweet-embed --source <embed-cache-dir>       --out <file.lync>

- `archive` — a Twitter archive directory or Bluesky `.car` file (same
  detection as the main pipeline) → one event per normalized item
  (`twitter/tweet`, `twitter/like`, …), reply links preserved as parents.
- `glowfic` — a glowfic-dl JSON export (`thread.json`) → one `glowfic/thread`
  event plus one `glowfic/post` per post, chained in post order.
- `ocr` — a directory of OCR pages (`page-NNN.txt`, optional
  `page-NNN.desc.txt` sidecars, combined `*.md`) → `ocr/set`, `ocr/page`,
  `ocr/document` events. `--set-locator <name>` pins the id-stable set
  identity (default: directory basename).
- `tweet-embed` — a directory of cached oEmbed responses
  (`<tweetid>-light.json`) → `twitter/tweet-embed` events. Pass
  `--archive-ids-file <path>` (JSON array or one id per line) to parent
  matched embeds to their canonical archive tweet events.

Common options: `--operator`, `--via`, `--source-ref` (author envelope
overrides), `--marked-at <rfc3339>` (record import time; opt-in because
omitting it keeps re-runs byte-identical so lync unions them as duplicates),
`--dry-run`, `--quiet`, `--verbose`, `--log-level`. Unknown flags are hard
errors (exit 2), not warnings. See `splice lync --help`.

Examples:

    npx tsx splice.ts lync archive --source ~/Downloads/my-twitter-archive --out ./out/twitter.lync
    npx tsx splice.ts lync glowfic --source tests/fixtures/glowfic-export/thread.json --out ./out/thread-5506.lync
    npx tsx splice.ts lync ocr --source ../deep-space/data/signal-ocr --out ./out/signal-ocr.lync
    npx tsx splice.ts lync tweet-embed --source ../deep-space/.embed-cache/tweets --out ./out/embeds.lync

Exit codes match the main CLI: 0 success, 1 runtime/verify error, 2 usage
error. Future exporters (lync → training data and lync → markdown) will land
as sibling subcommands here.

### Agent-session importer identity and cutover

Convert a complete Codex or Claude Code session tree with the direct private
intake commands:

```sh
splice session-import codex --source ~/.codex/sessions --out ./private-lync/codex
splice session-import claude --source ~/.claude/projects --out ./private-lync/claude
```

The source and output trees must not overlap. The JSON report names every
converted JSONL file, every unreadable JSONL file, and every ignored non-JSONL
entry. Any unreadable source makes the command exit nonzero after it prints the
partial accounting report. Raw session JSONL remains authority; the generated
lync tree is a deterministic, rebuildable normalization. Codex journals from
before the current `{timestamp,type,payload}` envelope are preserved as
top-level logical payloads rather than losing their role and message content.

The Codex and Claude Code tree importers use the explicit deterministic-id
schema `splice-session-tree/v1`. A source file's identity is its normalized,
root-relative path under the selected archive root, prefixed by that schema;
the physical location of the copied archive is not identity. Human-readable
`author.source` and payload paths remain root-relative. A breaking locator or
id change must introduce a new schema value rather than silently reusing v1.

Claude UUID-bearing records additionally use the repeat identity recipe
`splice-claude-repeat/v2`. Real subagent and compaction journals can repeat one
UUID within a file or copy it across files. The first occurrence in the
byte-sorted tree remains the canonical UUID-derived `claude/<type>` event.
Later byte-identical occurrences become deterministic, line-scoped
`lore/pointer` events targeting it; differing occurrences become
`lore/annotation` events that retain the complete source record and target the
same canonical event. This preserves every physical occurrence without
weakening same-id conflict verification or breaking `parentUuid` lineage.
V1 output from an interrupted Claude import must be regenerated from raw JSONL
before use; Codex identities are unchanged.

The earlier basename-only tree-import behavior never produced importer output
found in the v1-cutover audit of this workstation's home directory (excluding
macOS's system-managed `Library` tree): no `.lync` event was attributed to
`splice/codex-session` or `splice/claude-session`. It is therefore treated as
disposable pre-release output, not a migration source. If such generated files
exist elsewhere, delete them and regenerate from the original JSONL archive
with v1; do not union basename-era files with v1 output because their derived
ids belong to a different, unversioned identity scheme.

Session output files are mode 0600 and importer-created directories are 0700
on POSIX. Windows does not expose equivalent POSIX mode guarantees. Repeated
conversion replaces the generated file on every platform; replacement is
atomic on POSIX, while Windows may briefly remove the old destination before
renaming the verified staged file into place.

### Private session search projection

`splice session-search rebuild` builds a disposable SQLite FTS5 projection
over a tree of Splice-produced Codex and Claude Code `.lync` files;
`splice session-search find` performs literal, case-sensitive searches. The
lync files remain authority. Rebuilds walk byte-sorted root-relative paths,
stream bounded batches through one transaction, and report a deterministic
manifest with per-file digests and reconciled counts.

Privacy is structural rather than a query-time convention. Only user and
assistant message text enters the database. System/developer prompts,
reasoning, tool calls and results, and session sidecars are never copied into
the projection. Hits contain stable source path/line/event coordinates and an
argument vector for the source-native resume command (`codex resume
<session-id>` or `claude --resume <session-id>`). Projection directories are
0700 and the database and manifest are 0600 on POSIX.

Rebuilds publish immutable generations beneath a stable private projection
directory and atomically replace its `CURRENT` pointer. A fail-fast lock
rejects concurrent writers to the same projection; a failed controlled rebuild
leaves the prior generation current. `find` opens the selected database
read-only, preflights its schema, uses case-sensitive FTS5 trigram candidates,
then verifies each hit with exact `instr`. Queries must be at least three
characters. Published generations are not deleted during rebuild, so readers
that already resolved an older `CURRENT` remain valid; generation garbage
collection is an explicit future/manual maintenance action.

Generation publication copies the completed database and manifest into a new,
unpointed private generation and verifies both before updating `CURRENT`; it
does not depend on renaming a populated directory. POSIX replaces `CURRENT`
atomically. Windows cannot atomically rename over an existing file, so repeat
publication uses a recoverable pointer-to-backup swap with a brief interval in
which a new reader may need to retry; already-resolved generation readers are
unaffected.

Each source file is copied into a private immutable staging snapshot before it
is verified, hashed, or indexed. Lync's streaming parser must accept every
line, and a disk-backed union check rejects the same event id with different
body bytes across files. Thus the per-file manifest digest covers the exact
bytes indexed even if the authority file changes during a rebuild; identical
duplicates retain normal lync union-as-no-op semantics. The manifest separates
source message segments from unique projected rows and reports identities
seen, unique identities, and identical duplicates. Rebuild preflight requires
SQLite to honor `PRAGMA temp_store=FILE`; the union identity table therefore
does not grow in process memory.

The implementation invokes a `sqlite3` executable with FTS5 enabled (macOS's
system SQLite satisfies this) and deliberately adds no native Node dependency.
Callers on other platforms must provide such an executable, optionally through
the `sqliteBinary` option or `SPLICE_SQLITE3` for the CLI.

```ts
import {
  rebuildSessionSearchIndex,
  searchSessionIndex,
} from "@deepfates/splice";

const built = await rebuildSessionSearchIndex("./session-lync", "./search");
const hits = await searchSessionIndex(built.indexPath, "literal phrase");
```

Or use the direct JSON CLI surface:

```sh
splice session-search rebuild --source ./session-lync --out ./private-search
splice session-search find --index ./private-search --query "literal phrase"
```

## Sources

### Twitter/X

Extract the archive ZIP to a directory containing:

- `data/manifest.js`
- `data/tweets_media/` (optional, for media assets)
- YTD `.js` files for `tweets` and `like` data

We ingest tweets, likes, and media files prefixed with `<tweetId>-*`.

For a tiny copy-pasteable example, use the fixture at `tests/integration/fixtures/archive/`:

    npm run start -- --source tests/integration/fixtures/archive --out ./out

### Bluesky

Export your repository from Settings → Advanced → Export Content. Pass `--source path/to/repo.car`.

- Use `--enrich` to fetch parent posts from the public API for full conversation context
- Media blobs are referenced but not downloaded yet

### Glowfic

Pass a thread, section, or board URL: `--glowfic https://glowfic.com/posts/5506`

- Requires `--assistant <name>` to specify which character is the assistant
- For multi-character datasets: `--glowfic-board <url> --all-characters`
## Output layout

By default (`--format markdown oai json`), a successful run writes:

- `out/threads/YYYYMMDD/` — one Markdown file per detected multi-post thread, named like `<slug>.md`
- `out/tweets/` — directory for one Markdown file per non-thread self-authored post, named like `<slug>.md`; in the fixture run this directory is empty and has no dated child directory
- `out/images/` — copied media files referenced by the Markdown
- `out/conversations_oai.jsonl` — OAI JSONL file with conversations built from threads and reply chains
- `out/normalized_items.jsonl` — JSONL dump of normalized ContentItem records (one item per line)
- `out/.splice/objects/<sha256>.json|jsonl` — content-addressed intermediate artifacts used by checkpoint manifests
- `out/.splice/checkpoints/<checkpoint-id>.json` — pipeline checkpoint manifest for the run

The checked-in fixture command above creates this output tree:

```text
out
out/normalized_items.jsonl
out/images
out/tweets
out/threads
out/threads/20250101
out/threads/20250101/Top_tweet_with_link_httpstcoabc123.md
out/.splice
out/.splice/checkpoints
out/.splice/checkpoints/<checkpoint-id>.json
out/.splice/objects
out/.splice/objects/<sha256>.json
out/.splice/objects/<sha256>.jsonl
out/conversations_oai.jsonl
```

Opt-in files:

- `out/sharegpt.json` — ShareGPT export when you include `--format sharegpt`
- `out/stats.json` — summary (counts, threads/conversations, date range) when you pass `--stats-json`

Notes:
- Thread filenames are derived from the top post’s first words (sanitized).
- The OAI JSONL file includes a top-level “system” message (configurable).
- The `.splice/` store is safe to delete if you only need the exported files; keep it if you want checkpoint provenance or future resumable workflows.

## Architecture (for contributors)

- src/core — shared types, arg parsing, logger, utilities
- src/sources — input adapters (twitter.ts)
- src/transforms — filters, grouping, conversation mapping
- src/outputs — writers for markdown/oai/json/sharegpt/stats
- src/cli — CLI entrypoint wiring sources → transforms → outputs

The code is structured so you can add new sources, transforms, or outputs without touching unrelated parts.

## Library usage

You can import and compose pieces in your own app:

```ts
import {
  ingestTwitter,
  applyFilters,
  indexById,
  groupThreadsAndConversations,
  writeOAI,
} from "@deepfates/splice";

const items = await ingestTwitter("/path/to/archive", (l, m) => console.error(`[${l}] ${m}`));
const filtered = applyFilters(items, { minLength: 20, excludeRt: true, withMedia: false });
const all = indexById(filtered);
const { threads, conversations } = groupThreadsAndConversations(all);
await writeOAI(threads, conversations, "./out", "You have been uploaded to the internet", (l, m) => console.error(`[${l}] ${m}`), false);
```

Pluggable adapters (build proprietary ones privately and upstream later if you want):

- SourceAdapter: `detect(pathOrUri)`, `ingest(pathOrUri, logger) → ContentItem[]`
- OutputAdapter: `write(args, ctx)` where args may include `items`, `threads`, `conversations`, `systemMessage`, and ctx provides `outDir`, `dryRun`, and `logger`

## Development

Install deps:

    npm install

Run with tsx:

    npm run start -- --source /path/to/twitter-archive --out ./out

Watch mode:

    npm run dev -- --source /path/to/twitter-archive --out ./out

Build (emits `dist/cli/splice.js` and sets up the `splice` bin; library API at `dist/index.js`):

    npm run build

Run the built CLI:

    node dist/cli/splice.js --source /path/to/twitter-archive --out ./out

## Testing

Run the full test suite (includes integration tests for Markdown, OAI JSONL with system message, media copying, and normalized JSONL):

    npm test

Watch tests:

    npm run test:watch

## Roadmap (short)

- More inputs: Reddit, ChatGPT, HF datasets
- Checkpointing and resumable pipelines (JSONL-based manifests)
- More outputs: SQLite/Parquet/CSV
- Blob fetching for Bluesky media
- Better selection: persona/character filters, time ranges
- Improved role attribution and metadata preservation

## License

MIT. See `LICENSE`.

## Acknowledgements

See the blog post above for context. CLI UX follows clig.dev-style conventions.
