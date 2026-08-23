import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type Level, sanitizeFilename } from "../core/types.js";
import type {
  TwitterPublicWritingRecord,
  TwitterPublicWritingResult,
} from "../sources/twitter-public-writing.js";

export interface TwitterPublicMarkdownOptions {
  copyMedia?: boolean;
  dryRun?: boolean;
  timeZone?: string;
}

type ReplyContextStatus =
  | "authored"
  | "deleted"
  | "liked"
  | "unavailable"
  | "missing";

export interface TwitterPublicMarkdownReport {
  records: number;
  notesWritten: number;
  notesByKind: Record<TwitterPublicWritingRecord["kind"], number>;
  replies: number;
  replyContext: Record<ReplyContextStatus, number>;
  authoredParentLinks: number;
  authoredChildLinks: number;
  mediaReferenced: number;
  mediaCopied: number;
  mediaMissing: number;
  timeZone: string;
  outputDirectory: string;
  stats: TwitterPublicWritingResult["stats"];
}

interface MediaPlan {
  sources: string[];
  targets: Map<string, string>;
}

interface VaultPlan {
  paths: Map<TwitterPublicWritingRecord, string>;
  recordsById: Map<string, TwitterPublicWritingRecord>;
  pathsById: Map<string, string>;
  childrenById: Map<string, TwitterPublicWritingRecord[]>;
  media: MediaPlan;
  replyContext: TwitterPublicMarkdownReport["replyContext"];
  authoredParentLinks: number;
  authoredChildLinks: number;
}

// Historical Splice exports rendered Pacific timestamps with a fixed UTC-8 offset.
const DEFAULT_TIME_ZONE = "Etc/GMT+8";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function prose(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^ {0,3}#/.test(line)) return line.replace("#", "\\#");
      // A tweet that starts a line with ">" (greentext) is prose, not a quote.
      if (/^ {0,3}>/.test(line)) return line.replace(">", "\\>");
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return `\\${line}`;
      // "<thinking>" in a tweet is text, not a tag. Escape tag-like "<" so
      // Markdown and MDX readers do not parse it as HTML/JSX.
      return line.replace(/<(?=[A-Za-z/!?])/g, "\\<");
    })
    .join("\n")
    .trim();
}

function slug(record: TwitterPublicWritingRecord): string {
  const seed = record.title || record.text.split(/\s+/).slice(0, 8).join(" ");
  const value = sanitizeFilename(seed, 64)
    .replace(/_/g, "-")
    .toLocaleLowerCase("en-US");
  return value === "untitled" ? `${record.kind}-${record.id}` : value;
}

function localDate(record: TwitterPublicWritingRecord, timeZone: string): string {
  if (!record.createdAt) return "unknown-date";
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) return "unknown-date";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function kindDirectory(record: TwitterPublicWritingRecord): string {
  if (record.kind === "community-tweet") {
    return path.join("community-tweets", record.communityId ?? "unknown-community");
  }
  if (record.kind === "note-tweet") return "notes";
  if (record.kind === "article") return "articles";
  if (record.kind === "deleted-tweet") return "deleted-tweets";
  return "tweets";
}

function recordPath(record: TwitterPublicWritingRecord, timeZone: string): string {
  const day = localDate(record, timeZone);
  const [year, month] = day === "unknown-date" ? ["unknown", "unknown"] : day.split("-");
  const directory = record.kind === "article"
    ? path.join(kindDirectory(record), year)
    : path.join(kindDirectory(record), year, month);
  return path.join(directory, `${day}--${slug(record)}--${record.id}.md`);
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertTwitterId(value: string, label: string): void {
  if (!/^\d+$/.test(value)) {
    throw new Error(`twitter public markdown: invalid ${label} ${JSON.stringify(value)}`);
  }
}

function resolveWithin(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error(`twitter public markdown: output path escapes vault: ${relative}`);
  }
  return absolute;
}

function relativeMarkdownLink(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).split(path.sep).join("/");
  return encodeURI(relative);
}

function markdownAlt(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\n/g, " ");
}

