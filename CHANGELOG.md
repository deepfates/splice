# Changelog

All notable changes to this project will be documented in this file.

This project follows Conventional Commits and semantic versioning.
Dates are in YYYY-MM-DD.

## [Unreleased]

- Raw-Lync Markdown and training now consume
  `@deepfates/lync/presentation` instead of maintaining their own shallow text
  heuristics. Known source/profile contracts are allowlisted, source identity
  is unchanged, and incidental raw fields do not enter readable or model text.
- Added the filesystem-free `@deepfates/splice/browser` Twitter archive
  adapter. Local applications can turn decoded ZIP/directory members into one
  deterministic conversation loom without uploading content or evaluating the
  archive's JavaScript wrappers.
- The browser projection retains every readable tweet, retweet, and like,
  preserves held reply topology and exact external-parent IDs, and reports
  malformed records and unresolved replies explicitly.
- Syncable browser Looms carry readable text and explicit provenance without
  copying arbitrary unpresented provider fields from archive records.

## [0.4.0] - Unpublished release candidate

This release candidate targets `@deepfates/lync` 0.4.0 and Node.js 22 or newer.
Registry publication remains sequenced after the Lync 0.4.0 publication.

### Added
- Deterministic raw Lync importers for Twitter archives, Glowfic, OCR page sets,
  tweet-embed caches, Codex sessions, Claude Code sessions, ChatGPT exports, and
  Claude.ai exports.
- Conversation-loom adapters that preserve branching message ancestry.
- Private agent-session tree intake and bounded local search.
- Raw Lync Markdown, SFT, and preference projections that retain source event
  identities and standard selection annotations.

### Changed
- Lync output is serialized and independently parsed through the reference
  implementation; unsafe or lossy output fails loudly.
- Repeated Claude session identities are represented without weakening
  same-id conflict detection.
- Training projection understands structured message events and ignores
  tool-only records without losing surrounding context.

### Fixed
- Cycle verification remains linear at large-file and large-line boundaries.
- Empty public message records and stale tweet-cache size assumptions no longer
  corrupt otherwise valid intake.

## [0.3.0] - 2026-01-04

### Added
- **Glowfic source adapter**: Ingest collaborative fiction from glowfic.com
  - `--glowfic <url>` for threads, sections, or boards
  - `--assistant <name>` to select which character becomes the assistant role
  - `--assistant-regex <pattern>` for complex character matching
  - 827 conversations from a single Planecrash thread (test)
- **Multi-character board export**: Create datasets for all characters at once
  - `--glowfic-board <url> --all-characters` for bulk export
  - `--min-posts <n>` to filter characters by activity (default: 10)
  - HuggingFace-compatible dataset structure with per-character splits
- Lazy-load Glowfic module for Node 18 compatibility

### Fixed
- Threads now correctly exclude replies from other users
  - Added `accountId` and `inReplyToUserId` fields to `ContentItem` type
  - Replies from others are still captured in normalized output but excluded from thread files

### Performance
- **Media indexing optimization**: O(n) instead of O(n²)
  - Processing 767k tweets with 12k media files: ~39 seconds (down from potentially hours)

## [0.2.0] - 2026-01-04

### Added
- **Bluesky CAR file import**: Parse AT Protocol repository exports via `@atproto/repo`
  - Fetch full thread context with `--enrich` flag (parent posts from public API)
  - Multi-turn conversations: 8,939 with 4+ messages for test dataset
  - Strip Bluesky domain-style handles (`@user.bsky.social`)
- **Conversation deduplication**: Keep only the longest chain per root message by default
  - Eliminates redundant overlapping fragments
  - Example: 17K conversations → 6,216 unique conversations
- Date-baked paths for markdown export (`out/threads/YYYYMMDD/slug.md`)

### Fixed
- Walk full parent chains for longer conversations
  - Previously capped at ~4 messages due to early break on processed posts
  - Now captures conversations up to 23+ messages
  - 1,546 conversations with 5+ messages; 375 with 15+ messages

### Changed
- JSON now included in default output formats

