import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer, type ViteDevServer } from "vite";
let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });
const feed = { page: 1, pageSize: 20, total: 1, mode: "pilot", issueDate: "2026-10-05", lastSyncedAt: "2026-10-05T08:37:30Z", coverage: "Internal coverage Asia/Shanghai", note: "internal long disclaimer", latestBatch: { outcome: "selected" }, items: [{ paper_key: "test", title_zh: "论文中文标题", title_original: "Paper original title", summary_zh: "研究摘要与科学结果", reason_zh: "未涉及临床观察，因此给出SELECT", study_type: "observation", categories: ["astro-ph.GA"], arxiv_id: "2610.03572v1", submitted_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", url: "https://arxiv.org/abs/2610.03572" }] };
test("arxiv reader page retains scientific content without screening internals", async () => {
 const route = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
 assert.equal(typeof route.ArxivPageContent, "function");
 const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(route.ArxivPageContent, { feed, category: null })));
 assert.match(html, /AI 根据标题与摘要整理，请以论文原文为准。/);
 for (const text of ["论文中文标题", "Paper original title", "研究摘要与科学结果", "astro-ph.GA", "2610.03572v1", "2026-10-02"]) assert.ok(html.includes(text));
 assert.match(html, /href="https:\/\/arxiv.org\/abs\/2610.03572"/);
 assert.doesNotMatch(html, /candidate_only|SELECT|临床观察|推荐理由|Internal coverage|Asia\/Shanghai|internal long disclaimer|上次成功同步|Pilot：|每日摘要初筛/);
 assert.equal(html.split("AI 根据标题与摘要整理，请以论文原文为准。").length - 1, 1);
 assert.doesNotMatch(html, /2026-10-05/, "issue date is omitted from the reader header");
});
test("official search submits only official GET fields in a new tab", async () => {
 const { ArxivPageContent } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
 const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ArxivPageContent, { feed, category: null })));
 const form = html.match(/<form[^>]*action="https:\/\/arxiv\.org\/search\/"[^>]*>(.*?)<\/form>/s);
 assert.ok(form, "official search form is present");
 assert.match(form[0], /aria-label="搜索 arXiv（在新标签页查看官方结果）"/);
 assert.doesNotMatch(form[0], /在新标签页查看 arXiv 官方搜索结果/, "search explanation lives only in the accessible label");
 assert.match(form[0], /method="get"/);
 assert.match(form[0], /target="_blank"/);
 assert.match(form[0], /rel="noopener noreferrer"/);
 assert.match(form[1], /<input(?=[^>]*name="query")(?=[^>]*required="")[^>]*>/);
 assert.match(form[1], /name="searchtype"/);
 for (const value of ["all", "title", "author", "abstract"]) assert.ok(form[1].includes(`value="${value}"`));
 assert.match(form[1], /name="abstracts" value="show"/);
 assert.match(form[1], /name="order" value="-announced_date_first"/);
 assert.doesNotMatch(html, /<iframe/);
});
test("source-date headings group adjacent days without changing server order", async () => {
 const { ArxivPageContent } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
 const items = [
  { ...feed.items[0], paper_key: "first", title_zh: "第一篇", submitted_at: "2026-10-03T01:00:00Z" },
  { ...feed.items[0], paper_key: "second", title_zh: "第二篇", submitted_at: "2026-10-04T00:00:00+08:00" },
  { ...feed.items[0], paper_key: "third", title_zh: "第三篇", submitted_at: "2026-10-02T00:00:00Z" },
 ];
 const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ArxivPageContent, { feed: { ...feed, items, total: 3 }, category: null })));
 const headings = [...html.matchAll(/<h3[^>]*>([^<]+)/g)].map(m => m[1]);
 assert.deepEqual(headings, ["2026-10-03", "2026-10-02"]);
 assert.doesNotMatch(html, />2026-10-04<\/time>/, "card dates and UTC group headings must agree");
 assert.ok(html.indexOf("第一篇") < html.indexOf("第二篇"));
 assert.ok(html.indexOf("第二篇") < html.indexOf("第三篇"));
 assert.doesNotMatch(html, /原始提交 ·/, "date-only group headings drop the 原始提交 label");
});
test("approved scope does not add a collection-order toggle", async () => {
 const { ArxivPageContent } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
 const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ArxivPageContent, { feed, category: null })));
 assert.doesNotMatch(html, /最近收录|候选排序|newly_collected/);
});
test("arxiv latest-batch and paging status remain useful and truthful", async () => {
 const { ArxivPageContent } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
 for (const outcome of ["no_new_papers", "no_selection"]) {
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ArxivPageContent, { feed: { ...feed, latestBatch: { outcome } }, category: null })));
  assert.match(html, /下方为历史/);
  assert.match(html, outcome === "no_new_papers" ? /暂无已完成初筛的论文/ : /没有合适精选/);
 }
});
