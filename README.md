# 🫚 splice

Splice is the intake and export edge of a corpus instrument: it turns social
archives, conversation exports, OCR pages, and agent-session histories into
material a person can inspect, navigate, select, and reuse without forgetting
where it came from.

Today those sources travel through several distinct paths—normalized social
items, append-only Lync events, conversation Looms, and private search—and they
do not all preserve the same structure or have the same release status.
File-based imports stay local; Glowfic fetching and optional Bluesky enrichment
make network requests. Keep the original archive as evidence.

Splice began as a Python script and continues here as a TypeScript CLI and
library. It has powered archive-derived projects including
[deeperfates.com](https://deeperfates.com),
[keltham.lol](https://keltham.lol), and
[You Are the Assistant Now](https://youaretheassistantnow.com). The original
essay, [Convert your Twitter archive into training data](https://deepfates.com/convert-your-twitter-archive-into-training-data),
explains the practical need that gave the project its shape.

## Availability: source checkout versus npm

The npm `latest` release is 0.1.1 (verified 2026-09-06). It has the older social
pipeline, requires Node.js 18+, and does **not** contain the current Lync,
`twitter-markdown`, `session-import`, or `session-search` surfaces.

The commands below describe source branch `codex/twitter-public-markdown-export`,
whose documented product implementation is rooted at commit
`e7ce97efccffa8951448dab18e772c6041aafb6c`. Its package metadata declares 0.4.0
and Node.js 22+. This source is not an npm release or the default `main` branch.
Uncommitted extensions, including provisional media/FiftyOne work when present,
are outside the source surface documented here.

The checkout pins `@deepfates/lync@0.4.3` to an exact source-built archive under
`vendor/`; [its provenance record](vendor/LYNC-PROVENANCE.md) owns the source
commit and checksum. On 2026-09-06, a clean exact-index checkout using Node.js
22.23.2 completed `npm ci`, built Splice, and produced every artifact in the
checked-in fixture exercise below. This proves the source checkout path, not an
npm release of Splice or Lync.

Install and inspect the source CLI with:

```sh
npm ci
npx tsx splice.ts --help
```

Build and invoke the same source CLI with:

```sh
npm run build
node dist/cli/splice.js --help
```

Publishing this source package or merging the feature branch into `main` remains
an owner decision. `npx splice` without this checkout resolves to the older
registry package.

## Choose an input and result

| Source | Command family | Result | Scope |
| --- | --- | --- | --- |
| Extracted Twitter/X archive | `twitter-markdown` | Linked public-writing Markdown | Local; feature branch |
| Twitter/X archive or Bluesky CAR | main CLI | Markdown and dataset exports via `ContentItem` | Local unless Bluesky `--enrich` |
| Live Glowfic URL or board | main CLI | Character-oriented dataset exports | Network fetch |
| Twitter/X archive, Bluesky CAR, Glowfic JSON, OCR pages, or tweet cache | `lync` raw converters | Verified `.lync` events | Local files |
| Claude Code session, Claude.ai/ChatGPT export, or Twitter threads | `lync` Loom converters | `.loom.json` snapshot(s), not raw `.lync` | Local files |
| Codex or Claude Code session tree | `session-import`, then `session-search` | Private Lync tree and disposable local search | Local files |

In a source checkout, [the CLI reference](docs/cli.md) indexes these command
families. Run the corresponding `--help` command for exact flags.

## Social archive export

For an extracted Twitter/X archive, the narrow public-writing path creates one
portable Markdown note per authored tweet, community tweet, nonempty Note Tweet,
or published Article. It excludes standalone likes and private archive areas;
liked-post text is used only to recover missing reply context.

```sh
npx tsx splice.ts twitter-markdown \
  --source ~/Downloads/twitter-archive \
  --out ~/Downloads/twitter-markdown
```

The output directory must be new. Splice publishes it only after notes, media,
README, and accounting report succeed. Use `--dry-run` to inspect reconciliation
without writing, or `--no-media` for text only. The command reads an extracted
directory; it neither extracts nor uploads the ZIP.

The older normalized pipeline accepts a Twitter/X directory, Bluesky CAR, or
Glowfic URL and writes Markdown, OAI JSONL, normalized JSONL, or ShareGPT. This
checked-in fixture is the smallest local exercise:

```sh
npm run start -- \
  --source tests/integration/fixtures/archive \
  --out ./out
```

Bluesky `--enrich` and Glowfic URL ingestion use the network; ordinary archive
file conversion is local. The normalized pipeline is not a lossless interchange
format: source-specific fields remain in the original archive.

For the checked-in fixture, success includes:

```text
out/threads/20250101/Top_tweet_with_link_httpstcoabc123.md
out/conversations_oai.jsonl
out/normalized_items.jsonl
out/.splice/checkpoints/<checkpoint-id>.json
out/.splice/objects/<content-hash>.json|jsonl
```

The `.splice` directory is rebuildable checkpoint state. Keep it when run
provenance matters; the human- and model-facing exports do not depend on it
after the run finishes.

## Lync corpus conversion

Create a verified Lync history from a Twitter/X archive or Bluesky CAR:

```sh
npx tsx splice.ts lync archive \
  --source ~/Downloads/twitter-archive \
  --out ./out/twitter.lync
```

Other raw-event converters accept `glowfic-dl` JSON, an OCR page set, or cached
tweet embeds. Each reports emitted records, explicit skips, timestamp fallbacks,
and verification counts as JSON. Every written line must be accepted by
`@deepfates/lync`.

Project a Lync union without reminting source identities:

```sh
npx tsx splice.ts lync markdown --source ./out/twitter.lync --out ./out/twitter.md
npx tsx splice.ts lync training --source ./out/twitter.lync --out-dir ./out/training --render messages
```

The raw-event commands and the Loom commands are siblings under `splice lync`;
Loom conversion is not a projection from the `.lync` produced above.

## Private agent-session intake and search

Convert complete Codex or Claude Code trees into a separate private Lync tree:

```sh
npx tsx splice.ts session-import codex --source ~/.codex/sessions --out ./private-lync/codex
npx tsx splice.ts session-import claude --source ~/.claude/projects --out ./private-lync/claude
```

The trees must not overlap. Raw JSONL remains authoritative; generated Lync is
deterministic normalization. On POSIX, importer-created directories are mode
0700 and files are mode 0600.

Build and query the disposable search projection:

```sh
npx tsx splice.ts session-search rebuild --source ./private-lync --out ./private-search
npx tsx splice.ts session-search find --index ./private-search --query "literal phrase"
```

Search requires `sqlite3` with FTS5 and queries of at least three characters.
Only user and assistant message text is indexed; system/developer prompts,
reasoning, tool calls and results, and sidecars are excluded. Hits include
source coordinates and native `codex resume` or `claude --resume` arguments.
This filter separates record kinds; it cannot guarantee that user or assistant
prose contains no sensitive text.

## Boundaries and present limits

- Keep the original archive for source-specific fields, provenance, and re-import.
- The common social pipeline, Twitter writing exporter, Lync converters, Loom
  exporters, and session intake are distinct routes; not every source passes
  through one universal normalized type.
- Bluesky media blobs are referenced but not downloaded by the social pipeline.
- SQLite search is a rebuildable view, not a corpus authority.
- Fixture and automated tests establish bounded mechanics, not compatibility
  with every provider export or the usefulness of a personal corpus.

In a source checkout, [Architecture](docs/architecture.md) describes ownership
and recovery boundaries. Identity migration observations remain discoverable in
the dated reports under `reports/`.

## Library entry points

`@deepfates/splice` exports Node-oriented adapters, transforms, Lync mappers,
projections, and writers. `@deepfates/splice/browser` exports a filesystem-free
Twitter adapter for applications that already own decoded archive members. The
browser adapter performs no I/O, network requests, or logging; its host owns
private file selection and persistence. Exact exports live in `src/index.ts`
and `src/browser.ts`.

```ts
import { twitterArchiveEntriesToConversation } from "@deepfates/splice/browser";

const { snapshot, stats } = await twitterArchiveEntriesToConversation([
  { path: "data/manifest.js", text: manifestText },
  { path: "data/account.js", text: accountText },
  { path: "data/tweets.js", text: tweetsText },
  { path: "data/like.js", text: likesText },
]);
```

The adapter parses Twitter's JavaScript-wrapped JSON as data rather than
evaluating it. It returns a deterministic conversation Loom with readable text,
reply relationships, source coordinates, and malformed/unresolved accounting.
Media bytes and arbitrary provider fields remain outside this browser contract.

## Development and evidence

```sh
npm run build
npm test
```

See [CHANGELOG.md](CHANGELOG.md) for released and unreleased changes and
`.tickets/` for bounded repository-owned work.

## License

MIT. See [LICENSE](LICENSE).
