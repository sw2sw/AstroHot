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
const paper = { paper_key: "synthetic", title_zh: "合成论文", title_original: "Synthetic paper", summary_zh: "合成摘要", study_type: "observation", categories: ["astro-ph.GA"], arxiv_id: "synthetic-v1", url: "#synthetic", submitted_at: null, updated_at: null };
async function render(over: Record<string, unknown>) {
 const { ArxivPageContent } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
 const feed = { page: 1, pageSize: 20, total: 1, contentTag: "synthetic", groups: [], items: [{ ...paper, ...over }] };
 return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ArxivPageContent, { feed, category: null })));
}
for (const value of [null, undefined, "", " ", "not-a-date", "2026-02-30T00:00:00Z"]) {
 test(`unknown instants (${String(value)}) never crash or fabricate dates and hide an entirely unknown row`, async () => {
  const html = await render({ submitted_at: value, updated_at: value, announced_on: "2026-10-19" });
  assert.match(html, /2026-10-19/);
  assert.doesNotMatch(html, /1970-01-01|NaN|Invalid Date|提交（UTC）：|更新（UTC）：/);
 });
}
test("invalid submission fallback groups under unknown, never collection or analysis day", async () => {
 for (const value of [null, "", "bad", "2026-02-30T00:00:00Z"]) {
  const html = await render({ announced_on: null, submitted_at: value, updated_at: value, collected_at: "2026-10-18", generated_at: "2026-10-19" });
  assert.match(html, /<h3[^>]*>日期未知<span[^>]*>来源未提供日期/);
  assert.doesNotMatch(html, /1970|2026-10-18|2026-10-19|<time/);
 }
});
test("real UTC instants remain labelled while the missing counterpart is unknown", async () => {
 const html = await render({ submitted_at: "2026-10-19T01:00:00+08:00", updated_at: "bad" });
 assert.match(html, /<h3[^>]*>2026-10-18<span[^>]*>提交（UTC）/);
 assert.match(html, /<time dateTime="2026-10-19T01:00:00\+08:00">2026-10-18<\/time>/);
 assert.match(html, /更新（UTC）：未知/);
 assert.doesNotMatch(html, /dateTime="bad"/);
 const updatedOnly = await render({ updated_at: "2026-10-19T00:00:00Z" });
 assert.match(updatedOnly, /提交（UTC）：未知/);
 assert.match(updatedOnly, /更新（UTC）：<time/);
});
test("announcement calendar day wins without timezone conversion; invalid announcement falls back", async () => {
 const html = await render({ announced_on: "2026-10-19", submitted_at: "2026-10-17T23:00:00Z" });
 assert.match(html, /<h3[^>]*>2026-10-19<span[^>]*>公告/);
 const fallback = await render({ announced_on: "2026-02-30", submitted_at: "2026-10-17T23:00:00Z" });
 assert.match(fallback, /<h3[^>]*>2026-10-17<span[^>]*>提交（UTC）/);
});
