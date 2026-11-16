// Temporary browser-verification seed (task artifact, not production). Populates an isolated _test
// database with representative AI4S items: two 403 limited intros from a local fake RSS source, one
// scored AI4A full-text item (manually selected), and one long bilingual title with math. Uses a local
// stub model only; no production source, no real paid call. Run with DATABASE_URL pointing at the
// browser _test database and DASHSCOPE_API_KEY cleared.
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle } from "@aihot/backend/jobs/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = `browser${Date.now().toString(36)}`;
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
let feedXml = "";
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/rss") { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(feedXml); return; }
  res.writeHead(403, { "content-type": "text/html" }); res.end("<html><body>Forbidden</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
const LATTICE = `${base}/article/${T}/lattice`;
const BLOG = `${base}/article/${T}/blog`;
const NOT_BEFORE = "2026-11-15T22:00:00.000Z";
feedXml = `<rss version="2.0"><channel><title>seed</title>${[
  { url: LATTICE, title: "SYNTHETIC: A toy research workflow", date: "2026-11-15T22:00:01.000Z", summary: "BROWSERLATTICE: SYNTHETIC: A fictional team discusses a toy research idea with an AI assistant. Technical details are not available." },
  { url: BLOG, title: "SYNTHETIC: A fictional research community bulletin", date: "2026-11-15T22:00:00.000Z", summary: "BROWSERBLOG: SYNTHETIC: A fictional science community has a new discussion space. Technical details are not available." },
].map((i) => `<item><title>${escape(i.title)}</title><link>${escape(i.url)}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${escape(i.summary)}</description><category>Science</category></item>`).join("")}</channel></rss>`;

const ASTRO_EVIDENCE = "AI classified 12 million galaxy spectra in the survey.";
const structureAnswers: Record<string, unknown> = {
  BROWSERLATTICE: { scope: "single", domain: "physics", astroApplication: { applies: false, evidence: null }, fact: null },
  BROWSERBLOG: { scope: "single", domain: "research-meta", astroApplication: { applies: false, evidence: null }, fact: null },
  BROWSERASTRO: { scope: "single", domain: "astronomy-astrophysics", astroApplication: { applies: true, evidence: ASTRO_EVIDENCE, referent: "galaxy spectra" }, fact: { title: "星系光谱分类", subject: "某巡天团队", action: "发布", object: "光谱分类结果", occurredAt: null, evidence: ASTRO_EVIDENCE, conditions: [] } },
  BROWSERLONG: { scope: "single", domain: "methods-tools", astroApplication: { applies: false, evidence: null }, fact: null },
};
const scoreAnswers: Record<string, number[]> = { BROWSERASTRO: [88, 86], BROWSERLONG: [70, 74] };
const stepOf = (system: string, user: string) =>
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
  const marker = ["BROWSERLATTICE", "BROWSERBLOG", "BROWSERASTRO", "BROWSERLONG"].find((m) => user.includes(m)) ?? "";
  const answer = (c: unknown) => ({ id: "stub", model: "stub", choices: [{ message: { content: typeof c === "string" ? c : JSON.stringify(c) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: "PASS", reason: "seed" });
  if (step === "score") return answer({ attentionScore: scoreAnswers[marker]!.shift() });
  if (step === "understand") return answer({ itemType: "research_result", authorRole: "principal", tags: [], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  if (step === "ai4s-structure") return answer(structureAnswers[marker]);
  if (step === "structure") return answer({ category: "stars-transients", tags: [], subjects: [], scope: "single", fact: null });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

const SOURCE = `ai4s-${T}`;
await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
  VALUES (${SOURCE},'SYNTHETIC Science','rss',${sql.json({ feedUrl: `${base}/rss`, allowCategories: ["Science"], summaryIsBody: false, contentScope: "ai4s", cardImageAllowed: false, _aihot: { initialBackfillLimit: 2, initialUrlAllowlist: [LATTICE, BLOG], initialNotBefore: NOT_BEFORE } } as never)},'T1','editorial',null,'2100-01-01')`;
assert.equal((await collectSource(SOURCE)).created, 2);
for (const url of [LATTICE, BLOG]) {
  const [{ id }] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE url=${url}`;
  await processArticle(id);
  await extractArticleBody(id);
  assert.equal((await processArticle(id)).state, "pass");
}

const ASTRO_SOURCE = `ai4s-astro-${T}`;
await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${ASTRO_SOURCE},'天文交叉源','rss','T1','editorial','2100-01-01')`;
const astroId = (await upsertMaterial({ sourceId: ASTRO_SOURCE, url: `https://example.com/${T}/astro`, title: `BROWSERASTRO galaxy spectra classification ${T}`, bodyText: `BROWSERASTRO: a survey result. ${ASTRO_EVIDENCE} (${T})`, bodyStatus: "ok", coverage: "full_text", contentScope: "ai4s", via: "fetch", publishedAt: new Date("2026-11-15T22:00:01Z") } as never)).articleId;
await analyzeArticle(astroId);
await sql`UPDATE articles SET grouping_status='complete', grouped_at=now() WHERE id=${astroId}`;
await sql`INSERT INTO editorial_overrides (article_id, fields, reason) VALUES (${astroId}, ${sql.json({ selected: true } as never)}, '浏览器验证人工精选')`;
await publishArticle(astroId);

const longId = (await upsertMaterial({ sourceId: ASTRO_SOURCE, url: `https://example.com/${T}/long`, title: `BROWSERLONG A very long bilingual title about machine-learning methods for scientific discovery 机器学习方法赋能科学发现的超长标题 ${T}`, bodyText: `BROWSERLONG: methods. We measure $4\\%$ uncertainty with a reusable pipeline. (${T})`, bodyStatus: "ok", coverage: "full_text", contentScope: "ai4s", via: "fetch", publishedAt: new Date("2026-11-15T22:00:01Z") } as never)).articleId;
await analyzeArticle(longId);
await publishArticle(longId);

const n = (await sql`SELECT count(*)::int n FROM publications WHERE content_scope='ai4s' AND eligible`)[0]!.n;
console.log(`seeded ai4s eligible publications: ${n}`);
await provider.close();
await new Promise<void>((r) => server.close(() => r()));
await stopBoss();
await closeDb();