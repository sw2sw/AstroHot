// Conference recognition from one article's material, as a pure step: no database, no model.
// What a notice must prove before it becomes a conference: a verbatim supporting quote, a name that is
// in the original, dates that the original states (never an invented day, never the article's own
// publication time), and a participation signal that separates a call for registrations from a report
// that merely mentions a meeting it attended. Anything unproven is dropped, not guessed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { conferenceIdentityKey, conferenceNameNorm, normalizeConference, toIanaTimezone } from "@aihot/backend/editorial/conference";
import type { AnalyzeInputArticle } from "@aihot/backend/editorial/input";

const article = (body: string, over: Partial<AnalyzeInputArticle> = {}): AnalyzeInputArticle => ({
  id: "a1",
  revision: 1,
  title: "会议通知",
  url: "https://example.org/notice",
  author: null,
  publishedAt: new Date("2026-11-17T02:00:00Z"),
  bodyText: body,
  excerpt: null,
  bodyStatus: "ok",
  coverage: "full_text",
  xPost: null,
  media: [],
  source: { name: "测试源", kind: "rss", tier: "T1", firstParty: true },
  contentScope: "astro",
  ...over,
});

const CVO = [
  "第25届天文信息学与虚拟天文台学术研讨会（CVO2026）将于2026年11月24日至28日在西安召开，主题为“智能体驱动的数智天文——从模型调用走向自主科学发现”。",
  "现已开放报名，注册范围2026年9月28日至2026年11月28日；摘要投稿截止2026年10月15日。",
  "主办：国家天文科学数据中心。官网：https://nadc.china-vo.org/events/cvo2026/",
].join("\n");

const cvoExtraction = (over: Record<string, unknown> = {}) => ({
  isNotice: true,
  ambiguous: false,
  name: "第25届天文信息学与虚拟天文台学术研讨会",
  edition: "第25届",
  startDate: "2026-11-24",
  endDate: "2026-11-28",
  timezone: null,
  city: "西安",
  venue: null,
  online: false,
  organizer: "国家天文科学数据中心",
  officialUrl: "https://nadc.china-vo.org/events/cvo2026/",
  registrationUrl: null,
  deadlines: [
    { kind: "registration", date: "2026-11-28", quote: "注册范围2026年9月28日至2026年11月28日" },
    { kind: "abstract", date: "2026-10-15", quote: "摘要投稿截止2026年10月15日" },
  ],
  evidence: "第25届天文信息学与虚拟天文台学术研讨会（CVO2026）将于2026年11月24日至28日在西安召开",
  ...over,
});

test("a real call for participation keeps only the fields the original states", () => {
  const c = normalizeConference(cvoExtraction(), article(CVO));
  assert.ok(c);
  assert.equal(c.name, "第25届天文信息学与虚拟天文台学术研讨会");
  assert.equal(c.edition, "第25届");
  assert.equal(c.startDate, "2026-11-24");
  // "24日至28日": the closing day is stated as a day in the same month.
  assert.equal(c.endDate, "2026-11-28");
  assert.equal(c.city, "西安");
  assert.equal(c.online, false);
  assert.equal(c.organizer, "国家天文科学数据中心");
  assert.equal(c.officialUrl, "https://nadc.china-vo.org/events/cvo2026/");
  // Day-only deadlines keep their precision (no invented midnight).
  assert.deepEqual(c.deadlines.map((d) => [d.kind, d.date]), [["registration", "2026-11-28"], ["abstract", "2026-10-15"]]);
  // No stated time zone: unknown, not the venue's, not Beijing.
  assert.equal(c.timezone, null);
});

test("a quote that is not in the original voids the whole notice", () => {
  const c = normalizeConference(cvoExtraction({ evidence: "会议将在西安举办并开放报名" }), article(CVO));
  assert.equal(c, null);
});

test("isNotice false, or an ambiguous multi-conference paragraph, stays out", () => {
  assert.equal(normalizeConference(cvoExtraction({ isNotice: false }), article(CVO)), null);
  assert.equal(normalizeConference(cvoExtraction({ ambiguous: true }), article(CVO)), null);
  assert.equal(normalizeConference(null, article(CVO)), null);
});

test("an invented name is dropped rather than published", () => {
  const c = normalizeConference(cvoExtraction({ name: "2026 中国天文大会" }), article(CVO));
  assert.equal(c, null);
});

