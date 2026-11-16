// R1 isolation regression: a manually selected, non-backfill AI4S report is visible in its own column
// but never reaches the astronomy default consumers — period reports/entries, story heat evidence, the
// shared fact seat, or the machine selected snapshot/ledger. An astronomy report of the same fact keeps
// its seat even when the AI4S report would otherwise win it. Cross-listing is the only audited door in,
// and revoking it converges the snapshot and changes back to removal. Fake identities on a local _test
// database; no model, no network, no production source.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadAi4sFeed } from "@aihot/backend/publication/ai4s";
import { periodReports, periodEntries } from "@aihot/backend/reports/edition";
import { unavailableIds } from "@aihot/backend/publication/reports";
import { currentSignals } from "@aihot/backend/events/hot";
import { overrideFields } from "@aihot/backend/admin/content";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const ASTRO = `iso-astro-${T}`; // T2 media: would lose the seat to a first-party AI4S report without the guard
const AI4S = `iso-ai4s-${T}`; // T1 first-party
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${ASTRO}, '天文媒体', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${AI4S}, 'AI4S 官方', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

let n = 0;
async function report(source: string, factId: number | null, scope: "astro" | "ai4s", score: number) {
  n += 1;
  const marker = `ISO${n}-${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/${marker}`, title: `${marker} 标题`, bodyText: `${marker} 正文事实陈述。`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), contentScope: scope,
  } as never);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, ${`理由${n}`}, ${score}, true, ${[`iso-${T}`]})`;
  if (factId !== null) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${articleId}, 'report')`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason) VALUES (${articleId}, ${sql.json({ selected: true } as never)}, '隔离测试人工精选')`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}
const pub = async (id: string) => (await sql<{ seat: boolean; selected: boolean; content_scope: string; astro_cross_listed: boolean; eligible: boolean }[]>
  `SELECT seat, selected, content_scope, astro_cross_listed, eligible FROM publications WHERE article_id = ${id}`)[0]!;
const get = async (url: string) => { const res = await app.inject({ method: "GET", url }); return { status: res.statusCode, body: res.body, json: /json/.test(String(res.headers["content-type"] ?? "")) ? JSON.parse(res.body) : null }; };
const signal = (storyId: number, articleId: string, sourceId: string) =>
  sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at) VALUES (${storyId}, ${articleId}, ${`source:${sourceId}`}, ${sourceId}, 'editorial', now())`;
/** Cross-listing goes through the admin path the operator actually uses (B2), never a hand-written row. */
const setCrossList = async (id: string, crossListed: boolean) => {
  const version = (await sql<{ version: number }[]>`SELECT version FROM editorial_overrides WHERE article_id = ${id}`)[0]!.version;
  await overrideFields(id, crossListed
    ? { fields: { crossListed: true, astroApproved: true, astroApprovalNote: "隔离测试人工天文认定" }, reason: "隔离测试交叉推荐", version }
    : { fields: { crossListed: false }, reason: "隔离测试撤销交叉推荐", version }, "tester");
};

