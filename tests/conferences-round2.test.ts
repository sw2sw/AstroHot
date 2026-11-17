// The round-2 review findings, pinned where they actually broke: the storage and read layers.
//
// B1 a deadline a person corrected never reached the hub (the read layer rebuilt it from notices);
// B3 the zone and the direction were read from the conference row, so a hidden notice kept deciding
//    when "today" is and which column shows the event;
// B5 a notice found later but published earlier overwrote a newer statement, because ordering used the
//    48-hour discovery time;
// B6 a person's correction plus the last notice leaving aborted the retraction on a NOT NULL name;
// B7 an edition that exists only in the title was dropped, merging two series.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { projectConference } from "@aihot/backend/content/conferences";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadConferenceHub } from "@aihot/backend/publication/conferences";
import { overrideConference } from "@aihot/backend/admin/conferences";
import { conferenceIdentityKey, type GroundedConference } from "@aihot/backend/editorial/conference";

const T = tag();
const SRC = `test-round2-${T}`;
/** A fixed reading instant: 2026-11-17 in Beijing, 2026-11-16 in Los Angeles. */
const NOW = new Date("2026-11-17T04:00:00Z");
let n = 0;

type Seed = {
  name: string;
  edition?: string | null;
  start: string | null;
  end?: string | null;
  timezone?: string | null;
  city?: string | null;
  organizer?: string | null;
  deadlines?: Array<{ kind: "registration" | "abstract"; date: string; quote: string }>;
  scope?: "astro" | "ai4s";
  /** The source's own publication time, and when the site first saw it. */
  publishedAt?: string;
  discoveredAt?: Date;
};

async function seed(s: Seed) {
  n += 1;
  const scope = s.scope ?? "astro";
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url: `https://example.org/round2-${T}-${n}`, title: `会议通知 ${n}`,
    bodyText: `${s.name}现开放报名`, bodyStatus: "ok", coverage: "full_text", via: "ingest", contentScope: scope,
    publishedAt: s.publishedAt ? new Date(s.publishedAt) : undefined,
    discoveredAt: s.discoveredAt,
  });
  // A published article carries the Chinese title and summary the pool needs.
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'outreach-images', ${["学术会议"]}, ${`会议通知 ${n}`}, ${`${s.name}现开放报名`}, false, ${sql.json({ scope: "single" } as never)})`;
  await publishArticle(articleId);
  const conf: GroundedConference = {
    name: s.name, edition: s.edition ?? null, startDate: s.start, endDate: s.end ?? s.start,
    timezone: s.timezone ?? null, city: s.city ?? null, venue: null, online: false, organizer: s.organizer ?? null,
    officialUrl: null, registrationUrl: null, deadlines: s.deadlines ?? [], evidence: `${s.name}现开放报名`,
    nameNorm: s.name.toLowerCase(),
    identityKey: conferenceIdentityKey({ name: s.name, edition: s.edition ?? null, startDate: s.start }, articleId),
  };
  const conferenceId = await sql.begin((tx) => projectConference(tx, { articleId, revision: 1, contentScope: scope, conference: conf }));
  return { articleId, conferenceId: conferenceId! };
}

const hubItem = async (id: number, now = NOW) =>
  (await loadConferenceHub({ scope: "all", now })).items.find((c) => c.id === id);

type StoredConference = {
  id: number; name: string; edition: string | null; city: string | null; timezone: string | null;
  deadlines: Array<{ kind: string; date: string | null }>; manual_fields: string[];
  schedule_status: string; version: number;
};
const row = async (id: number) => (await sql<StoredConference[]>`SELECT * FROM conferences WHERE id = ${id}`)[0]!;
const versionOf = async (id: number) => (await sql<{ version: number }[]>`SELECT version FROM conferences WHERE id = ${id}`)[0]!.version;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC}, '会议二轮复审源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(closeDb);

// —— B1: a corrected deadline is what the public API shows ————————————————————————————————————————

test("B1 a deadline corrected by a person is shown by the hub, and releasing it returns to the notice", async () => {
  const { conferenceId } = await seed({
    name: "人工修改期限研讨会", start: "2027-01-20", end: "2027-01-22",
    deadlines: [{ kind: "registration", date: "2027-01-10", quote: "报名截止2027-01-10" }],
  });
  const before = (await hubItem(conferenceId))!;
  assert.deepEqual(before.deadlines.map((d) => [d.kind, d.date]), [["registration", "2027-01-10"]]);

  // The admin command, then the same read the public endpoint performs.
  await overrideConference(conferenceId, {
    fields: { deadlines: [{ kind: "registration", date: "2027-02-01", quote: null }] },
    reason: "主办方通知报名延期", version: await versionOf(conferenceId),
  }, "editor");
  const corrected = (await hubItem(conferenceId))!;
  assert.deepEqual(corrected.deadlines.map((d) => [d.kind, d.date]), [["registration", "2027-02-01"]],
    "the hub shows the corrected date, not the notice's");

  // Clearing releases the pin: the notice speaks again, and the date it states comes back.
  await overrideConference(conferenceId, {
    fields: {}, clear: ["deadlines"], reason: "以通知原文为准", version: await versionOf(conferenceId),
  }, "editor");
  const released = (await hubItem(conferenceId))!;
  assert.deepEqual(released.deadlines.map((d) => [d.kind, d.date]), [["registration", "2027-01-10"]]);
  assert.deepEqual((await row(conferenceId)).manual_fields, [], "the pin is gone, not just ignored");
});

// —— B3: zone and direction come from the notices that are public now ————————————————————————————

test("B3 a hidden notice stops deciding the conference's day and direction", async () => {
  const a = await seed({ name: "第9届时区与方向研讨会", edition: "第9届", start: "2026-11-18", end: "2026-11-18", city: "西安", scope: "astro" });
  const b = await seed({
    name: "第9届时区与方向研讨会", edition: "第9届", start: "2026-11-18", end: "2026-11-18",
    timezone: "America/Los_Angeles", scope: "ai4s",
  });
  assert.equal(a.conferenceId, b.conferenceId, "one event, two notices in two columns");

  // 16:00Z is still the 18th in Los Angeles, already the 19th in Beijing.
  const at = new Date("2026-11-18T16:00:00Z");
  const live = (await hubItem(a.conferenceId, at))!;
  assert.equal(live.phase, "ongoing", "the stated zone decides the day");
  assert.equal(live.domain, "both", "both columns announced it");

  // Hide the AI4S notice: it may no longer speak for the event at all.
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${b.articleId}`;
  const afterHide = (await hubItem(a.conferenceId, at))!;
  assert.equal(afterHide.phase, "ended", "with the zone gone the stated convention applies again");
  assert.equal(afterHide.domain, "astro", "the direction follows the notices that are visible now");

  // A person's zone outranks the notices, the same way every other field does.
  await overrideConference(a.conferenceId, {
    fields: { timezone: "America/Los_Angeles" }, reason: "按主办方公布的时区", version: await versionOf(a.conferenceId),
  }, "editor");
  const pinned = (await hubItem(a.conferenceId, at))!;
  assert.equal(pinned.phase, "ongoing", "a pinned zone is used even though no live notice states one");

  // Retracting both notices leaves nothing public: the event is gone from the hub, not shown empty.
  await sql.begin((tx) => projectConference(tx, { articleId: a.articleId, revision: 2, contentScope: "astro", conference: null }));
  await sql.begin((tx) => projectConference(tx, { articleId: b.articleId, revision: 2, contentScope: "ai4s", conference: null }));
  assert.equal(await hubItem(a.conferenceId, at), undefined);
});

