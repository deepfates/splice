import type { ContentItem } from "./types";

/**
 * Decisions — status/tags attached to IDs, typically ContentItem IDs.
 *
 * Pure helpers to fold a stream of decision records (e.g., parsed from JSONL)
 * into the latest per-id state; group and filter items by status; and build
 * decision records programmatically.
 */

/* --------------------------------- Types --------------------------------- */

export const DEFAULT_DECISION_STATUSES = ["unread", "export", "skip"] as const;
export type DefaultDecisionStatus = (typeof DEFAULT_DECISION_STATUSES)[number];

// Allow custom statuses in addition to defaults
export type DecisionStatus = DefaultDecisionStatus | string;

export interface DecisionRecord {
  // Target identifier (e.g., ContentItem.id)
  id: string;

  // Primary decision status (unread | export | skip | ...custom)
  status?: DecisionStatus;

  // Optional tags aggregated across decisions (union)
  tags?: string[];

  // Optional freeform note/comment
  notes?: string;

  // ISO-8601 timestamp when this decision was made
  // If omitted, treated as the lowest (oldest) timestamp.
  ts?: string;

  // Optional user/agent (e.g., "alice", "ui", "auto-filter")
  by?: string;

  // Arbitrary metadata for future extensions
  meta?: Record<string, unknown>;
}

/**
 * The latest, consolidated view per id.
 * - status is the last-known value (newer decisions win)
 * - tags are the union across all decisions for that id
 * - notes are the last-known (newer decisions win)
 * - ts is the latest timestamp observed for that id
 */
export interface LatestDecision extends Required<Pick<DecisionRecord, "id">> {
  status?: DecisionStatus;
  tags: string[];
  notes?: string;
  ts?: string;
  by?: string;
  meta?: Record<string, unknown>;
}

/* -------------------------------- Helpers -------------------------------- */

function isValidIso(ts: string | undefined): boolean {
  if (!ts) return false;
  const n = Date.parse(ts);
  return !Number.isNaN(n);
}

/**
 * Compare two "decision-like" objects (need only ts) in ascending order by time.
 * Returns:
 *   > 0 if a is newer than b
 *   < 0 if a is older than b
 *   = 0 if equal recency or both invalid
 */
export function compareDecisionRecency(
  a: { ts?: string },
  b: { ts?: string },
): number {
  const aValid = isValidIso(a.ts);
  const bValid = isValidIso(b.ts);
  if (aValid && bValid) {
    return Date.parse(a.ts!) - Date.parse(b.ts!);
  }
  if (aValid && !bValid) return 1;
  if (!aValid && bValid) return -1;
  return 0;
}

/**
 * Merge decision B into A, assuming B is newer or otherwise wins.
 * - status: take B's if present
 * - tags: union
 * - notes/by/meta/ts: take B's if present
 */
export function mergeDecision(
  a: LatestDecision,
  b: DecisionRecord,
): LatestDecision {
  const merged: LatestDecision = {
    id: a.id,
    status: b.status ?? a.status,
    tags: Array.from(new Set([...(a.tags || []), ...(b.tags || [])])),
    notes: b.notes ?? a.notes,
    ts: b.ts ?? a.ts,
    by: b.by ?? a.by,
    meta: { ...(a.meta || {}), ...(b.meta || {}) },
  };
  return merged;
}

/**
 * Build a LatestDecision from a single record (base state).
 */
export function baseFromDecision(rec: DecisionRecord): LatestDecision {
  return {
    id: rec.id,
    status: rec.status,
    tags: Array.from(new Set(rec.tags || [])),
    notes: rec.notes,
    ts: rec.ts,
    by: rec.by,
    meta: rec.meta ? { ...rec.meta } : undefined,
  };
}

export interface FoldOptions {
  /**
   * Restrict to known statuses. If false, accept any string.
   * Defaults to true (validate against DEFAULT_DECISION_STATUSES).
   */
  restrictStatuses?: boolean;

  /**
   * Custom allowed statuses (takes precedence over defaults if provided).
   */
  allowedStatuses?: ReadonlyArray<string>;
}

/**
 * Normalize a status. Returns undefined if restricted and invalid.
 */
export function normalizeStatus(
  status: DecisionStatus | undefined,
  opts?: FoldOptions,
): DecisionStatus | undefined {
  if (!status) return undefined;
  const restrict = opts?.restrictStatuses ?? true;
  const allowed = opts?.allowedStatuses ?? DEFAULT_DECISION_STATUSES;
  if (!restrict) return status;
  return allowed.includes(status) ? status : undefined;
}

/**
 * Fold a (possibly long) stream of decisions into the latest per id.
 * Newer decisions override older ones. In case of equal recency, last write wins
 * based on iteration order.
 */
