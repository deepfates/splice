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

## Usage

Help (equivalent to `--help`):

    splice — convert a Twitter archive to Markdown, OAI JSONL, and/or JSON

    Usage:
      splice --source <path> --out <dir> [--format markdown oai json sharegpt] [--system-message <text>]
             [--since <iso>] [--until <iso>] [--min-length <n>] [--exclude-rt] [--only-threads] [--with-media]
             [--enrich] [--dry-run] [--stats-json] [--log-level <level>] [--json-stdout] [--quiet|-q] [--verbose] [--version|-V]

      splice --glowfic <url> --out <dir> --assistant <name> [--assistant-regex <pattern>]
      splice --glowfic-board <url> --out <dir> --all-characters [--min-posts <n>]

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

## Sources

### Twitter/X

Extract the archive ZIP to a directory containing:

- `data/manifest.js`
- `data/tweets_media/` (optional, for media assets)
- YTD `.js` files for `tweets` and `like` data

We ingest tweets, likes, and media files prefixed with `<tweetId>-*`.

### Bluesky

Export your repository from Settings → Advanced → Export Content. Pass `--source path/to/repo.car`.

- Use `--enrich` to fetch parent posts from the public API for full conversation context
- Media blobs are referenced but not downloaded yet

### Glowfic

Pass a thread, section, or board URL: `--glowfic https://glowfic.com/posts/5506`

- Requires `--assistant <name>` to specify which character is the assistant
- For multi-character datasets: `--glowfic-board <url> --all-characters`
## Output layout

On a successful run, you’ll see:

- `out/threads/` — one Markdown file per detected thread, named like `YYYYMMDD-thread-<slug>.md`
- `out/tweets/` — one Markdown file per non-thread tweet, named like `YYYYMMDD-tweet-<slug>.md`
- `out/images/` — copied media files referenced by the Markdown
- `out/conversations_oai.jsonl` — OAI JSONL file with conversations built from threads and reply chains
- `out/normalized_items.jsonl` — JSONL dump of normalized ContentItem records (one item per line)
- `out/sharegpt.json` — ShareGPT export (array) for loaders that expect ShareGPT format
- `out/stats.json` — summary (counts, threads/conversations, date range)

Notes:
- Thread filenames are derived from the top post’s first words (sanitized).
- The OAI JSONL file includes a top-level “system” message (configurable).

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
