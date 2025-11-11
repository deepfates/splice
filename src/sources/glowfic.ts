/**
 * Glowfic source adapter and helpers
 *
 * - Uses the glowfic-dl library to fetch Threads/Sections/Boards from glowfic.com
 * - Normalizes posts to ContentItem[]
 * - Provides helpers to build ChatMessage conversations by selecting one character
 *   (by display name, handle, or author) as the "assistant" and others as "user"
 *
 * Notes:
 * - Requires the "glowfic-dl" package to be installed in your project.
 *   npm i glowfic-dl
 */

import type {
  Level,
  ContentItem,
  Thread as NormalizedThread,
  ChatMessage,
  Role,
} from "../core/types";
import { toIso } from "../core/types";

import {
  fetchStructure,
  threadToMarkdown as glowThreadToMarkdown,
  htmlToMarkdown as glowHtmlToMarkdown,
  type Thread as GlowThread,
  type Section as GlowSection,
  type Board as GlowBoard,
  type Post as GlowPost,
  type BookStructure,
} from "glowfic-dl";

/* --------------------------------- Detect --------------------------------- */

/**
 * Quick URL detection for Glowfic resources.
 * Matches posts, board sections, and boards.
 */
export function detectGlowficUri(pathOrUri: string): boolean {
  try {
    const u = new URL(pathOrUri);
    if (!/(\.|^)glowfic\.com$/i.test(u.hostname)) return false;
    return /\/(posts|board_sections|boards)\//.test(u.pathname);
  } catch {
    // Not a URL; allow bare paths that look like glowfic routes
    return /glowfic\.com\/(posts|board_sections|boards)\//.test(pathOrUri);
  }
}

/* ------------------------------ Fetch helpers ----------------------------- */

function threadsFromStructure(struct: BookStructure): GlowThread[] {
  if (struct.kind === "thread") return [struct.thread];
  if (struct.kind === "section") return struct.section.threads;
  if (struct.kind === "board") return struct.board.threads;
  return [];
}

/**
 * Fetch all threads reachable from a Glowfic URL (thread/section/board).
 * Optionally convert HTML content to Markdown for easier downstream use.
 */
export async function fetchGlowficThreads(
  url: string,
  logger: (l: Level, m: string) => void = () => {},
  options?: { markdown?: boolean },
): Promise<GlowThread[]> {
  logger("info", `Fetching Glowfic: ${url}`);
  const struct = await fetchStructure(url);
  let threads = threadsFromStructure(struct);
  if (options?.markdown !== false) {
    threads = threads.map((t) => glowThreadToMarkdown(t));
  }
  logger("info", `Fetched ${threads.length} thread(s) from ${url}`);
  return threads;
}

/**
 * Fetch threads from multiple URLs, flattening into a single list.
 */
export async function fetchGlowficThreadsMany(
  urls: string[],
  logger: (l: Level, m: string) => void = () => {},
  options?: { markdown?: boolean; concurrency?: number },
): Promise<GlowThread[]> {
  const conc = Math.max(1, Math.min(options?.concurrency ?? 4, 16));
  const out: GlowThread[] = [];
  const pending: Promise<void>[] = [];
  let i = 0;

  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const u = urls[idx];
      try {
        const ts = await fetchGlowficThreads(u, logger, {
          markdown: options?.markdown,
        });
        out.push(...ts);
      } catch (err) {
        logger("warn", `Failed to fetch ${u}: ${(err as Error).message}`);
      }
    }
  }

  for (let k = 0; k < conc; k++) pending.push(worker());
  await Promise.all(pending);
  return out;
}

/* -------------------------- Normalization to Items ------------------------- */

/**
 * Normalize a Glowfic post to a generic ContentItem.
 * - id: derived from post_id if present, otherwise from index.
 * - text: Markdown (recommended) or raw HTML stripped to text via glowfic-dl.
 * - createdAt: ISO if available, else now.
 * - source: "glowfic:post"
 * - raw: original Glowfic post shape
 */
export function normalizeGlowficPost(
  thread: GlowThread,
  post: GlowPost,
  indexInThread: number,
  options?: { markdown?: boolean },
): ContentItem {
  const id =
    post.post_id && post.post_id.length
      ? `${thread.id}:${post.post_id}`
      : `${thread.id}:idx-${indexInThread}`;

  let text = post.content ?? "";
  if (options?.markdown !== false) {
    // glowfic-dl post.content is the inner HTML of the post; convert to Markdown for training
    text = glowHtmlToMarkdown(post.content ?? "");
  }

  const createdAt = post.timestamp
    ? toIso(post.timestamp)
    : new Date().toISOString();
  return {
    id,
    text,
    createdAt,
    parentId: null,
    inReplyToUserId: null,
    accountId: null,
    source: "glowfic:post",
    raw: {
      thread_id: thread.id,
      thread_title: thread.title,
      url: thread.url,
      post,
    },
  };
}

