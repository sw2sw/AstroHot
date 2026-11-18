// The review findings, pinned as regression tests on the storage and read layers: what a human fixed
// stays fixed, a deadline that moves is updated, a field whose only notice was retracted disappears, a
// cancelled event is not recommended, two same-named meetings do not merge, and clearing a column that
// cannot be empty is refused instead of failing inside the database.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { projectConference } from "@aihot/backend/content/conferences";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadConferenceHub, loadRecentConferences } from "@aihot/backend/publication/conferences";
import { overrideConference } from "@aihot/backend/admin/conferences";
import { conferenceIdentityKey, type GroundedConference } from "@aihot/backend/editorial/conference";

const T = tag();
const SRC = `test-review-${T}`;
let n = 0;

type Seed = {
  name: string; edition?: string | null; start: string | null; end?: string | null;
  city?: string | null; venue?: string | null; organizer?: string | null; timezone?: string | null;
  officialUrl?: string | null; registrationUrl?: string | null;
  deadlines?: Array<{ kind: "registration" | "abstract"; date: string; quote: string }>;
  publishedAt?: string; scope?: "astro" | "ai4s";
};

/** One notice, published and projected — the rows a real ingest would leave. */
async function seed(s: Seed) {
  n += 1;
  const scope = s.scope ?? "astro";
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url: `https://example.org/review-${T}-${n}`, title: `会议通知 ${n}`,
    bodyText: `${s.name}现开放报名`, bodyStatus: "ok", coverage: "full_text", via: "ingest", contentScope: scope,
    publishedAt: s.publishedAt ? new Date(s.publishedAt) : undefined,
  });
  // A published article carries the Chinese title and summary the pool needs: without them it is not
  // eligible, and the hub would rightly refuse to show it.
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'outreach-images', ${["学术会议"]}, ${`会议通知 ${n}`}, ${`${s.name}现开放报名`}, false, ${sql.json({ scope: "single" } as never)})`;
  await publishArticle(articleId);
  const conf: GroundedConference = {
    name: s.name, edition: s.edition ?? null, startDate: s.start, endDate: s.end ?? s.start, timezone: s.timezone ?? null,
    city: s.city ?? null, venue: s.venue ?? null, online: false, organizer: s.organizer ?? null,
    officialUrl: s.officialUrl ?? null, registrationUrl: s.registrationUrl ?? null,
    deadlines: s.deadlines ?? [], evidence: `${s.name}现开放报名`,
    nameNorm: s.name.toLowerCase(), identityKey: conferenceIdentityKey({ name: s.name, edition: s.edition ?? null, startDate: s.start }, articleId),
  };
  const conferenceId = await sql.begin((tx) => projectConference(tx, { articleId, revision: 1, contentScope: scope, conference: conf }));
  return { articleId, conferenceId: conferenceId! };
}

/** A date column, as YYYY-MM-DD whatever the driver returns. */
const day = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
};

type StoredConference = {
  id: number; name: string; start_date: Date | string | null; end_date: Date | string | null;
  city: string | null; venue: string | null; organizer: string | null;
  official_url: string | null; registration_url: string | null;
  deadlines: Array<{ kind: string; date: string | null }>; manual_fields: string[]; schedule_status: string; version: number;
};
const row = async (id: number) => (await sql<StoredConference[]>`SELECT * FROM conferences WHERE id = ${id}`)[0]!;
const versionOf = async (id: number) => (await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${id}`)[0]!.version;
const hubItem = async (id: number) => (await loadConferenceHub({ scope: "all", now: new Date("2026-11-17T04:00:00Z") })).items.find((c) => c.id === id);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC}, '会议复审源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(closeDb);

// —— R2: a field a person pinned is never overwritten by a later notice ——————————————————————————

