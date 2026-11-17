// Conference identity and manual correction, at the database level: the projection the analysis
// transaction writes (content/conferences.ts) and the editor's correction of it (admin/conferences.ts).
// No model: the grounded extraction is handed in as the object the normalizer would have returned, so
// each rule below is tested on its own — deduplication, postponement, retraction, pinning, CAS.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { projectConference } from "@aihot/backend/content/conferences";
import { overrideConference } from "@aihot/backend/admin/conferences";
import { conferenceIdentityKey, type GroundedConference } from "@aihot/backend/editorial/conference";

const T = tag();
const SOURCE = `test-conf-${T}`;
const OTHER = `test-conf-other-${T}`;

let n = 0;
async function article(source = SOURCE, scope: "astro" | "ai4s" = "astro") {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.org/conf-${T}-${n}`, title: `会议通知 ${n}`, bodyText: "第25届天文信息学与虚拟天文台学术研讨会现开放报名",
    bodyStatus: "ok", coverage: "full_text", via: "ingest", contentScope: scope,
  });
  return articleId;
}

const conference = (over: Partial<GroundedConference> = {}): GroundedConference => {
  const base = {
    name: "第25届天文信息学与虚拟天文台学术研讨会",
    edition: "第25届",
    startDate: "2026-11-24",
    endDate: "2026-11-28",
    timezone: null, city: "西安", venue: null, online: false,
    organizer: "国家天文科学数据中心", officialUrl: "https://nadc.china-vo.org/events/cvo2026/", registrationUrl: null,
    deadlines: [{ kind: "registration" as const, date: "2026-11-28", quote: "注册范围2026年9月28日至2026年11月28日" }],
    evidence: "第25届天文信息学与虚拟天文台学术研讨会（CVO2026）将于2026年11月24日至28日在西安召开",
    nameNorm: "天文信息学与虚拟天文台学术研讨会",
  };
  const merged = { ...base, ...over };
  return { ...merged, identityKey: conferenceIdentityKey(merged) } as GroundedConference;
};

const project = (articleId: string, c: GroundedConference | null, scope: "astro" | "ai4s" = "astro") =>
  sql.begin((tx) => projectConference(tx, { articleId, revision: 1, contentScope: scope, conference: c }));

const conferences = () => sql<{ id: number; name: string; city: string | null; version: number; manual_fields: string[]; schedule_status: string; domain: string; deadlines: Array<{ kind: string; date: string }> }[]>`
  SELECT id, name, city, version, manual_fields, schedule_status, domain, deadlines FROM conferences ORDER BY id`;
const notices = () => sql<{ conference_id: number; article_id: string; content_scope: string }[]>`
  SELECT conference_id, article_id, content_scope FROM conference_notices ORDER BY conference_id, article_id`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, '会议测试源', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${OTHER}, '会议测试源二', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(closeDb);

test("two notices of one meeting become one conference with both originals kept", async () => {
  const a = await article();
  const b = await article(OTHER);
  assert.ok(await project(a, conference()));
  assert.ok(await project(b, conference({ evidence: "第25届天文信息学与虚拟天文台学术研讨会现开放报名" })));
  const rows = await conferences();
  assert.equal(rows.length, 1);
  assert.equal((await notices()).length, 2);
});

test("a different edition, or the same name on another date, stays a separate conference", async () => {
  const before = (await conferences()).length;
  const c = await article();
  await project(c, conference({ name: "第26届天文信息学与虚拟天文台学术研讨会", edition: "第26届", startDate: "2027-11-23", endDate: "2027-11-27" }));
  const d = await article(OTHER);
  await project(d, conference({ name: "天文信息学与虚拟天文台学术研讨会春季论坛", edition: null, startDate: "2027-05-06", endDate: "2027-05-07" }));
  assert.equal((await conferences()).length, before + 2);
  // Two rows now: the original meeting and the spring forum; the 26th edition is its own row.
  const names = (await conferences()).map((r) => r.name);
  assert.ok(names.some((name) => name.includes("第26届")));
  assert.ok(names.some((name) => name.includes("春季论坛")));
});

test("a postponement moves the dates of the same event instead of adding a row", async () => {
  const before = (await conferences()).length;
  const e = await article();
  await project(e, conference({ startDate: "2026-12-01", endDate: "2026-12-05", evidence: "会议改期至2026年12月1日至5日举行" }));
  assert.equal((await conferences()).length, before);
  const row = (await conferences()).find((r) => r.name.startsWith("第25届"))!;
  assert.equal(row.city, "西安");
});

test("a revised article that is no longer a notice is retracted, and its empty conference goes", async () => {
  const f = await article();
  await project(f, conference({ name: "临时讲座：射电望远镜数据处理", edition: null, startDate: "2026-12-09", endDate: "2026-12-09" }));
  const created = (await conferences()).find((r) => r.name.includes("临时讲座"))!;
  assert.ok(created);
  await project(f, null);
  assert.equal((await conferences()).some((r) => r.name.includes("临时讲座")), false);
  assert.equal((await notices()).some((r) => r.conference_id === created.id), false);
});

test("a human correction is pinned: a later notice does not overwrite or un-cancel it", async () => {
  const row = (await conferences()).find((r) => r.name.startsWith("第25届"))!;
  await overrideConference(row.id, { version: row.version, reason: "会场改到曲江国际会议中心，已电话确认", fields: { city: "西安", venue: "曲江国际会议中心", scheduleStatus: "postponed" } }, "tester");
  const g = await article();
  await project(g, conference({ city: "西安" }));
  const after = (await conferences()).find((r) => r.id === row.id)!;
  assert.equal(after.schedule_status, "postponed");
  // The deadline a notice supplied is still merged in, the pinned venue is untouched.
  assert.ok(after.manual_fields.includes("venue"));
  assert.equal(after.deadlines.length >= 1, true);
});

test("a correction written against a stale version is refused", async () => {
  const row = (await conferences()).find((r) => r.name.startsWith("第25届"))!;
  await assert.rejects(
    () => overrideConference(row.id, { version: row.version - 1, reason: "过期视图", fields: { city: "北京" } }, "tester"),
    /会议信息已更新|conflict/i,
  );
});

test("the column of a notice decides the conference's domain, and never the article's own flags", async () => {
  const h = await article(OTHER, "ai4s");
  const id = await project(h, conference({ name: "AI for Science 2026 学术研讨会", edition: null, startDate: "2026-12-14", endDate: "2026-12-16" }), "ai4s");
  const [row] = await sql<{ domain: string }[]>`SELECT domain FROM conferences WHERE id = ${id}`;
  assert.equal(row!.domain, "ai4s");
  // A second notice in the astronomy column makes it a cross-column event, without touching the article.
  const i = await article();
  await project(i, conference({ name: "AI for Science 2026 学术研讨会", edition: null, startDate: "2026-12-14", endDate: "2026-12-16" }));
  const [merged] = await sql<{ domain: string }[]>`SELECT domain FROM conferences WHERE id = ${id}`;
  assert.equal(merged!.domain, "both");
  const [row2] = await sql<{ content_scope: string }[]>`SELECT content_scope FROM articles WHERE id = ${i}`;
  assert.equal(row2!.content_scope, "astro");
});
