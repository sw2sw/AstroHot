// Conference recognition as a pure step over one article's material.
//
// A notice is not "a text that mentions a meeting": it must be a call to take part — registration,
// submission, an announced programme — for a named academic meeting, and every field it claims must be
// copied from the original. This step therefore does two things and nothing else:
//   1. gate: refuse results reports, one-line mentions and multi-conference paragraphs (null, not a guess);
//   2. ground: keep a field only when the original states it verbatim, drop the rest field by field.
// It never invents a time zone, never uses the article's own publication time as a conference date, and
// never merges two events: identity is (normalised name, edition, start date), computed here and enforced
// by the table's unique key.
//
// Grounding a date is stricter than finding the digits somewhere in the text: the year the original
// states must be the year claimed (2027-11-24 may not ride on "2026年11月24日"), a closing day may only
// inherit the opening day's month inside the same range, a deadline's quote must itself carry that date
// and the kind it claims, and a day that does not exist on the calendar (2026-02-30) is refused before it
// can break the analysis transaction at insert time.
import { z } from "zod";
import { collapseWhitespace } from "../lib/text.ts";
import type { AnalyzeInputArticle } from "./input.ts";

/** A deadline the notice states: day-only unless the original gives a clock time. */
export const ConferenceDeadlineSchema = z.object({
  kind: z.enum(["registration", "early_registration", "abstract", "paper", "other"]).catch("other"),
  /** YYYY-MM-DD exactly as stated; a clock time is not inferred from a day. */
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  /** The verbatim sentence the date comes from. */
  quote: z.string().trim().max(400).nullable().catch(null),
});

/** What the structure step returns for one article; every field may be unknown. */
export const ConferenceExtractionSchema = z.object({
  isNotice: z.boolean().nullable().catch(null),
  /** The material announces more than one distinct meeting: no single conference may be recorded. */
  ambiguous: z.boolean().catch(false),
  name: z.string().trim().max(200).nullable().catch(null),
  edition: z.string().trim().max(60).nullable().catch(null),
  startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  /** IANA name or the original's own wording; null unless the original states one. */
  timezone: z.string().trim().max(60).nullable().catch(null),
  city: z.string().trim().max(80).nullable().catch(null),
  venue: z.string().trim().max(120).nullable().catch(null),
  online: z.boolean().nullable().catch(null),
  organizer: z.string().trim().max(160).nullable().catch(null),
  officialUrl: z.string().trim().max(500).nullable().catch(null),
  registrationUrl: z.string().trim().max(500).nullable().catch(null),
  deadlines: z.array(ConferenceDeadlineSchema).max(6).catch([]),
  /** The verbatim sentence that proves this is a notice. */
  evidence: z.string().trim().max(600).nullable().catch(null),
}).nullable().catch(null);

export type ConferenceExtraction = z.infer<typeof ConferenceExtractionSchema>;
export type ConferenceDeadline = z.infer<typeof ConferenceDeadlineSchema>;

/** A grounded conference, ready to be projected: every field below is supported by the original. */
export interface GroundedConference {
  name: string;
  edition: string | null;
  startDate: string | null;
  endDate: string | null;
  timezone: string | null;
  city: string | null;
  venue: string | null;
  online: boolean | null;
  organizer: string | null;
  officialUrl: string | null;
  registrationUrl: string | null;
  deadlines: ConferenceDeadline[];
  evidence: string;
  /** Normalised name, kept beside the display name for identity lookups. */
  nameNorm: string;
  identityKey: string;
}

/** A meeting is named as one: a conference, a workshop, a school, a symposium. */
const CONFERENCE_WORD = /会议|研讨会|大会|年会|论坛|峰会|讲习班|研修班|培训班|暑期学校|symposium|conference|workshop|meeting|congress|colloquium|assembly|forum|summer school/i;
/** A notice asks for something: registration, submission, a programme, attendance. */
const PARTICIPATION = /报名|注册|征稿|投稿|摘要|参会|报到|注册费|会议费|议程|日程|线上参会|邀请报告|截止|register|registration|submit|submission|abstract|call for|attend|deadline|programme|program\b/i;
/** The event is online: the original says so. In person needs a stated place, or it is unknown. */
const ONLINE_WORD = /线上|网络参会|虚拟|远程参会|online|virtual|remote/i;