// —— B5: a later-found but older statement does not win ——————————————————————————————————————————

test("B5 a two-day-old notice found a minute ago cannot overwrite a newer statement", async () => {
  const now = Date.now();
  const a = await seed({
    name: "第10届期限倒灌研讨会", edition: "第10届", start: "2027-03-01", end: "2027-03-03",
    deadlines: [{ kind: "registration", date: "2027-02-01", quote: "报名截止2027-02-01" }],
    publishedAt: "2026-11-17T02:00:00Z", discoveredAt: new Date(now - 60_000),
  });
  // Older statement (16 Nov), discovered later — still inside the 48-hour window, so the discovery time
  // is not its statement time.
  const b = await seed({
    name: "第10届期限倒灌研讨会", edition: "第10届", start: "2027-03-01", end: "2027-03-03",
    deadlines: [{ kind: "registration", date: "2027-01-10", quote: "报名截止2027-01-10" }],
    publishedAt: "2026-11-16T02:00:00Z", discoveredAt: new Date(now),
  });
  assert.equal(b.conferenceId, a.conferenceId, "the same event");

  const stored = (await row(a.conferenceId)).deadlines;
  assert.deepEqual(stored.map((d) => [d.kind, d.date]), [["registration", "2027-02-01"]], "the newer statement holds");
  const item = (await hubItem(a.conferenceId))!;
  assert.deepEqual(item.deadlines.map((d) => [d.kind, d.date]), [["registration", "2027-02-01"]]);
});

// —— B6: a maintained conference survives its last notice, invisibly ——————————————————————————————

test("B6 the last notice leaving does not abort on the identity column", async () => {
  const { conferenceId, articleId } = await seed({ name: "人工维护的孤立会议", start: "2027-05-01", end: "2027-05-02" });
  await overrideConference(conferenceId, {
    fields: { city: "苏州", scheduleStatus: "postponed" }, reason: "等主办方新会期", version: await versionOf(conferenceId),
  }, "editor");

  // The article is re-judged as no longer a notice: the retraction runs inside one transaction and must
  // not fail because the row's name has no notice left to supply it.
  await sql.begin((tx) => projectConference(tx, { articleId, revision: 2, contentScope: "astro", conference: null }));

  const kept = await row(conferenceId);
  assert.equal(kept.name, "人工维护的孤立会议", "the identity a person still maintains is kept");
  assert.equal(kept.city, "苏州");
  assert.equal(kept.schedule_status, "postponed");
  assert.equal(await hubItem(conferenceId), undefined, "no notice means nothing public, even though the row exists");
});

// —— B7: an edition written only in the title separates the series ————————————————————————————————

test("B7 two series named only in the title stay two conferences in storage", async () => {
  const a = await seed({ name: "第25届全国天体物理年会", edition: null, start: "2027-07-01", city: "北京" });
  const b = await seed({ name: "第26届全国天体物理年会", edition: null, start: "2027-07-01", city: "上海" });
  assert.notEqual(a.conferenceId, b.conferenceId, "25th and 26th are not one event");
  assert.equal((await row(a.conferenceId)).edition, "第25届", "the edition the title states is stored");
  assert.equal((await row(b.conferenceId)).edition, "第26届");
  assert.equal((await row(a.conferenceId)).city, "北京");
  assert.equal((await row(b.conferenceId)).city, "上海");
});
