// The AI4S column's public read layer: its own flat lists (全部动态 / 精选), isolated from the
// astronomy site by publications.content_scope. Astronomy's read layer never sees these rows unless
// an editor cross-lists one (scope.ts astroScopeCondition); this layer never reads astronomy rows.
import type { Ai4sFeedResponse, Ai4sItemSummary } from "@aihot/contracts/site";
import { AI4S_DOMAIN_KEYS } from "@aihot/industry/ai4s";
import { one, sql, type Db } from "../db.ts";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "./items.ts";
import { readerNote } from "./rules.ts";
import { ai4sListedCondition, ai4sSelectedCondition } from "./scope.ts";

export const AI4S_PAGE_SIZE = 40;
export const AI4S_MAX_PAGES = 50;

export interface Ai4sQuery {
  tab: "selected" | "all";
  /** "astro" is the AI4A subset (verified astronomy applications); a domain key filters that domain. */
  domain: string | null;
  page: number;
  now?: Date;
}

export function parseAi4sQuery(query: Record<string, unknown>): Ai4sQuery {
  const tab = query.tab === undefined || query.tab === "all" ? "all" : query.tab === "selected" ? "selected" : null;
  if (!tab) throw new Error("invalid tab");
  const domain = query.domain === undefined || query.domain === "all" ? null : query.domain;
  if (domain !== null && (typeof domain !== "string" || (domain !== "astro" && !(AI4S_DOMAIN_KEYS as readonly string[]).includes(domain)))) throw new Error("invalid domain");
  let page = 1;
  if (query.page !== undefined) {
    if (typeof query.page !== "string" || !/^[1-9]\d*$/.test(query.page)) throw new Error("invalid pagination");
    page = Number(query.page);
    if (!Number.isSafeInteger(page) || page > 1_000_000) throw new Error("invalid pagination");
  }
  return { tab, domain, page };
}

type Ai4sItemRow = ItemRow & {
  domain: string | null;
  ai4a: boolean | null;
  /** This column's own selection — never the astronomy one. */
  ai4s_own_selected: boolean;
  /** This column's own score; null for a cross-listed row, which holds no AI4S-scored judgement. */
  ai4s_own_score: string | number | null;
  /** Keeps its astronomy home and is listed here through the cross-list. */
  cross_listed: boolean;
};

/**
 * The card belongs to the AI4S column, so the selection and the score it shows are that column's own.
 * A native AI4S row reads the publication's own judgement; a cross-listed astronomy row neither
 * inherits the astronomy selection nor wears its score — it has no AI4S score, so it shows none.
 * (The article's home page still renders its astronomy projection; only this column's DTO changes.)
 */
const AI4S_ITEM_COLUMNS = sql`${ITEM_COLUMNS}, p.domain, p.ai4a,
  (p.content_scope = 'ai4s' AND p.selected) OR (p.content_scope = 'astro' AND p.ai4s_cross_listed AND p.ai4s_selected) AS ai4s_own_selected,
  CASE WHEN p.content_scope = 'ai4s' THEN p.score END AS ai4s_own_score,
  (p.content_scope = 'astro' AND p.ai4s_cross_listed) AS cross_listed`;

function toAi4sItem(row: Ai4sItemRow): Ai4sItemSummary {
  const card = toFeedItemSummary(row);
  return {
    ...card,
    selected: row.ai4s_own_selected,
    score: row.ai4s_own_score === null ? null : Math.round(Number(row.ai4s_own_score)),
    // The "why selected" note belongs to the column that selected it.
    reason: row.ai4s_own_selected ? card.reason : null,
    originalTitle: row.original_title,
    links: { original: row.url },
    domain: row.domain,
    ai4a: row.ai4a,
    crossListed: row.cross_listed,
    accessNote: readerNote({ coverage: row.coverage, access: row.access, fullText: row.body_mode === "full" }),
  };
}

export async function loadAi4sFeed(query: Partial<Ai4sQuery>, database?: Db): Promise<Ai4sFeedResponse> {
  const db = database ?? sql;
  const now = query.now ?? new Date();
  const tab = query.tab ?? "all";
  const domain = query.domain ?? null;
  const page = Math.min(Math.max(query.page ?? 1, 1), AI4S_MAX_PAGES);
  const scope = tab === "selected" ? ai4sSelectedCondition(now) : ai4sListedCondition(now);
  const domainFilter = domain === "astro" ? sql`AND p.ai4a IS TRUE` : domain ? sql`AND p.domain = ${domain}` : sql``;
  // The selected tab puts verified astronomy applications first; both tabs keep time order within.
  const order = tab === "selected"
    ? sql`ORDER BY p.ai4a DESC NULLS LAST, p.timeline_at DESC, p.article_id DESC`
    : sql`ORDER BY p.timeline_at DESC, p.article_id DESC`;
  const offset = (page - 1) * AI4S_PAGE_SIZE;
  const cap = AI4S_MAX_PAGES * AI4S_PAGE_SIZE;
  const rows = await db<Ai4sItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p WHERE ${scope} ${domainFilter}
      ${order} LIMIT ${AI4S_PAGE_SIZE} OFFSET ${offset})
    SELECT ${AI4S_ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ${order}`;
  const meta = one(await db<{ total: number; updated_at: Date | null; content_tag: string | null; groups: Ai4sFeedResponse["groups"] | null }[]>`
    WITH filtered AS (SELECT p.article_id, p.updated_at FROM publications p WHERE ${scope} ${domainFilter})
    SELECT (SELECT count(*) FROM (SELECT 1 FROM filtered LIMIT ${cap}) t) AS total,
      (SELECT max(updated_at) FROM filtered) AS updated_at,
      -- The reader-side new-content signal over the WHOLE filtered scope (照 arxiv): a flat list, so every
      -- item is its own group keyed by its stable article id. An empty scope still yields a stable hash,
      -- so "this filter really is empty" is a known baseline rather than a missing signal.
      (SELECT md5(coalesce(string_agg(article_id, ',' ORDER BY article_id), '')) FROM filtered) AS content_tag,
      (SELECT jsonb_agg(jsonb_build_object('key', article_id, 'rep', article_id, 'members', 1,
        'memberIds', jsonb_build_array(article_id)) ORDER BY article_id) FROM filtered) AS groups`);
  return {
    tab,
    domain,
    items: rows.map(toAi4sItem),
    page,
    pageCount: Math.min(AI4S_MAX_PAGES, Math.max(1, Math.ceil(Number(meta.total) / AI4S_PAGE_SIZE))),
    total: Number(meta.total),
    updatedAt: meta.updated_at ? new Date(meta.updated_at).toISOString() : null,
    contentTag: meta.content_tag ?? "",
    groups: meta.groups ?? [],
  };
}