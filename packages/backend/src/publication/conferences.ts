// The conference hub's read layer: the one place that decides which conferences the site shows.
//
// A conference is public when at least one of its notices is a public, pool-eligible article from an
// editorial source — the same eligibility every other surface uses, read through `publications`, so an
// isolated, withdrawn, blocked or unpublished notice can never drag a conference into the open. Being a
// conference is not being news: this layer never reads or writes `selected`, never touches
// `astro_cross_listed`, and a notice's column only decides which scope may show the event.
//
// A field is shown only while a live notice still states it. The values are assembled from the notices
// that are public right now and whose revision is still the article's current one, newest statement
// first; a field whose only support was withdrawn disappears with it, and a pinned field keeps the value
// a person set. That is why the hub reads `conference_notices.payload` rather than the row alone.
//
// Dates are date-only throughout, evaluated in the event's own time zone when the notice stated a valid
// one and in Asia/Shanghai otherwise. "Ended" starts the day after the closing day, so a conference is
// not closed early on its own last day; "ongoing" needs a start date that has arrived. A conference
// without any date is shown as undated rather than placed at a guessed time.
import type { ConferenceDeadlineKind, ConferenceDeadlineView, ConferenceHubResponse, ConferenceNoticeView, ConferenceScope, ConferenceSummary } from "@aihot/contracts/site";
import { sql, type Db } from "../db.ts";
import { articleRevisionJoin, statedAt } from "../content/statement-time.ts";
import { publicSourceName } from "./rules.ts";

export const CONFERENCE_PAGE_SIZE = 20;
export const CONFERENCE_MAX_PAGES = 50;

export interface ConferenceQuery {
  scope: ConferenceScope;
  page: number;
  now?: Date;
}

export function parseConferenceQuery(query: Record<string, unknown>): ConferenceQuery {
  const scope = query.scope === undefined || query.scope === "all" ? "all" : query.scope;
  if (scope !== "astro" && scope !== "ai4s" && scope !== "all") throw new Error("invalid scope");
  let page = 1;
  if (query.page !== undefined) {
    if (typeof query.page !== "string" || !/^[1-9]\d*$/.test(query.page)) throw new Error("invalid pagination");
    page = Number(query.page);
    if (!Number.isSafeInteger(page) || page > 1_000_000) throw new Error("invalid pagination");
  }
  return { scope, page };
}

type Row = {
  id: number;
  name: string;
  edition: string | null;
  start_date: string | null;
  end_date: string | null;
  city: string | null;
  venue: string | null;
  online: boolean | null;
  organizer: string | null;
  official_url: string | null;
  registration_url: string | null;
  deadlines: Array<{ kind: string; date: string | null }> | null;
  domain: "astro" | "ai4s" | "both";
  schedule_status: string;
  updated_at: Date;
  local_today: string;
  phase: string;
  notice_id: string | null;
  merged: Record<string, unknown> | null;
  manual_fields: string[] | null;
  total: number;
};

const DEADLINE_KINDS = new Set<ConferenceDeadlineKind>(["registration", "early_registration", "abstract", "paper", "other"]);

/** A deadline's state from its day alone: open, closing today, or closed once the day has passed. */
export function deadlineView(raw: Array<{ kind: string; date: string | null }>, today: string): ConferenceDeadlineView[] {
  return raw.flatMap((d) => {
    if (!d.date) return [];
    const kind = DEADLINE_KINDS.has(d.kind as ConferenceDeadlineKind) ? (d.kind as ConferenceDeadlineKind) : "other";
    const state = d.date < today ? "closed" : d.date === today ? "today" : "open";
    return [{ kind, date: d.date, state }];
  });
}

