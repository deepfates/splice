import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Level, ChatMessage } from "../core/types";
import type { GlowficCharacter, MultiCharacterResult } from "../sources/glowfic";

/**
 * Ensure a directory exists (mkdir -p).
 */
async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Sanitize a character ID for use as a directory name.
 */
function sanitizeCharacterId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64) || "unknown";
}

/**
 * Options for HuggingFace dataset writing.
 */
export interface HuggingFaceDatasetOptions {
  /** Output directory */
  outDir: string;
  /** Board/source name for metadata */
  sourceName: string;
  /** Source URL */
  sourceUrl: string;
  /** Dry run mode */
  dryRun: boolean;
  /** Logger function */
  logger: (l: Level, m: string) => void;
}

/**
 * Metadata for a single character's dataset.
 */
export interface CharacterDatasetMeta {
  character_id: string;
  character_handle: string | null;
  character_display_name: string | null;
  author: string | null;
  post_count: number;
  conversation_count: number;
  message_count: number;
  source: string;
  source_url: string;
  created_at: string;
}

/**
 * Generate a simple system prompt for a character.
 * Format: "You are {displayName} ({handle})." or just "You are {displayName}."
 */
function generateCharacterSystemPrompt(character: GlowficCharacter): string {
  const name = character.displayName || character.id;
  // Include handle as epithet if it differs from display name
  if (character.handle && character.handle !== character.displayName) {
    return `You are ${name} (${character.handle}).`;
  }
  return `You are ${name}.`;
}

/**
 * Write a single character's dataset as OpenAI JSONL.
 */
async function writeCharacterDataset(
  result: MultiCharacterResult,
  charDir: string,
  sourceName: string,
  sourceUrl: string,
  logger: (l: Level, m: string) => void,
  dryRun: boolean,
): Promise<CharacterDatasetMeta> {
  // Generate character-specific system prompt
  const systemMessage = generateCharacterSystemPrompt(result.character);
  const trainPath = path.join(charDir, "train.jsonl");
  const metaPath = path.join(charDir, "metadata.json");

  if (dryRun) {
    logger("info", `(dry-run) would write ${result.conversations.length} conversations to ${trainPath}`);
  } else {
    await ensureDir(charDir);
    
    // Write JSONL
    const fh = await fs.open(trainPath, "w");
    for (const msgs of result.conversations) {
      const record = {
        messages: [
          { role: "system", content: systemMessage },
          ...msgs,
        ],
      };
      await fh.write(JSON.stringify(record) + "\n");
    }
    await fh.close();
  }

  const meta: CharacterDatasetMeta = {
    character_id: result.character.id,
    character_handle: result.character.handle,
    character_display_name: result.character.displayName,
    author: result.character.author,
    post_count: result.character.postCount,
    conversation_count: result.conversations.length,
    message_count: result.messageCount,
    source: sourceName,
    source_url: sourceUrl,
    created_at: new Date().toISOString(),
  };

  if (!dryRun) {
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  }

  return meta;
}

/**
 * Generate a HuggingFace dataset card (README.md).
 */
function generateDatasetCard(
  sourceName: string,
  sourceUrl: string,
  characterMetas: CharacterDatasetMeta[],
): string {
  const totalConversations = characterMetas.reduce((a, c) => a + c.conversation_count, 0);
  const totalMessages = characterMetas.reduce((a, c) => a + c.message_count, 0);

  const characterTable = characterMetas
    .slice(0, 20) // Top 20
    .map(c => `| ${c.character_display_name || c.character_id} | ${c.conversation_count} | ${c.message_count} |`)
    .join("\n");

  return `---
license: cc-by-4.0
task_categories:
  - conversational
  - text-generation
language:
  - en
tags:
  - roleplay
  - fiction
  - glowfic
  - chat
size_categories:
  - 1K<n<10K
---

# ${sourceName} Character Conversations

Fine-tuning dataset extracted from [${sourceName}](${sourceUrl}) using [splice](https://github.com/deepfates/splice).

## Dataset Description

This dataset contains multi-turn conversations from a collaborative fiction (glowfic) board. Each character's responses are segmented as "assistant" turns, with all other participants as "user" turns.

### Statistics

- **Total Characters**: ${characterMetas.length}
- **Total Conversations**: ${totalConversations.toLocaleString()}
- **Total Messages**: ${totalMessages.toLocaleString()}

### Top Characters by Conversations

| Character | Conversations | Messages |
|-----------|---------------|----------|
${characterTable}

## Dataset Structure

Each record follows the OpenAI chat format:

\`\`\`json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
\`\`\`

## Directory Structure

\`\`\`
characters/
├── <character_id>/
│   ├── train.jsonl      # Conversation data
│   └── metadata.json    # Character metadata
└── ...
\`\`\`

## Usage

\`\`\`python
from datasets import load_dataset

# Load a specific character
ds = load_dataset("json", data_files="characters/keltham/train.jsonl")

# Or load all characters
ds = load_dataset("json", data_files="characters/*/train.jsonl")
\`\`\`

## License

This dataset is provided under CC-BY-4.0. Original content from ${sourceUrl}.

## Source

Extracted on ${new Date().toISOString().split("T")[0]} using splice multi-character export.
`;
}