export async function foldDecisions(
  decisions: Iterable<DecisionRecord> | AsyncIterable<DecisionRecord>,
  opts?: FoldOptions,
): Promise<Map<string, LatestDecision>> {
  const out = new Map<string, LatestDecision>();
  for await (const rec of decisions as AsyncIterable<DecisionRecord>) {
    if (!rec || typeof rec.id !== "string" || rec.id.length === 0) {
      continue;
    }
    // Optionally validate status
    const normStatus = normalizeStatus(rec.status, opts);
    const normalized: DecisionRecord = { ...rec, status: normStatus };

    const existing = out.get(rec.id);
    if (!existing) {
      out.set(rec.id, baseFromDecision(normalized));
      continue;
    }

    // Determine if incoming is newer; if equal, prefer incoming (last write wins)
    const cmp = compareDecisionRecency(normalized, existing);
    if (cmp >= 0) {
      out.set(rec.id, mergeDecision(existing, normalized));
    } else {
      // Older record: still merge tags (union) but keep newer status/notes/ts
      const mergedTags = Array.from(
        new Set([...(existing.tags || []), ...(normalized.tags || [])]),
      );
      out.set(rec.id, { ...existing, tags: mergedTags });
    }
  }
  return out;
}

/* ----------------------------- Selection helpers ----------------------------- */

/**
 * Returns a numeric ranking for statuses useful for sorting/filtering UIs.
 * Higher rank means "more included":
 *   export (2) > unread (1) > skip (0)
 * Unknown/custom statuses get rank 1 by default (treat as unread).
 */
export function statusRank(status?: DecisionStatus): number {
  if (status === "export") return 2;
  if (status === "skip") return 0;
  if (status === "unread") return 1;
  return 1; // unknown/custom -> neutral default
}

export interface ApplyStatusOptions {
  /**
   * If an item has no decision, treat it as this status for categorization.
   * Defaults to "unread".
   */
  defaultStatus?: DecisionStatus;

  /**
   * Predicate to define whether a decision means "selected for export".
   * Defaults to (status === "export").
   */
  isSelected?: (status?: DecisionStatus) => boolean;
}

export interface AppliedStatus<T> {
  // Lists grouped by status
  byStatus: Record<string, T[]>;
  // Convenience aliases for defaults
  unread: T[];
  export: T[];
  skip: T[];
  // Flattened selection list (based on isSelected)
  selected: T[];
}

/**
 * Apply latest decisions to a list of items, grouping them by status and
 * computing the selection subset (e.g., export).
 */
export function applyDecisionStatus<T extends { id: string }>(
  items: T[],
  latest: Map<string, LatestDecision>,
  opts?: ApplyStatusOptions,
): AppliedStatus<T> {
  const defaultStatus = opts?.defaultStatus ?? "unread";
  const isSelected =
    opts?.isSelected ?? ((s?: DecisionStatus) => s === "export");

  const byStatus: Record<string, T[]> = {};
  const selected: T[] = [];

  for (const item of items) {
    const dec = latest.get(item.id);
    const status = dec?.status ?? defaultStatus;
    (byStatus[status] ||= []).push(item);
    if (isSelected(status)) selected.push(item);
  }

  // Ensure default buckets exist for convenience
  const unread = byStatus["unread"] || [];
  const willExport = byStatus["export"] || [];
  const skip = byStatus["skip"] || [];

  return { byStatus, unread, export: willExport, skip, selected };
}

/* ------------------------------- Summarization ------------------------------- */

export interface DecisionSummary {
  totalIds: number;
  countsByStatus: Record<string, number>;
}

/**
 * Summarize the latest decisions (counts by status).
 */
export function summarizeLatestDecisions(
  latest: Map<string, LatestDecision>,
): DecisionSummary {
  const counts: Record<string, number> = {};
  for (const rec of latest.values()) {
    const status = rec.status ?? "unread";
    counts[status] = (counts[status] || 0) + 1;
  }
  const total = Array.from(latest.keys()).length;
  return { totalIds: total, countsByStatus: counts };
}

/* --------------------------------- Builders --------------------------------- */

/**
 * Utility to create decision records for a set of ids.
 */
export function decisionsFromIds(
  ids: string[],
  status: DecisionStatus,
  params?: Omit<DecisionRecord, "id" | "status">,
): DecisionRecord[] {
  const base: Omit<DecisionRecord, "id" | "status"> = {
    ts: params?.ts ?? new Date().toISOString(),
    by: params?.by,
    tags: params?.tags,
    notes: params?.notes,
    meta: params?.meta,
  };
  return ids.map((id) => ({ id, status, ...base }));
}

/* ------------------------------- Item filters -------------------------------- */

/**
 * Filter a list of ContentItem to those whose latest decision is selected for export.
 */
export function filterSelectedItems(
  items: ContentItem[],
  latest: Map<string, LatestDecision>,
  isSelected: (status?: DecisionStatus) => boolean = (s) => s === "export",
): ContentItem[] {
  const out: ContentItem[] = [];
  for (const it of items) {
    const s = latest.get(it.id)?.status;
    if (isSelected(s)) out.push(it);
  }
  return out;
}