test("dates the original does not state are dropped, not invented", () => {
  const c = normalizeConference(cvoExtraction({ endDate: "2026-12-02", timezone: "Asia/Shanghai" }), article(CVO));
  assert.ok(c);
  assert.equal(c.startDate, "2026-11-24");
  assert.equal(c.endDate, null);
  // A time zone with no textual support is unknown.
  assert.equal(c.timezone, null);
});

test("the article's own publication date never becomes the conference dates", () => {
  const body = "第25届天文信息学与虚拟天文台学术研讨会现开放报名，会议详情见官网。";
  const c = normalizeConference(cvoExtraction({
    startDate: "2026-11-17", endDate: null, deadlines: [],
    evidence: "第25届天文信息学与虚拟天文台学术研讨会现开放报名",
  }), article(body));
  assert.ok(c);
  assert.equal(c.startDate, null);
  assert.equal(c.endDate, null);
});

test("an ungrounded place, organizer or link is dropped field by field", () => {
  const c = normalizeConference(cvoExtraction({
    city: "北京", organizer: "中国天文学会", officialUrl: "https://example.org/fake", registrationUrl: "https://example.org/reg",
  }), article(CVO));
  assert.ok(c);
  assert.equal(c.city, null);
  assert.equal(c.organizer, null);
  assert.equal(c.officialUrl, null);
  assert.equal(c.registrationUrl, null);
});

test("a result reported after the meeting is not a notice", () => {
  const body = "Our survey results were presented at the 243rd AAS meeting in January, where the team reported 1,200 new asteroids.";
  const c = normalizeConference({
    isNotice: true, ambiguous: false, name: "243rd AAS meeting", edition: "243rd", startDate: "2026-01-11", endDate: "2026-01-15",
    timezone: null, city: "Seattle", venue: null, online: false, organizer: null, officialUrl: null, registrationUrl: null,
    deadlines: [], evidence: "presented at the 243rd AAS meeting",
  }, article(body));
  assert.equal(c, null);
});

test("an ordinary news story that mentions a conference once is not a notice", () => {
  const body = "The observatory released its first images. The director said the team would discuss them at a conference later this year.";
  const c = normalizeConference({
    isNotice: true, ambiguous: false, name: "a conference", edition: null, startDate: null, endDate: null, timezone: null,
    city: null, venue: null, online: null, organizer: null, officialUrl: null, registrationUrl: null, deadlines: [],
    evidence: "discuss them at a conference later this year",
  }, article(body));
  assert.equal(c, null);
});

test("a one-day workshop with a registration deadline stays a one-day event", () => {
  const body = "The 2027 radio-astronomy workshop will be held on 2027-02-01 at Dwingeloo. Registration closes on 2027-01-15.";
  const c = normalizeConference({
    isNotice: true, ambiguous: false, name: "2027 radio-astronomy workshop", edition: null, startDate: "2027-02-01", endDate: "2027-02-01",
    timezone: null, city: "Dwingeloo", venue: null, online: false, organizer: null, officialUrl: null, registrationUrl: null,
    deadlines: [{ kind: "registration", date: "2027-01-15", quote: "Registration closes on 2027-01-15" }],
    evidence: "The 2027 radio-astronomy workshop will be held on 2027-02-01 at Dwingeloo.",
  }, article(body));
  assert.ok(c);
  assert.equal(c.startDate, "2027-02-01");
  assert.equal(c.endDate, "2027-02-01");
  assert.equal(c.deadlines.length, 1);
});

test("an end date before the start date is not a range the original supports", () => {
  const c = normalizeConference(cvoExtraction({ endDate: "2026-11-20" }), article(CVO));
  assert.ok(c);
  assert.equal(c.endDate, null);
});

