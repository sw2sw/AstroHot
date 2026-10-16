// Two explicitly approved weekly columns; no source fetch, scoring or model work here.
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { publicSourceName } from "./rules.ts";
import { releasedCondition } from "./scope.ts";

export interface ObservingGuideCard {
  id: string;
  title: string;
  summary: string | null;
  sourceName: string;
  publishedAt: string | null;
}
interface GuideRow {
  id: string; title: string; summary: string | null; source_name: string; published_at: Date | null; cursor_at: string | null;
}
const LIMIT = 30;

/** A deployment must supply one fixed activation instant; unset means manual entries only. */
export function autoGuidesStart(value = process.env.OBSERVING_GUIDES_AUTO_START_AT): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.]\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("invalid OBSERVING_GUIDES_AUTO_START_AT");
  }
  return new Date(value);
}

/** Match persisted RSS categories, never the generic observing section or translated keywords. */
function weeklyColumnCondition() {
  return sql`(
    (btrim(regexp_replace(s.name, '（[^（）]*）', '', 'g')) = 'Astronomy Magazine · News'
      AND a.url ~ '^https://(www[.])?astronomy[.]com/the-sky-this-week/[^/?#]+/?([?#].*)?$'
      AND a.title ~ '^The Sky This Week( from|:)')
    OR
    (btrim(regexp_replace(s.name, '（[^（）]*）', '', 'g')) = 'Sky & Telescope · 天文新闻'
      AND a.url ~ '^https://(www[.])?skyandtelescope[.]org/[^?#]+$'
      AND a.title ~ '^This Week[''’]s Sky at a Glance(,|:| )'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(a.raw->'categories') = 'array' THEN a.raw->'categories' ELSE '[]'::jsonb END
        ) AS category(value)
        WHERE lower(category.value) IN ('sky at a glance', 'this week''s sky at a glance')
      ))
  )`;
}

/** One bounded, filtered query. Manual and automatic entries share publication-date pagination. */
export async function loadObservingGuides(ids: readonly string[], cursor: string | null = null) {
  if (ids.length > 20 || ids.some((id) => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new InvalidCursorError("invalid guide ids");
  const manual = [...new Set(ids)].sort();
  const start = autoGuidesStart();
  const binding = queryBinding({ manual, start: start?.toISOString() ?? null });
  let after = sql``;
  if (cursor) {
    const c = decodeCursor<{ binding: string; at: string | null; id: string }>("guides1", cursor);
    if (c.binding !== binding || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id)
      || !(c.at === null || (typeof c.at === "string" && Number.isFinite(Date.parse(c.at))))) throw new InvalidCursorError("invalid guides cursor");
    after = c.at === null
      ? sql`AND p.published_at IS NULL AND p.article_id COLLATE "C" > ${c.id}`
      : sql`AND (p.published_at < ${c.at}::text::timestamptz OR (p.published_at = ${c.at}::text::timestamptz AND p.article_id COLLATE "C" > ${c.id}) OR p.published_at IS NULL)`;
  }
  const automatic = start
    ? sql`(a.discovered_at >= ${start} AND NOT a.backfill AND ${weeklyColumnCondition()})`
    : sql`FALSE`;
  const rows = await sql<GuideRow[]>`
    SELECT p.article_id AS id, p.title, p.summary, s.name AS source_name, p.published_at, p.published_at::text AS cursor_at
    FROM publications p JOIN articles a ON a.id = p.article_id JOIN sources s ON s.id = p.source_id
    WHERE p.visibility = 'public' AND s.participation_mode = 'editorial' AND ${releasedCondition(new Date())}
      AND (p.article_id = ANY(${manual}::text[]) OR ${automatic})
      ${after}
    ORDER BY p.published_at DESC NULLS LAST, p.article_id COLLATE "C" ASC LIMIT ${LIMIT + 1}`;
  const visible = rows.slice(0, LIMIT);
  const last = visible.at(-1);
  return {
    guides: visible.map((r): ObservingGuideCard => ({ id: r.id, title: r.title, summary: r.summary,
      sourceName: publicSourceName(r.source_name), publishedAt: r.published_at?.toISOString() ?? null })),
    withdrawn: 0,
    unreadable: 0,
    // Keep PostgreSQL microseconds in the cursor; JS Date truncation would skip near-equal rows.
    nextCursor: rows.length > LIMIT && last ? encodeCursor("guides1", { binding, at: last.cursor_at, id: last.id }) : null,
  };
}
