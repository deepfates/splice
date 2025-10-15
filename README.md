# splice

Convert your Twitter/X archive into normalized threads and export to Markdown, OAI JSONL, and/or JSON (normalized items). Single-file TypeScript CLI, human-first, composable.

- Human-friendly CLI (clig.dev principles)
- Outputs:
  - Markdown per-thread, plus non-thread tweets grouped by date
  - OAI-compatible JSONL for language model fine-tuning/evaluation
  - Normalized items JSONL (one item per line, for debugging/inspection)
- Copies referenced media into an images/ folder
- Works directly with your Twitter archive (manifest.js + data files)

## Background and context

This project is the TypeScript successor to the original Python script described here:
- Convert your Twitter archive into training data (blog post): https://deepfates.com/convert-your-twitter-archive-into-training-data

That early script extracted tweets, threads, and media to Markdown, and generated OAI-friendly JSONL for fine-tuning. It was used to power experiments like deeperfates.com and to build character models from Glowfic (e.g., Keltham and Nethys), using a slightly different importer.

splice is the next step: a small, elegant CLI that sets a foundation for a pluggable “ingest → normalize → export” pipeline.

## Vision: splice into the loom, weave your dataset

The metaphor we’re aiming at:
- Splice: bring strands of text from many archives together (Twitter/X today; Bluesky, ChatGPT, Reddit, Hugging Face datasets, Glowfic, and more soon).
- Loom: a normalized schema where each source adapter lands cleanly.
- Weave: choose how to export—Markdown for reading/publishing, OAI JSONL for training, JSONL for inspection, and future database/dataset outputs.

Planned capabilities:
- Import from many sources and formats (archive zips, JSONL datasets, custom exports).
- Select and filter by character/persona, thread types, time windows, and other metadata.
- Apply reward-signal/labeling strategies (e.g., thumbs-up replies, likes, cluster labels).
- Output curated training sets tailored to a specific voice or purpose.

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

## Roadmap

Near-term
- Input adapters: Bluesky/ATProto, Reddit, ChatGPT exports, Glowfic, Hugging Face datasets (JSONL)
- Output adapters: SQLite/Parquet/CSV; ShareGPT JSON; Hugging Face dataset packager
- Twitter coverage: “note tweets”/long posts, additional YTD shapes, better parent reconstruction
- Heuristics: better role attribution (detect account owner vs others), richer text cleanup and URL expansion
- Selection and filtering: character/persona filters, time windows, media presence, RT/exclusion toggles
- JSON/STDOUT: add --json/--plain modes to emit normalized items to stdout for shell pipelines

Medium-term
- Labeling/curation: clustering and LLM labeling to improve dataset quality; reward-signal hooks
- Evaluation: plug-in eval tasks for quick sanity checks on curated datasets
- Plugin model: split adapters/outputs into modules; simple registry and discovery
- Performance: worker threads for heavy transforms; concurrency tuning

Long-term
- Multi-source splicing into a unified corpus; project-level configs/recipes for specific personas
- Dataset provenance and reproducibility (manifest of selections, filters, versions)
- Optional UI to browse/select threads, personas, and export plans

## License

MIT. See `LICENSE`.

## Acknowledgements

Background
- Blog: Convert your Twitter archive into training data — https://deepfates.com/convert-your-twitter-archive-into-training-data
- Early experiments: deeperfates.com; Glowfic importers used to create character models (e.g., Keltham and Nethys)

CLI UX inspired by:
- cli-guidelines: https://clig.dev
- 12 Factor CLI apps
- Heroku CLI style guide
- Simon Willison’s CLI notes
