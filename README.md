# splice

Convert your Twitter/X archive into normalized threads and export to Markdown, OAI JSONL, and/or JSON (normalized items). Single-file TypeScript CLI, human-first, composable.

- Human-friendly CLI (clig.dev principles)
- Outputs:
  - Markdown per-thread, plus non-thread tweets grouped by date
  - OAI-compatible JSONL for language model fine-tuning/evaluation
  - Normalized items JSONL (one item per line, for debugging/inspection)
- Copies referenced media into an images/ folder
- Works directly with your Twitter archive (manifest.js + data files)

## Why

A minimalist CLI to turn your Twitter archive into:
- Markdown you can read or publish
- OAI JSONL you can train on
- A normalized JSONL dump for inspection

Today it imports Twitter/X. The plan is to splice in other archives (Bluesky, ChatGPT, Reddit, Glowfic, Hugging Face, …) and let you pick the strands you want to weave into a training set.

More context: https://deepfates.com/convert-your-twitter-archive-into-training-data

## Quick start

Requirements:
- Node.js 18+ (tested with recent Node LTS and current)
- For direct execution: `tsx` (installed automatically when using `npx`)

Run with tsx (no build needed):

    npx tsx splice.ts --source /path/to/twitter-archive --out ./out

Build then run with Node:

    npm install
    npm run build
    node dist/splice.js --source /path/to/twitter-archive --out ./out

Dev/watch mode:

    npm run dev -- --source /path/to/twitter-archive --out ./out

## Usage

Help (equivalent to `--help`):

    splice — convert a Twitter archive to Markdown, OAI JSONL, and/or JSON

    Usage:
      splice --source <path> --out <dir> [--format markdown oai json] [--system-message <text>] [--dry-run] [--log-level <level>]

    Options:
      --source <path>            Path to the Twitter archive directory
      --out <dir>                Output directory
      --format <fmt...>          One or more formats: markdown, oai, json (default: markdown oai)
      --system-message <text>    System message for OAI JSONL (default: "You have been uploaded to the internet")
                                 Alias: --system
      --dry-run, -n              Plan only; don’t write files
      --log-level <level>        debug|info|warn|error (default: info)
      --help, -h                 Show help
      --version, -V              Show version

    Environment:
      SPLICE_SYSTEM_MESSAGE      Alternative way to set the OAI system message
                                 (flag value takes precedence)

Exit codes:
- 0: success
- 1: runtime error
- 2: invalid arguments or source detection failed

Stdout/Stderr:
- Primary logs and progress go to stderr (so you can pipe stdout safely when we add stdout formats)
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

All three formats:

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format markdown oai json

Use environment variable for system message:

    SPLICE_SYSTEM_MESSAGE="Be concise." npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --format oai

Dry run with debug logs (no files written):

    npx tsx splice.ts --source ~/Downloads/my-twitter-archive --out ./out --dry-run --log-level debug

## Input assumptions

This first version supports the standard Twitter archive ZIP extracted to a directory that contains:

- `data/manifest.js`
- `data/tweets_media/` (optional, for media assets)
- YTD `.js` files for `tweets` and `like` data (e.g., `data/tweets.js`, `data/like.js`, split across parts)

We currently ingest:
- Tweets (YTD `tweets`) and Likes (YTD `like`)
- Media files prefixed with `<tweetId>-*` in `data/tweets_media/`

## Output layout

On a successful run, you’ll see:

- `out/threads/` — one Markdown file per detected thread (user self-replies)
- `out/tweets_by_date/` — one Markdown file per day for non-thread tweets
- `out/images/` — copied media files referenced by the Markdown
- `out/conversations_oai.jsonl` — OAI JSONL file with conversations built from threads and reply chains
- `out/normalized_items.jsonl` — JSONL dump of normalized ContentItem records (one item per line)

Notes:
- Filenames for threads are derived from the first five words of the top post (sanitized).
- The OAI JSONL file includes a top-level “system” message (configurable).

## Development

Install deps:

    npm install

Run with tsx:

    npm run start -- --source /path/to/twitter-archive --out ./out

Watch mode:

    npm run dev -- --source /path/to/twitter-archive --out ./out

Build (emits `dist/splice.js` and sets up the `splice` bin):

    npm run build

Run the built CLI:

    node dist/splice.js --source /path/to/twitter-archive --out ./out

## Testing

Run the full test suite (includes an integration test that verifies Markdown, OAI JSONL with system message, and normalized JSONL outputs):

    npm test

Watch tests:

    npm run test:watch

## Roadmap (short)

- More inputs: Bluesky, Reddit, ChatGPT, Glowfic, HF datasets
- More outputs: ShareGPT, SQLite/Parquet/CSV
- Better selection: persona/character filters, time ranges
- Note tweets and improved role attribution

## License

MIT. See `LICENSE`.

## Acknowledgements

See the blog post above for context. CLI UX follows clig.dev-style conventions.
