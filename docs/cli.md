# CLI reference

This is the navigation reference for the current source CLI. Exact options live
in each command's `--help` output; this page centralizes command families without
maintaining a second copy of every flag.

## Availability

This reference describes branch `codex/twitter-public-markdown-export` at
`e7ce97efccffa8951448dab18e772c6041aafb6c` (source metadata 0.4.0, Node.js
22+). It is neither the default `main` branch nor an npm release. npm `latest`
is 0.1.1 as of 2026-09-06 and lacks Lync, `twitter-markdown`, `session-import`,
and `session-search`. Provisional dirty media/FiftyOne additions are outside
this reference.

Run source after `npm install`:

```sh
npx tsx splice.ts <arguments>
```

Or run `npm run build` and substitute `node dist/cli/splice.js` below.

## Help entry points

```sh
npx tsx splice.ts --help
npx tsx splice.ts twitter-markdown --help
npx tsx splice.ts lync --help
npx tsx splice.ts session-import --help
npx tsx splice.ts session-search --help
```

Main and Lync commands use exit code 0 for success, 1 for runtime or verification
failure, and 2 for invalid usage. Logs go to stderr; structured reports and data
go to stdout.

## Social archive commands

```sh
npx tsx splice.ts twitter-markdown --source <twitter-dir> --out <new-dir>
npx tsx splice.ts --source <twitter-dir-or-bluesky.car> --out <dir>
npx tsx splice.ts --glowfic <url> --out <dir> --assistant <name>
npx tsx splice.ts --glowfic-board <url> --out <dir> --all-characters
```

`twitter-markdown` is the atomic, source-specific public-writing export. The
other forms use the common social normalization pipeline. Their help owns format
selection, filters, network enrichment, media, dry runs, and logging.

## Lync commands

`splice lync --help` owns command-specific options. Converters report accounting
JSON and verify written Lync; projections preserve source identities.

| Command | Input | Output |
| --- | --- | --- |
| `lync archive` | Twitter/X directory or Bluesky CAR | Verified `.lync` |
| `lync glowfic` | `glowfic-dl` `thread.json` | Verified `.lync` |
| `lync ocr` | OCR page-set directory | Verified `.lync` |
| `lync tweet-embed` | Cached oEmbed JSON directory | Verified `.lync` |
| `lync markdown` | Raw `.lync` union | Readable Markdown |
| `lync training` | Raw `.lync` union | Accounted SFT/preference JSONL |
| `lync session-loom` | Claude Code session JSONL | Conversation Loom |
| `lync claudeai-export` | Claude.ai `conversations.json` | Conversation Looms |
| `lync chatgpt-export` | ChatGPT `conversations.json` | Conversation Looms |
| `lync twitter-threads` | Twitter/X directory or `tweets.js` | Reply-thread Looms |

```sh
npx tsx splice.ts lync archive --source <archive> --out <corpus.lync>
npx tsx splice.ts lync markdown --source <corpus.lync> --out <corpus.md>
npx tsx splice.ts lync training --source <corpus.lync> --out-dir <training-dir>
```

For portable OCR identity, keep both `--set-locator` and a non-filesystem
`--source-ref` stable across reruns:

```sh
npx tsx splice.ts lync ocr --source <pages> \
  --source-ref archive://<corpus> --set-locator <stable-name> \
  --out <corpus.lync>
```

## Private session commands

```sh
npx tsx splice.ts session-import codex --source <sessions-dir> --out <lync-dir>
npx tsx splice.ts session-import claude --source <projects-dir> --out <lync-dir>
npx tsx splice.ts session-search rebuild --source <lync-dir> --out <projection-dir>
npx tsx splice.ts session-search find --index <projection-dir> --query <literal>
```

Input and output trees must not overlap. Every discovered JSONL file is converted
or reported unreadable; non-JSONL entries are reported ignored. Search requires
SQLite with FTS5 and publishes immutable generations behind `CURRENT`. Its index
is a private, disposable projection over the Lync tree.

## Library consumers

CLI help does not define the TypeScript API. `src/index.ts` and `src/browser.ts`
own the export lists; [Architecture](architecture.md#library-boundary) explains
their responsibility boundary.