[0.3.0]: https://github.com/deepfates/splice/compare/v0.2.0...v0.3.0

[0.4.0]: https://github.com/deepfates/splice/compare/v0.3.0...HEAD

[0.2.0]: https://github.com/deepfates/splice/compare/v0.1.2...v0.2.0

## [0.1.1] - 2025-10-15

### Added
- CLI flags and polish:
  - `--json-stdout` to stream normalized items as JSONL to stdout (logs to stderr)
  - `--quiet` (`-q`) and `--verbose` shorthands for log level
  - Unknown-flag warnings with simple suggestions
  - Format validation with friendly messages
- Selection and filtering:
  - `--since` / `--until` (ISO), `--min-length`, `--exclude-rt`, `--only-threads`, `--with-media`
- Exports:
  - ShareGPT export (`--format sharegpt`) to `out/sharegpt.json`
  - Stats summary (`--stats-json`) to `out/stats.json`
- Config:
  - Load defaults via config files using cosmiconfig (e.g., `.splicerc.*`, package.json `"splice"`)
- Docs/packaging:
  - README updates and package `"files"` whitelist for a lean npm tarball

### Notes
- Backward-compatible with v0.1.0.

[0.1.1]: https://github.com/deepfates/splice/releases/tag/v0.1.1

## [0.1.0] - 2025-10-15

### Added
- Initial single‑file TypeScript CLI, `splice`.
- Twitter/X archive ingestion:
  - Detects `data/manifest.js`.
  - Parses YTD `tweets` and `like` data files.
  - Collects media from `data/tweets_media/`.
- Normalized schema and grouping:
  - Normalizes items to a simple ContentItem shape.
  - Builds self‑reply threads and basic conversations.
- Exports:
  - Markdown:
    - Per‑thread files under `out/threads/`, named like `YYYYMMDD-thread-<slug>.md`.
    - Non‑thread tweets as individual files under `out/tweets/`, named like `YYYYMMDD-tweet-<slug>.md`.
    - Copies referenced media into `out/images/` and links them from Markdown.
  - OAI JSONL:
    - Writes `out/conversations_oai.jsonl`.
    - Supports custom system message via `--system`/`--system-message` or `SPLICE_SYSTEM_MESSAGE`.
  - JSON (normalized items):
    - Writes `out/normalized_items.jsonl` (one item per line).
- CLI UX and flags (clig.dev‑style):
  - `--source`, `--out`, `--format markdown|oai|json`.
  - `--system` / `--system-message "<text>"` and `SPLICE_SYSTEM_MESSAGE`.
  - `--dry-run` (`-n`) for plan‑only runs.
  - `--log-level debug|info|warn|error`, plus shorthands `--quiet` (`-q`) and `--verbose`.
  - `--json-stdout` to emit normalized items as JSONL to stdout (logs remain on stderr).
  - `--version` (`-V`), `--help` (`-h`).
  - Unknown flag warnings with simple suggestions; format validation with friendly messages.
- Parsing robustness:
  - Cleans `window.* = ...;` wrappers.
  - Falls back to evaluating cleaned JS when `JSON.parse` fails (handles non‑strict YTD JS).
- Logging and exit codes:
  - Logs to stderr; data to files/stdout as appropriate.
  - Exit codes: `0` success, `1` runtime error, `2` invalid args/source.

### Fixed
- Ensure `--system-message` is honored; `--system` alias and env fallback added.
- Correct Node `FileHandle.write` usage for TypeScript typings.

### Tests
- Vitest integration tests invoking the CLI with `tsx`:
  - Baseline conversion: threads, OAI JSONL, cleaning heuristics, system message.
  - Media handling: copies media and inserts correct Markdown image links.

### CI
- GitHub Actions matrix across OS (Ubuntu, macOS, Windows) and Node (18, 20, 22):
  - `npm ci` → build → tests.

### Docs
- README with quick start, concise usage, and short roadmap.
- Link to context post: "Convert your Twitter archive into training data".

### License
- MIT license added.

---

[0.1.0]: https://github.com/deepfates/splice/releases/tag/v0.1.0
