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

export interface TwitterPublicMarkdownReport {
  records: number;
  filesWritten: number;
  dailyFiles: number;
  replyFiles: number;
  threadFiles: number;
  articleFiles: number;
  noteFiles: number;
  communityFiles: number;
  deletedFiles: number;
  mediaReferenced: number;
  mediaCopied: number;
  mediaMissing: number;
  timeZone: string;
  outputDirectory: string;
  stats: TwitterPublicWritingResult["stats"];
}

interface Document {
  relativePath: string;
  records: TwitterPublicWritingRecord[];
  markdown: string;
}

interface MediaPlan {
  sources: string[];
  targets: Map<string, string>;
}

// Historical Splice exports rendered Pacific timestamps with a fixed UTC-8 offset.
const DEFAULT_TIME_ZONE = "Etc/GMT+8";

function prose(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function firstWords(record: TwitterPublicWritingRecord): string {
  return record.title || record.text.split(/\s+/).slice(0, 5).join(" ");
}

function slug(record: TwitterPublicWritingRecord): string {
  const value = sanitizeFilename(firstWords(record), 64);
  return value === "untitled" ? `tweet_${record.id}` : value;
}

function dateOnly(record: TwitterPublicWritingRecord, timeZone: string): string {
  if (!record.createdAt) return "unknown-date";
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) return "unknown-date";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function localTime(record: TwitterPublicWritingRecord, timeZone: string): string {
  if (!record.createdAt) return "Unknown time";
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function mediaPlan(records: TwitterPublicWritingRecord[]): MediaPlan {
  const byTarget = new Map<string, string>();
  const targets = new Map<string, string>();
  for (const source of [...new Set(records.flatMap((record) =>
    record.media.flatMap((media) => media.sourcePath ? [media.sourcePath] : []),
  ))].sort()) {
    const target = path.join("images", `_${path.basename(source)}`);
    const prior = byTarget.get(target);
    if (prior && prior !== source) {
      throw new Error(
        `twitter public markdown: media collision at ${target} (${prior} and ${source})`,
      );
    }
    byTarget.set(target, source);
    targets.set(source, target);
  }
  return { sources: [...targets.keys()], targets };
}

function mediaMarkdown(
  record: TwitterPublicWritingRecord,
  from: string,
  targets: Map<string, string>,
): string[] {
  return record.media.flatMap((media) => {
    if (media.sourcePath) {
      const target = targets.get(media.sourcePath);
      if (!target) return [];
      const relative = path.relative(path.dirname(from), target).split(path.sep).join("/");
      return [`![${media.alt}](${encodeURI(relative)})`];
    }
    return media.url ? [`![${media.alt}](${media.url})`] : [];
  });
}

function replyContextMarkdown(record: TwitterPublicWritingRecord): string | null {
  const context = record.replyContext;
  if (!context) return null;
  const attribution = context.screenName
    ? `Replying to @${context.screenName}`
    : "Reply context";
  const quoted = context.text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return `> [${attribution}](${context.sourceUrl})\n>\n${quoted}`;
}

function renderEntry(
  record: TwitterPublicWritingRecord,
  from: string,
  timeZone: string,
  targets: Map<string, string>,
): string {
  const time = localTime(record, timeZone);
  const heading = record.sourceUrl ? `*[${time}](${record.sourceUrl})*  ` : `*${time}*  `;
  const body = [prose(record.text), ...mediaMarkdown(record, from, targets)]
    .filter(Boolean)
    .join("\n\n");
  return [replyContextMarkdown(record), `${heading}\n${body}`]
    .filter(Boolean)
    .join("\n\n")
    .trimEnd();
}

function groupByDate(
  records: TwitterPublicWritingRecord[],
  timeZone: string,
): Map<string, TwitterPublicWritingRecord[]> {
  const result = new Map<string, TwitterPublicWritingRecord[]>();
  for (const record of records) {
    const day = dateOnly(record, timeZone);
    const values = result.get(day) ?? [];
    values.push(record);
    result.set(day, values);
  }
  for (const values of result.values()) {
    values.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
  }
  return result;
}

function connectedTweetComponents(records: TwitterPublicWritingRecord[]): TwitterPublicWritingRecord[][] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const neighbors = new Map(records.map((record) => [record.id, new Set<string>()]));
  for (const record of records) {
    if (!record.replyToOwnAccount || !record.parentId || !byId.has(record.parentId)) continue;
    neighbors.get(record.id)?.add(record.parentId);
    neighbors.get(record.parentId)?.add(record.id);
  }
  const visited = new Set<string>();
  const components: TwitterPublicWritingRecord[][] = [];
  for (const start of [...records].sort((a, b) => a.id.localeCompare(b.id))) {
    if (visited.has(start.id)) continue;
    const ids = [start.id];
    visited.add(start.id);
    const component: TwitterPublicWritingRecord[] = [];
    while (ids.length > 0) {
      const id = ids.pop() as string;
      component.push(byId.get(id) as TwitterPublicWritingRecord);
      for (const neighbor of [...(neighbors.get(id) ?? [])].sort().reverse()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        ids.push(neighbor);
      }
    }
    component.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
    components.push(component);
  }
  return components.sort((a, b) =>
    (a[0]?.createdAt ?? "").localeCompare(b[0]?.createdAt ?? "") ||
    (a[0]?.id ?? "").localeCompare(b[0]?.id ?? ""),
  );
}

function uniqueThreadPaths(threads: TwitterPublicWritingRecord[][]): Map<TwitterPublicWritingRecord[], string> {
  const bases = threads.map((thread) => slug(thread[0]));
  const counts = new Map<string, number>();
  const keys = bases.map((base) => base.normalize("NFC").toLocaleLowerCase("en-US"));
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return new Map(threads.map((thread, index) => {
    const base = bases[index];
    const name = (counts.get(keys[index]) ?? 0) > 1 ? `${base}--${thread[0].id}` : base;
    return [thread, path.join("threads", `${name}.md`)];
  }));
}

function dailyDocuments(
  records: TwitterPublicWritingRecord[],
  directory: string,
  timeZone: string,
  targets: Map<string, string>,
): Document[] {
  return [...groupByDate(records, timeZone)].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => {
    const relativePath = path.join(directory, `${day}.md`);
    return {
      relativePath,
      records: values,
      markdown: `${values.map((record) => renderEntry(record, relativePath, timeZone, targets)).join("\n\n---\n\n")}\n`,
    };
  });
}

