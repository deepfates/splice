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
}

export interface TwitterPublicMarkdownReport {
  records: number;
  notesWritten: number;
  mediaReferenced: number;
  mediaCopied: number;
  mediaMissing: number;
  outputDirectory: string;
  stats: TwitterPublicWritingResult["stats"];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function prose(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^ {0,3}#/.test(line)) return line.replace("#", "\\#");
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return `\\${line}`;
      return line;
    })
    .join("\n")
    .trim();
}

function slug(record: TwitterPublicWritingRecord): string {
  const seed = record.title || record.text.split(/\s+/).slice(0, 8).join(" ");
  return sanitizeFilename(seed.toLowerCase().replace(/_/g, "-"), 64).replace(/_/g, "-");
}

function recordPath(record: TwitterPublicWritingRecord): string {
  const day = record.createdAt?.slice(0, 10) ?? "unknown-date";
  const year = record.createdAt?.slice(0, 4) ?? "unknown";
  const month = record.createdAt?.slice(5, 7) ?? "unknown";
  const directory = record.kind === "tweet"
    ? "tweets"
    : record.kind === "community-tweet"
      ? "community-tweets"
      : record.kind === "note-tweet"
        ? "notes"
        : record.kind === "article"
          ? "articles"
          : "deleted-tweets";
  return path.join(directory, year, month, `${day}--${slug(record)}--${record.id}.md`);
}

function relativeMarkdownLink(from: string, to: string): string {
  const relative = path.relative(path.dirname(from), to).split(path.sep).join("/");
  return encodeURI(relative);
}

function renderRecord(
  record: TwitterPublicWritingRecord,
  outputPath: string,
  pathsByTweetId: Map<string, string>,
  mediaTargets: Map<string, string>,
): string {
  const tags = ["twitter", "archive", record.kind];
  const title = record.title || record.text.split(/\s+/).slice(0, 12).join(" ") || record.id;
  const properties = [
    "---",
    `title: ${yamlString(title)}`,
    `type: ${yamlString(`twitter/${record.kind}`)}`,
    `twitter_id: ${yamlString(record.id)}`,
    ...(record.createdAt ? [`date: ${yamlString(record.createdAt)}`] : []),
    ...(record.sourceUrl ? [`source_url: ${yamlString(record.sourceUrl)}`] : []),
    ...(record.parentId ? [`in_reply_to: ${yamlString(record.parentId)}`] : []),
    ...(record.communityId ? [`community_id: ${yamlString(record.communityId)}`] : []),
    `tags: ${JSON.stringify(tags)}`,
    "---",
  ];
  const body: string[] = [];
  if (record.kind === "article" && record.title) body.push(`# ${prose(record.title)}`);
  if (record.text) body.push(prose(record.text));
  for (const media of record.media) {
    if (media.sourcePath) {
      const target = mediaTargets.get(media.sourcePath);
      if (target) {
        body.push(`![${media.alt}](${relativeMarkdownLink(outputPath, target)})`);
      }
    } else if (media.url) {
      body.push(`![${media.alt}](${media.url})`);
    }
  }
  const provenance: string[] = [];
  if (record.parentId) {
    const parentPath = pathsByTweetId.get(record.parentId);
    provenance.push(
      parentPath
        ? `[Replying to archived tweet ${record.parentId}](${relativeMarkdownLink(outputPath, parentPath)})`
        : `Replying to tweet ${record.parentId} (not present in this public-writing export)`,
    );
  }
  if (record.sourceUrl) provenance.push(`[View original on X](${record.sourceUrl})`);
  if (provenance.length > 0) body.push(provenance.join(" · "));
  return `${properties.join("\n")}\n\n${body.join("\n\n").trim()}\n`;
}

