// Selected news timeline: one card per fact, or per standalone article. Only duplicate reports
// fold together. Each fact stays at its first appearance; other news in its story never moves it.
import type { GroupInfo, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { createHash } from "node:crypto";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { cachedByKey } from "../lib/cache.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeRow } from "./representative.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import {
  ITEM_COLUMNS, ITEM_FROM, categoryCondition, channelCondition, tagCondition, toFeedItemSummary,
  type ItemRow,
} from "./items.ts";
import { evidenceCondition, listedCondition, ownFactEvidenceCondition, selectedCondition } from "./scope.ts";

export interface TimelineQuery extends TimelineFilters {
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

interface GroupRow {
  gk: string;
  anchor_at: Date;
}

/** A rankable candidate row of one fact group: the representative fields plus the article id. */
type GroupMember = RepresentativeRow & Pick<ItemRow, "id"> & { fact_id: number };

/** What one read of the whole filtered scope tells the reader-side new-content check. */
interface ScopeSignal {
  rows: { gk: string; anchor: number }[];
  /** Newest WRITE instant of the scope's rows (see `admittedAt` in the response); null when empty. */
  admittedAt: number | null;
  /** The scope's comparable identity map (see `ScopeGroup` in the contracts): key, rep, members, ids. */
  groups: TimelineResponse["groups"];
}

function filterSql(q: TimelineQuery) {
  return sql`${channelCondition(q.channel)} ${categoryCondition(q.category)} ${tagCondition(q.tag)}`;
}

function binding(q: TimelineQuery): string {
  return queryBinding({ c: q.channel, k: q.category, t: q.tag });
}

/**
 * Public pool reports linked to the given facts, under the same
 * filters (non-selected included): the sets "另有 N 家信源报道" expands and the group counts come from.
 */
async function groupPool(q: TimelineQuery, now: Date, factIds: number[]) {
  if (!factIds.length) return [];
  return sql<{ fact_id: number; article_id: string; source_id: string }[]>`
    SELECT DISTINCT f.id AS fact_id, p.article_id, p.source_id
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    WHERE f.id IN ${sql(factIds)}
      AND ${evidenceCondition()} AND ${listedCondition(now)} ${filterSql(q)}`;
}

/**
 * The selected set grouped into cards (fact or standalone item) with their anchor times, newest
 * first. Every timeline page and its day counts read this list; it is kept for five seconds per
 * filter scope (a newly selected report appears at most that much later).
 */
const scopeSignal = cachedByKey(binding, (q: TimelineQuery) => queryScopeSignal(q, new Date()), { freshMs: 5000, maxStaleMs: 5000, maxKeys: 50 });

async function queryScopeSignal(q: TimelineQuery, now: Date): Promise<ScopeSignal> {
  const raw = await sql<{ gk: string; anchor_at: Date; members: number; member_ids: string[]; admitted_at: Date | null }[]>`
      WITH base AS (
        SELECT p.sort_at, p.updated_at, p.article_id,
          CASE WHEN p.fact_id IS NOT NULL AND ${ownFactEvidenceCondition()}
          THEN 'f' || p.fact_id::text ELSE 'a' || p.article_id END AS gk
        FROM publications p
        WHERE ${selectedCondition(now)} ${filterSql(q)}
      )
      SELECT gk, min(sort_at) AS anchor_at, count(*)::int AS members,
             array_agg(DISTINCT article_id ORDER BY article_id) AS member_ids,
             (SELECT max(updated_at) FROM base) AS admitted_at
      FROM base GROUP BY gk ORDER BY anchor_at DESC, gk COLLATE "C" DESC`;
  const rows = raw.map((r) => ({ gk: r.gk, anchor: r.anchor_at.getTime() }));
  // The scope's newest WRITE instant (publish.ts refreshes `updated_at` only when a row really
  // changed), read from the same snapshot as the list — never a separate download. Kept as a COARSE
  // witness only (ROUND6 R6-2/R6-3): it is a transaction-start instant, so commit order can invert
  // it, and a write that changes no scope identity refreshes it all the same. The identity map below
  // is what decides.
  const admitted = raw[0]?.admitted_at;
  // The identity map replaces the old whole-scope representative hash: the reader diffs the two maps,
  // so a group that LEFT, a member that JOINED a surviving group, a within-group swap the member
  // COUNT cannot classify and a replaced representative are each decidable on their own
  // (ROUND6 R6-1/R6-2, ROUND7 R7-1). `memberIds` carries the member identity — ids only, no bodies.
  const reps = await scopeRepresentatives(q, now, rows);
  const byGk = new Map(raw.map((r) => [r.gk, r]));
  const groups = [...reps.keys()].sort().map((gk) => {
    const row = byGk.get(gk);
    return {
      key: gk, rep: reps.get(gk)!,
      members: row?.members ?? 0, memberIds: row?.member_ids ?? [],
    };
  });
  return { rows, admittedAt: admitted instanceof Date ? admitted.getTime() : null, groups };
}

/**
 * The representative every group in the WHOLE filtered scope would be shown with, keyed by the
 * stable group key. Read with the same candidate rule the page-level choice uses
 * (`selectedCondition` + `ownFactEvidenceCondition` + the filters), so signal and page agree on what
 * a representative is; only the reach differs — this one covers the pages the reader has not opened.
 */
async function scopeRepresentatives(q: TimelineQuery, now: Date, grouped: readonly { gk: string }[]): Promise<Map<string, string>> {
  const reps = new Map<string, string>();
  const factIds: number[] = [];
  for (const g of grouped) {
    if (g.gk.startsWith("a")) reps.set(g.gk, g.gk.slice(1));
    else factIds.push(Number(g.gk.slice(1)));
  }
  if (!factIds.length) return reps;
  const members = await sql<GroupMember[]>`
    SELECT p.fact_id, p.article_id AS id, p.body_mode, p.score, p.timeline_at, ${REPRESENTATIVE_COLUMNS}
    FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN facts f ON f.id = p.fact_id
    WHERE p.fact_id IN ${sql(factIds)}
      AND ${selectedCondition(now)} AND ${ownFactEvidenceCondition()} ${filterSql(q)}`;
  const byFact = new Map<number, GroupMember[]>();
  for (const m of members) {
    const list = byFact.get(m.fact_id);
    if (list) list.push(m);
    else byFact.set(m.fact_id, [m]);
  }
  for (const gk of factIds.map((id) => `f${id}`)) {
    const candidates = byFact.get(Number(gk.slice(1))) ?? [];
    // A group with no surviving candidate gets an empty marker rather than no entry: the map's domain
    // then stays the identity set, so only a real representative change can move the fingerprint.
    reps.set(gk, candidates.length ? pickRepresentative(candidates).id! : "");
  }
  return reps;
}

/** Counts requested Beijing days over anchors already sorted newest first. */
export function countTimelineDays(grouped: readonly { anchor: number }[], days: ReadonlySet<string>): Record<string, number> {
  const firstBelow = (bound: number) => {
    let lo = 0, hi = grouped.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (grouped[mid]!.anchor >= bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const counts: Record<string, number> = {};
  for (const day of days) {
    const start = beijingMidnight(day).getTime();
    const count = firstBelow(start) - firstBelow(start + 86_400_000);
    if (count) counts[day] = count;
  }
  return counts;
}

export async function loadTimeline(q: TimelineQuery): Promise<Omit<TimelineResponse, "hot">> {
  const now = q.now ?? new Date();
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  const bind = binding(q);
  let after: { a: number; g: string } | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ a: number; g: string; b: string }>("tl2", q.cursor);
    if (c.b !== bind || typeof c.a !== "number" || typeof c.g !== "string") throw new InvalidCursorError("cursor does not match this query");
    after = { a: c.a, g: c.g };
  }

  // A given clock (tests, replays) reads afresh.
  const scope = q.now ? await queryScopeSignal(q, now) : await scopeSignal(q);
  const grouped = scope.rows;
  const start = after ? grouped.findIndex((g) => g.anchor < after!.a || (g.anchor === after!.a && g.gk < after!.g)) : 0;
  const groups: GroupRow[] = (start < 0 ? [] : grouped.slice(start, start + limit + 1)).map((g) => ({ gk: g.gk, anchor_at: new Date(g.anchor) }));

  const page = groups.slice(0, limit);
  const hasMore = groups.length > limit;

  const factIds = page.filter((g) => g.gk.startsWith("f")).map((g) => Number(g.gk.slice(1)));

  // Read only ranking fields for the whole group; bodies, media and translations are hydrated for this page's representatives.
  const [members, pool] = await Promise.all([
    factIds.length
      ? sql<GroupMember[]>`
        SELECT p.fact_id, p.article_id AS id, p.body_mode, p.score, p.timeline_at, ${REPRESENTATIVE_COLUMNS}
        FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN facts f ON f.id = p.fact_id
        WHERE p.fact_id IN ${sql(factIds)}
          AND ${selectedCondition(now)} AND ${ownFactEvidenceCondition()} ${filterSql(q)}`
      : Promise.resolve([] as GroupMember[]),
    groupPool(q, now, factIds),
  ]);
  const factInfo = new Map(
    factIds.length ? (await sql<{ id: number; public_id: string }[]>`SELECT id, public_id FROM facts WHERE id IN ${sql(factIds)}`).map((f) => [f.id, f]) : [],
  );

  const planned: Array<{ key: string; anchorAt: string; id: string; group: GroupInfo | null }> = [];
  for (const g of page) {
    if (g.gk.startsWith("a")) {
      planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: g.gk.slice(1), group: null });
      continue;
    }
    const factId = Number(g.gk.slice(1));
    const candidates = members.filter((m) => m.fact_id === factId);
    if (!candidates.length) continue;
    const rep = pickRepresentative(candidates);
    const reports = pool.filter((r) => r.fact_id === factId);
    const repSource = reports.find((r) => r.article_id === rep.id)?.source_id;
    const group: GroupInfo = {
      factId: factInfo.get(factId)?.public_id ?? String(factId),
      additionalSourceCount: new Set(reports.filter((r) => r.source_id !== repSource).map((r) => r.source_id)).size,
      reportCount: new Set(reports.map((r) => r.article_id)).size,
    };
    const showGroup = group.reportCount > 1;
    planned.push({ key: g.gk, anchorAt: g.anchor_at.toISOString(), id: rep.id, group: showGroup ? group : null });
  }

  // Recheck scope when hydrating: a withdrawal may commit after the narrow representative read.
  const rows = new Map(planned.length ? (await sql<ItemRow[]>`
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${sql(planned.map((p) => p.id))}
      AND ${selectedCondition(now)} ${filterSql(q)}`).map((row) => [row.id, row]) : []);
  const cards: TimelineCard[] = planned.flatMap(({ id, key, anchorAt, group }) => {
    const row = rows.get(id);
    if (!row) return [];
    return [{ key, anchorAt, item: toFeedItemSummary(row), group }];
  });

  // Day header counts for the days on this page, over the full grouped set.
  const days = new Set(page.map((g) => beijingDate(g.anchor_at)));
  const dayCounts = countTimelineDays(grouped, days);

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor("tl2", { a: last.anchor_at.getTime(), g: last.gk, b: bind }) : null;
  // total = every group in the filtered scope (the same full list cursor paging walks); it is the
  // only reliable read-only "something new was admitted" signal, because a late entrant can land on
  // any page under the anchor-date ordering.
  return {
    filters: { channel: q.channel, category: q.category, tag: q.tag }, cards, nextCursor, dayCounts,
    total: grouped.length,
    // The reader-side new-content signal, computed over the WHOLE filtered scope from the reads this
    // function already makes — no extra download, no change to the ordering:
    //  - contentTag fingerprints the scope's IDENTITY SET (group keys only, sorted). A group that
    //    merely moved its displayed anchor does NOT change it, so a pure retraction can never look
    //    like an admission; a same-count swap or a backfilled admission does. Coarse witness only.
    //  - admittedAt is the newest WRITE instant of the scope's rows (`publications.updated_at`), not
    //    the newest release/discovery date they display. COARSE witness only (ROUND6 R6-2/R6-3): it
    //    is a transaction-start instant, so commit order can invert it, and a write that changes no
    //    scope identity (SEO-only redecision, summary edit) refreshes it all the same.
    //  - groups is the scope's comparable IDENTITY MAP (ROUND6 R6-1/R6-2, ROUND7 R7-1): one
    //    `key`/`rep`/`members`/`memberIds` entry per group across ALL pages. The reader diffs the two
    //    maps, so a group that left, a member that joined a surviving group, a WITHIN-GROUP swap the
    //    member count cannot classify, and a replaced representative are each decidable on their own
    //    — while a pure retraction (whole group or single member), a reorder and a metadata-only
    //    write stay silent.
    contentTag: contentTagOf(grouped),
    admittedAt: scope.admittedAt === null ? null : new Date(scope.admittedAt).toISOString(),
    groups: scope.groups,
  };
}

/**
 * A stable fingerprint of the filtered scope's identity set. Group keys are hashed in SORTED order
 * and nothing else is included: the same members always produce the same tag however the scope is
 * displayed, so anchor drift on a surviving group is invisible to it while a member entering or
 * leaving is not.
 */
function contentTagOf(grouped: readonly { gk: string }[]): string {
  const hash = createHash("sha256");
  for (const gk of grouped.map((g) => g.gk).sort()) hash.update(`${gk}\n`);
  return hash.digest("hex").slice(0, 32);
}