function threadDocuments(
  threads: TwitterPublicWritingRecord[][],
  timeZone: string,
  targets: Map<string, string>,
): Document[] {
  const paths = uniqueThreadPaths(threads);
  return threads.map((thread) => {
    const relativePath = paths.get(thread) as string;
    const first = thread[0];
    const parts = thread.map((record) =>
      [replyContextMarkdown(record), prose(record.text), ...mediaMarkdown(record, relativePath, targets)]
        .filter(Boolean)
        .join("\n\n"),
    );
    const footer = first.sourceUrl ? `\n\n[View on Twitter](${first.sourceUrl})` : "";
    return {
      relativePath,
      records: thread,
      markdown: `---\nDate: ${dateOnly(first, timeZone)}\n---\n\n\n${parts.join("\n\n\n\n")}${footer}\n`,
    };
  });
}

function articleDocuments(
  records: TwitterPublicWritingRecord[],
  timeZone: string,
  targets: Map<string, string>,
): Document[] {
  const names = new Map<string, number>();
  return records.map((record) => {
    const base = slug(record);
    const key = base.normalize("NFC").toLocaleLowerCase("en-US");
    const count = names.get(key) ?? 0;
    names.set(key, count + 1);
    const name = count === 0 ? base : `${base}--${record.id}`;
    const relativePath = path.join("articles", `${name}.md`);
    const body = [
      ...(record.title ? [`# ${prose(record.title)}`] : []),
      ...(record.text ? [prose(record.text)] : []),
      ...mediaMarkdown(record, relativePath, targets),
      ...(record.sourceUrl ? [`[View on Twitter](${record.sourceUrl})`] : []),
    ].join("\n\n");
    return {
      relativePath,
      records: [record],
      markdown: `---\nDate: ${dateOnly(record, timeZone)}\n---\n\n${body}\n`,
    };
  });
}

