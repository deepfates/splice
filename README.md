# 🫚 splice

Turn a Twitter/X archive into linked Markdown you can read in Obsidian, export
conversations as training data, or search your old coding-agent sessions for a
phrase you remember. Splice is a TypeScript CLI and library for getting material
out of provider exports and into files you can use.

It also converts supported archives and OCR pages into Lync histories, preserving
source identities and relationships for further work. Different commands retain
different parts of the source; keep your original archives. File-based imports
stay local. Glowfic fetching and optional Bluesky enrichment use the network.

Splice began as a Python script. It has powered archive-derived projects including
[deeperfates.com](https://deeperfates.com),
[keltham.lol](https://keltham.lol), and
[You Are the Assistant Now](https://youaretheassistantnow.com). The original
essay, [Convert your Twitter archive into training data](https://deepfates.com/convert-your-twitter-archive-into-training-data),
explains the practical need that gave the project its shape.

<a id="availability-source-checkout-versus-npm"></a>

## Get the source CLI

Use Node.js 22+ in a checkout of `codex/twitter-public-markdown-export` for the
commands below. This branch is not yet on `main` or npm. `npx splice` outside
this checkout gets the older npm release, not these commands.

```sh
npm ci
npx tsx splice.ts --help
```

Build and invoke the same source CLI with:

```sh
npm run build
node dist/cli/splice.js --help
```

The checkout includes a pinned source-built Lync dependency; no sibling Lync
checkout is needed. See [source and release details](#source-and-release-details)
for versions and provenance.

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

## Read your Twitter/X writing as Markdown

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

### Source and release details

The npm `latest` release is 0.1.1 (verified 2026-09-06). It requires Node.js 18+
and has the older social pipeline, without the current Lync, `twitter-markdown`,
`session-import`, or `session-search` commands.

The source branch declares version 0.4.0 and Node.js 22+. Its documented product
implementation is rooted at commit `e7ce97efccffa8951448dab18e772c6041aafb6c`.
Uncommitted extensions, including provisional media/FiftyOne work when present,
are not described here. Publishing this package or merging the feature branch
into `main` remains an owner decision.

`@deepfates/lync@0.4.3` is pinned to a source-built archive under `vendor/`;
[its provenance record](vendor/LYNC-PROVENANCE.md) records the source commit and
checksum. On 2026-09-06, a clean source checkout using Node.js 22.23.2 completed
`npm ci`, built Splice, and produced every artifact in the checked-in fixture
exercise above. Other provider exports may differ; inspect conversion reports
and retain the source archive.

## License

MIT. See [LICENSE](LICENSE).