test("R2 a pinned start, end and both links survive a new notice, and are shown by the hub", async () => {
  const { conferenceId } = await seed({
    name: "人工固定会期研讨会", start: "2026-12-01", end: "2026-12-03",
    officialUrl: "https://a.example/official", registrationUrl: "https://a.example/reg",
  });
  await overrideConference(conferenceId, {
    fields: { startDate: "2026-12-10", endDate: "2026-12-12", officialUrl: "https://b.example/official", registrationUrl: "https://b.example/reg" },
    reason: "会期与链接以官网为准", version: await versionOf(conferenceId),
  }, "reviewer");
  // A later notice of the same event still states the old dates and links.
  const second = await seed({
    name: "人工固定会期研讨会", start: "2026-12-01", end: "2026-12-03",
    officialUrl: "https://a.example/official", registrationUrl: "https://a.example/reg",
  });
  assert.equal(second.conferenceId, conferenceId, "the same event, not a second row");
  const r = await row(conferenceId);
  assert.equal(day(r.start_date), "2026-12-10");
  assert.equal(day(r.end_date), "2026-12-12");
  assert.equal(r.official_url, "https://b.example/official");
  assert.equal(r.registration_url, "https://b.example/reg");
  const item = await hubItem(conferenceId);
  assert.equal(item!.startDate, "2026-12-10");
  assert.equal(item!.officialUrl, "https://b.example/official");
});

test("R2 a pin written with the first version's camelCase names still protects its column", async () => {
  const { conferenceId } = await seed({ name: "旧命名固定研讨会", start: "2027-01-05", end: "2027-01-06", city: "南京" });
  // What the first release wrote: the API's own field names, not the column names.
  await sql`UPDATE conferences SET manual_fields = ${sql.json(["startDate", "endDate", "city"] as never)}, start_date = '2027-02-01', end_date = '2027-02-02', city = '苏州'
             WHERE id = ${conferenceId}`;
  await seed({ name: "旧命名固定研讨会", start: "2027-01-05", end: "2027-01-06", city: "南京" });
  const r = await row(conferenceId);
  assert.equal(day(r.start_date), "2027-02-01");
  assert.equal(day(r.end_date), "2027-02-02");
  assert.equal(r.city, "苏州");
});

// —— R3: a postponement of a deadline moves it; an old notice cannot overwrite a newer one ——————