export function portableMediaBasename(sourcePath: string): string {
  const basename = path.basename(sourcePath).normalize("NFC");
  const rawExtension = path.extname(basename);
  let stem = basename.slice(0, basename.length - rawExtension.length)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[#[\]()]/g, "_")
    .replace(/[ .]+$/g, "");
  let extension = rawExtension
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[#[\]()]/g, "_")
    .replace(/[ .]+$/g, "")
    .slice(0, 32);
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem)) stem = `_${stem}`;
  if (!stem) stem = "media";
  const maxStemLength = Math.max(1, 180 - extension.length);
  stem = stem.slice(0, maxStemLength).replace(/[ .]+$/g, "") || "media";
  if (extension === ".") extension = "";
  return `${stem}${extension}`;
}

function buildMediaPlan(records: TwitterPublicWritingRecord[]): MediaPlan {
  const targets = new Map<string, string>();
  const used = new Map<string, string>();
  for (const record of records) {
    for (const media of record.media) {
      if (!media.sourcePath || targets.has(media.sourcePath)) continue;
      const target = path.join("media", record.id, portableMediaBasename(media.sourcePath));
      const key = portablePathKey(target);
      const prior = used.get(key);
      if (prior && prior !== media.sourcePath) {
        throw new Error(`twitter public markdown: media collision at ${target}`);
      }
      used.set(key, media.sourcePath);
      targets.set(media.sourcePath, target);
    }
  }
  return { sources: [...targets.keys()].sort(), targets };
}

function contextStatus(
  record: TwitterPublicWritingRecord,
  recordsById: Map<string, TwitterPublicWritingRecord>,
): ReplyContextStatus | null {
  if (!record.parentId) return null;
  if (recordsById.has(record.parentId)) return "authored";
  if (!record.replyContext) return "missing";
  if (record.replyContext.source === "deleted-tweet") return "deleted";
  if (/This (?:Post|Tweet) is (?:from a suspended account|unavailable)/i.test(record.replyContext.text)) {
    return "unavailable";
  }
  return "liked";
}

function buildVaultPlan(
  records: TwitterPublicWritingRecord[],
  timeZone: string,
): VaultPlan {
  const paths = new Map<TwitterPublicWritingRecord, string>();
  const usedPaths = new Set<string>();
  const recordsById = new Map<string, TwitterPublicWritingRecord>();
  const pathsById = new Map<string, string>();
  for (const record of records) {
    assertTwitterId(record.id, "record id");
    if (record.communityId) assertTwitterId(record.communityId, "community id");
    const relative = recordPath(record, timeZone);
    const key = portablePathKey(relative);
    if (usedPaths.has(key)) {
      throw new Error(`twitter public markdown: output collision at ${relative}`);
    }
    usedPaths.add(key);
    paths.set(record, relative);
    if (recordsById.has(record.id)) {
      throw new Error(`twitter public markdown: ambiguous cross-kind id ${record.id}`);
    }
    recordsById.set(record.id, record);
    pathsById.set(record.id, relative);
  }

  const childrenById = new Map<string, TwitterPublicWritingRecord[]>();
  for (const record of records) {
    if (!record.parentId || !recordsById.has(record.parentId)) continue;
    const children = childrenById.get(record.parentId) ?? [];
    children.push(record);
    childrenById.set(record.parentId, children);
  }
  for (const children of childrenById.values()) {
    children.sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
    );
  }

  const replyContext: TwitterPublicMarkdownReport["replyContext"] = {
    authored: 0,
    deleted: 0,
    liked: 0,
    unavailable: 0,
    missing: 0,
  };
  let authoredParentLinks = 0;
  let authoredChildLinks = 0;
  for (const record of records) {
    const status = contextStatus(record, recordsById);
    if (status) replyContext[status] += 1;
    if (status === "authored") authoredParentLinks += 1;
    authoredChildLinks += childrenById.get(record.id)?.length ?? 0;
  }

  return {
    paths,
    recordsById,
    pathsById,
    childrenById,
    media: buildMediaPlan(records),
    replyContext,
    authoredParentLinks,
    authoredChildLinks,
  };
}

