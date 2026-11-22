// One article, two column entries. A both-PASS judgement keeps the astronomy row and additionally
// gives the AI4S column a display right for that SAME article. The right comes from this revision's
// own AI4S dimension — never from ai4a, never from moving content_scope — and the two columns select
// independently: the AI4S column lists the article while the astronomy column keeps its selection.
// The card each column serves is that column's own projection (its selection, its score), and the
// right only stands while the judgement behind it reads the article's current revision.
// The reverse combination (selected in AI4S, unselected in astronomy) is exercised through a fixture:
// `ai4sSelection` is a reserved output key that no production path writes yet.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadAi4sFeed } from "@aihot/backend/publication/ai4s";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SRC = `dual-col-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${SRC}, '综合科学源（双栏测试）', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

let n = 0;
/**
 * A stored judgement of one article revision. Everything here except `ai4sSelection` is the shape
 * `normalizeAnalysis` actually writes (`sharedPrefilter`, `domain`, `ai4a`). `ai4sSelection` is a
 * RESERVED key with no production writer today — a both-PASS row gets an AI4S structure call, never
 * an AI4S score — so only a fixture can reproduce "the AI4S column selected this row". Tests that
 * pass it are proving the field and the predicate are in place, not that the pipeline produces it.
 */
async function addAnalysis(articleId: string, revision: number, opts: {
  shared?: { astronomy: "PASS" | "BLOCK" | "UNKNOWN"; ai4s: "PASS" | "BLOCK" | "UNKNOWN" } | null;
  ai4a?: boolean | null;
  ai4sSelection?: boolean;
  selected?: boolean;
  score?: number;
  summary?: string | null;
}) {
  n += 1;
  const output: Record<string, unknown> = {
    ...(opts.shared ? { sharedPrefilter: { ...opts.shared, reason: "测试", version: "shared-prefilter@test" } } : {}),
    ...(opts.ai4sSelection !== undefined ? { ai4sSelection: opts.ai4sSelection } : {}),
    domain: "astronomy-astrophysics",
    ai4a: opts.ai4a ?? null,
  };
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags, output)
    VALUES (${articleId}, ${revision}, 'rule', 'pass', 'stars-transients', ${`标题${n}-${T}`}, ${opts.summary === undefined ? `摘要${n}-${T}` : opts.summary}, ${`理由${n}`}, ${opts.score ?? 80},
      ${opts.selected ?? true}, ${[`dual-${T}`]}, ${sql.json(output as never)})`;
}

/**
 * An astronomy-row article whose judgement carries a shared-prefilter result.
 * `shared` null models a judgement from before the shared prefilter existed.
 */
async function judged(opts: Parameters<typeof addAnalysis>[2]) {
  n += 1;
  const marker = `DUAL${n}-${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url: `https://example.com/${marker}`, title: `${marker} 天文与 AI 交叉研究`,
    bodyText: `${marker} 正文：研究团队用模型处理巡天数据并给出定量结果。`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 120_000),
  } as never);
  await addAnalysis(articleId, 1, opts);
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

/** An AI4S-row article: no astronomy home, so its own selection and score are the column's own. */
async function nativeAi4s(opts: { score?: number; selected?: boolean } = {}) {
  n += 1;
  const marker = `NATIVE${n}-${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url: `https://example.com/${marker}`, title: `${marker} 用模型预测材料性质`,
    bodyText: `${marker} 正文：模型给出可复核的定量预测。`, bodyStatus: "ok", via: "fetch",
    publishedAt: new Date(Date.now() - 120_000), contentScope: "ai4s",
  } as never);
  await addAnalysis(articleId, 1, { selected: opts.selected ?? true, score: opts.score ?? 86 });
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

/** The body moves on (a source re-publish or a maintenance correction): rev N+1, no judgement of it. */
async function revise(articleId: string) {
  await sql`UPDATE articles SET revision = revision + 1, content_hash = ${`rev2-${articleId}`},
    body_text = coalesce(body_text, '') || ' 补充了一段新结果。' WHERE id = ${articleId}`;
  return articleId;
}

const row = async (id: string) =>
  (await sql<{
    content_scope: string; selected: boolean; eligible: boolean; visibility: string;
    ai4s_cross_listed: boolean; ai4s_selected: boolean; ai4a: boolean | null;
  }[]>`SELECT content_scope, selected, eligible, visibility, ai4s_cross_listed, ai4s_selected, ai4a
      FROM publications WHERE article_id = ${id}`)[0]!;
const ai4sIds = async (tab: "all" | "selected") =>
  (await loadAi4sFeed({ tab, domain: null, page: 1, now: new Date() })).items.map((i) => i.id);
