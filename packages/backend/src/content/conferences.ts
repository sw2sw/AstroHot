// Writing a grounded conference into the database, inside the analysis transaction that produced it.
//
// Four rules, all enforced here rather than by the caller:
//   • identity: a notice joins an existing event only on evidence — the same normalised name and
//     edition, or the same name and opening day with no contradicting edition. A notice that states
//     neither an edition nor a date is anchored to its own article and never merged by name alone.
//   • support: every notice keeps its own payload, so a field exists only while a live notice states it.
//     Retracting a notice rebuilds the row from the notices that remain; it never leaves a field behind
//     that only the retracted notice ever supported.
//   • manual first: a field a human set is never overwritten or cleared by an automatic projection, and
//     schedule_status (postponed / cancelled) is only ever set by hand. Pins are stored under their
//     column names; the camelCase names written by the first version are still honoured.
//   • retraction: an article whose new revision is no longer a notice leaves the conference, and a
//     conference left with no notices and no manual work is removed.
import type { Tx } from "../db.ts";
import { conferenceEditionNorm, editionFromName, type GroundedConference } from "../editorial/conference.ts";
import { articleRevisionJoin, statedAt } from "./statement-time.ts";

/** Fields an automatic projection may fill, and a human override may pin. */
const AUTOMATIC_FIELDS = [
  "name", "edition", "start_date", "end_date", "timezone", "city", "venue", "online",
  "organizer", "official_url", "registration_url",
] as const;

type Field = (typeof AUTOMATIC_FIELDS)[number] | "deadlines" | "schedule_status";

/**
 * A pin is stored under its database column. The first version stored the API's camelCase names, and
 * those rows must keep protecting the same column — otherwise an editor's correction silently becomes
 * overwritable the day a new notice arrives.
 */
const PIN_ALIASES: Record<string, Field> = {
  name: "name", edition: "edition",
  startDate: "start_date", start_date: "start_date",
  endDate: "end_date", end_date: "end_date",
  timezone: "timezone", city: "city", venue: "venue", online: "online", organizer: "organizer",
  officialUrl: "official_url", official_url: "official_url",
  registrationUrl: "registration_url", registration_url: "registration_url",
  deadlines: "deadlines",
  scheduleStatus: "schedule_status", schedule_status: "schedule_status",
};

/** The columns a human has pinned, whichever spelling the row was written with. */
export function pinnedColumns(manual: readonly string[] | null | undefined): Set<Field> {
  const out = new Set<Field>();
  for (const name of manual ?? []) {
    const column = PIN_ALIASES[name];
    if (column) out.add(column);
  }
  return out;
}

type ConferenceRow = {
  id: number;
  identity_key: string;
  name: string;
  edition: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  city: string | null;
  venue: string | null;
  online: boolean | null;
  organizer: string | null;
  official_url: string | null;
  registration_url: string | null;
  deadlines: Array<{ kind: string; date: string | null; quote: string | null }>;
  domain: string;
  schedule_status: string;
  manual_fields: string[];
  version: number;
};

type NoticePayload = {
  name?: string | null;
  edition?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
  city?: string | null;
  venue?: string | null;
  online?: boolean | null;
  organizer?: string | null;
  officialUrl?: string | null;
  registrationUrl?: string | null;
  deadlines?: Array<{ kind: string; date: string | null; quote: string | null }>;
};

const asDate = (value: string | null | undefined) => (value ? value : null);

/** What this notice states, kept beside the notice so a field can be withdrawn with it. */
function payloadOf(c: GroundedConference): NoticePayload {
  return {
    name: c.name, edition: c.edition, startDate: asDate(c.startDate), endDate: asDate(c.endDate),
    timezone: c.timezone, city: c.city, venue: c.venue, online: c.online, organizer: c.organizer,
    officialUrl: c.officialUrl, registrationUrl: c.registrationUrl, deadlines: c.deadlines,
  };
}

/** The payload key behind each column. */
const PAYLOAD_KEY: Record<(typeof AUTOMATIC_FIELDS)[number], keyof NoticePayload> = {
  name: "name", edition: "edition", start_date: "startDate", end_date: "endDate", timezone: "timezone",
  city: "city", venue: "venue", online: "online", organizer: "organizer",
  official_url: "officialUrl", registration_url: "registrationUrl",
};

/**
 * The event a notice belongs to. Exact identity first; then the same name and edition (a postponement
 * moves the dates, "the 25th" does not); then the same name on the same opening day — but only when the
 * two say nothing contradictory about the edition, which is the one thing that names a different event.
 * Editions are compared in one normalised form on both sides ("第25届" and "25" are the same), because a
 * mismatch here silently merges two editions the original kept apart.
 */
