// R5 rollback drill on a local _test database: a scoped, reversible AI4S visibility/ledger/seat revert
// that keeps the additive scope columns and all content/metadata. Withdrawing the ai4s publications
// through the existing override+publish path hides them from every astronomy exit, removes their ledger
// entries and releases their seats (a co-fact astronomy report keeps its seat); restoring the original
// overrides converges back. No column is dropped and no article/analysis is deleted. Fake identities,
// no model, no network, no production source. This is the drill DEPLOYMENT-PLAN §2 requires before any
// authorized rollback — stopping the source alone would not hide these already-published rows.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const ASTRO = `rb-astro-${T}`; // T2 media: holds the shared fact seat the whole time
const AI4S = `rb-ai4s-${T}`; // T1 first-party
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${ASTRO}, '天文媒体', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${AI4S}, 'AI4S 官方', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

let n = 0;
async function report(source: string, factId: number | null, scope: "astro" | "ai4s", score: number, output: Record<string, unknown>, overrideFields: Record<string, unknown> | null, analysisSelected = true) {
  n += 1;
  const marker = `RB${n}-${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/${marker}`, title: `${marker} 标题`, bodyText: `${marker} 正文事实陈述。`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), contentScope: scope,
  } as never);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, ${`理由${n}`}, ${score}, ${analysisSelected}, ${[`rb-${T}`]}, ${sql.json(output as never)})`;
  if (factId !== null) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${articleId}, 'report')`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  if (overrideFields) await sql`INSERT INTO editorial_overrides (article_id, fields, reason) VALUES (${articleId}, ${sql.json(overrideFields as never)}, '回滚演练初始精选')`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}
const pub = async (id: string) => (await sql<{ visibility: string; seat: boolean; selected: boolean; content_scope: string; astro_cross_listed: boolean; eligible: boolean; domain: string | null; ai4a: boolean | null }[]>
  `SELECT visibility, seat, selected, content_scope, astro_cross_listed, eligible, domain, ai4a FROM publications WHERE article_id = ${id}`)[0]!;
const get = async (url: string) => { const res = await app.inject({ method: "GET", url }); return { status: res.statusCode, body: res.body, json: /json/.test(String(res.headers["content-type"] ?? "")) ? JSON.parse(res.body) : null }; };
const snap = () => get("/api/v1/selected/snapshot?fields=minimal&limit=1000");