/**
 * Convert a Glowfic thread into a normalized Thread (ContentItem[]) object.
 */
export function normalizeGlowficThread(
  thread: GlowThread,
  options?: { markdown?: boolean },
): NormalizedThread {
  const items = thread.posts.map((p, i) =>
    normalizeGlowficPost(thread, p, i, options),
  );
  return {
    id: thread.id,
    items,
  };
}

/**
 * Normalize many Glowfic threads into ContentItems.
 */
export function normalizeGlowficThreadsToItems(
  threads: GlowThread[],
  options?: { markdown?: boolean },
): ContentItem[] {
  const out: ContentItem[] = [];
  for (const t of threads) {
    for (let i = 0; i < t.posts.length; i++) {
      out.push(normalizeGlowficPost(t, t.posts[i]!, i, options));
    }
  }
  return out;
}

/* -------------------------- Conversation generation ------------------------ */

export function segmentedConversationsFromGlowficThread(
  thread: GlowThread,
  assistant: AssistantMatcher,
  options?: ConversationOptions,
): ChatMessage[][] {
  const markdown = options?.markdown !== false;

  // Map posts to role + content
  const msgs = (thread.posts || [])
    .map((p) => {
      const role: Role = isAssistantPost(p, assistant) ? "assistant" : "user";
      const content = markdown
        ? glowHtmlToMarkdown(p.content ?? "")
        : (p.content ?? "");
      const c = (content || "").trim();
      if (!c) return null;
      return { role, content: c } as ChatMessage;
    })
    .filter(Boolean) as ChatMessage[];

  const conversations: ChatMessage[][] = [];
  let userBuf: string[] = [];
  let asstBuf: string[] = [];
  let seenAnyUser = false;

  const flushIfComplete = () => {
    if (userBuf.length > 0 && asstBuf.length > 0) {
      const userMsg: ChatMessage = {
        role: "user",
        content: userBuf.join("\n\n").trim(),
      };
      const asstMsg: ChatMessage = {
        role: "assistant",
        content: asstBuf.join("\n\n").trim(),
      };
      conversations.push([userMsg, asstMsg]);
      userBuf = [];
      asstBuf = [];
      seenAnyUser = false;
    }
  };

  for (const m of msgs) {
    if (m.role === "user") {
      // If we already accumulated an assistant block, that segment is complete; flush and start new.
      if (asstBuf.length > 0) {
        flushIfComplete();
      }
      userBuf.push(m.content);
      seenAnyUser = true;
    } else {
      // assistant
      if (!seenAnyUser) {
        // Leading assistant before any user: ignore (do not start a segment until users appear)
        continue;
      }
      asstBuf.push(m.content);
    }
  }

  // Finalize trailing segment if it ends with assistant
  flushIfComplete();

  return conversations;
}

/**
 * How to decide which posts are the "assistant".
 * - You can pass a string (matched against display name or handle, case-insensitive).
 * - Or a RegExp on display name/handle/author.
 * - Or a predicate function that receives the raw GlowPost.
 */
export type AssistantMatcher =
  | string
  | {
      displayName?: string | RegExp;
      handle?: string | RegExp;
      author?: string | RegExp;
    }
  | ((post: GlowPost) => boolean);

/**
 * Returns true if a glowfic Post should be considered assistant according to the matcher.
 */
export function isAssistantPost(
  post: GlowPost,
  matcher: AssistantMatcher,
): boolean {
  const display = (post.character_display_name || "").trim();
  const handle = (post.character_handle || "").trim();
  const author = (post.author || "").trim();

  // Predicate
  if (typeof matcher === "function") return !!matcher(post);

  // String: match display name or handle case-insensitive
  if (typeof matcher === "string") {
    const needle = matcher.trim().toLowerCase();
    return (
      (display && display.toLowerCase() === needle) ||
      (handle && handle.toLowerCase() === needle)
    );
  }

  // Object form
  const matchStr = (val: string | null, target?: string | RegExp): boolean => {
    if (!target) return false;
    if (!val) return false;
    if (typeof target === "string")
      return val.toLowerCase() === target.toLowerCase();
    try {
      return target.test(val);
    } catch {
      return false;
    }
  };

  return (
    matchStr(display, matcher.displayName) ||
    matchStr(handle, matcher.handle) ||
    matchStr(author, matcher.author)
  );
}

