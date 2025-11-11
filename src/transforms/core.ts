import {
  ContentItem,
  Thread,
  ChatMessage,
  Role,
  isRetweet,
} from "../core/types";

/**
 * Replace shortened URLs with expanded; strip t.co links, mentions, hashtags.
 * Preserve paragraph breaks; collapse intra-line spaces and trim.
 */
export function cleanText(
  text: string,
  entities?: { urls?: Array<{ url: string; expanded_url?: string }> },
): string {
  let t = text ?? "";
  if (entities?.urls) {
    for (const u of entities.urls) {
      if (u.url && u.expanded_url) t = t.split(u.url).join(u.expanded_url);
    }
  }
  // Normalize line endings
  t = t.replace(/\r\n?/g, "\n");
  // Remove t.co links, mentions, and hashtags
  t = t.replace(/https:\/\/t\.co\/\w+/g, "");
  t = t.replace(/@\w+/g, "");
  t = t.replace(/#\w+/g, "");
  // Collapse spaces/tabs within lines while preserving paragraph breaks
  t = t
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  // Limit excessive blank lines but keep paragraph breaks
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export type FilterOptions = {
  since?: string;
  until?: string;
  minLength: number;
  excludeRt: boolean;
  onlyThreads: boolean; // reserved for higher-level logic; not applied here
  withMedia: boolean;
};

/**
 * Apply stateless filters to a list of ContentItem.
 * Note: onlyThreads is intentionally ignored here; thread selection happens after grouping.
 */
export function applyFilters(
  items: ContentItem[],
  opts: FilterOptions,
): ContentItem[] {
  const sinceTime = opts.since ? new Date(opts.since).getTime() : -Infinity;
  const untilTime = opts.until ? new Date(opts.until).getTime() : Infinity;

  return items.filter((it) => {
    const t = new Date(it.createdAt).getTime();
    if (!(t >= sinceTime && t <= untilTime)) return false;
    if (opts.excludeRt && isRetweet(it.text)) return false;
    if (opts.minLength > 0 && (it.text?.trim().length ?? 0) < opts.minLength)
      return false;
    if (opts.withMedia && !(it.media && it.media.length > 0)) return false;
    return true;
  });
}

/**
 * Build a fast lookup map of items by id.
 */
export function indexById(items: ContentItem[]): Record<string, ContentItem> {
  const m: Record<string, ContentItem> = {};
  for (const it of items) {
    if (it.id) m[it.id] = it;
  }
  return m;
}

/**
 * Group items into tweet threads and mixed-source conversations.
 * Threads are chains where all items come from "twitter:tweet" and are self-replies.
 * A self-reply is one where inReplyToUserId matches accountId (or is null/missing).
 * Conversations are chains which include other sources, likes, or replies to others.
 */
export function groupThreadsAndConversations(
  all: Record<string, ContentItem>,
): {
  threads: Thread[];
  conversations: ContentItem[][];
} {
  const processed = new Set<string>();
  const threads: Thread[] = [];
  const conversations: ContentItem[][] = [];

  const items = Object.values(all);
  for (const item of items) {
    if (processed.has(item.id)) continue;

    const chain: ContentItem[] = [item];
    let current = item;
    while (current.parentId && all[current.parentId]) {
      const parent = all[current.parentId];
      chain.push(parent);
      current = parent;
      if (processed.has(current.id)) break;
    }
    for (const c of chain) processed.add(c.id);

    const allTweets = chain.every((c) => c.source === "twitter:tweet");

    // Check if this is a self-thread (all tweets are self-replies)
    // A tweet is a self-reply if:
    // 1. It has no parent (root tweet), OR
    // 2. inReplyToUserId matches accountId, OR
    // 3. inReplyToUserId is null/missing (older archives may not have this field)
    const isSelfThread = chain.every((c) => {
      // Root tweets (no parent) are always part of self-threads
      if (!c.parentId) return true;

      // If we have accountId and inReplyToUserId, check they match
      if (c.accountId && c.inReplyToUserId) {
        return c.inReplyToUserId === c.accountId;
      }

      // If inReplyToUserId is missing, we can't determine ownership
      // In this case, fall back to checking if parent is in our chain
      // (assumes parent must be by same user if it's in the archive)
      return true;
    });

    if (allTweets && isSelfThread) {
      const ordered = chain.slice().reverse(); // oldest → newest
      threads.push({ id: ordered[0].id, items: ordered });
    } else {
      conversations.push(chain.slice().reverse()); // oldest → newest
    }
  }

  return { threads, conversations };
}

/**
 * Convert a conversation (ordered list of ContentItems) into ChatMessages:
 * - Simple heuristic for roles (maintains prior behavior).
 * - Clean text using cleanText().
 * - Merge consecutive messages from the same role.
 * - Trim trailing user messages to end on assistant if possible.
 */
export function inferRole(it: ContentItem): Role {
  // Heuristic: tweets that look like assistant outputs (e.g., have full_text) are "assistant"; others are "user"
  return it.raw && "full_text" in (it.raw as any) ? "assistant" : "user";
}

export function messagesFromConversation(items: ContentItem[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let currentRole: Role | undefined;
  let currentContent: string[] = [];

  function flush() {
    if (!currentRole) return;
    const content = currentContent.join("\n\n").trim();
    if (content) msgs.push({ role: currentRole, content });
    currentContent = [];
  }

  for (const it of items) {
    const role: Role = inferRole(it);
    const cleaned = cleanText(it.text, (it.raw as any)?.entities);
    if (!cleaned) continue;

    if (role !== currentRole && currentRole) flush();
    currentRole = role;
    currentContent.push(cleaned);
  }
  flush();

  // Trim to last assistant message if present
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return msgs.slice(0, i + 1);
  }
  return [];
}