async function findConference(tx: Tx, c: GroundedConference): Promise<ConferenceRow | null> {
  const [exact] = await tx<ConferenceRow[]>`
    SELECT * FROM conferences WHERE identity_key = ${c.identityKey} FOR UPDATE`;
  if (exact) return exact;
  const edition = conferenceEditionNorm(c.edition ?? editionFromName(c.name));
  if (edition) {
    const sameName = await tx<ConferenceRow[]>`
      SELECT * FROM conferences WHERE name_norm = ${c.nameNorm} FOR UPDATE`;
    const sameEdition = sameName.find((row) => conferenceEditionNorm(row.edition) === edition);
    if (sameEdition) return sameEdition;
  }
  if (c.startDate) {
    const sameDay = await tx<ConferenceRow[]>`
      SELECT * FROM conferences WHERE name_norm = ${c.nameNorm} AND start_date = ${c.startDate} FOR UPDATE`;
    // The same name on the same day with a different stated edition is a different meeting.
    const hit = sameDay.find((row) => !edition || !row.edition || conferenceEditionNorm(row.edition) === edition);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rebuilds the row's automatic fields from the notices that remain, newest statement first. A field no
 * remaining notice states returns to unknown — the row must not keep a value whose only support was
 * retracted. A pinned field is left exactly as the editor set it.
 *
 * "Newest" means when the notice was *stated* (see `statement-time.ts`), not when we happened to find it
 * and not when the notice row was last written: neither discovery nor a re-projection may reorder claims.
 */
async function recomputeFields(tx: Tx, conferenceId: number): Promise<void> {
  const [row] = await tx<ConferenceRow[]>`SELECT * FROM conferences WHERE id = ${conferenceId} FOR UPDATE`;
  if (!row) return;
  const pinned = pinnedColumns(row.manual_fields);
  const notices = await tx<{ payload: NoticePayload; revision: number; stated_at: Date }[]>`
    SELECT n.payload, n.revision, ${statedAt()} AS stated_at
      FROM conference_notices n
      JOIN articles a ON a.id = n.article_id
      ${articleRevisionJoin()}
     WHERE n.conference_id = ${conferenceId}
     ORDER BY stated_at DESC, n.revision DESC, n.article_id ASC`;
  const writes: Record<string, unknown> = {};
  for (const field of AUTOMATIC_FIELDS) {
    if (pinned.has(field)) continue;
    const key = PAYLOAD_KEY[field];
    let value: unknown = null;
    for (const notice of notices) {
      const candidate = notice.payload?.[key];
      if (candidate !== null && candidate !== undefined && candidate !== "") { value = candidate; break; }
    }
    // name is NOT NULL and is the only thing that still identifies an event whose notices have all gone:
    // it keeps its last stated value instead of being blanked (a pin alone can hold a row).
    if (field === "name" && (value === null || value === "")) continue;
    if (String(value ?? "") !== String((row as unknown as Record<string, unknown>)[field] ?? "")) writes[field] = value;
  }
  if (!pinned.has("deadlines")) {
    const merged = mergeDeadlines(notices.map((n) => n.payload?.deadlines ?? []));
    if (JSON.stringify(merged) !== JSON.stringify(row.deadlines ?? [])) writes.deadlines = merged;
  }
  if (Object.keys(writes).length) {
    const columns = Object.keys(writes);
    await tx`UPDATE conferences SET ${tx(writes, ...columns)}, version = version + 1, updated_at = now() WHERE id = ${conferenceId}`;
  }
}

/** One value per kind, from the newest statement: an old notice arriving late cannot overwrite a later
 *  correction, because priority is when the notice was stated, not when we found it. */
function mergeDeadlines(lists: Array<Array<{ kind: string; date: string | null; quote: string | null }>>) {
  const merged = new Map<string, { kind: string; date: string | null; quote: string | null }>();
  for (const list of lists) for (const d of list ?? []) if (!merged.has(d.kind)) merged.set(d.kind, d);
  return [...merged.values()];
}

/**
 * The union of the notices' columns decides where the conference may appear. It never touches the
 * notice article's own scope, selected flag or cross-listing.
 */
async function reconcileDomain(tx: Tx, conferenceId: number): Promise<string> {
  const scopes = (await tx<{ content_scope: string }[]>`
    SELECT DISTINCT content_scope FROM conference_notices WHERE conference_id = ${conferenceId}`).map((r) => r.content_scope);
  const domain = scopes.length === 0 ? "astro" : scopes.length > 1 ? "both" : scopes[0]!;
  await tx`UPDATE conferences SET domain = ${domain} WHERE id = ${conferenceId} AND domain <> ${domain}`;
  return domain;
}

/** Removes an event that no notice and no human correction holds any more. */
async function releaseIfUnused(tx: Tx, conferenceId: number): Promise<void> {
  const [left] = await tx<{ notices: number; manual: string[] }[]>`
    SELECT (SELECT count(*) FROM conference_notices WHERE conference_id = ${conferenceId}) AS notices,
           manual_fields AS manual
    FROM conferences WHERE id = ${conferenceId}`;
  if (!left) return;
  if (Number(left.notices) === 0 && (left.manual?.length ?? 0) === 0) {
    await tx`DELETE FROM conferences WHERE id = ${conferenceId}`;
    return;
  }
  if (Number(left.notices) === 0) {
    // Nothing states it any more: every unpinned field is unknown again, the row survives only because
    // a person is still maintaining it.
    await recomputeFields(tx, conferenceId);
    return;
  }
  // A notice left: the fields it alone stated may have gone with it.
  await recomputeFields(tx, conferenceId);
  await reconcileDomain(tx, conferenceId);
}

/**
 * Projects one article revision's conference judgement. `null` retracts: the article is no longer a
 * notice (a revised article, a corrected extraction, or a withdrawn announcement).
 */
export async function projectConference(
  tx: Tx,
  input: { articleId: string; revision: number; contentScope: string; conference: GroundedConference | null },
): Promise<number | null> {
  const { articleId, revision, conference } = input;
  const contentScope = input.contentScope === "ai4s" ? "ai4s" : "astro";
  const [notice] = await tx<{ conference_id: number }[]>`
    SELECT conference_id FROM conference_notices WHERE article_id = ${articleId} FOR UPDATE`;

  if (!conference) {
    if (!notice) return null;
    await tx`DELETE FROM conference_notices WHERE article_id = ${articleId}`;
    await releaseIfUnused(tx, notice.conference_id);
    return null;
  }

  // The edition may only be in the name; store what the original states so later notices, the hub and
  // the identity lookup all see the same series marker.
  const edition = conference.edition ?? editionFromName(conference.name);
  const grounded = edition === conference.edition ? conference : { ...conference, edition };
  const existing = await findConference(tx, grounded);
  const payload = payloadOf(grounded);
  let conferenceId: number;

  if (!existing) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO conferences (identity_key, name, name_norm, edition, start_date, end_date, timezone, city, venue, online,
        organizer, official_url, registration_url, deadlines, domain)
      VALUES (${conference.identityKey}, ${conference.name}, ${conference.nameNorm}, ${edition},
        ${asDate(conference.startDate)}, ${asDate(conference.endDate)}, ${conference.timezone}, ${conference.city}, ${conference.venue},
        ${conference.online}, ${conference.organizer}, ${conference.officialUrl}, ${conference.registrationUrl},
        ${tx.json(conference.deadlines as never)}, ${contentScope})
      RETURNING id`;
    conferenceId = row!.id;
  } else {
    conferenceId = existing.id;
  }

  // One article, one event: a re-judged notice moves rather than duplicates.
  if (notice && notice.conference_id !== conferenceId) {
    await tx`DELETE FROM conference_notices WHERE article_id = ${articleId}`;
    await releaseIfUnused(tx, notice.conference_id);
  }
  await tx`
    INSERT INTO conference_notices (conference_id, article_id, revision, content_scope, evidence, deadlines, payload)
    VALUES (${conferenceId}, ${articleId}, ${revision}, ${contentScope}, ${conference.evidence}, ${tx.json(conference.deadlines as never)}, ${tx.json(payload as never)})
    ON CONFLICT (article_id) DO UPDATE SET
      conference_id = EXCLUDED.conference_id, revision = EXCLUDED.revision, content_scope = EXCLUDED.content_scope,
      evidence = EXCLUDED.evidence, deadlines = EXCLUDED.deadlines, payload = EXCLUDED.payload, updated_at = now()`;

  // Every unpinned field is rebuilt from the notices that remain, in their own timeline order: the
  // newest statement wins, a notice that arrives late with an older timeline cannot overwrite a later
  // correction, and a field loses its value when the notice that stated it leaves.
  await recomputeFields(tx, conferenceId);
  await reconcileDomain(tx, conferenceId);
  return conferenceId;
}