test("R3 a deadline moves with the newest notice, an old notice arriving late cannot undo it", async () => {
  const first = await seed({
    name: "截止日期更新研讨会", start: "2027-03-01",
    deadlines: [{ kind: "registration", date: "2026-11-01", quote: "报名截止2026-11-01" }],
    publishedAt: "2026-10-01T00:00:00Z",
  });
  const later = await seed({
    name: "截止日期更新研讨会", start: "2027-03-01",
    deadlines: [{ kind: "registration", date: "2026-11-10", quote: "报名截止2026-11-10" }],
    publishedAt: "2026-11-01T00:00:00Z",
  });
  assert.equal(later.conferenceId, first.conferenceId);
  assert.equal((await row(first.conferenceId)).deadlines[0].date, "2026-11-10");

  // An announcement from before the correction is ingested afterwards: it must not move the deadline back.
  await seed({
    name: "截止日期更新研讨会", start: "2027-03-01",
    deadlines: [{ kind: "registration", date: "2026-10-01", quote: "报名截止2026-10-01" }],
    publishedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal((await row(first.conferenceId)).deadlines[0].date, "2026-11-10");
  const item = await hubItem(first.conferenceId);
  assert.equal(item!.deadlines.find((d) => d.kind === "registration")!.date, "2026-11-10");
});

test("R3 a person can correct or clear the deadline list, and a pin holds against the notices", async () => {
  const { conferenceId } = await seed({
    name: "人工纠正截止研讨会", start: "2027-04-01",
    deadlines: [{ kind: "abstract", date: "2027-01-10", quote: "摘要截止2027-01-10" }],
    publishedAt: "2026-11-01T00:00:00Z",
  });
  const [before] = await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${conferenceId}`;
  await overrideConference(conferenceId, {
    fields: { deadlines: [{ kind: "abstract", date: "2027-02-01", quote: "主办方通知：摘要截止延至 2027-02-01" }] },
    reason: "主办方延期通知", version: before!.version,
  }, "reviewer");
  // A later notice still states the old day: the human correction wins.
  await seed({
    name: "人工纠正截止研讨会", start: "2027-04-01",
    deadlines: [{ kind: "abstract", date: "2027-01-10", quote: "摘要截止2027-01-10" }],
    publishedAt: "2026-12-01T00:00:00Z",
  });
  assert.equal((await row(conferenceId)).deadlines[0].date, "2027-02-01");

  // Clearing releases the pin: the day returns to what the notices say.
  const [current] = await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${conferenceId}`;
  await overrideConference(conferenceId, { fields: {}, clear: ["deadlines"], reason: "撤销人工延期", version: current!.version }, "reviewer");
  assert.equal((await row(conferenceId)).deadlines.length, 0);
  await seed({
    name: "人工纠正截止研讨会", start: "2027-04-01",
    deadlines: [{ kind: "abstract", date: "2027-01-10", quote: "摘要截止2027-01-10" }],
    publishedAt: "2026-12-02T00:00:00Z",
  });
  assert.equal((await row(conferenceId)).deadlines[0].date, "2027-01-10");
});

// —— R5: a field exists only while a live notice still states it ——————————————————————————————

test("R5 retracting the notice that supplied a venue and a link removes them, not the conference", async () => {
  const base = await seed({ name: "字段来源撤回研讨会", start: "2027-05-01", city: "西安" });
  const withVenue = await seed({
    name: "字段来源撤回研讨会", start: "2027-05-01", venue: "曲江国际会议中心",
    registrationUrl: "https://example.org/reg", publishedAt: "2026-11-10T00:00:00Z",
  });
  assert.equal(withVenue.conferenceId, base.conferenceId);
  let item = await hubItem(base.conferenceId);
  assert.equal(item!.venue, "曲江国际会议中心");
  assert.equal(item!.registrationUrl, "https://example.org/reg");

  // The venue notice is withdrawn: the conference stays public through the other one, the fields it
  // alone supported do not.
  await sql.begin((tx) => projectConference(tx, { articleId: withVenue.articleId, revision: 1, contentScope: "astro", conference: null }));

  const r = await row(base.conferenceId);
  assert.equal(r.venue, null);
  assert.equal(r.registration_url, null);
  assert.equal(r.city, "西安");
  item = await hubItem(base.conferenceId);
  assert.ok(item, "the conference is still public through the notice that remains");
  assert.equal(item!.venue, null);
  assert.equal(item!.registrationUrl, null);
  assert.equal(item!.city, "西安");
});

test("R5 hiding a notice removes the fields only it stated, without retracting the article", async () => {
  const base = await seed({ name: "字段可见性研讨会", start: "2027-06-01", city: "合肥" });
  const withOrganizer = await seed({
    name: "字段可见性研讨会", start: "2027-06-01", organizer: "中国科学技术大学",
    publishedAt: "2026-11-12T00:00:00Z",
  });
  assert.equal(withOrganizer.conferenceId, base.conferenceId);
  assert.equal((await hubItem(base.conferenceId))!.organizer, "中国科学技术大学");

  // The row still records what the notice said; the public hub may only show what its live notices say.
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${withOrganizer.articleId}`;
  const item = await hubItem(base.conferenceId);
  assert.ok(item);
  assert.equal(item!.organizer, null);
  assert.equal(item!.city, "合肥");
});

// —— R6: a cancelled event is not recommended, and still findable with its state ——————————————

test("R6 a cancelled or postponed event leaves the recent entry and never reads as ongoing", async () => {
  const upcoming = await seed({ name: "取消状态研讨会", start: "2026-12-20", end: "2026-12-21", city: "杭州" });
  const ongoingNow = await seed({ name: "会期中取消研讨会", start: "2026-11-16", end: "2026-11-19", city: "南京" });
  const postponedPast = await seed({ name: "待定延期研讨会", start: "2026-11-10", end: "2026-11-11", city: "成都" });
  for (const [id, status] of [[upcoming.conferenceId, "cancelled"], [ongoingNow.conferenceId, "cancelled"], [postponedPast.conferenceId, "postponed"]] as const) {
    const [r] = await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${id}`;
    await overrideConference(id, { fields: { scheduleStatus: status }, reason: "主办方通知", version: r!.version }, "reviewer");
  }

  const now = new Date("2026-11-17T04:00:00Z");
  const recent = await loadRecentConferences("astro", 3, now);
  assert.ok(!recent.some((c) => [upcoming.conferenceId, ongoingNow.conferenceId, postponedPast.conferenceId].includes(c.id)), "neither state is recommended");

  const hub = await loadConferenceHub({ scope: "all", now });
  const byId = new Map(hub.items.map((c) => [c.id, c]));
  // The state outranks the clock: a cancelled event inside its dates is not "ongoing", and one whose
  // new dates are unsettled is not "ended" because the old dates have passed.
  assert.equal(byId.get(upcoming.conferenceId)!.phase, "cancelled");
  assert.equal(byId.get(ongoingNow.conferenceId)!.phase, "cancelled");
  assert.equal(byId.get(postponedPast.conferenceId)!.phase, "postponed");
  assert.equal(byId.get(ongoingNow.conferenceId)!.scheduleStatus, "cancelled");
});

// —— R7: same name, different edition, or no identity at all, never merges ————————————————————

test("R7 the same name on the same day with a different edition stays two conferences", async () => {
  const a = await seed({ name: "天体物理年会", edition: "第25届", start: "2027-07-01", city: "北京" });
  const b = await seed({ name: "天体物理年会", edition: "第26届", start: "2027-07-01", city: "上海" });
  assert.notEqual(a.conferenceId, b.conferenceId);
  assert.equal((await row(a.conferenceId)).city, "北京");
  assert.equal((await row(b.conferenceId)).city, "上海");
});

test("R7 a notice with neither an edition nor a date is anchored to its own article", async () => {
  const a = await seed({ name: "太阳物理工作会议", start: null });
  const b = await seed({ name: "太阳物理工作会议", start: null });
  assert.notEqual(a.conferenceId, b.conferenceId, "name alone is not enough evidence to merge");
  const hub = await loadConferenceHub({ scope: "all", now: new Date("2026-11-17T04:00:00Z") });
  assert.equal(hub.items.filter((c) => c.name === "太阳物理工作会议").length, 2);
});

// —— R9: clearing a column that cannot be empty ————————————————————————————————————————————————

test("R9 clearing the schedule state returns it to scheduled instead of writing NULL", async () => {
  const s = await seed({ name: "状态清除研讨会", start: "2027-08-01" });
  const [r] = await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${s.conferenceId}`;
  await overrideConference(s.conferenceId, { fields: { scheduleStatus: "postponed" }, reason: "延期", version: r!.version }, "reviewer");
  const [r2] = await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${s.conferenceId}`;
  await overrideConference(s.conferenceId, { fields: {}, clear: ["scheduleStatus"], reason: "确认如期", version: r2!.version }, "reviewer");
  const after = await row(s.conferenceId);
  assert.equal(after.schedule_status, "scheduled");
  assert.deepEqual(after.manual_fields, []);
});

test("R9 clearing the name is refused, and nothing is written", async () => {
  const s = await seed({ name: "名称不可清空研讨会", start: "2027-09-01" });
  const [before] = await sql<{ version: number; name: string }[]>`SELECT version, name FROM conferences WHERE id = ${s.conferenceId}`;
  await assert.rejects(
    () => overrideConference(s.conferenceId, { fields: {}, clear: ["name"], reason: "试图清空", version: before!.version }, "reviewer"),
    /不能清空/,
  );
  const after = await row(s.conferenceId);
  assert.equal(after.name, "名称不可清空研讨会");
  assert.equal(after.version, before!.version);
});

// —— R8: a stated time zone decides which local day "today" is ——————————————————————————————

test("R8 a conference in another zone is judged by its own local day, not Beijing's", async () => {
  // Two conferences with the same dates; only one notice states a zone, so the difference can only come
  // from the notice's own evidence — never from a column someone edited afterwards.
  const zoned = await seed({
    name: "太平洋时区研讨会", start: "2026-11-18", end: "2026-11-18", timezone: "America/Los_Angeles",
    deadlines: [{ kind: "registration", date: "2026-11-18", quote: "报名截止2026-11-18" }],
  });
  const plain = await seed({
    name: "未写时区研讨会", start: "2026-11-18", end: "2026-11-18",
    deadlines: [{ kind: "registration", date: "2026-11-18", quote: "报名截止2026-11-18" }],
  });
  // 2026-11-18T16:00Z: already the 19th in Beijing, still the 18th in Los Angeles.
  const hub = await loadConferenceHub({ scope: "all", now: new Date("2026-11-18T16:00:00Z") });
  const a = hub.items.find((c) => c.id === zoned.conferenceId)!;
  const b = hub.items.find((c) => c.id === plain.conferenceId)!;
  assert.equal(a.phase, "ongoing", "its last day has not ended where the meeting is");
  assert.equal(a.deadlines[0]!.state, "today", "a date-only deadline is not closed early");
  assert.equal(b.phase, "ended", "without a stated zone the stated convention applies");
  assert.equal(b.deadlines[0]!.state, "closed");
});
