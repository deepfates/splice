# Agent-session identity cutover (2026-07-22)

This historical record preserves the migration observation behind the current
session identity contract. See [Architecture](../docs/architecture.md#private-session-route)
and `splice session-import --help` for maintained guidance.

## Change

The tree importer adopted `splice-session-tree/v1`. A file's identity became its
normalized root-relative path under the archive root, prefixed by the schema,
rather than its physical location or basename alone.

Claude UUID records adopted `splice-claude-repeat/v2`. The first occurrence in
byte-sorted tree order remains canonical. Later byte-identical occurrences become
deterministic `lore/pointer` events; differing occurrences become
`lore/annotation` events retaining the source record. This preserves physical
occurrences without weakening same-ID conflict detection.

## Migration audit

The cutover audit searched the workstation home directory, excluding macOS's
system-managed `Library` tree, for output attributed to `splice/codex-session` or
`splice/claude-session`. It found none. Basename-only output was therefore
treated as disposable pre-release output, not a migration source.

That negative was bounded to the inspected workstation and scope. It did not
prove that such files never existed elsewhere, and the original acceptance work
used synthetic session histories rather than private real histories.

## Recovery rule

Regenerate basename-era or interrupted v1 Claude output from authoritative raw
JSONL. Do not union it with current output because the IDs belong to a different
recipe. Codex identities were unchanged by the Claude repeat-v2 correction.

Evidence coordinates include commits `da9b5a1`, `6a3cec4`, and `fa667fd`;
`src/outputs/lync-session-*.ts`; and session tests under `tests/lync/` and
`tests/integration/`.
