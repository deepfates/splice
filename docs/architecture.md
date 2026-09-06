# Architecture

Splice is an importer and projector. A source archive remains authority for its
provider records and bytes. Splice can turn that evidence into a common social
item stream, deterministic Lync events, conversation Looms, or source-specific
Markdown. Those routes share helpers but not one universal intermediate type.

## State and authority

| Representation | Responsibility | Authority |
| --- | --- | --- |
| Provider archive, JSONL, CAR, or page set | Original records and bytes | Source evidence; retain for re-import and unrepresented fields |
| `ContentItem` | Common fields for the original social pipeline | Lossy in-memory normalization |
| `.lync` | Deterministic append-only events with identity and provenance | Durable normalized corpus record |
| `.loom.json` | Folded conversation snapshot | Derived interoperable snapshot |
| Markdown and training JSONL | Human/model-facing presentation | Derived output |
| `.splice` checkpoints | Content-addressed pipeline intermediates | Rebuildable execution evidence |
| SQLite session search | Local navigation over imported sessions | Disposable projection over the Lync tree |

## Social archive route

The original CLI detects Twitter/X directories or Bluesky CAR files, normalizes
them to `ContentItem[]`, applies filters and grouping, then invokes Markdown,
OAI, normalized JSONL, ShareGPT, and stats writers.

```text
Twitter/X or Bluesky -> ContentItem[] -> filters/grouping -> output writers
```

Glowfic fetching and board segmentation enter through their own training path.
Glowfic and explicit Bluesky enrichment use the network.

`twitter-markdown` is deliberately separate. Its reader models authored writing,
Articles, reply context, and media that the simpler type does not own. Its writer
plans portable paths and collisions before atomically publishing the complete
directory. The general writers do not share one transaction across all outputs.

## Lync corpus route

Raw converters map source records to deterministic event bodies with source
actor/provenance and explicit accounting. Twitter/X and Bluesky reuse
`ContentItem`; Glowfic JSON, OCR, tweet embeds, and agent sessions use their own
mappers because their causal and identity contracts differ.

For archive conversion, `ContentItem` retains the provider record in `raw`, but
its common relationship field names only one parent. Do not infer that every
importer preserves the same graph shape merely because each can produce Lync.

```text
source records -> deterministic mapping -> Lync serialization
               -> @deepfates/lync verification -> retained .lync
               -> Markdown / training projections
```

An invalid line is a conversion failure. Skips and timestamp substitutions are
reported. Import time is omitted by default so unchanged inputs and options can
reproduce identical bytes; `--marked-at` deliberately changes that property.

Markdown and training parse Lync and preserve event IDs. They use the
kind/profile presentation contract from `@deepfates/lync`; unknown payloads are
not recursively mined for text.

Current identity schemes include `splice/ocr-portable-v2`,
`splice-session-tree/v1`, and Claude repeat handling under
`splice-claude-repeat/v2`. Breaking recipes must use a new scheme rather than
changing bytes under an existing ID. Known earlier schemes and recovery are in
the dated [OCR](../reports/2026-07-30-ocr-portability-cutover.md) and
[session](../reports/2026-07-22-session-identity-cutover.md) reports.

## Private session route

The importer classifies a Codex or Claude Code tree, normalizes each root-relative
JSONL coordinate, writes a separate Lync file, verifies it, and accounts for
unreadable and ignored entries. Raw JSONL remains authority.

```text
private JSONL tree -> deterministic Lync tree -> immutable staging snapshot
                  -> SQLite FTS5 generation -> literal hit + resume coordinates
```

Search rejects cross-file same-ID/different-body conflicts. Rebuild takes a
fail-fast writer lock, verifies an immutable generation, then replaces `CURRENT`;
a controlled failure leaves the prior generation current. Only user and
assistant message text enters the database; those messages may themselves
contain sensitive material, so this is not a content-secrecy guarantee.

POSIX paths receive restrictive modes. Windows has no equivalent mode guarantee,
and replacing `CURRENT` can create a brief retry interval for new readers.
Published generations are not automatically garbage-collected.

## Library boundary

`@deepfates/splice` exports Node source readers, common transforms, writers,
Lync/Loom converters, session functions, and adapter interfaces. Exact names
live in `src/index.ts`. The interfaces are composition contracts, not a runtime
plugin registry, and they cover the common `ContentItem` path rather than forcing
source-specific routes through it.

`@deepfates/splice/browser` exports the filesystem-free Twitter adapter from
`src/browser.ts`. It accepts decoded members and returns a deterministic Loom
plus accounting. The host owns I/O, networking, selection, and persistence.

## Failure and recovery

- Commands are process-scoped; there is no shared scheduler or general
  cancellation protocol.
- Twitter Markdown, session replacement, and search publication stage work
  before replacing final targets; the main social writers are not one transaction.
- Lync and session intake fail on verification errors and preserve accounting.
- No documented local route uploads, publishes, or deletes the source archive.
- Automated tests establish bounded mechanics, not every provider export,
  independent reproduction, or corpus usefulness.