test("a selected non-backfill AI4S report is excluded from astronomy reports, heat, seat and machine snapshot", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`ISO-S-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`iso-fact-${T}`}, ${story!.id}, '共享事实') RETURNING id`;
  const astro = await report(ASTRO, fact!.id, "astro", 80);
  const ai4s = await report(AI4S, fact!.id, "ai4s", 95); // first-party + higher score: would take the seat without the guard

  assert.deepEqual([ (await pub(astro)).content_scope, (await pub(ai4s)).content_scope ], ["astro", "ai4s"]);
  assert.equal((await pub(ai4s)).selected, true, "the AI4S report is manually selected in its own column");
  assert.equal((await sql`SELECT backfill FROM articles WHERE id = ${ai4s}`)[0]!.backfill, false, "a normal new report, not a backfill");
  assert.equal((await pub(astro)).seat, true, "the astronomy report keeps the fact's machine seat");
  assert.equal((await pub(ai4s)).seat, false, "the AI4S report never holds an astronomy seat");

  const ai4sSelected = (await loadAi4sFeed({ tab: "selected" })).items.map((i) => i.id);
  assert.ok(ai4sSelected.includes(ai4s), "visible in the AI4S selected tab");

  const now = new Date();
  const period = await periodReports(new Date(now.getTime() - 3600_000), new Date(now.getTime() + 3600_000));
  const periodIds = period.map((r) => r.id);
  assert.ok(periodIds.includes(astro), "astronomy report is a daily candidate");
  assert.ok(!periodIds.includes(ai4s), "R1: the AI4S report is not a daily/period candidate");

  const day = now.toISOString().slice(0, 10);
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${day}, ${now}, ${now}, ${sql.json({ leadItemId: astro, highlights: [], sections: [{ items: [{ itemId: astro, sources: 1 }, { itemId: ai4s, sources: 1 }] }] } as never)}, ${now}, 'manual')`;
  const entries = (await periodEntries(day, day)).entries.map((e) => e.itemId);
  assert.ok(entries.includes(astro) && !entries.includes(ai4s), "R1: periodEntries回查 excludes the AI4S item even when a daily cited it");

  await signal(story!.id, astro, ASTRO);
  await signal(story!.id, ai4s, AI4S);
  const heatIds = (await sql<{ article_id: string }[]>`SELECT article_id FROM ${currentSignals()} cs`).map((r) => r.article_id);
  assert.ok(heatIds.includes(astro) && !heatIds.includes(ai4s), "R1: AI4S evidence does not count toward astronomy story heat");

  const snap = (await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body;
  assert.ok(snap.includes(astro) && !snap.includes(ai4s), "R1: the machine selected snapshot excludes the AI4S report");
  assert.ok(!(await get("/feed.xml")).body.includes(ai4s), "the default RSS excludes it");
  const v1selected = (await get(`/api/v1/items?mode=selected&window=24h&limit=100&q=${T}`)).json.items as Array<{ id: string }>;
  assert.ok(!v1selected.map((i) => i.id).includes(ai4s), "v1 selected excludes it");
  const pool = (await get(`/api/site/pool?q=${T}`)).json.items as Array<{ id: string }>;
  assert.ok(pool.map((i) => i.id).includes(astro) && !pool.map((i) => i.id).includes(ai4s), "the astronomy pool excludes it");
});

test("cross-listing is the only door into astronomy machines, and revoking converges snapshot and changes", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`ISO-S2-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`iso-fact2-${T}`}, ${story!.id}, '独立事实') RETURNING id`;
  const item = await report(AI4S, fact!.id, "ai4s", 90);
  await signal(story!.id, item, AI4S);

  const before = (await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).json as { cursor: string };
  assert.equal((await pub(item)).seat, false);
  assert.ok(!(await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body.includes(item), "not in the snapshot before cross-listing");
  assert.ok(!(await sql<{ article_id: string }[]>`SELECT article_id FROM ${currentSignals()} cs`).map((r) => r.article_id).includes(item), "not heat evidence before cross-listing");

  await setCrossList(item, true);
  await publishArticle(item);
  assert.equal((await pub(item)).astro_cross_listed, true);
  assert.equal((await pub(item)).seat, true, "an authorized cross-listed AI4S report holds its own fact's seat");
  assert.ok((await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body.includes(item), "now in the machine snapshot");
  assert.ok((await sql<{ article_id: string }[]>`SELECT article_id FROM ${currentSignals()} cs`).map((r) => r.article_id).includes(item), "now counts as heat evidence");
  const upserts = (await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(before.cursor)}&limit=100`)).json.changes as Array<{ op: string; id?: string; item?: { id: string } }>;
  assert.equal(upserts.find((c) => (c.id ?? c.item!.id) === item)?.op, "upsert", "changes announce the cross-listed entry");

  await setCrossList(item, false);
  await publishArticle(item);
  assert.equal((await pub(item)).astro_cross_listed, false);
  assert.equal((await pub(item)).seat, false);
  assert.ok(!(await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body.includes(item), "snapshot converges back to exclusion");
  assert.ok(!(await sql<{ article_id: string }[]>`SELECT article_id FROM ${currentSignals()} cs`).map((r) => r.article_id).includes(item), "heat evidence converges too");
  const after = (await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(before.cursor)}&limit=100`)).json.changes as Array<{ op: string; id?: string; item?: { id: string } }>;
  const net = new Map<string, string>();
  for (const c of after) net.set(c.id ?? c.item!.id, c.op);
  assert.equal(net.get(item), "remove", "R1: revoking cross-list converges changes to a removal");
  assert.ok((await loadAi4sFeed({ tab: "selected" })).items.map((i) => i.id).includes(item), "it remains selected in its own column throughout");
});

test("revoking a cross-list stops an astronomy issue from publicly citing the AI4S item", async () => {
  const item = await report(AI4S, null, "ai4s", 88);
  await setCrossList(item, true);
  await publishArticle(item);
  assert.equal((await pub(item)).astro_cross_listed, true);
  assert.ok(!(await unavailableIds([item])).has(item), "an approved cross-listed item is still a public citation");

  await setCrossList(item, false);
  await publishArticle(item);
  assert.equal((await pub(item)).astro_cross_listed, false);
  assert.equal((await pub(item)).eligible, true, "the row itself stays public in its own column");
  assert.ok((await unavailableIds([item])).has(item), "R1补充: a revoked cross-list is no longer publicly cited by astronomy reports");
});