test("identity separates editions, and a parenthetical that names a different meeting is kept", () => {
  const a = { name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届", startDate: "2026-11-24" };
  const sameNoticeOtherSource = { name: "第25届 天文信息学与虚拟天文台学术研讨会", edition: "25", startDate: "2026-11-24" };
  const nextEdition = { name: "第26届天文信息学与虚拟天文台学术研讨会", edition: "第26届", startDate: "2027-11-23" };
  const otherYearSameName = { name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届", startDate: "2027-05-01" };
  assert.equal(conferenceIdentityKey(a), conferenceIdentityKey(sameNoticeOtherSource));
  assert.notEqual(conferenceIdentityKey(a), conferenceIdentityKey(nextEdition));
  assert.notEqual(conferenceIdentityKey(a), conferenceIdentityKey(otherYearSameName));
  // A parenthetical may name a branch or a city: shortening the name would fold two meetings together.
  assert.notEqual(
    conferenceNameNorm("天文信息学研讨会（北京分会）"),
    conferenceNameNorm("天文信息学研讨会（上海分会）"),
  );
  // Neither an edition nor a date: the article anchors the identity instead of a name shared by others.
  assert.notEqual(conferenceIdentityKey({ name: "空间天文探测技术交流会" }, "a1"), conferenceIdentityKey({ name: "空间天文探测技术交流会" }, "a2"));
});

test("a day only counts in the year the original states", () => {
  // The original says 2026; a 2027 claim may not ride on the same month and day.
  const wrongYear = normalizeConference(cvoExtraction({ startDate: "2027-11-24", endDate: null }), article(CVO));
  assert.ok(wrongYear);
  assert.equal(wrongYear.startDate, null);
  // The same for a month: 24 December is not "11月24日".
  const wrongMonth = normalizeConference(cvoExtraction({ startDate: "2026-12-24", endDate: null }), article(CVO));
  assert.equal(wrongMonth!.startDate, null);
  // A closing day from another sentence is not this meeting's range.
  const strayDay = normalizeConference(cvoExtraction({ endDate: "2026-12-28" }), article(CVO));
  assert.equal(strayDay!.endDate, null);
});

test("a date that does not exist on the calendar never reaches the database", () => {
  const body = "第25届天文信息学与虚拟天文台学术研讨会将于2026年2月30日召开，现开放报名。";
  const c = normalizeConference({
    isNotice: true, ambiguous: false, name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届",
    startDate: "2026-02-30", endDate: null, timezone: null, city: null, venue: null, online: null,
    organizer: null, officialUrl: null, registrationUrl: null, deadlines: [],
    evidence: "第25届天文信息学与虚拟天文台学术研讨会将于2026年2月30日召开",
  }, article(body));
  assert.ok(c);
  assert.equal(c.startDate, null);
});

test("a deadline needs its own quote to carry both that day and that kind", () => {
  // The quote is real, the date is real, but the quote does not state that date.
  const mismatched = normalizeConference(cvoExtraction({
    deadlines: [{ kind: "abstract", date: "2026-10-15", quote: "摘要投稿截止" }],
  }), article(CVO));
  assert.deepEqual(mismatched!.deadlines, []);
  // The quote states the date but talks about something else entirely.
  const wrongKind = normalizeConference(cvoExtraction({
    deadlines: [{ kind: "registration", date: "2026-10-15", quote: "摘要投稿截止2026年10月15日" }],
  }), article(CVO));
  assert.deepEqual(wrongKind!.deadlines, []);
});

test("an English notice keeps its dates, including a written range", () => {
  const body = [
    "The 2026 Radio Astronomy Workshop will be held November 24–28, 2026 in Dwingeloo.",
    "Registration closes on 15 October 2026.",
  ].join(" ");
  const c = normalizeConference({
    isNotice: true, ambiguous: false, name: "2026 Radio Astronomy Workshop", edition: null,
    startDate: "2026-11-24", endDate: "2026-11-28", timezone: null, city: "Dwingeloo", venue: null, online: false,
    organizer: null, officialUrl: null, registrationUrl: null,
    deadlines: [{ kind: "registration", date: "2026-10-15", quote: "Registration closes on 15 October 2026" }],
    evidence: "The 2026 Radio Astronomy Workshop will be held November 24–28, 2026 in Dwingeloo.",
  }, article(body));
  assert.ok(c);
  assert.equal(c.startDate, "2026-11-24");
  assert.equal(c.endDate, "2026-11-28");
  assert.deepEqual(c.deadlines.map((d) => d.date), ["2026-10-15"]);
});

test("a stated time zone becomes a name the clock can use, and an unknown one stays unknown", () => {
  const body = "第25届天文信息学与虚拟天文台学术研讨会将于2026年11月24日至28日在西安召开，时间为北京时间，现开放报名。";
  const c = normalizeConference({
    isNotice: true, ambiguous: false, name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届",
    startDate: "2026-11-24", endDate: "2026-11-28", timezone: "北京时间", city: "西安", venue: null, online: false,
    organizer: null, officialUrl: null, registrationUrl: null, deadlines: [],
    evidence: "第25届天文信息学与虚拟天文台学术研讨会将于2026年11月24日至28日在西安召开",
  }, article(body));
  assert.equal(c!.timezone, "Asia/Shanghai");
  const unknown = normalizeConference(cvoExtraction({ timezone: "会务组通知的时间" }), article(CVO));
  assert.equal(unknown!.timezone, null);
});

test("a conference date has to come from the sentence that says when it takes place", () => {
  const body = [
    "第26届全国天体测量学术研讨会现开放报名。",
    "报名截止2026年11月24日，会期另行通知。",
  ].join("");
  const extraction = {
    isNotice: true, ambiguous: false, name: "第26届全国天体测量学术研讨会", edition: "第26届",
    startDate: "2026-11-24", endDate: null, timezone: null, city: null, venue: null, online: false,
    organizer: null, officialUrl: null, registrationUrl: null,
    deadlines: [{ kind: "registration", date: "2026-11-24", quote: "报名截止2026年11月24日" }],
    evidence: "第26届全国天体测量学术研讨会现开放报名",
  };
  const c = normalizeConference(extraction, article(body));
  assert.ok(c, "the notice is real");
  // The only day in the text is a registration deadline: the conference is kept, without a start date.
  assert.equal(c.startDate, null);
  assert.equal(c.endDate, null);
  assert.deepEqual(c.deadlines.map((d) => [d.kind, d.date]), [["registration", "2026-11-24"]]);
});

test("an English range keeps the year it states, and a wrong year cannot borrow it", () => {
  const body = "The Radio Astronomy Workshop will be held November 24–28, 2027 in Dwingeloo. Registration closes on 15 October 2027.";
  const base = {
    isNotice: true, ambiguous: false, name: "Radio Astronomy Workshop", edition: null, timezone: null,
    city: "Dwingeloo", venue: null, online: false, organizer: null, officialUrl: null, registrationUrl: null, deadlines: [],
    evidence: "The Radio Astronomy Workshop will be held November 24–28, 2027 in Dwingeloo",
  };
  const right = normalizeConference({ ...base, startDate: "2027-11-24", endDate: "2027-11-28" }, article(body));
  assert.equal(right!.startDate, "2027-11-24");
  assert.equal(right!.endDate, "2027-11-28", "the closing day belongs to the year written at the end of the range");
  const wrongStart = normalizeConference({ ...base, startDate: "2026-11-24", endDate: "2026-11-28" }, article(body));
  assert.equal(wrongStart!.startDate, null);
  assert.equal(wrongStart!.endDate, null);
});

test("a day with no year of its own is dated only by a year the notice writes for this event", () => {
  // Published in December for a meeting "on 12 January": nothing says which January, and the publication
  // date is not evidence — it is the reason a notice like this is usually about the *next* year.
  const body = "天文数据研讨会将于1月12日举行，现开放报名。";
  const extraction = (dates: { startDate: string | null; endDate: string | null }) => ({
    isNotice: true, ambiguous: false, name: "天文数据研讨会", edition: null,
    ...dates, timezone: null, city: null, venue: null, online: false,
    organizer: null, officialUrl: null, registrationUrl: null, deadlines: [],
    evidence: "天文数据研讨会将于1月12日举行",
  });
  const december = article(body, { publishedAt: new Date("2026-12-20T02:00:00Z") });
  // Neither this year nor next year is stated, so neither may be shown: the event stays undated rather
  // than becoming one that ended eleven months ago.
  assert.equal(normalizeConference(extraction({ startDate: "2026-01-12", endDate: null }), december)!.startDate, null);
  assert.equal(normalizeConference(extraction({ startDate: "2027-01-12", endDate: null }), december)!.startDate, null);

  // The meeting's own title states the year, and that year is what a yearless day may use.
  const titled = "2027年天文数据研讨会将于1月12日举行，现开放报名。";
  const titledExtraction = (startDate: string) => ({
    ...extraction({ startDate, endDate: null }), name: "2027年天文数据研讨会",
    evidence: "2027年天文数据研讨会将于1月12日举行",
  });
  const right = normalizeConference(titledExtraction("2027-01-12"), article(titled, { publishedAt: new Date("2026-12-20T02:00:00Z") }));
  assert.equal(right!.startDate, "2027-01-12");
  const wrong = normalizeConference(titledExtraction("2026-01-12"), article(titled, { publishedAt: new Date("2026-12-20T02:00:00Z") }));
  assert.equal(wrong!.startDate, null, "the title says 2027, so 2026 is not that meeting");

  // A year written inside the date expression itself still counts, and covers the days that follow it.
  const ranged = "第26届全国天体测量学术研讨会将于2026年11月24日至28日召开，现开放报名。";  const rangedExtraction = {
    isNotice: true, ambiguous: false, name: "第26届全国天体测量学术研讨会", edition: "第26届",
    startDate: "2026-11-24", endDate: "2026-11-28", timezone: null, city: null, venue: null, online: false,
    organizer: null, officialUrl: null, registrationUrl: null, deadlines: [],
    evidence: "第26届全国天体测量学术研讨会将于2026年11月24日至28日召开",
  };
  const inYear = normalizeConference(rangedExtraction, article(ranged));
  assert.equal(inYear!.startDate, "2026-11-24");
  assert.equal(inYear!.endDate, "2026-11-28");
  // One year written by the clause dates that clause's yearless day: it is the meeting's own year, and
  // it does not depend on when the notice was published.
  const oneYear = "2026年第26届全国天体测量学术研讨会将于11月24日至28日召开，现开放报名。";
  const clauseDated = normalizeConference(
    { ...rangedExtraction, evidence: "2026年第26届全国天体测量学术研讨会将于11月24日至28日召开" },
    article(oneYear, { publishedAt: new Date("2026-12-30T02:00:00Z") }),
  );
  assert.equal(clauseDated!.startDate, "2026-11-24");
  assert.equal(clauseDated!.endDate, "2026-11-28");
  // The same words without any year do not license one, even one taken from the article's own date.
  const undated = ranged.replace("2026年", "");
  const yearless = normalizeConference(
    { ...rangedExtraction, evidence: "第26届全国天体测量学术研讨会将于11月24日至28日召开" },
    article(undated),
  );
  assert.equal(yearless!.startDate, null);
});

test("a quote listing two deadlines proves each kind only in the clause that carries its date", () => {
  const body = "第26届全国天体测量学术研讨会现开放报名，报名截止2026年11月1日，摘要投稿截止2026年10月15日。";
  const quote = "报名截止2026年11月1日，摘要投稿截止2026年10月15日";
  const extraction = (deadlines: unknown[]) => ({
    isNotice: true, ambiguous: false, name: "第26届全国天体测量学术研讨会", edition: "第26届",
    startDate: null, endDate: null, timezone: null, city: null, venue: null, online: false,
    organizer: null, officialUrl: null, registrationUrl: null, deadlines,
    evidence: "第26届全国天体测量学术研讨会现开放报名",
  });
  const right = normalizeConference(extraction([
    { kind: "registration", date: "2026-11-01", quote },
    { kind: "abstract", date: "2026-10-15", quote },
  ]), article(body));
  assert.deepEqual(right!.deadlines.map((d) => [d.kind, d.date]), [["registration", "2026-11-01"], ["abstract", "2026-10-15"]]);
  // The abstract kind claimed for the registration day: the word is in the quote, but not in that clause.
  const crossed = normalizeConference(extraction([{ kind: "abstract", date: "2026-11-01", quote }]), article(body));
  assert.deepEqual(crossed!.deadlines, []);
});

test("an edition written only in the name still separates two series", () => {
  assert.notEqual(
    conferenceIdentityKey({ name: "第25届全国天体物理年会", edition: null, startDate: "2027-07-01" }),
    conferenceIdentityKey({ name: "第26届全国天体物理年会", edition: null, startDate: "2027-07-01" }),
  );
  assert.equal(
    conferenceIdentityKey({ name: "第25届全国天体物理年会", edition: null, startDate: "2027-07-01" }),
    conferenceIdentityKey({ name: "第25届全国天体物理年会", edition: "第25届", startDate: "2027-07-01" }),
  );
});

test("an ambiguous abbreviation is not a zone, and a fixed standard offset does not follow summer time", () => {
  // CST is China Standard Time and US Central; IST is India, Israel and Ireland. Neither is evidence.
  assert.equal(toIanaTimezone("CST"), null);
  assert.equal(toIanaTimezone("IST"), null);
  assert.equal(toIanaTimezone("cst"), null);
  // EST/PST/GMT/AEST name an offset, not a place: a fixed-offset zone cannot move an hour in July.
  assert.equal(toIanaTimezone("EST"), "Etc/GMT+5");
  assert.equal(toIanaTimezone("PST"), "Etc/GMT+8");
  assert.equal(toIanaTimezone("GMT"), "Etc/GMT");
  assert.equal(toIanaTimezone("AEST"), "Etc/GMT-10");
  assert.equal(toIanaTimezone("北京时间"), "Asia/Shanghai");
});