function quoted(text: string): string {
  return prose(text)
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function parentContextMarkdown(
  record: TwitterPublicWritingRecord,
  outputPath: string,
  plan: VaultPlan,
): string | null {
  if (!record.parentId) return null;
  const parent = plan.recordsById.get(record.parentId);
  if (parent) {
    const parentPath = plan.pathsById.get(parent.id) as string;
    return [
      `> [In reply to an archived post](${relativeMarkdownLink(outputPath, parentPath)})`,
      ">",
      quoted(parent.text),
    ].join("\n");
  }

  const fallbackUrl = `https://x.com/i/web/status/${record.parentId}`;
  const context = record.replyContext;
  const label = record.replyToScreenName ? `@${record.replyToScreenName}` : "parent post";
  const status = contextStatus(record, plan.recordsById);
  if (context && (status === "liked" || status === "deleted")) {
    const note = status === "deleted" ? " — recovered from a deleted-tweet record" : "";
    return [
      `> [In reply to ${label}](${context.sourceUrl})${note}`,
      ">",
      quoted(context.text),
    ].join("\n");
  }
  if (status === "unavailable") {
    return `[In reply to ${label}](${context?.sourceUrl ?? fallbackUrl}); parent text is unavailable.`;
  }
  return `[In reply to ${label}](${context?.sourceUrl ?? fallbackUrl}); parent text was not present in the archive.`;
}

function mediaMarkdown(
  record: TwitterPublicWritingRecord,
  outputPath: string,
  targets: Map<string, string>,
): string[] {
  return record.media.flatMap((media) => {
    if (media.sourcePath) {
      const target = targets.get(media.sourcePath);
      return target
        ? [`![${markdownAlt(media.alt)}](${relativeMarkdownLink(outputPath, target)})`]
        : [];
    }
    return media.url ? [`![${markdownAlt(media.alt)}](${media.url})`] : [];
  });
}

function linkLabel(record: TwitterPublicWritingRecord, timeZone: string): string {
  const excerpt = (record.title || record.text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72)
    .replace(/[\[\]]/g, "");
  return `${localDate(record, timeZone)} — ${excerpt || record.id}`;
}

function renderRecord(
  record: TwitterPublicWritingRecord,
  outputPath: string,
  plan: VaultPlan,
  mediaTargets: Map<string, string>,
  timeZone: string,
): string {
  const status = contextStatus(record, plan.recordsById);
  const properties = [
    "---",
    `type: ${yamlString(record.kind)}`,
    `id: ${yamlString(record.id)}`,
    ...(record.createdAt ? [`date: ${yamlString(record.createdAt)}`] : []),
    ...(record.deletedAt ? [`deleted_at: ${yamlString(record.deletedAt)}`] : []),
    ...(record.sourceUrl ? [`source: ${yamlString(record.sourceUrl)}`] : []),
    ...(record.parentId ? [`reply_to: ${yamlString(record.parentId)}`] : []),
    ...(status ? [`reply_context: ${yamlString(status)}`] : []),
    ...(record.communityId ? [`community_id: ${yamlString(record.communityId)}`] : []),
    "---",
  ];
  const body: string[] = [];
  const parentContext = parentContextMarkdown(record, outputPath, plan);
  if (parentContext) body.push(parentContext);
  if (record.kind === "article" && record.title) body.push(`# ${prose(record.title)}`);
  if (record.text) body.push(prose(record.text));
  else if (record.kind === "article") body.push("*Article body was not present in the archive.*");
  body.push(...mediaMarkdown(record, outputPath, mediaTargets));

  const related: string[] = [];
  if (record.sourceUrl) related.push(`[View original on X](${record.sourceUrl})`);
  const children = plan.childrenById.get(record.id) ?? [];
  if (children.length > 0) {
    related.push(
      "### Replies in this archive",
      ...children.map((child) => {
        const target = plan.paths.get(child) as string;
        return `- [${linkLabel(child, timeZone)}](${relativeMarkdownLink(outputPath, target)})`;
      }),
    );
  }
  if (related.length > 0) body.push(["---", ...related].join("\n\n"));
  return `${properties.join("\n")}\n\n${body.filter(Boolean).join("\n\n").trim()}\n`;
}

function emptyKindCounts(): TwitterPublicMarkdownReport["notesByKind"] {
  return {
    tweet: 0,
    "community-tweet": 0,
    "note-tweet": 0,
    article: 0,
    "deleted-tweet": 0,
  };
}

export async function writeTwitterPublicMarkdown(
  result: TwitterPublicWritingResult,
  outDir: string,
  logger: (level: Level, message: string) => void,
  options: TwitterPublicMarkdownOptions = {},
): Promise<TwitterPublicMarkdownReport> {
  const copyMedia = options.copyMedia !== false;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  const finalDir = path.resolve(outDir);
  const partialDir = `${finalDir}.partial-${process.pid}`;
  const plan = buildVaultPlan(result.records, timeZone);
  const notesByKind = emptyKindCounts();
  for (const record of result.records) notesByKind[record.kind] += 1;
  const renderedMediaTargets = copyMedia ? plan.media.targets : new Map<string, string>();
  const report: TwitterPublicMarkdownReport = {
    records: result.records.length,
    notesWritten: options.dryRun ? 0 : result.records.length,
    notesByKind,
    replies: result.records.filter((record) => record.parentId).length,
    replyContext: plan.replyContext,
    authoredParentLinks: plan.authoredParentLinks,
    authoredChildLinks: plan.authoredChildLinks,
    mediaReferenced: copyMedia ? plan.media.sources.length : 0,
    mediaCopied: 0,
    mediaMissing: 0,
    timeZone,
    outputDirectory: finalDir,
    stats: result.stats,
  };
  if (options.dryRun) return report;

  try {
    if (await fs.stat(finalDir).catch(() => null)) throw new Error(`output already exists: ${finalDir}`);
    if (await fs.stat(partialDir).catch(() => null)) throw new Error(`partial output already exists: ${partialDir}`);
    await fs.mkdir(partialDir, { recursive: true });

    for (let index = 0; index < result.records.length; index += 1) {
      const record = result.records[index];
      const relative = plan.paths.get(record) as string;
      const absolute = resolveWithin(partialDir, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(
        absolute,
        renderRecord(record, relative, plan, renderedMediaTargets, timeZone),
        "utf8",
      );
      if ((index + 1) % 10_000 === 0) {
        logger("info", `Wrote ${index + 1}/${result.records.length} Markdown note(s)`);
      }
    }

    if (copyMedia) {
      for (let index = 0; index < plan.media.sources.length; index += 1) {
        const source = plan.media.sources[index];
        const target = resolveWithin(partialDir, plan.media.targets.get(source) as string);
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
          report.mediaCopied += 1;
        } catch (error) {
          report.mediaMissing += 1;
          throw new Error(
            `could not copy media ${source}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if ((index + 1) % 5_000 === 0) {
          logger("info", `Copied ${index + 1}/${plan.media.sources.length} media file(s)`);
        }
      }
    }

    const indexLines = result.records.map((record) => JSON.stringify({
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      deletedAt: record.deletedAt ?? null,
      parentId: record.parentId,
      replyToAccountId: record.replyToAccountId,
      replyToOwnAccount: record.replyToOwnAccount,
      replyToScreenName: record.replyToScreenName,
      replyContext: contextStatus(record, plan.recordsById),
      replyContextSource: record.replyContext?.source ?? null,
      replyContextId: record.replyContext?.id ?? null,
      communityId: record.communityId ?? null,
      file: (plan.paths.get(record) as string).split(path.sep).join("/"),
    }));
    const metadataDir = path.join(partialDir, ".splice");
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(path.join(metadataDir, "export-index.jsonl"), `${indexLines.join("\n")}\n`, "utf8");

    const readme = [
      `# Twitter archive @${result.stats.accountHandle}`,
      "",
      "One clean Markdown file per authored public-writing record, generated by Splice.",
      "Each reply includes the best parent context available and links to archived parents and children.",
      "Open this directory as an Obsidian vault or use it with any Markdown reader.",
      "",
      `- Authored notes: ${result.records.length}`,
      `- Replies: ${report.replies}`,
      `- Replies with an authored parent: ${report.replyContext.authored}`,
      `- Replies with context from a deleted-tweet record: ${report.replyContext.deleted}`,
      `- Replies with liked-post context: ${report.replyContext.liked}`,
      `- Replies whose parent is unavailable: ${report.replyContext.unavailable}`,
      `- Replies whose parent is missing: ${report.replyContext.missing}`,
      `- Local media copied: ${report.mediaCopied}`,
      `- Counts reconciled: ${result.stats.totals.reconciled ? "yes" : "no"}`,
      `- Display-date timezone: ${timeZone}`,
      "- Standalone likes are excluded; liked-post text is used only for matched reply context.",
      "- Retweets, drafts, direct messages, Grok chats, and account metadata are excluded.",
      "",
      "Machine-readable receipts are stored under `.splice/` so they do not clutter the writing folders.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(partialDir, "README.md"), readme, "utf8");
    await fs.writeFile(path.join(metadataDir, "export-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.rename(partialDir, finalDir);
    logger("info", `Completed atomic Markdown export at ${finalDir}`);
    return report;
  } catch (error) {
    throw new Error(
      `twitter public markdown export failed; partial files, if any, remain at ${partialDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
