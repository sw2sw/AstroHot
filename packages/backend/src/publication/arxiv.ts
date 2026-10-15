import type { ArxivFeed, ArxivReport } from "@aihot/contracts/arxiv";
import type { Db } from "../db.ts";

const CATEGORIES = ["astro-ph.CO", "astro-ph.EP", "astro-ph.GA", "astro-ph.HE", "astro-ph.IM", "astro-ph.SR"];
export const ARXIV_CANDIDATE_NOTE = "AI摘要初筛候选；未阅读全文；同行评议未核实";
export interface ArxivQuery { page: number; pageSize: number; category: string | null }

export function parseArxivQuery(query: Record<string, unknown>): ArxivQuery {
  function integer(value: unknown, fallback: number, max: number) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new Error("invalid pagination");
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > max) throw new Error("invalid pagination");
    return n;
  }
  const category = query.category === undefined ? null : query.category;
  if (category !== null && (typeof category !== "string" || !CATEGORIES.includes(category))) throw new Error("invalid category");
  return { page: integer(query.page, 1, 1_000_000), pageSize: integer(query.pageSize, 20, 50), category };
}

export async function loadArxivFeed(query: ArxivQuery, database?: Db): Promise<ArxivFeed> {
  const db = database ?? (await import("../db.ts")).sql;
  // One statement gives items, actual total and metadata the same database snapshot.
  const rows = await db`
    WITH latest AS (
      SELECT report, synced_at FROM arxiv_reports ORDER BY generated_at DESC, run_id ASC LIMIT 1
    ), first_announcements AS (
      SELECT base_id, min(announced_on) AS announced_on FROM arxiv_announcements
      WHERE announce_type = 'new'
      GROUP BY base_id
    ), candidates AS (
      SELECT CASE WHEN a.announced_on IS NULL THEN p.paper
                  ELSE p.paper || jsonb_build_object('announced_on', a.announced_on::text) END AS paper,
             p.base_id,
             -- The day the reader can honestly name, from the most specific source to the least:
             -- the stored 'new' announcement evidence, then the day the record itself carries (an
             -- RSS-sourced record states one and states no submission instant), then the submission
             -- day a record taken from the API can fall back on. A row that names no day at all
             -- stays NULL and is never dressed up as the newest one.
             COALESCE(a.announced_on::text, p.paper->>'announced_on',
               to_char((p.paper->>'submitted_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')) AS display_day,
             (a.announced_on IS NOT NULL) AS has_announcement,
             (p.paper->>'submitted_at')::timestamptz AS submitted_at,
             p.admitted_at
      FROM arxiv_papers p LEFT JOIN first_announcements a ON a.base_id = p.base_id
      WHERE paper->>'verdict' = 'SELECT' AND paper->>'publication_status' = 'candidate_only'
        AND (${query.category}::text IS NULL OR (paper->'categories') ? ${query.category})
    ), page_items AS (
      SELECT paper, base_id, display_day, has_announcement, submitted_at FROM candidates
      ORDER BY display_day DESC NULLS LAST, has_announcement DESC, submitted_at DESC NULLS LAST, base_id ASC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    )
    SELECT COALESCE((SELECT jsonb_agg(paper ORDER BY display_day DESC NULLS LAST, has_announcement DESC, submitted_at DESC NULLS LAST, base_id ASC) FROM page_items), '[]'::jsonb) AS items,
      (SELECT count(*)::integer FROM candidates) AS total,
      -- The reader-side new-content signal, computed over the WHOLE filtered set from rows this query
      -- already reads: no extra download, no change to the ordering.
      --  - content_tag fingerprints the candidate IDENTITY set. An EMPTY scope still yields a stable,
      --    non-empty fingerprint (md5 of the empty string), so "this filter really is empty" is a
      --    known baseline rather than a missing signal.
      --  - admitted_at is the newest WRITE instant of the filtered candidates: when the most recently
      --    admitted paper (or regenerated version) was actually stored. Null for a legitimately empty
      --    scope. It is deliberately not the stored generated_at, which is the reporting run's own
      --    date — a report imported late can carry an OLDER one, and then a new candidate used to
      --    leave this maximum untouched (the round-5 W1 counterexample).
      (SELECT md5(coalesce(string_agg(c.base_id || '#' || (c.paper->>'arxiv_id'), ',' ORDER BY c.base_id), '')) FROM candidates c) AS content_tag,
      (SELECT max(c.admitted_at) FROM candidates c) AS admitted_at,
      -- The comparable identity map (ROUND6 R6-2, ROUND7 R7-2): one entry per candidate, base-id
      -- order. The archive is a flat list, so every candidate is its own group. The stable 'key' is
      -- the base id, but the versioned arxiv_id is the member/rep IDENTITY: a v1->v2 replacement
      -- the version guard accepted must look like a change (otherwise a net decrease can swallow it
      -- — exactly the R7-2 counterexample), and the reader diffs memberIds for that. Ids only.
      (SELECT jsonb_agg(jsonb_build_object(
                'key', c.base_id, 'rep', c.paper->>'arxiv_id', 'members', 1,
                'memberIds', jsonb_build_array(c.paper->>'arxiv_id')) ORDER BY c.base_id)
        FROM (SELECT DISTINCT base_id, paper FROM candidates) c) AS groups,
      (SELECT report FROM latest) AS report,
      (SELECT synced_at FROM latest) AS synced_at`;
  const row = rows[0];
  if (!row) throw new Error("arxiv feed query returned no aggregate");
  const report = row.report as ArxivReport | null;
  return {
    items: row.items as ArxivFeed["items"], total: Number(row.total), page: query.page, pageSize: query.pageSize,
    contentTag: (row.content_tag as string | null) ?? "",
    admittedAt: row.admitted_at ? new Date(row.admitted_at as string).toISOString() : null,
    groups: (row.groups as ArxivFeed["groups"] | null) ?? [],
    latestBatch: report ? {
      paperCount: report.paper_count,
      selectedCount: report.counts.SELECT,
      outcome: report.paper_count === 0 ? "no_new_papers" : report.counts.SELECT === 0 ? "no_selected_papers" : "selected",
    } : null,
    lastSyncedAt: row.synced_at ? new Date(row.synced_at as string).toISOString() : null,
    issueDate: report?.issue_date ?? null, mode: report?.mode ?? null, coverage: report?.coverage ?? null,
    note: report?.note_zh ? `${ARXIV_CANDIDATE_NOTE}。${report.note_zh}` : ARXIV_CANDIDATE_NOTE,
  };
}