function buildDocuments(
  records: TwitterPublicWritingRecord[],
  timeZone: string,
  targets: Map<string, string>,
): {
  documents: Document[];
  dailyFiles: number;
  replyFiles: number;
  threadFiles: number;
  articleFiles: number;
  noteFiles: number;
  communityFiles: number;
  deletedFiles: number;
} {
  const tweets = records.filter((record) => record.kind === "tweet");
  const components = connectedTweetComponents(tweets);
  const threads = components.filter((component) => component.length > 1);
  const singletons = components.filter((component) => component.length === 1).flat();
  const standalone = singletons.filter((record) => !record.parentId);
  const replies = singletons.filter((record) => record.parentId);
  const daily = dailyDocuments(standalone, "tweets_by_date", timeZone, targets);
  const replyDocs = dailyDocuments(replies, "replies_by_date", timeZone, targets);
  const threadDocs = threadDocuments(threads, timeZone, targets);
  const articles = articleDocuments(
    records.filter((record) => record.kind === "article"),
    timeZone,
    targets,
  );
  const notes = dailyDocuments(
    records.filter((record) => record.kind === "note-tweet"),
    "notes_by_date",
    timeZone,
    targets,
  );
  const community = dailyDocuments(
    records.filter((record) => record.kind === "community-tweet"),
    "community_tweets_by_date",
    timeZone,
    targets,
  );
  const deleted = dailyDocuments(
    records.filter((record) => record.kind === "deleted-tweet"),
    "deleted_tweets_by_date",
    timeZone,
    targets,
  );
  const documents = [...daily, ...replyDocs, ...threadDocs, ...articles, ...notes, ...community, ...deleted];
  const recordCount = documents.reduce((sum, document) => sum + document.records.length, 0);
  if (recordCount !== records.length) {
    throw new Error(
      `twitter public markdown: document accounting failed (${recordCount} mapped != ${records.length} records)`,
    );
  }
  const pathCount = new Set(documents.map((document) =>
    document.relativePath.normalize("NFC").toLocaleLowerCase("en-US"),
  )).size;
  if (pathCount !== documents.length) {
    throw new Error("twitter public markdown: duplicate document output path");
  }
  return {
    documents,
    dailyFiles: daily.length,
    replyFiles: replyDocs.length,
    threadFiles: threadDocs.length,
    articleFiles: articles.length,
    noteFiles: notes.length,
    communityFiles: community.length,
    deletedFiles: deleted.length,
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
  // Validate the configured zone before doing any work.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  const finalDir = path.resolve(outDir);
  const partialDir = `${finalDir}.partial-${process.pid}`;
  const media = mediaPlan(result.records);
  const renderedTargets = copyMedia ? media.targets : new Map<string, string>();
  const built = buildDocuments(result.records, timeZone, renderedTargets);
  const report: TwitterPublicMarkdownReport = {
    records: result.records.length,
    filesWritten: options.dryRun ? 0 : built.documents.length,
    dailyFiles: built.dailyFiles,
    replyFiles: built.replyFiles,
    threadFiles: built.threadFiles,
    articleFiles: built.articleFiles,
    noteFiles: built.noteFiles,
    communityFiles: built.communityFiles,
    deletedFiles: built.deletedFiles,
    mediaReferenced: copyMedia ? media.sources.length : 0,
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

    for (const document of built.documents) {
      const absolute = path.join(partialDir, document.relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, document.markdown, "utf8");
    }

    if (copyMedia) {
      for (let index = 0; index < media.sources.length; index += 1) {
        const source = media.sources[index];
        const target = path.join(partialDir, media.targets.get(source) as string);
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
          report.mediaCopied += 1;
        } catch {
          report.mediaMissing += 1;
        }
        if ((index + 1) % 5_000 === 0) {
          logger("info", `Copied ${index + 1}/${media.sources.length} media file(s)`);
        }
      }
    }

    const recordToFile = new Map<string, string>();
    for (const document of built.documents) {
      for (const record of document.records) {
        recordToFile.set(`${record.kind}:${record.id}`, document.relativePath.split(path.sep).join("/"));
      }
    }
    const indexLines = result.records.map((record) => JSON.stringify({
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      parentId: record.parentId,
      replyToAccountId: record.replyToAccountId,
      replyToOwnAccount: record.replyToOwnAccount,
      replyToScreenName: record.replyToScreenName,
      replyContextSource: record.replyContext?.source ?? null,
      replyContextId: record.replyContext?.id ?? null,
      file: recordToFile.get(`${record.kind}:${record.id}`),
    }));
    await fs.writeFile(path.join(partialDir, "export-index.jsonl"), `${indexLines.join("\n")}\n`, "utf8");

    const readme = [
      `# Twitter archive @${result.stats.accountHandle}`,
      "",
      "Portable Markdown generated by Splice in the original daily-note and thread-oriented archive style.",
      "Open this directory as an Obsidian vault or use it with any Markdown reader.",
      "",
      `- Public writing records: ${result.records.length}`,
      `- Daily tweet files: ${built.dailyFiles}`,
      `- Daily reply files: ${built.replyFiles}`,
      `- Thread files: ${built.threadFiles}`,
      `- Published Article files: ${built.articleFiles}`,
      `- Community-tweet daily files: ${built.communityFiles}`,
      `- Note-Tweet daily files: ${built.noteFiles}`,
      `- Missing reply parents recovered from liked-post text: ${result.stats.replyContext.recoveredFromLikes}`,
      `- Missing reply parents still without context: ${result.stats.replyContext.stillMissing}`,
      `- Local media copied: ${report.mediaCopied}`,
      `- Retweets excluded: ${result.stats.skipped.retweets}`,
      `- Article drafts excluded: ${result.stats.skipped.articleDrafts}`,
      `- Recent deleted tweets excluded: ${result.stats.skipped.deletedTweets}`,
      `- Counts reconciled: ${result.stats.totals.reconciled ? "yes" : "no"}`,
      `- Display timezone: ${timeZone}`,
      "- Standalone likes are excluded; liked-post text is used only for matched reply context.",
      "- Direct messages, Grok chats, and account metadata are outside this export by design.",
      "",
      "`export-index.jsonl` maps every included source record to its Markdown file without adding database-like metadata to each note.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(partialDir, "README.md"), readme, "utf8");
    await fs.writeFile(path.join(partialDir, "export-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
