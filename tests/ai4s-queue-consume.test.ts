// A02 (R4) — the AI4S road is consumed by REAL persistent-queue workers, not by direct function calls.
// collectSource only enqueues; the extractBody/analyze workers registered here are the same ones
// apps/worker/main.ts registers. The jobs are enqueued while NO worker is alive (the durable restart gap:
// they sit in pgboss.job unprocessed), then the workers come up and drain them — exactly how a restart
// recovers pending work. A fake source (403 pages) and a fake model on the task's _test database; no
// production source, no paid Reader, no score on a limited intro. Nothing here calls processArticle or
// extractArticleBody directly: every transition happens through a pg-boss job a worker consumes.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { registerContentJobs, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { collectSource } from "@aihot/backend/sources/collect";
import { loadAi4sFeed } from "@aihot/backend/publication/ai4s";
import { loadPool } from "@aihot/backend/publication/pool";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
let feedXml = "";
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/rss") { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(feedXml); return; }
  res.writeHead(403, { "content-type": "text/html" }); res.end("<html><body>Forbidden</body></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

const LATTICE = `${base}/article/${T}/qc-lattice`;
const BLOG = `${base}/article/${T}/qc-blog`;
const NOT_BEFORE = "2026-11-15T22:00:00.000Z";
const rssOf = (items: Array<{ url: string; title: string; date: string; summary: string }>) =>
  `<rss version="2.0"><channel><title>合成队列列表</title>${items.map((i) =>
    `<item><title>${escape(i.title)}</title><link>${escape(i.url)}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${escape(i.summary)}</description><category>Science</category></item>`).join("")}</channel></rss>`;
feedXml = rssOf([
  { url: LATTICE, title: "SYNTHETIC: A toy research workflow", date: "2026-11-15T22:00:01.000Z", summary: `QCLATTICE: SYNTHETIC: A fictional team discusses a toy research idea with an AI assistant. Technical details are not available. (${T})` },
  { url: BLOG, title: "SYNTHETIC: A fictional research community bulletin", date: "2026-11-15T22:00:00.000Z", summary: `QCBLOG: SYNTHETIC: A fictional science community has a new discussion space. Technical details are not available. (${T})` },
]);

type Step = "prefilter" | "score" | "understand" | "summarize" | "ai4s-structure" | "structure";
const requests: Array<{ step: Step; marker: string }> = [];
const structureAnswers: Record<string, unknown> = {
  QCLATTICE: { scope: "single", domain: "physics", astroApplication: { applies: false, evidence: null }, fact: null },
  QCBLOG: { scope: "single", domain: "research-meta", astroApplication: { applies: false, evidence: null }, fact: null },
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
  const marker = ["QCLATTICE", "QCBLOG"].find((m) => user.includes(m)) ?? "";
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

const SOURCE = `ai4s-qc-${T}`;
const app = await buildApp();
const boss = await getBoss();
after(async () => { await app.close(); await provider.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function until(check: () => Promise<boolean>, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await check())) { assert.ok(Date.now() < deadline, "bounded wait for the workers expired"); await delay(150); }
}
const articleRow = (url: string) => sql<{ id: string; body_status: string; grouping_status: string }[]>`SELECT id, body_status, grouping_status FROM articles WHERE url = ${url}`;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);

test("collect enqueues durably with no worker alive; real workers then drain the whole AI4S chain", async () => {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${SOURCE},'SYNTHETIC Science（队列消费测试）','rss',${sql.json({
      feedUrl: `${base}/rss`, allowCategories: ["Science"], summaryIsBody: false, contentScope: "ai4s", cardImageAllowed: false,
      _aihot: { initialBackfillLimit: 2, initialUrlAllowlist: [LATTICE, BLOG], initialNotBefore: NOT_BEFORE },
    } as never)},'T1','editorial',null,'2100-01-01')`;

  // 1. Collection enqueues; NO worker is registered yet, so the jobs must persist unprocessed (restart gap).
  const run = await collectSource(SOURCE);
  assert.deepEqual([run.status, run.created], ["ok", 2]);
  const ids: string[] = [];
  for (const url of [LATTICE, BLOG]) ids.push((await articleRow(url))[0]!.id);
  assert.equal(provider.hits(), 0, "collection spends no model call");
  const queued = await sql<{ n: number }[]>`SELECT count(*)::int n FROM pgboss.job WHERE name = ${QUEUES.extractBody} AND data->>'articleId' = ANY(${ids}::text[]) AND state IN ('created','retry','active')`;
  assert.ok(queued[0]!.n >= 2, "A02: the extract jobs are durably queued in pgboss while no worker is alive");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM analyses WHERE article_id = ANY(${ids}::text[])`)[0]!.n, 0, "nothing is processed before a worker consumes the queue");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM publications WHERE article_id = ANY(${ids}::text[])`)[0]!.n, 0);

  // 2. The workers come up (the same registrations as apps/worker/main.ts) and recover the pending jobs.
  await registerExtractionJobs(boss);
  await registerContentJobs(boss);
  await until(async () => {
    const rows = await sql<{ body_status: string }[]>`SELECT body_status FROM articles WHERE id = ANY(${ids}::text[])`;
    const pubs = (await sql<{ n: number }[]>`SELECT count(*)::int n FROM publications WHERE article_id = ANY(${ids}::text[])`)[0]!.n;
    return rows.length === 2 && rows.every((r) => r.body_status === "unconfirmed") && pubs === 2;
  });

  // 3. Every transition went through a consumed job: the extract and analyze jobs are completed in pgboss.
  for (const q of [QUEUES.extractBody, QUEUES.analyze]) {
    const done = await sql<{ n: number }[]>`SELECT count(*)::int n FROM pgboss.job WHERE name = ${q} AND data->>'articleId' = ANY(${ids}::text[]) AND state = 'completed'`;
    assert.ok(done[0]!.n >= 2, `A02: the ${q} jobs were consumed and completed by a real worker`);
  }
  assert.deepEqual(calls("QCLATTICE").sort(), ["ai4s-structure", "prefilter", "summarize"], "A06: a limited intro is never scored");
  assert.deepEqual(calls("QCBLOG").sort(), ["ai4s-structure", "prefilter", "summarize"]);
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM receipts WHERE purpose = 'body_fallback'`)[0]!.n, 0, "A06: no paid Reader on a 403");
  assert.ok((await sql<{ n: number }[]>`SELECT count(*)::int n FROM receipts WHERE status = 'completed' AND subject LIKE ${`article:%`}`)[0]!.n >= 2, "the workers settled paid analysis receipts");

  // 4. The public read layer and API show the worker-produced limited intros, isolated from astronomy.
  const feed = await loadAi4sFeed({ tab: "all" });
  for (const [url, marker] of [[LATTICE, "QCLATTICE"], [BLOG, "QCBLOG"]] as const) {
    const [{ id }] = await articleRow(url);
    const item = feed.items.find((i) => i.id === id)!;
    assert.ok(item, "the worker-produced limited intro is visible");
    assert.equal(item.score, null);
    assert.equal(item.accessNote, "本介绍依据原文公开摘要整理。阅读全文可能需要登录或订阅。");
    assert.equal(item.summary, `翻译摘要 ${marker}。第二句补充影响。`);
  }
  assert.equal((await loadAi4sFeed({ tab: "selected" })).items.length, 0, "auto-selection stays off");
  const poolIds = (await loadPool({ channel: "all", category: null, tag: null })).items.map((i) => i.id);
  assert.ok(ids.every((id) => !poolIds.includes(id)), "A09: the astronomy pool never lists an ai4s item");
  const api = (await app.inject("/api/site/ai4s?tab=all")).json() as { items: Array<{ id: string }> };
  assert.ok(ids.every((id) => api.items.some((i) => i.id === id)), "the public API serves the worker-produced intros");
});