export type ConversationOptions = {
  markdown?: boolean; // default true
  mergeConsecutive?: boolean; // merge adjacent messages from same role
  trimToLastAssistant?: boolean; // drop trailing user tail if assistant appears earlier
};

/**
 * Convert a single Glowfic thread into messages with the chosen assistant character.
 */
export function conversationFromGlowficThread(
  thread: GlowThread,
  assistant: AssistantMatcher,
  options?: ConversationOptions,
): ChatMessage[] {
  const markdown = options?.markdown !== false;
  const mergeConsecutive = options?.mergeConsecutive !== false; // default true
  const trimToLastAssistant = options?.trimToLastAssistant !== false; // default true

  type P = GlowPost;
  const posts: P[] = thread.posts || [];

  const messagesRaw: ChatMessage[] = posts
    .map((p) => {
      const role: Role = isAssistantPost(p, assistant) ? "assistant" : "user";
      const content = markdown
        ? glowHtmlToMarkdown(p.content ?? "")
        : (p.content ?? "");
      const c = (content || "").trim();
      if (!c) return null;
      return { role, content: c };
    })
    .filter(Boolean) as ChatMessage[];

  const msgs = mergeConsecutive ? mergeSameRole(messagesRaw) : messagesRaw;

  if (trimToLastAssistant) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "assistant") return msgs.slice(0, i + 1);
    }
    return []; // if no assistant lines, skip
  }

  return msgs;
}

/**
 * Build conversations for each thread captured by the given URL (thread/section/board).
 */
export async function conversationsFromGlowficUrl(
  url: string,
  assistant: AssistantMatcher,
  logger: (l: Level, m: string) => void = () => {},
  options?: ConversationOptions,
): Promise<{ thread: GlowThread; messages: ChatMessage[] }[]> {
  const threads = await fetchGlowficThreads(url, logger, {
    markdown: options?.markdown,
  });
  const out: { thread: GlowThread; messages: ChatMessage[] }[] = [];
  for (const t of threads) {
    const segments = segmentedConversationsFromGlowficThread(
      t,
      assistant,
      options,
    );
    for (const messages of segments) {
      if (messages.length > 0) out.push({ thread: t, messages });
    }
  }
  return out;
}

/**
 * Build conversations across many URLs (flattened).
 */
export async function conversationsFromGlowficUrls(
  urls: string[],
  assistant: AssistantMatcher,
  logger: (l: Level, m: string) => void = () => {},
  options?: ConversationOptions,
): Promise<{ thread: GlowThread; messages: ChatMessage[] }[]> {
  const threads = await fetchGlowficThreadsMany(urls, logger, {
    markdown: options?.markdown,
  });
  const out: { thread: GlowThread; messages: ChatMessage[] }[] = [];
  for (const t of threads) {
    const segments = segmentedConversationsFromGlowficThread(
      t,
      assistant,
      options,
    );
    for (const messages of segments) {
      if (messages.length > 0) out.push({ thread: t, messages });
    }
  }
  return out;
}

/* ------------------------------- SourceAdapter ---------------------------- */

import type { SourceAdapter, Logger } from "../index";

/**
 * A pluggable SourceAdapter for Glowfic URLs.
 * - detect(): true for glowfic.com posts/sections/boards
 * - ingest(): returns normalized ContentItem[] flattened from all threads
 *
 * Note: Use the conversation helpers above if you want ChatMessage dialogs
 * with a chosen assistant character. The adapter focuses on generic items.
 */
export const GlowficSourceAdapter: SourceAdapter = {
  kind: "glowfic",
  async detect(pathOrUri: string): Promise<boolean> {
    return detectGlowficUri(pathOrUri);
  },
  async ingest(pathOrUri: string, log: Logger): Promise<ContentItem[]> {
    const threads = await fetchGlowficThreads(pathOrUri, (l, m) => log(l, m), {
      markdown: true,
    });
    return normalizeGlowficThreadsToItems(threads, { markdown: true });
  },
};

/* --------------------------------- utils ---------------------------------- */

function mergeSameRole(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const out: ChatMessage[] = [];
  let curRole: Role | null = null;
  let cur: string[] = [];
  const flush = () => {
    if (curRole && cur.length) {
      const content = cur.join("\n\n").trim();
      if (content) out.push({ role: curRole, content });
    }
    curRole = null;
    cur = [];
  };
  for (const m of messages) {
    if (curRole !== m.role) {
      flush();
      curRole = m.role;
      cur.push(m.content);
    } else {
      cur.push(m.content);
    }
  }
  flush();
  return out;
}
