#!/usr/bin/env -S tsx
/**
 * splice — CLI entrypoint
 * Wires sources → transforms → outputs using modular architecture.
 *
 * Maintains existing flags/behavior from the original monolithic script.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CLIOptions, parseArgs, makeLogger, usage } from "../core/types";

import { detectTwitterArchive, ingestTwitter } from "../sources/twitter";
import {
  applyFilters,
  indexById,
  groupThreadsAndConversations,
} from "../transforms/core";
import {
  writeMarkdown,
  writeOAI,
  writeNormalizedJSONL,
  writeShareGPT,
  writeStatsJSON,
} from "../outputs/writers";
import {
  FsStore,
  createCheckpointManifest,
  storeItemsJSONL,
  storeThreadsJSON,
  storeConversationsJSON,
} from "../core/store";
import { decisionsFromIds } from "../core/decisions";

/* -------------------------------- version -------------------------------- */

async function getVersion(): Promise<string> {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const dir = path.dirname(thisFile);
    // src/cli/splice.ts -> ../../package.json
    // dist/cli/splice.js -> ../../package.json
    const pkgPath = path.join(dir, "..", "..", "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const opts: CLIOptions = parseArgs(process.argv);
  if (opts.help) {
    process.stderr.write(usage() + "\n");
    process.exit(0);
  }
  if (opts.version) {
    const v = await getVersion();
    process.stdout.write(`splice ${v}\n`);
    process.exit(0);
  }

  // Allow quick verbosity shorthands unless an explicit --log-level was provided
  {
    const argv = process.argv.slice(2);
    const hasExplicitLogLevel = argv.includes("--log-level");
    const wantsQuiet = argv.includes("--quiet") || argv.includes("-q");
    const wantsVerbose = argv.includes("--verbose");
    if (!hasExplicitLogLevel) {
      if (wantsQuiet) (opts as any).logLevel = "error";
      else if (wantsVerbose) (opts as any).logLevel = "debug";
    }
  }

  const logger = makeLogger(opts.logLevel);

  // Warn on unknown flags with a simple suggestion
  {
    const argv = process.argv.slice(2);
    const known = new Set([
      "--help",
      "-h",
      "--version",
      "-V",
      "--source",
      "--archive-path",
      "--out",
      "--output-dir",
      "--workspace",
      "--checkpoint",
      "--format",
      "--formats",
      "--output-formats",
      "--system-message",
      "--system",
      "--dry-run",
      "-n",
      "--log-level",
      "--quiet",
      "-q",
      "--verbose",
      "--json-stdout",
      "--since",
      "--until",
      "--min-length",
      "--exclude-rt",
      "--only-threads",
      "--with-media",
      "--stats-json",
      "--decisions-import",
      "--decisions-file",
      "--set-status",
      "--status",
      "--ids",
      "--ids-file",
      "--",
    ]);
    const unknown = argv.filter(
      (a) => a.startsWith("-") && !known.has(a) && a !== "-" && a !== "--",
    );
    const candidates = Array.from(known).filter((f) => f.startsWith("--"));
    const suggest = (flag: string): string | null => {
      let best: string | null = null;
      let score = -1;
      for (const c of candidates) {
        // simple common prefix score
        let s = 0;
        const L = Math.min(flag.length, c.length);
        for (let i = 0; i < L; i++) {
          if (flag[i] === c[i]) s++;
          else break;
        }
        if (s > score) {
          score = s;
          best = c;
        }
      }
      return score >= 2 ? best : null;
    };
    for (const uf of unknown) {
      const hint = suggest(uf);
      if (hint) logger("warn", `Unknown flag ${uf}. Did you mean ${hint}?`);
      else
        logger(
          "warn",
          `Unknown flag ${uf}. Run with --help to see supported flags.`,
        );
    }
  }

  if (!opts.source || !opts.out) {
    process.stderr.write(usage() + "\n");
    process.exit(2);
  }

  const source = path.resolve(opts.source);
  const outDir = path.resolve(opts.out);
  const workspaceDir = path.resolve(
    opts.workspace || path.join(outDir, ".splice"),
  );

  const detected = await detectTwitterArchive(source);
  if (!detected) {
    logger(
      "error",
      `Could not detect a Twitter archive at ${source} (missing data/manifest.js)`,
    );
    process.exit(2);
  }

  try {
    logger("info", `Ingesting from ${source}`);
    const items = await ingestTwitter(source, logger);

    const filtered = applyFilters(items, {
      since: opts.since,
      until: opts.until,
      minLength: opts.minLength,
      excludeRt: opts.excludeRt,
      onlyThreads: opts.onlyThreads,
      withMedia: opts.withMedia,
    });

    const all = indexById(filtered);
    let { threads, conversations } = groupThreadsAndConversations(all);
    if (opts.onlyThreads) {
      conversations = [];
    }
    logger(
      "info",
      `Threads: ${threads.length}, Conversations: ${conversations.length}`,
    );

    // Create a checkpoint manifest and store artifacts
    if (opts.dryRun) {
      logger("info", `(dry-run) would create checkpoint in ${workspaceDir}`);
    } else {
      try {
        const store = new FsStore(workspaceDir, logger);

        // Optional: build a decisions stream from --decisions-import and/or --set-status with ids/ids-file
        let decisionsRef: string | undefined;

        // Helper to parse a JSONL file into an iterable of objects
        const parseJsonlFile = async function* (
          filePath: string,
        ): AsyncIterable<any> {
          try {
            const raw = await fs.readFile(filePath, "utf8");
            const lines = raw.split(/\r?\n/);
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              try {
                yield JSON.parse(t);
              } catch {
                // ignore invalid line
              }
            }
          } catch {
            // ignore missing file
          }
        };

        // Helper to load IDs from a file (either JSON array or newline-separated)
        const loadIdsFile = async (filePath: string): Promise<string[]> => {
          try {
            const raw = await fs.readFile(filePath, "utf8");
            try {
              const j = JSON.parse(raw);
              if (Array.isArray(j))
                return j.filter((x) => typeof x === "string");
            } catch {
              // not JSON; fall through
            }
            return raw
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
          } catch {
            return [];
          }
        };

        // Build a combined decisions iterable
        const decisionIterables: Array<AsyncIterable<any>> = [];

        // Import existing decisions JSONL if provided
        const decisionsPath = opts.decisionsImport;
        if (decisionsPath) {
          decisionIterables.push(parseJsonlFile(decisionsPath));
          logger("info", `Importing decisions from ${decisionsPath}`);
        }

        // Generate new decisions from --set-status and ids/ids-file
        const setStatus = opts.setStatus;
        if (setStatus) {
          let ids: string[] = opts.ids || [];
          const idsFile = opts.idsFile;
          if (idsFile) {
            const fromFile = await loadIdsFile(idsFile);
            ids = ids.concat(fromFile);
          }
          ids = Array.from(new Set(ids.filter(Boolean)));
          if (ids.length > 0) {
            const records = decisionsFromIds(ids, setStatus, { by: "cli" });
            // Wrap array as async iterable
            async function* gen() {
              for (const r of records) yield r;
            }
            decisionIterables.push(gen());
            logger(
              "info",
              `Prepared ${records.length} decision(s) with status="${setStatus}"`,
            );
          }
        }

        // If we have any decision streams, materialize them into the store
        if (decisionIterables.length > 0) {
          // Concatenate iterables
          async function* concatAll() {
            for (const it of decisionIterables) {
              for await (const rec of it) {
                yield rec;
              }
            }
          }
          decisionsRef = await store.putJSONL(concatAll());
          logger("info", `Stored decisions JSONL as ${decisionsRef}`);
        }

        const itemsRefAll = await storeItemsJSONL(store, items);
        const filteredRef = await storeItemsJSONL(store, filtered);
        const threadsRef = await storeThreadsJSON(store, threads);
        const conversationsRef = await storeConversationsJSON(
          store,
          conversations,
        );

        const transforms = [
          {
            name: "filter",
            config: {
              since: opts.since,
              until: opts.until,
              minLength: opts.minLength,
              excludeRt: opts.excludeRt,
              withMedia: opts.withMedia,
            },
            inputRef: itemsRefAll,
            outputRef: filteredRef,
            stats: { total: items.length, filtered: filtered.length },
          },
          {
            name: "group:threads",
            config: {},
            inputRef: filteredRef,
            outputRef: threadsRef,
            stats: { threads: threads.length },
          },
          {
            name: "group:conversations",
            config: {},
            inputRef: filteredRef,
            outputRef: conversationsRef,
            stats: { conversations: conversations.length },
          },
        ];

        const latest = await store.resolveLatestCheckpoint().catch(() => null);
        const manifest = createCheckpointManifest({
          parentId: (latest && latest.id) || null,
          itemsRef: itemsRefAll,
          sourceRefs: [{ kind: "twitter", uri: source }],
          transforms,
          decisionsRef,
          materialized: { threadsRef, conversationsRef },
        });
        const cpId = await store.saveCheckpoint(manifest);
        logger("info", `Saved checkpoint ${cpId} in ${workspaceDir}`);
      } catch (e) {
        logger("warn", `Failed to write checkpoint: ${(e as Error).message}`);
      }
    }

    // Validate formats and support --json-stdout for piping normalized items
    const argv = process.argv.slice(2);
    const formatSpecified =
      argv.includes("--format") ||
      argv.includes("--formats") ||
      argv.includes("--output-formats");
    const allowedFormats = new Set(["markdown", "oai", "json", "sharegpt"]);
    const requested = opts.format || [];
    const validFormats = requested.filter((f) => allowedFormats.has(f));
    const invalidFormats = requested.filter((f) => !allowedFormats.has(f));
    for (const bad of invalidFormats) {
      logger(
        "warn",
        `Unknown format "${bad}". Supported: markdown, oai, json, sharegpt`,
      );
    }
    const jsonStdout = argv.includes("--json-stdout");

    if (jsonStdout) {
      // Print normalized items as JSONL to stdout; logs remain on stderr
      for (const it of items) {
        process.stdout.write(JSON.stringify(it) + "\n");
      }
      logger("info", "Wrote normalized items to stdout");
      process.exit(0);
    }

    if (formatSpecified && validFormats.length === 0) {
      logger(
        "error",
        "No valid formats requested. Supported: markdown, oai, json, sharegpt",
      );
      process.stderr.write(usage() + "\n");
      process.exit(2);
    }

    if (validFormats.includes("markdown")) {
      await writeMarkdown(
        threads,
        opts.onlyThreads ? [] : filtered,
        outDir,
        logger,
        opts.dryRun,
      );
    }
    if (validFormats.includes("json")) {
      await writeNormalizedJSONL(items, outDir, logger, opts.dryRun);
    }
    const systemMessage =
      process.env.SPLICE_SYSTEM_MESSAGE ?? opts.systemMessage;
    logger("debug", `System message: ${systemMessage}`);
    if (validFormats.includes("oai")) {
      await writeOAI(
        threads,
        conversations,
        outDir,
        systemMessage,
        logger,
        opts.dryRun,
      );
    }
    if (validFormats.includes("sharegpt")) {
      await writeShareGPT(threads, conversations, outDir, logger, opts.dryRun);
    }
    if (opts.statsJson) {
      await writeStatsJSON(
        filtered,
        threads,
        conversations,
        outDir,
        logger,
        opts.dryRun,
      );
    }

    logger("info", opts.dryRun ? "Dry run complete." : "Done.");
    process.exit(0);
  } catch (e) {
    logger("error", (e as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[error] ${(err as Error).message}\n`);
  process.exit(1);
});