const ai4sCard = async (id: string, tab: "all" | "selected" = "all") =>
  (await loadAi4sFeed({ tab, domain: null, page: 1, now: new Date() })).items.find((i) => i.id === id) ?? null;
const listedCard = async (id: string) =>
  (await loadPool({ channel: "all", category: null, tag: null, page: 1, now: new Date() })).items.find((i) => i.id === id) ?? null;
const astroIds = async () =>
  (await loadTimeline({ channel: "all", category: null, tag: null, limit: 40, now: new Date() })).cards.map((c) => c.item.id);

test("A03/D1 both dimensions pass: the article keeps its astronomy row and gains an AI4S display right", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, ai4a: true });
  const r = await row(id);
  assert.equal(r.content_scope, "astro", "the primary column is not moved");
  assert.equal(r.selected, true, "the astronomy column keeps its own selection");
  assert.equal(r.ai4s_cross_listed, true, "the AI4S dimension of this revision grants the display right");
  assert.equal(r.ai4s_selected, false, "the AI4S column has no scored judgement for this row, so it does not select it");
});

test("D2 listing and selection are independent: the AI4S column lists it, its selected tab does not", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" } });
  assert.ok((await ai4sIds("all")).includes(id), "the AI4S column lists the cross-listed article");
  assert.ok(!(await ai4sIds("selected")).includes(id), "the AI4S selected tab keeps only its own selections");
  assert.ok((await astroIds()).includes(id), "the astronomy timeline is unaffected by the second column");
});

test("D3 an AI4S-scored selection in the same judgement selects it in the AI4S column only", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, ai4sSelection: true });
  const r = await row(id);
  assert.equal(r.ai4s_selected, true, "the column's own selection state is stored separately");
  assert.ok((await ai4sIds("selected")).includes(id), "a selected cross-listed row reaches the AI4S selected tab");
  assert.equal(r.selected, true, "the astronomy selection is not disturbed by the AI4S one");
});

test("D4 the right comes from the AI4S dimension, not from ai4a", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "BLOCK" }, ai4a: true });
  const r = await row(id);
  assert.equal(r.ai4a, true);
  assert.equal(r.ai4s_cross_listed, false, "a verified AI4A finding is evidence, not a column right");
  assert.ok(!(await ai4sIds("all")).includes(id));
});

test("D5 a judgement that predates the shared prefilter grants nothing, and is not re-analysed", async () => {
  const id = await judged({ shared: null, ai4a: true });
  assert.equal((await row(id)).ai4s_cross_listed, false, "历史分析不因 ai4a 得到双栏资格");
  assert.ok(!(await ai4sIds("all")).includes(id));
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM analyses WHERE article_id = ${id}`;
  assert.equal(count, 1, "publication rebuild does not add a judgement");
});

test("D6 an UNKNOWN AI4S dimension holds instead of listing", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "UNKNOWN" } });
  assert.equal((await row(id)).ai4s_cross_listed, false, "未定的维度不给展示资格");
  assert.ok(!(await ai4sIds("all")).includes(id));
});

test("D7 an ineligible (no summary) both-PASS row gets no AI4S display right", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, summary: null });
  const r = await row(id);
  assert.equal(r.eligible, false);
  assert.equal(r.ai4s_cross_listed, false, "不合格的材料在任何栏目都不展示");
});

test("D8 neither column duplicates the article: one row, one entry per column", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" } });
  const all = await ai4sIds("all");
  assert.equal(all.filter((x) => x === id).length, 1, "the AI4S list carries the article once");
  const astro = await astroIds();
  assert.equal(astro.filter((x) => x === id).length, 1, "the astronomy timeline carries it once");
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM publications WHERE article_id = ${id}`;
  assert.equal(count, 1, "one publication row, two column predicates — not a second identity");
});

// ---------------------------------------------------------------------------------------------
// R1: the card is the AI4S column's. It shows that column's own selection and never borrows the
// astronomy score; the astronomy listings keep their own projection of the same row.
// ---------------------------------------------------------------------------------------------

test("R1 an astronomy-selected cross-listed row is listed here unselected and without a score", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, ai4a: true, selected: true, score: 80 });
  const card = await ai4sCard(id);
  assert.ok(card, "the article is listed in the AI4S column");
  assert.equal(card.crossListed, true);
  assert.equal(card.selected, false, "the astronomy selection is not inherited");
  assert.equal(card.score, null, "no AI4S score exists, so none is invented");
  assert.equal(card.reason, null, "the selection note belongs to the column that selected it");
  const listing = await listedCard(id);
  assert.ok(listing, "the astronomy listing still carries the article");
  assert.equal(listing.selected, true, "the astronomy column keeps its own selection");
  assert.equal(listing.score, 80);
  assert.ok(!(await ai4sIds("selected")).includes(id), "and it stays out of the AI4S selected tab");
});