/**
 * Generate dataset_info.json for HuggingFace.
 */
function generateDatasetInfo(
  sourceName: string,
  sourceUrl: string,
  characterMetas: CharacterDatasetMeta[],
): object {
  return {
    description: `Character conversations extracted from ${sourceName}`,
    citation: "",
    homepage: sourceUrl,
    license: "cc-by-4.0",
    features: {
      messages: {
        feature: {
          role: { dtype: "string", _type: "Value" },
          content: { dtype: "string", _type: "Value" },
        },
        _type: "Sequence",
      },
    },
    splits: {
      train: {
        name: "train",
        num_examples: characterMetas.reduce((a, c) => a + c.conversation_count, 0),
      },
    },
    download_size: 0,
    dataset_size: 0,
  };
}

/**
 * Write a complete HuggingFace-compatible dataset structure.
 */
export async function writeHuggingFaceDataset(
  results: MultiCharacterResult[],
  opts: HuggingFaceDatasetOptions,
): Promise<{ characterCount: number; conversationCount: number }> {
  const { outDir, sourceName, sourceUrl, dryRun, logger } = opts;
  const charactersDir = path.join(outDir, "characters");

  logger("info", `Writing HuggingFace dataset for ${results.length} characters`);

  if (!dryRun) {
    await ensureDir(charactersDir);
  }

  const characterMetas: CharacterDatasetMeta[] = [];
  let totalConversations = 0;

  for (const result of results) {
    const charDirName = sanitizeCharacterId(result.character.id);
    const charDir = path.join(charactersDir, charDirName);
    
    const meta = await writeCharacterDataset(
      result,
      charDir,
      sourceName,
      sourceUrl,
      logger,
      dryRun,
    );
    characterMetas.push(meta);
    totalConversations += result.conversations.length;
    
    logger("info", `  ${result.character.displayName || result.character.id}: ${result.conversations.length} conversations`);
  }

  // Write combined train.jsonl (all characters)
  const combinedPath = path.join(outDir, "train.jsonl");
  if (dryRun) {
    logger("info", `(dry-run) would write combined dataset to ${combinedPath}`);
  } else {
    const fh = await fs.open(combinedPath, "w");
    for (const result of results) {
      const charSystemMessage = generateCharacterSystemPrompt(result.character);
      for (const msgs of result.conversations) {
        const record = {
          messages: [
            { role: "system", content: charSystemMessage },
            ...msgs,
          ],
        };
        await fh.write(JSON.stringify(record) + "\n");
      }
    }
    await fh.close();
    logger("info", `Wrote combined dataset to ${combinedPath}`);
  }

  // Write README.md (dataset card)
  const readmePath = path.join(outDir, "README.md");
  if (!dryRun) {
    const readme = generateDatasetCard(sourceName, sourceUrl, characterMetas);
    await fs.writeFile(readmePath, readme, "utf8");
    logger("info", `Wrote dataset card to ${readmePath}`);
  }

  // Write dataset_info.json
  const infoPath = path.join(outDir, "dataset_info.json");
  if (!dryRun) {
    const info = generateDatasetInfo(sourceName, sourceUrl, characterMetas);
    await fs.writeFile(infoPath, JSON.stringify(info, null, 2), "utf8");
    logger("info", `Wrote dataset info to ${infoPath}`);
  }

  // Write characters manifest
  const manifestPath = path.join(outDir, "characters.json");
  if (!dryRun) {
    await fs.writeFile(manifestPath, JSON.stringify(characterMetas, null, 2), "utf8");
    logger("info", `Wrote characters manifest to ${manifestPath}`);
  }

  return {
    characterCount: results.length,
    conversationCount: totalConversations,
  };
}
