// A02/A06 — the whole AI4S road on the real seams with a fake source and a fake model:
// official-style RSS (exact Science filter) -> collect -> body extraction against a confirmed 403 ->
// the column's own limited-intro analysis -> publication -> the public read layer -> the public API.
// Nothing here touches production: the feed and the article pages are a local server, the model is a
// local stub, and the database is the task's _test copy. The two short Science summaries must reach a
// reader as honest limited intros even though their original pages refuse us with 403.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle } from "@aihot/backend/jobs/content";
import { loadAi4sFeed } from "@aihot/backend/publication/ai4s";
import { loadPool } from "@aihot/backend/publication/pool";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// A local source: the RSS listing plus article pages that always refuse with 403 (no readable body).
const articleHits: Record<string, number> = {};
let feedXml = "";
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/rss") { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(feedXml); return; }
  articleHits[path] = (articleHits[path] ?? 0) + 1;
  res.writeHead(403, { "content-type": "text/html" });
  res.end("<html><body>Forbidden</body></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

const LATTICE = `${base}/article/${T}/lattice`;
const BLOG = `${base}/article/${T}/blog`;
const RESEARCH = `${base}/article/${T}/research`;
const NOT_BEFORE = "2026-11-15T22:00:00.000Z";
const LATTICE_SUMMARY = "E2ELATTICE: SYNTHETIC: A fictional team discusses a toy research idea with an AI assistant. Technical details are not available.";
const BLOG_SUMMARY = "E2EBLOG: SYNTHETIC: A fictional science community has a new discussion space. Technical details are not available.";
function rssOf(items: Array<{ url: string; title: string; date: string; category: string; summary: string }>): string {
  return `<rss version="2.0"><channel><title>合成 AI4S 端到端列表</title>${items.map((i) =>
    `<item><title>${escape(i.title)}</title><link>${escape(i.url)}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${escape(i.summary)}</description><category>${escape(i.category)}</category></item>`).join("")}</channel></rss>`;
}
feedXml = rssOf([
  { url: LATTICE, title: "SYNTHETIC: A toy research workflow", date: "2026-11-15T22:00:01.000Z", category: "Science", summary: LATTICE_SUMMARY },
  { url: BLOG, title: "SYNTHETIC: A fictional research community bulletin", date: "2026-11-15T22:00:00.000Z", category: "Science", summary: BLOG_SUMMARY },
  { url: RESEARCH, title: "A Research-category item that must never enter", date: "2026-11-16T01:00:00.000Z", category: "Research", summary: "E2ERESEARCH: not Science." },
]);

// The fake model: the column's own steps, never a score on a limited intro.
type Step = "prefilter" | "score" | "understand" | "summarize" | "ai4s-structure" | "structure";
const requests: Array<{ step: Step; marker: string }> = [];
const structureAnswers: Record<string, unknown> = {
  E2ELATTICE: { scope: "single", domain: "physics", astroApplication: { applies: false, evidence: null }, fact: null },
  E2EBLOG: { scope: "single", domain: "research-meta", astroApplication: { applies: false, evidence: null }, fact: null },
};
const stepOf = (system: string, user: string): Step =>
  system.includes("AI4S 栏目（AI 赋能科学）做宽召回") || system.includes("宽召回的天文相关性预筛") ? "prefilter"
  : system.includes("事件注意力评分器") ? "score"
  : system.includes("内容理解编辑") ? "understand"
  : system.includes("AI4S 栏目（AI 赋能科学）的资料结构化助手") ? "ai4s-structure"
  : system.includes("资料结构化助手") ? "structure"
  : user.includes("title_zh") ? "summarize" : (() => { throw new Error("unknown request"); })();
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  const marker = ["E2ELATTICE", "E2EBLOG"].find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: "PASS", reason: "测试" });
  if (step === "score") return answer({ attentionScore: 80 });
  if (step === "understand") return answer({ itemType: "research_result", authorRole: "principal", tags: [], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充。` });
  if (step === "ai4s-structure") return answer(structureAnswers[marker]);
  if (step === "structure") return answer({ category: "stars-transients", tags: [], subjects: [], scope: "single", fact: null });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

const SOURCE = `ai4s-e2e-${T}`;
const app = await buildApp();
after(async () => { await app.close(); await provider.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await stopBoss(); await closeDb(); });

const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const articleRow = (url: string) => sql<{ id: string; content_scope: string; coverage: string; body_status: string; body_text: string | null; access: string | null; excerpt: string | null; published_at: Date }[]>`
  SELECT id, content_scope, coverage, body_status, body_text, access, excerpt, published_at FROM articles WHERE url = ${url}`;

test("the two short Science summaries travel collect -> 403 extraction -> limited intro -> publication -> public API", async () => {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${SOURCE},'SYNTHETIC Science（端到端测试）','rss',${sql.json({
      feedUrl: `${base}/rss`, allowCategories: ["Science"], summaryIsBody: false, contentScope: "ai4s", cardImageAllowed: false,
      _aihot: { initialBackfillLimit: 2, initialUrlAllowlist: [LATTICE, BLOG], initialNotBefore: NOT_BEFORE },
    } as never)},'T1','editorial',null,'2100-01-01')`;

  // 1. Collection: the exact Science filter keeps the two baseline URLs; the Research item never becomes an article.
  const run = await collectSource(SOURCE);
  assert.deepEqual([run.status, run.found, run.created], ["ok", 3, 2]);
  assert.equal((await articleRow(RESEARCH)).length, 0, "A03: a non-Science item has no article record before any extraction or model step");
  for (const url of [LATTICE, BLOG]) {
    const [a] = await articleRow(url);
    assert.equal(a!.content_scope, "ai4s");
    assert.equal(a!.coverage, "official_abstract");
    assert.equal(a!.body_status, "pending", "the feed summary is not a body");
    assert.ok(a!.excerpt && a!.excerpt.length > 20);
  }
  assert.equal((await articleRow(LATTICE))[0]!.published_at.toISOString(), "2026-11-15T22:00:01.000Z", "A10: the official pubDate is kept, not the collection time");
  assert.equal(provider.hits(), 0, "collection spends no model call");

  // 2. The processing job first asks for the page (only a feed summary): no paid call yet.
  for (const url of [LATTICE, BLOG]) {
    const [{ id }] = await articleRow(url);
    assert.equal((await processArticle(id)).state, "fetching-body");
  }
  assert.equal(provider.hits(), 0, "A06: a pending body short-circuits before any model call");

  // 3. Extraction meets a confirmed 403: recorded limited/unconfirmed, no body, no paid reader, one bounded read.
  for (const url of [LATTICE, BLOG]) {
    const [{ id }] = await articleRow(url);
    assert.equal(await extractArticleBody(id), "unconfirmed");
    const [a] = await articleRow(url);
    assert.equal(a!.body_status, "unconfirmed");
    assert.equal(a!.body_text, null, "A06: a 403 page is never stored as the body");
    assert.equal(a!.coverage, "official_abstract", "the source's own abstract stays the material");
    assert.ok(a!.access, "the restriction is recorded");
  }
  assert.equal(articleHits[new URL(LATTICE).pathname], 1, "A06: one bounded read, no retry loop on a refused page");
  assert.equal(articleHits[new URL(BLOG).pathname], 1);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE purpose = 'body_fallback'`)[0]!.n, 0, "A06: no paid Reader on a 403");

  // 4. The column's own limited-intro analysis: its prompts, a faithful summary, no score, then publication.
  for (const url of [LATTICE, BLOG]) {
    const [{ id }] = await articleRow(url);
    assert.equal((await processArticle(id)).state, "pass");
  }
  assert.deepEqual(calls("E2ELATTICE").sort(), ["ai4s-structure", "prefilter", "summarize"], "A06: no paid score on a summary-only material");
  assert.deepEqual(calls("E2EBLOG").sort(), ["ai4s-structure", "prefilter", "summarize"]);

  // 5. The public read layer shows both as honest limited intros, isolated from the astronomy pool.
  const feed = await loadAi4sFeed({ tab: "all" });
  for (const [url, marker] of [[LATTICE, "E2ELATTICE"], [BLOG, "E2EBLOG"]] as const) {
    const [{ id }] = await articleRow(url);
    const item = feed.items.find((i) => i.id === id)!;
    assert.ok(item, "the limited intro is visible to a reader");
    assert.equal(item.score, null, "A06: no invented score");
    assert.equal(item.accessNote, "本介绍依据原文公开摘要整理。阅读全文可能需要登录或订阅。", "the 403 restriction is stated honestly to the reader");
    assert.equal(item.summary, `翻译摘要 ${marker}。第二句补充影响。`);
    assert.equal(item.links.original, url, "the original external link is carried");
    assert.ok(item.source.name.includes("SYNTHETIC Science"));
    assert.ok(item.publishedAt);
  }
  assert.equal((await loadAi4sFeed({ tab: "selected" })).items.length, 0, "auto-selection stays off; an empty selected tab is honest");
  const poolIds = (await loadPool({ channel: "all", category: null, tag: null })).items.map((i) => i.id);
  for (const url of [LATTICE, BLOG]) {
    const [{ id }] = await articleRow(url);
    assert.ok(!poolIds.includes(id), "A09: the astronomy pool never lists an ai4s item");
  }

  // 6. The public API serves the same limited intros over HTTP (the website reads this, never the DB).
  const res = await app.inject("/api/site/ai4s?tab=all");
  assert.equal(res.statusCode, 200);
  const api = res.json() as { items: Array<{ id: string; score: number | null; accessNote: string | null; links: { original: string } }> };
  for (const url of [LATTICE, BLOG]) {
    const [{ id }] = await articleRow(url);
    const item = api.items.find((i) => i.id === id)!;
    assert.ok(item, "the public API carries the limited intro");
    assert.equal(item.score, null);
    assert.equal(item.accessNote, "本介绍依据原文公开摘要整理。阅读全文可能需要登录或订阅。", "the 403 restriction is stated honestly to the reader");
    assert.equal(item.links.original, url);
  }

  // 7. A second round costs no new identity and no second paid call (receipt reuse on the same revision).
  const before = provider.hits();
  const again = await collectSource(SOURCE);
  assert.deepEqual([again.status, again.created, again.revised], ["ok", 0, 0], "A04: a repeat run adds no identity");
  for (const url of [LATTICE, BLOG]) {
    const [{ id }] = await articleRow(url);
    await processArticle(id);
  }
  assert.equal(provider.hits(), before, "A04/A08: the same revision is not paid for twice");
  assert.equal(articleHits[new URL(LATTICE).pathname], 1, "a settled restricted page is not re-extracted every round");
});