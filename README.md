# 🫚 splice

Convert social/chat archives into normalized threads and export to Markdown, OAI JSONL, JSON (normalized items), and ShareGPT. Modular TypeScript CLI and library with extensible sources → transforms → outputs.

- Idiomatic CLI (clig.dev principles)
- Modular architecture:
  - sources: Twitter/X today; Bluesky, ChatGPT, etc. next
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

Today it imports Twitter/X and Glowfic. The plan is to splice in other archives (Bluesky, ChatGPT, Reddit, Hugging Face, …) and let you pick the strands you want to weave into a training set.

Glowfic input (threads, sections, boards)
- You can now target Glowfic threads, board sections, or entire boards by URL (examples: https://glowfic.com/posts/5506, https://glowfic.com/board_sections/703, https://glowfic.com/boards/215).
- Under the hood we use the glowfic-dl library to fetch and parse content consistently (classic view).
- Programmatic usage in splice:
  - Import helpers from the library: `detectGlowficUri`, `fetchGlowficThreads`, `fetchGlowficThreadsMany`, `normalizeGlowficThread`, `normalizeGlowficThreadsToItems`, `conversationsFromGlowficUrl`, `conversationsFromGlowficUrls`, and `GlowficSourceAdapter`.
  - Provide one or more Glowfic URLs and an assistant selector to build conversations where a specific character speaks as the assistant and all others are the user.
  - Assistant selection options:
    - Exact display name string (matches `character_display_name`, case-insensitive)
    - Exact handle string (matches `character_handle`, case-insensitive)
    - Regex match on display name, handle, or author
    - Predicate function `(post) => boolean`
  - Typical flow:
    1) Choose your URL(s): thread/section/board.
    2) Choose the assistant character (e.g., display name or handle).
    3) Call `conversationsFromGlowficUrl(url, assistant)` (or the `...Urls` variant) to get arrays of `{ role: "assistant" | "user", content }`.
    4) Feed those messages into your exporter or fine-tuning writer.
- Notes:
  - Markdown: Content is normalized to Markdown by default for training-friendly text; relative links/images are made absolute.
  - If you want generic items instead of conversations, use `GlowficSourceAdapter.ingest(url, logger)` which returns normalized `ContentItem[]`.
  - To mirror the Doctor Who “script” style, select the relevant character as the assistant and enable consecutive-message merging; trailing user-only tails are trimmed by default so conversations end on an assistant reply.
- Install dependency:
  - Add `glowfic-dl` to your project (Node 18+): `npm i glowfic-dl`

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
             [--dry-run] [--stats-json] [--log-level <level>] [--json-stdout] [--quiet|-q] [--verbose] [--version|-V]

    Options:
      --source <path>            Path to the Twitter archive directory
      --out <dir>                Output directory
      --format <fmt...>          One or more formats: markdown, oai, json, sharegpt (default: markdown oai)
      --system-message <text>    System message for OAI JSONL (default: "You have been uploaded to the internet")
                                 Alias: --system
      --since <iso>              Include items on/after this ISO date
      --until <iso>              Include items on/before this ISO date
      --min-length <n>           Minimum text length
      --exclude-rt               Exclude retweets (RT ...)
      --only-threads             Output threads only
      --with-media               Only include items that have media
      --dry-run, -n              Plan only; don’t write files
      --stats-json               Write a stats.json summary
      --log-level <level>        debug|info|warn|error (default: info)
      --json-stdout              Emit normalized items JSONL to stdout; logs to stderr
      --quiet, -q                Errors only
      --verbose                  Debug logging
      --version, -V              Show version
      --help, -h                 Show help

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

## Input assumptions

Supports the standard Twitter/X archive ZIP extracted to a directory that contains:

- `data/manifest.js`
- `data/tweets_media/` (optional, for media assets)
- YTD `.js` files for `tweets` and `like` data (e.g., `data/tweets.js`, `data/like.js`, split across parts)

We currently ingest:
- Tweets (YTD `tweets`) and Likes (YTD `like`)
- Media files prefixed with `<tweetId>-*` in `data/tweets_media/`

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

- More inputs: Bluesky, Reddit, ChatGPT, HF datasets (Glowfic done)
- Checkpointing and resumable pipelines (JSONL-based manifests)
- More outputs: ShareGPT enhancements, SQLite/Parquet/CSV
- Better selection: persona/character filters, time ranges
- Improved role attribution and metadata preservation

## License

MIT. See `LICENSE`.

## Acknowledgements

See the blog post above for context. CLI UX follows clig.dev-style conventions.