/** The columns a human may pin, as stored on the row, and the camelCase names the first version used. */
const PINNED = (column: string, camel: string) =>
  sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(manual_fields) m WHERE m IN (${column}, ${camel}))`;

/**
 * A value a person set wins over the notices; otherwise only what the live notices state is shown. There
 * is deliberately no fallback to the stored column: that column is itself the union of past notices, so
 * falling back to it would keep showing a venue whose only notice is no longer public.
 */
const effectiveText = (column: string, camel: string, payloadKey: string) =>
  sql`CASE WHEN ${PINNED(column, camel)} THEN ${sql.unsafe(column)}::text
           ELSE merged->>${payloadKey} END`;

const effectiveDate = (column: string, camel: string, payloadKey: string) =>
  sql`CASE WHEN ${PINNED(column, camel)} THEN ${sql.unsafe(column)}
           ELSE (merged->>${payloadKey})::date END`;

const effectiveBool = (column: string, camel: string, payloadKey: string) =>
  sql`CASE WHEN ${PINNED(column, camel)} THEN ${sql.unsafe(column)}
           ELSE (merged->>${payloadKey})::boolean END`;

/**
 * Public conferences, globally ordered then paginated: ongoing first, then future by opening day, then
 * ended (most recently closed first), undated last.
 */
export async function loadConferenceHub(query: Partial<ConferenceQuery>, database?: Db): Promise<ConferenceHubResponse> {
  const db = database ?? sql;
  const scope = query.scope ?? "all";
  const page = Math.min(Math.max(query.page ?? 1, 1), CONFERENCE_MAX_PAGES);
  const at = query.now ?? new Date();
  const scopeFilter = scope === "all" ? sql`` : sql`AND n.content_scope = ${scope}`;
  const offset = (page - 1) * CONFERENCE_PAGE_SIZE;

  const rows = await db<Row[]>`
    WITH supported AS (
      -- The notices that may speak for their conference right now: public, pool-eligible, from an
      -- editorial source, and still the article's current revision. stated_at is when the notice was
      -- stated — the source's publication time, or when a correction's own revision appeared — never
      -- the discovery time and never when this row was last written, so neither finding an old page
      -- late nor re-projecting it can promote it above a newer statement.
      SELECT n.conference_id, n.article_id, n.content_scope, n.payload, n.revision,
             ${statedAt()} AS stated_at
        FROM conference_notices n
        JOIN articles a ON a.id = n.article_id
        JOIN publications p ON p.article_id = n.article_id
        JOIN sources s ON s.id = p.source_id
        ${articleRevisionJoin()}
       WHERE p.visibility = 'public' AND p.eligible
         AND s.participation_mode = 'editorial'
         AND n.revision = a.revision ${scopeFilter}
    ), visible AS (
      -- The same eligibility without the column filter: which direction(s) a conference belongs to is a
      -- property of every notice the site currently shows, not of the page being looked at.
      SELECT n.conference_id, n.content_scope
        FROM conference_notices n
        JOIN articles a ON a.id = n.article_id
        JOIN publications p ON p.article_id = n.article_id
        JOIN sources s ON s.id = p.source_id
       WHERE p.visibility = 'public' AND p.eligible
         AND s.participation_mode = 'editorial'
         AND n.revision = a.revision
    ), flattened AS (
      SELECT s.conference_id, e.key, e.value,
             row_number() OVER (PARTITION BY s.conference_id, e.key
                                ORDER BY s.stated_at DESC NULLS LAST, s.revision DESC, s.article_id) AS rn
        FROM supported s, jsonb_each(s.payload) e
       WHERE e.value <> 'null'::jsonb AND e.key <> 'deadlines'
    ), pick AS (
      SELECT conference_id, jsonb_object_agg(key, value) AS merged FROM flattened WHERE rn = 1 GROUP BY conference_id
    ), first_notice AS (
      SELECT DISTINCT ON (conference_id) conference_id, article_id FROM supported
       ORDER BY conference_id, stated_at DESC NULLS LAST, revision DESC, article_id
    ), live AS (
      -- A field a person pinned is read from the row; everything else only from what a live notice states.
      SELECT c.*, pick.merged, fn.article_id AS notice_article,
             CASE WHEN ${PINNED("timezone", "timezone")} THEN c.timezone ELSE pick.merged->>'timezone' END AS eff_timezone
        FROM conferences c
        JOIN pick ON pick.conference_id = c.id
        LEFT JOIN first_notice fn ON fn.conference_id = c.id
    ), zoned AS (
      -- The day is the event's own: the zone a live notice states (or a person pinned), else the stated
      -- convention. An unknown zone is not the same as "no zone": it falls back rather than guessing.
      SELECT live.*, tz.name AS tz_name,
        CASE WHEN tz.name IS NOT NULL THEN ${at}::timestamptz AT TIME ZONE tz.name
             ELSE ${at}::timestamptz AT TIME ZONE 'Asia/Shanghai' END::date AS local_today
        FROM live
        LEFT JOIN LATERAL (SELECT name FROM pg_timezone_names z WHERE z.name = live.eff_timezone) tz ON true
    ), shaped AS (
      SELECT zoned.*,
        ${effectiveDate("start_date", "startDate", "startDate")} AS eff_start,
        ${effectiveDate("end_date", "endDate", "endDate")} AS eff_end,
        ${effectiveText("name", "name", "name")} AS eff_name,
        ${effectiveText("edition", "edition", "edition")} AS eff_edition,
        ${effectiveText("city", "city", "city")} AS eff_city,
        ${effectiveText("venue", "venue", "venue")} AS eff_venue,
        ${effectiveBool("online", "online", "online")} AS eff_online,
        ${effectiveText("organizer", "organizer", "organizer")} AS eff_organizer,
        ${effectiveText("official_url", "officialUrl", "officialUrl")} AS eff_official_url,
        ${effectiveText("registration_url", "registrationUrl", "registrationUrl")} AS eff_registration_url,
        CASE WHEN (SELECT count(DISTINCT v.content_scope) FROM visible v WHERE v.conference_id = zoned.id) > 1 THEN 'both'
             ELSE coalesce((SELECT min(v.content_scope) FROM visible v WHERE v.conference_id = zoned.id), 'astro') END AS eff_domain
        FROM zoned
    ), phased AS (
      -- A person's state outranks the clock: a cancelled event is never "ongoing", and one whose new
      -- dates are not settled is not shown as "ended" on the strength of the dates it no longer holds.
      SELECT shaped.*, CASE
          WHEN schedule_status = 'cancelled' THEN 'cancelled'
          WHEN schedule_status = 'postponed' THEN 'postponed'
          WHEN eff_start IS NULL THEN 'undated'
          WHEN coalesce(eff_end, eff_start) < local_today THEN 'ended'
          WHEN eff_start <= local_today THEN 'ongoing'
          ELSE 'upcoming' END AS phase
        FROM shaped
    )
    SELECT p.id, p.eff_name AS name, p.eff_edition AS edition,
           p.eff_start::text AS start_date, p.eff_end::text AS end_date,
           p.eff_city AS city, p.eff_venue AS venue, p.eff_online AS online,
           p.eff_organizer AS organizer, p.eff_official_url AS official_url, p.eff_registration_url AS registration_url,
           -- A deadline someone corrected is theirs until they release it; otherwise only a live notice
           -- may state it, and each kind follows the newest statement of that kind.
           CASE WHEN ${PINNED("deadlines", "deadlines")} THEN p.deadlines
                ELSE (SELECT coalesce(jsonb_agg(d ORDER BY d->>'kind'), '[]'::jsonb) FROM (
                        SELECT DISTINCT ON (d->>'kind') d
                          FROM supported s2, jsonb_array_elements(coalesce(s2.payload->'deadlines', '[]'::jsonb)) d
                         WHERE s2.conference_id = p.id
                         ORDER BY d->>'kind', s2.stated_at DESC NULLS LAST, s2.revision DESC, s2.article_id
                      ) kinds) END AS deadlines,
           p.eff_domain AS domain, p.schedule_status, p.updated_at, p.local_today::text AS local_today, p.phase,
           p.notice_article AS notice_id, p.merged, p.manual_fields, count(*) OVER () AS total
      FROM phased p
     ORDER BY
       CASE p.phase WHEN 'ongoing' THEN 0 WHEN 'upcoming' THEN 1 WHEN 'ended' THEN 2
                    WHEN 'postponed' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END,
       CASE WHEN p.phase = 'ended' THEN coalesce(p.eff_end, p.eff_start) END DESC NULLS LAST,
       coalesce(p.eff_start, 'infinity'::date) ASC, p.updated_at DESC, p.id ASC
     LIMIT ${CONFERENCE_PAGE_SIZE} OFFSET ${offset}`;

  const notices = new Map<string, ConferenceNoticeView>();
  const ids = rows.flatMap((r) => (r.notice_id ? [r.notice_id] : []));
  if (ids.length) {
    const list = await db<{ id: string; title: string; summary: string | null; source_name: string; url: string; published_at: Date | null }[]>`
      SELECT p.article_id AS id, p.title, p.summary, s.name AS source_name, p.url, p.published_at
        FROM publications p JOIN sources s ON s.id = p.source_id
       WHERE p.article_id IN ${db(ids)}`;
    for (const n of list) {
      notices.set(n.id, {
        id: n.id, title: n.title, summary: n.summary, source: publicSourceName(n.source_name), url: n.url,
        publishedAt: n.published_at ? new Date(n.published_at).toISOString() : null,
      });
    }
  }

  const items: ConferenceSummary[] = rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    edition: r.edition,
    startDate: r.start_date,
    endDate: r.end_date,
    phase: r.phase as ConferenceSummary["phase"],
    city: r.city,
    venue: r.venue,
    online: r.online,
    organizer: r.organizer,
    officialUrl: r.official_url,
    registrationUrl: r.registration_url,
    // Each deadline is judged in the event's own day, which may already be tomorrow in Beijing.
    deadlines: deadlineView(r.deadlines ?? [], r.local_today),
    scheduleStatus: (["scheduled", "cancelled", "postponed"].includes(r.schedule_status) ? r.schedule_status : "scheduled") as ConferenceSummary["scheduleStatus"],
    domain: r.domain,
    notice: r.notice_id ? notices.get(r.notice_id) ?? null : null,
    verifiedAt: new Date(r.updated_at).toISOString(),
  }));

  const total = rows.length ? Number(rows[0]!.total) : 0;
  const updatedAt = rows.reduce<Date | null>((latest, r) => (!latest || r.updated_at > latest ? r.updated_at : latest), null);
  return {
    scope, items,
    total,
    page,
    pageCount: Math.min(CONFERENCE_MAX_PAGES, Math.max(1, Math.ceil(total / CONFERENCE_PAGE_SIZE))),
    pageSize: CONFERENCE_PAGE_SIZE,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}

/**
 * The compact entry above a column's list: the next few conferences that have not ended. A cancelled
 * event, and one whose new dates are not settled, is not recommended here — it stays findable in the hub
 * with its state. No model call, no database write. An empty list means the section is not shown at all.
 */
export async function loadRecentConferences(scope: Exclude<ConferenceScope, "all">, limit = 3, now = new Date()): Promise<ConferenceSummary[]> {
  const hub = await loadConferenceHub({ scope, page: 1, now });
  return hub.items
    .filter((c) => (c.phase === "ongoing" || c.phase === "upcoming") && c.scheduleStatus === "scheduled")
    .slice(0, limit);
}