test("a scoped AI4S rollback hides every astronomy exit, keeps columns/content/metadata, and restores", async () => {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`RB-S-${T}`}, now(), now()) RETURNING id`;
  const [fact1] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`rb-fact1-${T}`}, ${story!.id}, '共享事实') RETURNING id`;
  const [fact2] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`rb-fact2-${T}`}, ${story!.id}, '跨荐事实') RETURNING id`;
  const astro = await report(ASTRO, fact1!.id, "astro", 80, { scope: "single" }, { selected: true });
  const ai4sSel = await report(AI4S, fact1!.id, "ai4s", 95, { scope: "single", domain: "physics", ai4a: false }, { selected: true });
  const ai4sCross = await report(AI4S, fact2!.id, "ai4s", 90, { scope: "single", domain: "astronomy-astrophysics", ai4a: true }, { selected: true, crossListed: true });
  const ai4sPlain = await report(AI4S, null, "ai4s", 70, { scope: "single", domain: "physics", ai4a: false }, null, false);
  const ai4sIds = [ai4sSel, ai4sCross, ai4sPlain];

  // Pre-rollback boundary: the cross-listed item is in the machine snapshot; the merely-selected one is not.
  assert.equal((await pub(astro)).seat, true);
  assert.deepEqual([(await pub(ai4sSel)).selected, (await pub(ai4sSel)).seat], [true, false]);
  assert.deepEqual([(await pub(ai4sCross)).astro_cross_listed, (await pub(ai4sCross)).seat], [true, true]);
  assert.deepEqual([(await pub(ai4sCross)).domain, (await pub(ai4sCross)).ai4a], ["astronomy-astrophysics", true]);
  const before = (await snap()).json.cursor as string;
  const snapBefore = (await snap()).body;
  assert.ok(snapBefore.includes(ai4sCross) && !snapBefore.includes(ai4sSel), "only the cross-listed item is seated before rollback");

  const originalOverrides = await sql<{ article_id: string; fields: Record<string, unknown>; visibility: string | null; reason: string | null }[]>
    `SELECT article_id, fields, visibility, reason FROM editorial_overrides WHERE article_id = ANY(${ai4sIds}::text[])`;
  const analysesBefore = (await sql<{ n: number }[]>`SELECT count(*)::int n FROM analyses WHERE article_id = ANY(${ai4sIds}::text[])`)[0]!.n;

  // PHASE 1 — scoped withdraw through the existing override+publish path: no schema change, no content delete.
  for (const id of ai4sIds) {
    await sql`INSERT INTO editorial_overrides (article_id, fields, visibility, reason)
      VALUES (${id}, ${sql.json({ selected: false, crossListed: false } as never)}, 'withdrawn', 'R5 回滚演练：撤回 AI4S 可见性')
      ON CONFLICT (article_id) DO UPDATE SET fields = EXCLUDED.fields, visibility = EXCLUDED.visibility, reason = EXCLUDED.reason`;
    await publishArticle(id);
  }

  for (const id of ai4sIds) {
    const p = await pub(id);
    assert.deepEqual([p.visibility, p.selected, p.astro_cross_listed], ["withdrawn", false, false], "every ai4s row is withdrawn, unselected and un-cross-listed");
  }
  // The fact-bearing ai4s rows release their astronomy seats; the factless plain item keeps its own
  // (harmless) seat, but withdrawn visibility still excludes it from every exit.
  assert.equal((await pub(ai4sSel)).seat, false, "the merely-selected ai4s report holds no astronomy seat");
  assert.equal((await pub(ai4sCross)).seat, false, "the cross-listed ai4s report releases its fact seat on withdraw");
  const snapAfter = (await snap()).body;
  assert.ok(!snapAfter.includes(ai4sCross) && !snapAfter.includes(ai4sSel) && !snapAfter.includes(ai4sPlain), "the machine snapshot excludes all ai4s after rollback");
  const pool = (await get(`/api/site/pool?q=${T}`)).json.items as Array<{ id: string }>;
  assert.ok(pool.map((i) => i.id).includes(astro) && !pool.map((i) => i.id).includes(ai4sCross), "the astronomy pool drops the cross-listed item but keeps the astronomy report");
  assert.equal((await pub(astro)).seat, true, "the co-fact astronomy report keeps its seat through the rollback");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM publications WHERE fact_id = ${fact2!.id} AND seat`)[0]!.n, 0, "the released ai4s fact seat has no holder");
  assert.equal((await sql<{ in_set: boolean }[]>`SELECT in_set FROM selected_state WHERE article_id = ${ai4sCross}`)[0]?.in_set ?? false, false, "the shared fact seat state is cleared");
  const changes = (await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(before)}&limit=100`)).json.changes as Array<{ op: string; id?: string; item?: { id: string } }>;
  const net = new Map<string, string>();
  for (const c of changes) net.set(c.id ?? c.item!.id, c.op);
  assert.equal(net.get(ai4sCross), "remove", "the sync ledger announces the rollback as a removal");

  // Nothing destructive: content, analyses and the additive columns/metadata all survive.
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM articles WHERE id = ANY(${ai4sIds}::text[])`)[0]!.n, 3, "no article was deleted");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM analyses WHERE article_id = ANY(${ai4sIds}::text[])`)[0]!.n, analysesBefore, "no analysis was deleted");
  const cols = (await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'publications' AND column_name = ANY(${["content_scope", "domain", "ai4a", "astro_cross_listed"]}::text[])`).map((r) => r.column_name);
  assert.deepEqual(cols.sort(), ["ai4a", "astro_cross_listed", "content_scope", "domain"], "the additive scope columns are kept, not dropped");
  assert.deepEqual([(await pub(ai4sCross)).domain, (await pub(ai4sCross)).ai4a], ["astronomy-astrophysics", true], "domain/AI4A metadata survives the withdraw");

  // RESTORE — put back the original overrides (the plain item had none) and republish; the boundary converges.
  await sql`DELETE FROM editorial_overrides WHERE article_id = ANY(${ai4sIds}::text[])`;
  for (const o of originalOverrides) await sql`INSERT INTO editorial_overrides (article_id, fields, visibility, reason) VALUES (${o.article_id}, ${sql.json(o.fields as never)}, ${o.visibility}, ${o.reason})`;
  for (const id of ai4sIds) await publishArticle(id);

  assert.deepEqual([(await pub(ai4sSel)).selected, (await pub(ai4sSel)).seat], [true, false], "manual selection restored without stealing the astronomy seat");
  assert.deepEqual([(await pub(ai4sCross)).astro_cross_listed, (await pub(ai4sCross)).seat], [true, true], "the cross-list and its fact seat are restored");
  assert.equal((await pub(ai4sPlain)).visibility, "public", "the plain item is public again in its own column");
  assert.equal((await pub(ai4sPlain)).selected, false, "auto-selection stays off for the plain item");
  assert.equal((await pub(astro)).seat, true, "the astronomy seat is intact after restore");
  const snapRestored = (await snap()).body;
  assert.ok(snapRestored.includes(ai4sCross) && !snapRestored.includes(ai4sSel), "the snapshot converges back to the pre-rollback boundary");
});