export async function writeTwitterPublicMarkdown(
  result: TwitterPublicWritingResult,
  outDir: string,
  logger: (level: Level, message: string) => void,
  options: TwitterPublicMarkdownOptions = {},
): Promise<TwitterPublicMarkdownReport> {
  const copyMedia = options.copyMedia !== false;
  const finalDir = path.resolve(outDir);
  const partialDir = `${finalDir}.partial-${process.pid}`;
  const paths = new Map<TwitterPublicWritingRecord, string>();
  const usedPaths = new Set<string>();
  const pathsByTweetId = new Map<string, string>();
  for (const record of result.records) {
    const relative = recordPath(record);
    if (usedPaths.has(relative)) {
      throw new Error(`twitter public markdown: output collision at ${relative}`);
    }
    usedPaths.add(relative);
    paths.set(record, relative);
    if (record.kind === "tweet" || record.kind === "community-tweet") {
      pathsByTweetId.set(record.id, relative);
    }
  }

  const localMedia = result.records.flatMap((record) =>
    record.media.flatMap((media) => media.sourcePath ? [media.sourcePath] : []),
  );
  const uniqueMedia = [...new Set(localMedia)].sort();
  const mediaTargets = new Map<string, string>();
  for (const source of uniqueMedia) {
    mediaTargets.set(
      source,
      path.join("attachments", "twitter", path.basename(path.dirname(source)), path.basename(source)),
    );
  }
  const renderedMediaTargets = copyMedia ? mediaTargets : new Map<string, string>();
  const report: TwitterPublicMarkdownReport = {
    records: result.records.length,
    notesWritten: options.dryRun ? 0 : result.records.length,
    mediaReferenced: uniqueMedia.length,
    mediaCopied: 0,
    mediaMissing: 0,
    outputDirectory: finalDir,
    stats: result.stats,
  };
  if (options.dryRun) return report;

  try {
    const finalStat = await fs.stat(finalDir).catch(() => null);
    if (finalStat) throw new Error(`output already exists: ${finalDir}`);
    const partialStat = await fs.stat(partialDir).catch(() => null);
    if (partialStat) throw new Error(`partial output already exists: ${partialDir}`);
    await fs.mkdir(partialDir, { recursive: true });

    for (let index = 0; index < result.records.length; index += 1) {
      const record = result.records[index];
      const relative = paths.get(record) as string;
      const absolute = path.join(partialDir, relative);
      const markdown = renderRecord(record, relative, pathsByTweetId, renderedMediaTargets);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, markdown, "utf8");
      if ((index + 1) % 10_000 === 0) {
        logger("info", `Wrote ${index + 1}/${result.records.length} Markdown note(s)`);
      }
    }

    if (copyMedia && uniqueMedia.length > 0) {
      for (let index = 0; index < uniqueMedia.length; index += 1) {
        const source = uniqueMedia[index];
        const target = path.join(partialDir, mediaTargets.get(source) as string);
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
          report.mediaCopied += 1;
        } catch {
          report.mediaMissing += 1;
        }
        if ((index + 1) % 5_000 === 0) {
          logger("info", `Copied ${index + 1}/${uniqueMedia.length} media file(s)`);
        }
      }
    }

    const readme = [
      `# Twitter archive @${result.stats.accountHandle}`,
      "",
      "Portable Markdown notes generated by Splice. Open this directory as an Obsidian vault or use it with any Markdown reader.",
      "",
      `- Public writing notes: ${result.records.length}`,
      `- Local media referenced: ${uniqueMedia.length}`,
      `- Local media copied: ${report.mediaCopied}`,
      `- Retweets excluded: ${result.stats.skipped.retweets}`,
      `- Article drafts excluded: ${result.stats.skipped.articleDrafts}`,
      `- Recent deleted tweets excluded: ${result.stats.skipped.deletedTweets}`,
      `- Counts reconciled: ${result.stats.totals.reconciled ? "yes" : "no"}`,
      "- Likes, direct messages, Grok chats, and account metadata are outside this export by design.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(partialDir, "README.md"), readme, "utf8");
    await fs.writeFile(
      path.join(partialDir, "export-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
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
