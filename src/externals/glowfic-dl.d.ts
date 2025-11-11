declare module "glowfic-dl" {
  // Types mirrored from the glowfic-dl README/source (minimal surface)
  export type Post = {
    post_id: string;
    author: string | null;
    character_display_name: string | null;
    character_handle: string | null;
    icon_url: string | null;
    timestamp: string | null;
    content: string;
  };

  export type Thread = {
    id: string;
    title: string;
    url: string;
    description: string | null;
    posts: Post[];
    authors: string[];
    created_at?: string | null;
    updated_at?: string | null;
  };

  export type Section = {
    id: string;
    title: string | null;
    description: string | null;
    threads: Thread[];
  };

  export type Board = {
    id: string;
    title: string;
    description: string | null;
    sections: Section[];
    threads: Thread[];
  };

  export type BookStructure =
    | { kind: "thread"; thread: Thread }
    | { kind: "section"; section: Section }
    | { kind: "board"; board: Board };

  export const GLOWFIC_ROOT: string;

  // Fetchers
  export function fetchThread(url: string): Promise<Thread>;
  export function fetchSection(url: string): Promise<Section>;
  export function fetchBoard(url: string): Promise<Board>;
  export function fetchStructure(url: string): Promise<BookStructure>;

  // HTML/Markdown transforms
  export function htmlToMarkdown(html: string, options?: {
    baseUrl?: string;
    absoluteUrls?: boolean;
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "*" | "+";
    keepUnknownInlineHtml?: boolean;
  }): string;

  export function postToMarkdown(p: Post, options?: {
    baseUrl?: string;
    absoluteUrls?: boolean;
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "*" | "+";
    keepUnknownInlineHtml?: boolean;
  }): Post;

  export function threadToMarkdown(t: Thread, options?: {
    baseUrl?: string;
    absoluteUrls?: boolean;
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "*" | "+";
    keepUnknownInlineHtml?: boolean;
  }): Thread;

  export function sectionToMarkdown(s: Section, options?: {
    baseUrl?: string;
    absoluteUrls?: boolean;
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "*" | "+";
    keepUnknownInlineHtml?: boolean;
  }): Section;

  export function boardToMarkdown(b: Board, options?: {
    baseUrl?: string;
    absoluteUrls?: boolean;
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "*" | "+";
    keepUnknownInlineHtml?: boolean;
  }): Board;
}
