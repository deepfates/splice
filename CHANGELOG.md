# Changelog

All notable changes to this project will be documented in this file.

This project follows Conventional Commits and semantic versioning.
Dates are in YYYY-MM-DD.

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

[0.2.0]: https://github.com/deepfates/splice/compare/v0.1.2...v0.2.0

## Unreleased

### Fixed
- Threads now correctly exclude replies from other users. Previously, if someone replied to your tweet, that reply would be included in your thread output. Now threads only include self-replies (where `in_reply_to_user_id` matches your account ID).
  - Added `accountId` and `inReplyToUserId` fields to `ContentItem` type
  - Updated Twitter source adapter to read account ID from `data/account.js`
  - Updated Twitter source adapter to extract `in_reply_to_user_id` from tweets
  - Modified `groupThreadsAndConversations` to filter threads to only include self-replies
  - Replies from others are still captured in normalized output but excluded from thread files

### Performance
- **Major optimization**: Media file indexing is now O(n) instead of O(n²). Previously, for each tweet we would read the entire media directory to find matching files. Now we build a single media map upfront, reducing processing time from minutes to seconds for large archives.
  - Processing 767k tweets with 12k media files now takes ~39 seconds (down from potentially hours)
  - Replaced per-tweet `getMediaFiles()` calls with a single `buildMediaMap()` call at ingestion start

This project follows Conventional Commits and semantic versioning.
Dates are in YYYY-MM-DD.

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
- Link to context post: “Convert your Twitter archive into training data”.

### License
- MIT license added.

---

[0.1.0]: https://github.com/deepfates/splice/releases/tag/v0.1.0