const flat = (s: string | null | undefined) => collapseWhitespace(s ?? "").toLowerCase();

/** The original's own text: bodies, quoted posts and an existing translation, never the assembled prompt. */
function originalsOf(a: AnalyzeInputArticle): string[] {
  const raw = a.xPost
    ? [String(a.xPost.text ?? a.title), String(a.xPost.quoted?.text ?? "")]
    : [a.bodyText ?? a.excerpt ?? ""];
  return [...raw, a.translationZh ?? ""].map(collapseWhitespace).filter(Boolean);
}

/** A phrase kept only when it appears in the original verbatim (case and whitespace aside). */
function groundedPhrase(value: string | null | undefined, originals: string[]): string | null {
  const text = collapseWhitespace(value ?? "");
  if (!text) return null;
  const needle = text.toLowerCase();
  return originals.some((o) => o.toLowerCase().includes(needle)) ? text : null;
}

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_WORD = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";

/** A real day on the calendar; 2026-02-30 is not a date, and Postgres would refuse it mid-transaction. */
export function isValidDay(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const parts = (date: string) => {
  const m = DATE_SHAPE.exec(date);
  if (!m) return null;
  const [, y, mo, d] = m;
  const triple = { y: Number(y), m: Number(mo), d: Number(d) };
  return isValidDay(triple.y, triple.m, triple.d) ? triple : null;
};

/** A sentence is the unit a range may inherit from: "24日至28日" never reaches across a full stop. */
const sentencesOf = (text: string) => text.split(/[。；;!?！？\n]+/).map((s) => s.trim()).filter(Boolean);

/**
 * The four-digit year nearest before a position, if one sits inside the given window: "2026年11月24日"
 * puts it immediately in front of the day, and a range writes it once for both ends
 * ("2026年11月30日至12月2日"). Read through `matchAll`, so the capture is the year and not the first
 * character after it.
 */
function yearBefore(text: string, index: number, window = 14): number | null {
  const before = text.slice(Math.max(0, index - window), index);
  const adjacent = [...before.matchAll(/(?<!\d)(\d{4})\s*[-/.年]?\s*$/g)].at(-1);
  if (adjacent) return Number(adjacent[1]);
  const loose = [...before.matchAll(/(?<!\d)(\d{4})\s*年/g)].at(-1);
  return loose ? Number(loose[1]) : null;
}

/** The four-digit year nearest after a position (English writes "November 24, 2026"). */
function yearAfter(text: string, index: number, window = 14): number | null {
  const after = text.slice(index, index + window);
  const m = /^[^0-9]{0,12}(\d{4})(?!\d)/.exec(after);
  return m ? Number(m[1]) : null;
}

/**
 * Every way the original may write a day, each checked against the year it belongs to:
 *   2026-11-24 · 2026/11/24 · 2026年11月24日 · 11月24日 · November 24, 2026 · 24 November 2026
 *
 * A day written without a year is accepted only for a year the notice itself writes for this event:
 * one named in the meeting's own title ("2027年天文数据研讨会", `titleYears`). When the source published
 * the notice is not evidence of when the meeting is — a notice published in December for a meeting "on
 * 12 January" is normally about the next year, and nothing in the text says which. Such a day stays
 * unknown rather than becoming a conference that already ended.
 */
function statesDay(text: string, target: { y: number; m: number; d: number }, titleYears: ReadonlySet<number>): boolean {
  const { y, m, d } = target;
  // A year the sentence itself writes, once: "2026年第26届…将于11月24日召开" dates that day, because the
  // whole clause is about one meeting in one year. Two different years in one clause prove nothing.
  const statedYears = new Set([...text.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((hit) => Number(hit[1])));
  /**
   * An explicit year must be the claimed one. With no year beside the day, only a year the notice writes
   * for this event may be used — the meeting's own title, or the single year this clause states.
   */
  const yearOk = (explicit: number | null) =>
    explicit === y || (explicit === null && (titleYears.has(y) || (statedYears.size === 1 && statedYears.has(y))));
  // A full date with its own year: it must be this exact day.
  for (const hit of text.matchAll(/(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?(?!\d)/g)) {
    if (Number(hit[1]) === y && Number(hit[2]) === m && Number(hit[3]) === d) return true;
  }
  // A month-day without a year (Chinese or numeric).
  for (const hit of text.matchAll(/(?<!\d)(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号](?!\d)/g)) {
    if (Number(hit[1]) !== m || Number(hit[2]) !== d) continue;
    if (yearOk(yearBefore(text, hit.index ?? 0))) return true;
  }
  // English ranges carry the year at the end: "November 24–28, 2026" / "24–28 November 2026". Both ends
  // are read here, with the range's own year, instead of letting a plain month-day match stop at "24".
  const enRangeMonthFirst = new RegExp(`\\b(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—~]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b[^0-9]{0,8}(\\d{4})?`, "gi");
  for (const hit of text.matchAll(enRangeMonthFirst)) {
    if (MONTHS[hit[1]!.toLowerCase()] !== m) continue;
    if (Number(hit[2]) !== d && Number(hit[3]) !== d) continue;
    const explicit = hit[4] ? Number(hit[4]) : yearAfter(text, (hit.index ?? 0) + hit[0].length);
    if (yearOk(explicit)) return true;
  }
  const enRangeDayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—~]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD})\\b[^0-9]{0,8}(\\d{4})?`, "gi");
  for (const hit of text.matchAll(enRangeDayFirst)) {
    if (MONTHS[hit[3]!.toLowerCase()] !== m) continue;
    if (Number(hit[1]) !== d && Number(hit[2]) !== d) continue;
    const explicit = hit[4] ? Number(hit[4]) : yearAfter(text, (hit.index ?? 0) + hit[0].length);
    if (yearOk(explicit)) return true;
  }
  // English single day: "November 24, 2026" / "Nov 24" / "24 November 2026" / "24th of November".
  // A day that starts a range is read by the range branch above, year included; it is not a single day
  // whose missing year may then be filled from the article.
  const monthFirst = new RegExp(`\\b(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*[-–—~])[^0-9]{0,6}(\\d{4})?`, "gi");
  for (const hit of text.matchAll(monthFirst)) {
    if (MONTHS[hit[1]!.toLowerCase()] !== m || Number(hit[2]) !== d) continue;
    const explicit = hit[3] ? Number(hit[3]) : yearAfter(text, (hit.index ?? 0) + hit[0].length);
    if (yearOk(explicit)) return true;
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD})\\b[^0-9]{0,6}(\\d{4})?`, "gi");
  for (const hit of text.matchAll(dayFirst)) {
    if (MONTHS[hit[2]!.toLowerCase()] !== m || Number(hit[1]) !== d) continue;
    const explicit = hit[3] ? Number(hit[3]) : yearAfter(text, (hit.index ?? 0) + hit[0].length);
    if (yearOk(explicit)) return true;
  }
  return false;
}

