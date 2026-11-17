// Manual corrections to a conference. The pipeline fills what the notices stated; a person fixes what
// they got wrong (a changed venue, a deadline the notice left out, a cancelled edition) and the
// automatic projection stops touching the fields they set. CAS on `conferences.version` refuses a
// correction written against a view that has moved on; every change is audited with its reason.
//
// Pins are stored under their database column names, which is what the projection compares against. The
// camelCase names written by the first version are still read (and rewritten as columns on the next
// correction), so an existing correction keeps protecting its field.
import { z } from "zod";
import { audit, Conflict } from "../audit.ts";
import { sql } from "../db.ts";
import { isValidDay } from "../editorial/conference.ts";
import { pinnedColumns } from "../content/conferences.ts";
import { articleRevisionJoin, statedAt } from "../content/statement-time.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A day a person typed must exist on the calendar: 2026-02-30 would break every later read. */
const calendarDate = z.string().regex(DATE).refine((value) => {
  const [y, m, d] = value.split("-").map(Number);
  return isValidDay(y!, m!, d!);
}, "不是有效日期");

const DeadlineSchema = z.object({
  kind: z.enum(["registration", "early_registration", "abstract", "paper", "other"]),
  date: calendarDate.nullable(),
  quote: z.string().trim().max(400).nullable(),
}).strict();

const FieldsSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  edition: z.string().trim().max(60).nullable().optional(),
  startDate: calendarDate.nullable().optional(),
  endDate: calendarDate.nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  venue: z.string().trim().max(120).nullable().optional(),
  online: z.boolean().nullable().optional(),
  organizer: z.string().trim().max(160).nullable().optional(),
  timezone: z.string().trim().max(60).nullable().optional(),
  officialUrl: z.string().trim().url().max(500).nullable().optional(),
  registrationUrl: z.string().trim().url().max(500).nullable().optional(),
  /** Only a person states this: postponement and cancellation are never inferred from the clock. */
  scheduleStatus: z.enum(["scheduled", "cancelled", "postponed"]).optional(),
  /** A correction to the whole deadline list: the notices are no longer allowed to rewrite it. */
  deadlines: z.array(DeadlineSchema).max(6).optional(),
}).strict();

const COLUMN: Record<string, string> = {
  name: "name", edition: "edition", startDate: "start_date", endDate: "end_date", city: "city", venue: "venue",
  online: "online", organizer: "organizer", timezone: "timezone", officialUrl: "official_url",
  registrationUrl: "registration_url", scheduleStatus: "schedule_status", deadlines: "deadlines",
};

/** What clearing a field means. A NOT NULL column is never set to NULL; it returns to its default. */
const CLEAR: Record<string, "null" | "scheduled" | "empty" | "refuse"> = {
  name: "refuse",
  schedule_status: "scheduled",
  deadlines: "empty",
};

/** The deadline list as it is stored: JSON, not a column value, so it is written separately. */
const JSON_COLUMNS = new Set(["deadlines"]);

export async function overrideConference(
  id: number,
  input: { fields: unknown; clear?: string[]; reason: string; version: number },
  actor: string,
) {
  z.object({ reason: z.string().trim().min(1), version: z.number().int().nonnegative(), clear: z.array(z.string()).optional() }).parse(input);
  const fields = FieldsSchema.parse(input.fields ?? {});
  const clearKeys = input.clear ?? [];
  for (const key of clearKeys) {
    if (!(key in COLUMN)) throw new Error(`unknown field: ${key}`);
    if (CLEAR[COLUMN[key]!] === "refuse") throw new Error(`${key} 不能清空，请给出新值`);
  }
  return sql.begin(async (tx) => {
    const [before] = await tx<{ id: number; version: number; manual_fields: string[] }[]>`
      SELECT id, version, manual_fields FROM conferences WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (before.version !== input.version) throw new Conflict("会议信息已更新，请刷新后再修改");
    // Start from the pins this row already honours, in column names: an old camelCase pin protects the
    // same column and is upgraded here.
    const pinned = pinnedColumns(before.manual_fields) as Set<string>;
    const writes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      writes[COLUMN[key]!] = value;
      pinned.add(COLUMN[key]!);
    }
    // Clearing a manual field releases it: the next notice may fill it again, and nothing is invented
    // meanwhile. A NOT NULL column returns to its neutral value instead of being nulled.
    const cleared: string[] = [];
    for (const key of clearKeys) {
      const column = COLUMN[key]!;
      pinned.delete(column);
      if (!(key in fields)) cleared.push(column);
    }
    const manual = tx.json([...pinned] as never);
    const plain = Object.fromEntries(Object.entries(writes).filter(([column]) => !JSON_COLUMNS.has(column)));
    if (Object.keys(plain).length) {
      await tx`UPDATE conferences SET ${tx(plain, ...Object.keys(plain))}, version = version + 1, updated_at = now(), manual_fields = ${manual}
               WHERE id = ${id}`;
    } else {
      await tx`UPDATE conferences SET version = version + 1, updated_at = now(), manual_fields = ${manual} WHERE id = ${id}`;
    }
    if (writes.deadlines !== undefined) {
      await tx`UPDATE conferences SET deadlines = ${tx.json(writes.deadlines as never)} WHERE id = ${id}`;
    }
    for (const column of cleared) {
      const behaviour = CLEAR[column] ?? "null";
      if (behaviour === "scheduled") {
        await tx`UPDATE conferences SET schedule_status = 'scheduled' WHERE id = ${id}`;
      } else if (behaviour === "empty") {
        await tx`UPDATE conferences SET deadlines = '[]'::jsonb WHERE id = ${id}`;
      } else {
        // A cleared field returns to "unknown"; the next notice may state it again.
        await tx`UPDATE conferences SET ${tx({ [column]: null })} WHERE id = ${id}`;
      }
    }
    await audit(actor, "conference.override", `conference:${id}`, input.reason, { version: before.version, manualFields: before.manual_fields }, { fields: writes, cleared, manualFields: [...pinned] }, { db: tx });
    const [after] = await tx`SELECT * FROM conferences WHERE id = ${id}`;
    return after ?? null;
  });
}

/** The admin read of one conference, with the notices behind it (internal view, not a public exit). */
export async function conferenceDetail(id: number) {
  const [conference] = await sql`SELECT * FROM conferences WHERE id = ${id}`;
  if (!conference) return null;
  const notices = await sql`
    SELECT n.article_id, n.revision, n.content_scope, n.evidence, n.deadlines, n.payload, n.updated_at,
           ${statedAt()} AS stated_at,
           a.revision AS article_revision, p.title, p.visibility, p.eligible
      FROM conference_notices n
      LEFT JOIN articles a ON a.id = n.article_id
      LEFT JOIN publications p ON p.article_id = n.article_id
      ${articleRevisionJoin()}
     WHERE n.conference_id = ${id}
     -- The order the projection used: what was stated last, not what was written last.
     ORDER BY stated_at DESC, n.revision DESC, n.article_id ASC`;
  return { conference, notices };
}