test("R1 the API answer carries the same column projection, not only the SQL filter", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, selected: true, score: 73 });
  const res = await app.inject({ method: "GET", url: "/api/site/ai4s?tab=all" });
  assert.equal(res.statusCode, 200);
  const item = (JSON.parse(res.body) as { items: Array<{ id: string; selected: boolean; score: number | null; crossListed: boolean }> })
    .items.find((i) => i.id === id);
  assert.ok(item, "the DTO reaches the public API");
  assert.equal(item.selected, false);
  assert.equal(item.score, null);
  assert.equal(item.crossListed, true);
});

test("R1 the reverse combination is projected from a fixture: selected here, unselected in astronomy", async () => {
  // `ai4sSelection` is reserved — no production path writes it — so this case proves the read layer
  // and the predicate, not that the pipeline can reach it today.
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, selected: false, ai4sSelection: true });
  const card = await ai4sCard(id);
  assert.equal(card?.selected, true, "the column's own selection is shown");
  assert.equal(card?.score, null, "and still no borrowed score");
  assert.ok((await ai4sIds("selected")).includes(id), "the AI4S selected tab carries it");
  const listing = await listedCard(id);
  assert.equal(listing?.selected, false, "the astronomy listing keeps its own state");
  assert.equal((await row(id)).selected, false);
});

test("R1 neither column selected: listed in both, marked in neither", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, selected: false, ai4sSelection: false });
  assert.equal((await ai4sCard(id))?.selected, false);
  assert.equal((await listedCard(id))?.selected, false);
});

test("R1 a native AI4S row keeps its own selection and score", async () => {
  const id = await nativeAi4s({ score: 91, selected: true });
  const card = await ai4sCard(id);
  assert.equal(card?.crossListed, false, "its home is this column");
  assert.equal(card?.selected, true);
  assert.equal(card?.score, 91, "its own AI4S score, unchanged");
  assert.equal(await listedCard(id), null, "a native AI4S row is not in the astronomy pool at all");
});

// ---------------------------------------------------------------------------------------------
// R2: the dual-column right belongs to the judgement of the CURRENT revision. A body that moved on
// has no AI4S verdict yet, and a late result for the old body may not stand in for one.
// ---------------------------------------------------------------------------------------------

test("R2 a new revision with no judgement of its own loses the right on republish", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" }, ai4sSelection: true });
  assert.equal((await row(id)).ai4s_cross_listed, true, "the judged revision earns the right");
  await revise(id);
  await publishArticle(id);
  const r = await row(id);
  assert.equal(r.ai4s_cross_listed, false, "a judgement of rev1 may not speak for rev2");
  assert.equal(r.ai4s_selected, false);
  assert.ok(!(await ai4sIds("all")).includes(id), "the AI4S column stops listing it until rev2 is judged");
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM analyses WHERE article_id = ${id}`;
  assert.equal(count, 1, "the rebuild adds no judgement and calls no model");
});

test("R2 a late judgement of the old revision never grants the new one", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "BLOCK" } });
  await revise(id);
  // The response of a rev1 request lands after the body moved on.
  await addAnalysis(id, 1, { shared: { astronomy: "PASS", ai4s: "PASS" } });
  await publishArticle(id);
  const r = await row(id);
  assert.equal(r.ai4s_cross_listed, false, "a late rev1 result is not this revision's AI4S verdict");
  assert.ok(!(await ai4sIds("all")).includes(id));
});

test("R2 the new revision's own judgement re-establishes the right, and republish is stable", async () => {
  const id = await judged({ shared: { astronomy: "PASS", ai4s: "PASS" } });
  await revise(id);
  await publishArticle(id);
  assert.equal((await row(id)).ai4s_cross_listed, false);
  await addAnalysis(id, 2, { shared: { astronomy: "PASS", ai4s: "PASS" }, ai4sSelection: true });
  await publishArticle(id);
  const r = await row(id);
  assert.equal(r.ai4s_cross_listed, true, "the current revision's own dimension grants it again");
  assert.equal(r.ai4s_selected, true, "and its own selection state comes with it");
  await publishArticle(id);
  assert.equal((await row(id)).ai4s_cross_listed, true, "a further rebuild from the same judgement is stable");
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM analyses WHERE article_id = ${id}`;
  assert.equal(count, 2, "two revisions, two judgements — no extra paid analysis");
});