/**
 * The closing day of a range written as a range — "24日至28日", "November 24–28, 2026", "24-28 November
 * 2026". It inherits the opening day's month and year, and only from the sentence that states the
 * opening day; a stray "28日" elsewhere in the text proves nothing.
 */
function statesRangeEnd(
  text: string,
  start: { y: number; m: number; d: number },
  end: { y: number; m: number; d: number },
  titleYears: ReadonlySet<number>,
): boolean {
  if (start.m !== end.m || start.y !== end.y) return false;
  for (const sentence of sentencesOf(text)) {
    const zh = new RegExp(`(?<!\\d)${start.d}\\s*[日号]\\s*[至到\\-–—~〜]\\s*${end.d}\\s*[日号]`);
    if (!zh.test(sentence)) {
      const zhFull = new RegExp(`(?<!\\d)${start.d}\\s*日?\\s*[至到\\-–—~〜]\\s*${end.d}\\s*日`);
      if (!zhFull.test(sentence)) {
        const enMonthFirst = new RegExp(`\\b${MONTH_WORD}\\s+${start.d}(?:st|nd|rd|th)?\\s*[-–—~]\\s*${end.d}(?:st|nd|rd|th)?\\b`, "i");
        const enDayFirst = new RegExp(`\\b${start.d}(?:st|nd|rd|th)?\\s*[-–—~]\\s*${end.d}(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\b`, "i");
        if (!enMonthFirst.test(sentence) && !enDayFirst.test(sentence)) continue;
      }
    }
    // The sentence must also carry the calendar day the range starts on.
    if (statesDay(sentence, start, titleYears)) return true;
  }
  return false;
}

