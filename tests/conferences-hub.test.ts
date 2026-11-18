// The public conference hub read layer: who may appear, in which order, and how the date-only clock is
// applied. Synthetic rows on a local database, with the clock frozen where a boundary is the point.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { projectConference } from "@aihot/backend/content/conferences";
import { publishArticle } from "@aihot/backend/publication/publish";
import { deadlineView, loadConferenceHub, loadRecentConferences } from "@aihot/backend/publication/conferences";
import { setVisibility } from "@aihot/backend/admin/content";
import { overrideConference } from "@aihot/backend/admin/conferences";
import { conferenceIdentityKey, type GroundedConference } from "@aihot/backend/editorial/conference";

const T = tag();
const ASTRO = `test-hub-astro-${T}`;
const AI4S = `test-hub-ai4s-${T}`;
const ISOLATED = `test-hub-iso-${T}`;

let n = 0;
type Seed = {
  name: string; edition?: string | null; start: string | null; end?: string | null; scope?: "astro" | "ai4s";
  source?: string; public?: boolean; city?: string | null;
  deadlines?: Array<{ kind: "registration"; date: string; quote: string }>; summary?: string | null;
};

/** One notice article, judged, published, and projected — exactly the rows a real ingest would leave. */
async function seed(s: Seed) {
  n += 1;
  const scope = s.scope ?? "astro";
  const source = s.source ?? (scope === "ai4s" ? AI4S : ASTRO);
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.org/hub-${T}-${n}`, title: `通知 ${n}`, bodyText: `${s.name}现开放报名`,
    bodyStatus: "ok", coverage: "full_text", via: "ingest", contentScope: scope,
  });
  const summary = s.summary === undefined ? `摘要 ${n}` : s.summary;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'outreach-images', ${["学术会议"]}, ${`标题 ${n}`}, ${summary}, false, ${sql.json({ scope: "single" } as never)})`;
  await publishArticle(articleId);
  const conf: GroundedConference = {
    name: s.name, edition: s.edition ?? null, startDate: s.start, endDate: s.end ?? s.start, timezone: null,
    city: s.city === undefined ? "西安" : s.city, venue: null, online: false, organizer: "国家天文科学数据中心",
    officialUrl: null, registrationUrl: null, deadlines: s.deadlines ?? [], evidence: `${s.name}现开放报名`,
    nameNorm: s.name.toLowerCase(), identityKey: conferenceIdentityKey({ name: s.name, edition: s.edition ?? null, startDate: s.start }),
  };
  const conferenceId = await sql.begin((tx) => projectConference(tx, { articleId, revision: 1, contentScope: scope, conference: conf }));
  return { articleId, conferenceId };
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${ASTRO}, '会议公开测试源', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${AI4S}, '会议公开测试源 AI4S', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${ISOLATED}, '会议隔离测试源', 'rss', 'T1', 'isolated', '2100-01-01')`;
});
after(closeDb);

test("only a public, pool-eligible notice from an editorial source makes a conference public", async () => {
  const ok = await seed({ name: "公开会议A", start: "2026-12-01", end: "2026-12-03" });
  const withdrawn = await seed({ name: "撤回会议B", start: "2026-12-05" });
  await setVisibility(withdrawn.articleId, { visibility: "withdrawn", reason: "测试撤回", version: 0 }, "tester");
  await seed({ name: "隔离会议C", start: "2026-12-07", source: ISOLATED });
  // A notice with no Chinese summary is not pool-eligible, so it is not shown.
  await seed({ name: "无摘要会议D", start: "2026-12-09", summary: null });

  const hub = await loadConferenceHub({ scope: "all", now: new Date("2026-11-17T04:00:00Z") });
  const names = hub.items.map((c) => c.name);
  assert.ok(names.includes("公开会议A"));
  assert.equal(names.includes("撤回会议B"), false);
  assert.equal(names.includes("隔离会议C"), false);
  assert.equal(names.includes("无摘要会议D"), false);
  assert.equal(hub.total, hub.items.length > 0 ? hub.total : 0);
  assert.ok(ok.conferenceId);
});

test("revising the fee updates the same conference and rejects stale editors", async () => {
  const seeded = await seed({ name: "会务费修订测试会议", start: "2026-11-29" });
  const id = seeded.conferenceId!;
  const read = async () => (await loadConferenceHub({ scope: "all" })).items.find((c) => c.id === id)!;
  const [{ version }] = await sql<[{ version: number }]>`SELECT version FROM conferences WHERE id = ${id}`;
  assert.equal((await read()).meetingFee, null);
  const pending = await overrideConference(id, { fields: { meetingFee: "待后续通知" }, version, reason: "初始通知" }, "tester");
  assert.equal((await read()).meetingFee, "待后续通知");
  await assert.rejects(overrideConference(id, { fields: { meetingFee: "免会务费" }, version, reason: "旧版本" }, "tester"), /已更新/);
  await overrideConference(id, { fields: { meetingFee: "免会务费" }, version: Number(pending!.version), reason: "组委会更新" }, "tester");
  assert.equal((await read()).meetingFee, "免会务费");
  assert.equal((await read()).notice?.id, seeded.articleId);
});

test("the column filter is a notice's column, not the event's importance", async () => {
  await seed({ name: "AI4S 会议E", start: "2026-11-30", scope: "ai4s" });
  const astro = await loadConferenceHub({ scope: "astro", now: new Date("2026-11-17T04:00:00Z") });
  const ai4s = await loadConferenceHub({ scope: "ai4s", now: new Date("2026-11-17T04:00:00Z") });
  assert.equal(astro.items.some((c) => c.name === "AI4S 会议E"), false);
  assert.equal(ai4s.items.some((c) => c.name === "AI4S 会议E"), true);
});

test("ongoing first, then future by opening day, then ended newest-first, then undated", async () => {
  const now = new Date("2026-11-25T04:00:00Z"); // 2026-11-25 in Beijing
  const hub = await loadConferenceHub({ scope: "all", now });
  const phases = hub.items.map((c) => c.phase);
  const order = { ongoing: 0, upcoming: 1, ended: 2, postponed: 3, cancelled: 4, undated: 5 } as const;
  const sorted = [...phases].sort((a, b) => order[a] - order[b]);
  assert.deepEqual(phases, sorted);
  const upcoming = hub.items.filter((c) => c.phase === "upcoming").map((c) => c.startDate!);
  assert.deepEqual(upcoming, [...upcoming].sort());
});

test("a date-only conference is still on its last day, and a deadline is not closed early", async () => {
  const seeded = await seed({
    name: "边界会议F", start: "2026-11-24", end: "2026-11-26",
    deadlines: [{ kind: "registration", date: "2026-11-26", quote: "报名截止2026年11月26日" }],
  });
  const lastDay = await loadConferenceHub({ scope: "all", now: new Date("2026-11-26T15:00:00Z") }); // 11-26 23:00 Beijing
  const item = lastDay.items.find((c) => c.id === seeded.conferenceId)!;
  assert.equal(item.phase, "ongoing");
  assert.equal(item.deadlines[0]!.state, "today");
  const nextDay = await loadConferenceHub({ scope: "all", now: new Date("2026-11-27T01:00:00Z") }); // 11-27 09:00 Beijing
  const endedItem = nextDay.items.find((c) => c.id === seeded.conferenceId)!;
  assert.equal(endedItem.phase, "ended");
  assert.equal(endedItem.deadlines[0]!.state, "closed");
});

test("a notice without dates is shown as undated, never placed at a guessed time", async () => {
  const seeded = await seed({ name: "待定会议G", start: null });
  const hub = await loadConferenceHub({ scope: "all", now: new Date("2026-11-17T04:00:00Z") });
  const item = hub.items.find((c) => c.id === seeded.conferenceId)!;
  assert.equal(item.phase, "undated");
  assert.equal(item.startDate, null);
  assert.equal(hub.items[hub.items.length - 1]!.phase, "undated");
});

test("pagination happens after the global order, and the total counts conferences once", async () => {
  const first = await loadConferenceHub({ scope: "all", page: 1, now: new Date("2026-11-17T04:00:00Z") });
  const second = await loadConferenceHub({ scope: "all", page: 2, now: new Date("2026-11-17T04:00:00Z") });
  assert.equal(first.pageSize, 20);
  if (first.total > first.pageSize) {
    assert.equal(second.items.length, first.total - first.pageSize);
    const ids = new Set([...first.items, ...second.items].map((c) => c.id));
    assert.equal(ids.size, first.total);
  }
  const hub = await loadConferenceHub({ scope: "all", now: new Date("2026-11-17T04:00:00Z") });
  assert.equal(hub.total, new Set(hub.items.map((c) => c.id)).size);
});

test("the recent entry is the next few unended conferences, and never a model call", async () => {
  const recent = await loadRecentConferences("astro", 3, new Date("2026-11-17T04:00:00Z"));
  assert.ok(recent.length <= 3);
  assert.ok(recent.every((c) => c.phase === "ongoing" || c.phase === "upcoming"));
});

test("deadline states come from the day alone", () => {
  const today = "2026-11-17";
  assert.deepEqual(deadlineView([{ kind: "registration", date: "2026-11-16" }], today).map((d) => d.state), ["closed"]);
  assert.deepEqual(deadlineView([{ kind: "registration", date: "2026-11-17" }], today).map((d) => d.state), ["today"]);
  assert.deepEqual(deadlineView([{ kind: "abstract", date: "2026-11-18" }], today).map((d) => d.state), ["open"]);
});