/** A day the original states, optionally as the closing day of a range it also states. */
function dateGrounded(date: string, texts: string[], titleYears: ReadonlySet<number>, startDate?: string | null): boolean {
  const target = parts(date);
  if (!target) return false;
  if (texts.some((t) => statesDay(t, target, titleYears))) return true;
  if (!startDate) return false;
  const start = parts(startDate);
  if (!start) return false;
  return texts.some((t) => statesRangeEnd(t, start, target, titleYears));
}

/**
 * The clause declares when the event takes place — 举办/举行/召开/会期, "will be held", "takes place".
 * A conference date has to come from such a clause: a day that only appears next to a registration
 * deadline ("报名截止2026年11月24日，会期另行通知") states a deadline, not an opening day, and the
 * conference is then kept without a date rather than given the deadline as its start. Clause, not
 * sentence: those two claims are usually written in one sentence, separated by a comma.
 */
const SCHEDULE_WORD = /会期|会议时间|会议日期|举办日期|召开时间|举办|举行|召开|开幕|闭幕|日程安排|held|takes?\s+place|will\s+be\s+held|scheduled\s+for|conference\s+dates|workshop\s+dates/i;

function scheduleSpans(originals: string[]): string[] {
  return originals.flatMap((text) => clausesOf(text)).filter((clause) => SCHEDULE_WORD.test(clause));
}

/** The clauses a sentence is made of: a role word binds to a day inside its own clause. An English
 *  date writes its year after a comma ("November 24–28, 2027"), so that comma is not a clause break. */
function clausesOf(text: string): string[] {
  return text
    .split(/[，；;。、\n]|,(?!\s*\d{4}\b)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The quote must say, in the clause that carries the day, that this day is a deadline of that kind.
 * A quote listing two deadlines ("报名截止11月1日，摘要截止10月15日") therefore proves only the pair it
 * actually states; the kind is never borrowed from the other clause.
 */
function kindStatedBy(quote: string, kind: string, date: string, titleYears: ReadonlySet<number>): boolean {
  const target = parts(date);
  if (!target) return false;
  const clauses = clausesOf(quote);
  const carrying = clauses.filter((clause) => statesDay(clause, target, titleYears));
  const pool = carrying.length ? carrying : [quote];
  return pool.some((clause) => KIND_WORD[kind]!.test(clause));
}

/** The kinds a quote must actually talk about: a date with no matching wording is not that deadline. */
const KIND_WORD: Record<string, RegExp> = {
  registration: /报名|注册|register|registration|enrol|sign[\s-]?up/i,
  early_registration: /早期|提前|早鸟|优惠|early|discount/i,
  abstract: /摘要|abstract/i,
  paper: /论文|全文|paper|proceedings|camera[\s-]?ready|manuscript/i,
  other: /截止|deadline|due|closes?/i,
};

/** Only an absolute http(s) link without credentials becomes a reader-facing link. */
function safeUrl(value: string | null | undefined, originals: string[]): string | null {
  const text = collapseWhitespace(value ?? "");
  if (!text || !originals.some((o) => o.includes(text))) return null;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The original's own wording for its time zone, mapped to the name the clock can be evaluated in.
 *
 * Two rules: an abbreviation that names more than one zone (CST is China Standard Time and US Central;
 * IST is India, Israel and Ireland) is not evidence, so it stays unknown; and a fixed standard offset
 * (EST/PST/GMT/AEST name an offset, not a place) maps to a fixed-offset zone, so a November conference
 * does not silently move an hour because the place observes summer time.
 */
const ZONE_ALIASES: Record<string, string> = {
  "北京时间": "Asia/Shanghai", "中国标准时间": "Asia/Shanghai", "beijing time": "Asia/Shanghai",
  "asia/shanghai": "Asia/Shanghai", "asia/tokyo": "Asia/Tokyo", "日本标准时间": "Asia/Tokyo", "jst": "Asia/Tokyo",
  "asia/seoul": "Asia/Seoul", "kst": "Asia/Seoul", "asia/singapore": "Asia/Singapore", "sgt": "Asia/Singapore",
  "asia/kolkata": "Asia/Kolkata", "asia/dubai": "Asia/Dubai",
  "europe/london": "Europe/London",
  "utc": "UTC", "协调世界时": "UTC", "世界时": "UTC", "gmt": "Etc/GMT", "格林尼治时间": "Etc/GMT",
  "europe/paris": "Europe/Paris", "cest": "Etc/GMT-2", "cet": "Etc/GMT-1", "欧洲中部时间": "Etc/GMT-1",
  "europe/berlin": "Europe/Berlin",
  "america/new_york": "America/New_York", "edt": "America/New_York", "美国东部时间": "America/New_York",
  "est": "Etc/GMT+5", "america/chicago": "America/Chicago", "cst6cdt": "America/Chicago",
  "america/denver": "America/Denver", "mst": "Etc/GMT+7",
  "america/los_angeles": "America/Los_Angeles", "pdt": "America/Los_Angeles", "美国太平洋时间": "America/Los_Angeles",
  "pst": "Etc/GMT+8", "pacific/auckland": "Pacific/Auckland",
  "australia/sydney": "Australia/Sydney", "aest": "Etc/GMT-10",
};

export function toIanaTimezone(value: string | null | undefined): string | null {
  const text = collapseWhitespace(value ?? "");
  if (!text) return null;
  const alias = ZONE_ALIASES[text.toLowerCase()];
  if (alias) return alias;
  // An IANA-shaped name is kept as written; the read layer checks it against the database's own zone
  // table before using it, so an unknown area falls back to the stated convention.
  return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(text) ? text : null;
}

/**
 * NFKC, lowercase, edition and punctuation dropped. Parentheticals are KEPT: "（北京分会）" and
 * "（上海分会）" are different meetings, so a name is never shortened into a neighbour's identity.
 */
export function conferenceNameNorm(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/第\s*[一二三四五六七八九十百零〇\d]+\s*届/g, " ")
    .replace(/[\u3000\s]+/g, "")
    .replace(/[，,。.、·:：;；!！?？"'“”‘’《》<>()（）[\]【】\-—_/\\|]/g, "");
}

/** "第25届" and "25" name the same edition; a bare number keeps its digits. */
export function conferenceEditionNorm(edition: string | null): string {
  if (!edition) return "";
  return edition.normalize("NFKC").toLowerCase().replace(/第\s*/g, "").replace(/\s*届/g, "").replace(/[\u3000\s]+/g, "");
}

/**
 * The edition a name itself states: "第25届天体物理年会". A model that returns edition=null must not
 * erase the distinction the original wrote down — two notices of the 25th and the 26th would otherwise
 * share one identity and merge. Only a series marker in the name counts; a bare year is not an edition.
 */
export function editionFromName(name: string | null | undefined): string | null {
  const hit = /第\s*([一二三四五六七八九十百零〇\d]+)\s*届/.exec(name ?? "");
  return hit ? `第${hit[1]}届` : null;
}

/**
 * The identity a conference is deduplicated on: the same name, edition and opening day. Different
 * editions and different years therefore never merge, and a notice that states neither an edition nor a
 * date carries no identity of its own — `anchor` (its article) keeps it separate instead of folding it
 * into a same-named event it cannot be shown to be.
 */
export function conferenceIdentityKey(
  c: { name: string; edition?: string | null; startDate?: string | null },
  anchor?: string | null,
): string {
  // The edition may only exist in the name ("第25届…"): a notice whose model output left it empty still
  // has to differ from the 26th, so the key reads it from the name it already grounded.
  const edition = conferenceEditionNorm(c.edition ?? editionFromName(c.name));
  const base = [conferenceNameNorm(c.name), edition, c.startDate ?? ""].join("|");
  // No edition and no date: two different meetings could share this key, so the article anchors it.
  return !edition && !c.startDate && anchor ? `${base}#${anchor}` : base;
}

/**
 * The recognition result for one article, or null. Null is the common answer: a story that mentions a
 * meeting it attended, a paragraph that names three meetings, a notice whose quote is not in the
 * original, or one whose name the original never states — none of them may become a conference entry.
 */
export function normalizeConference(raw: unknown, a: AnalyzeInputArticle): GroundedConference | null {
  const data = ConferenceExtractionSchema.parse(raw ?? null);
  if (!data || data.isNotice !== true || data.ambiguous) return null;
  const originals = originalsOf(a);
  if (!originals.length) return null;
  const material = originals.join("\n");
  const evidence = groundedPhrase(data.evidence, originals);
  if (!evidence) return null;
  // A call to take part in a named academic meeting: both halves must be in the original.
  const name = groundedPhrase(data.name, originals);
  if (!name || !CONFERENCE_WORD.test(name)) return null;
  if (!PARTICIPATION.test(material)) return null;
  const edition = groundedPhrase(data.edition, originals) ?? editionFromName(name);

  // Dates must come from a clause that says when the event takes place, not merely from anywhere in
  // the article. A day the text leaves without a year may only borrow the year the meeting's own name
  // states; the publication date is not evidence of when the meeting is.
  const titleYears = new Set([...name.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number(m[1])));
  const spans = scheduleSpans(originals);
  let startDate = data.startDate && dateGrounded(data.startDate, spans, titleYears) ? data.startDate : null;
  let endDate = data.endDate && dateGrounded(data.endDate, spans, titleYears, startDate) ? data.endDate : null;
  // A range that closes before it opens is not the range the original states.
  if (startDate && endDate && endDate < startDate) endDate = null;
  // A closing day without an opening day is a single undated day: it must stand as its own date.
  if (!startDate && endDate && !dateGrounded(endDate, spans, titleYears)) endDate = null;
  if (!startDate && endDate) startDate = endDate;

  const city = groundedPhrase(data.city, originals);
  const venue = groundedPhrase(data.venue, originals);
  const organizer = groundedPhrase(data.organizer, originals);
  const timezone = data.timezone && groundedPhrase(data.timezone, originals) ? toIanaTimezone(groundedPhrase(data.timezone, originals)) : null;
  // "Online" is a fact about the event only when the original says so; "in person" needs a stated place.
  const online = data.online === true
    ? (ONLINE_WORD.test(material) ? true : null)
    : data.online === false
      ? (city || venue ? false : null)
      : null;

  const deadlines: ConferenceDeadline[] = [];
  const seen = new Set<string>();
  for (const d of data.deadlines) {
    const quote = groundedPhrase(d.quote, originals);
    if (!quote || seen.has(d.kind)) continue;
    // The quote has to carry both halves of the claim: that day, and the kind of deadline it is.
    if (!d.date || !dateGrounded(d.date, [quote], titleYears)) continue;
    if (!kindStatedBy(quote, d.kind, d.date, titleYears)) continue;
    seen.add(d.kind);
    deadlines.push({ kind: d.kind, date: d.date, quote });
  }

  const nameNorm = conferenceNameNorm(name);
  return {
    name, edition, startDate, endDate, timezone, city, venue, online, organizer,
    officialUrl: safeUrl(data.officialUrl, originals), registrationUrl: safeUrl(data.registrationUrl, originals),
    deadlines, evidence, nameNorm,
    identityKey: conferenceIdentityKey({ name, edition, startDate }, a.id),
  };
}
