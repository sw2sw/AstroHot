// Real React route SSR rendering, MOCK loader DTO; not browser/hydration acceptance.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { ArxivFeed } from "../packages/contracts/src/arxiv.ts";

let vite: ViteDevServer;
let Page: () => ReturnType<typeof createElement>;
before(async () => {
 // fileURLToPath, not `new URL(...).pathname`: on Windows the latter yields `/D:/…`, which Vite
 // resolves to `D:\D:\…` and then cannot create — the whole file failed before rendering anything.
 vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/web", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" });
 Page = (await vite.ssrLoadModule("/app/routes/arxiv.tsx")).default;
});
after(async () => { await vite?.close(); });
test("rendered direction navigation and paper categories use Chinese labels with unchanged codes", () => {
 const labels = {
  "astro-ph.CO": "宇宙学与河外天体物理",
  "astro-ph.EP": "地球与行星天体物理",
  "astro-ph.GA": "星系天文学",
  "astro-ph.HE": "高能天体物理",
  "astro-ph.IM": "天文仪器与方法",
  "astro-ph.SR": "太阳与恒星天体物理",
 };
 const dto = feed();
 const paper = { ...dto.items[0]!, categories: Object.keys(labels) as ArxivFeed["items"][number]["categories"] };
 const html = render(feed({ items: [paper], total: 1 }), "astro-ph.CO");
 const nav = html.match(/<nav aria-label="天文方向过滤"[^>]*>(.*?)<\/nav>/s)![1]!;
 const card = html.match(/<li[^>]*>(.*?)<\/li>/s)![1]!;
 for (const [code, label] of Object.entries(labels)) {
  assert.ok(nav.includes(`${label}（${code}）`), `navigation label: ${code}`);
  assert.ok(card.includes(`${label}（${code}）`), `paper label: ${code}`);
  assert.ok(nav.includes(`href="/arxiv?page=1&amp;pageSize=20&amp;category=${code}"`), `original category href: ${code}`);
 }
 assert.ok(nav.includes('aria-current="page"'));
});

test("rendered cross-listed categories retain unknown original codes", () => {
 const paper = { ...feed().items[0]!, categories: ["gr-qc"] };
 assert.ok(render(feed({ items: [paper] })).includes("观测 · gr-qc ·"));
});
test("announcement day takes precedence while submission and version dates explicitly show UTC", () => {
 const original = feed().items[0]!;
 const html = render(feed({ items: [{ ...original, submitted_at: "2026-10-04T23:59:00Z", updated_at: "2026-10-05T01:00:00Z", announced_on: "2026-10-06" }], total: 1 }));
 assert.match(html, /<h3[^>]*>2026-10-06/);
 assert.ok(html.includes("公告"));
 assert.ok(html.includes("提交（UTC）")); assert.ok(html.includes("更新（UTC）"));
 assert.ok(html.includes('dateTime="2026-10-04T23:59:00Z"') || html.includes('datetime="2026-10-04T23:59:00Z"'));
 assert.doesNotMatch(html, /<h3[^>]*>2026-10-04/);
});
test("unknown historical announcement dates honestly fall back to UTC submission without guessing", () => {
 const html = render(feed({ items: [{ ...feed().items[0]!, submitted_at: "2026-10-04T23:59:00Z" }], total: 1 }));
 assert.match(html, /<h3[^>]*>2026-10-04/);assert.ok(html.includes("提交（UTC）"));
 assert.ok(!html.includes("首次公开："));
});
const historical = JSON.parse(readFileSync(new URL("fixtures/arxiv-pilot.json", import.meta.url), "utf8"));
function feed(overrides: Partial<ArxivFeed> = {}): ArxivFeed {
 return { items: historical.items.filter((p: { verdict: string }) => p.verdict === "SELECT"), total: 5, page: 1, pageSize: 20,
 contentTag: "tag-5", admittedAt: "2026-10-04T00:00:00.000Z",
 groups: historical.items.filter((p: { verdict: string; arxiv_id: string; base_id: string }) => p.verdict === "SELECT").map((p: { arxiv_id: string; base_id: string }) => ({ key: p.base_id, rep: p.arxiv_id, members: 1, memberIds: [p.arxiv_id] })),
 lastSyncedAt: null, issueDate: "2026-10-04", mode: "pilot", coverage: "bounded_sample_not_complete_daily_census", note: "candidate_only",
 latestBatch: { paperCount: 0, selectedCount: 0, outcome: "no_new_papers" }, ...overrides };
}
function render(dto: ArxivFeed, category: string | null = null) {
 const router = createMemoryRouter([{ id: "arxiv", path: "/arxiv", Component: Page }], {
 initialEntries: ["/arxiv"], hydrationData: { loaderData: { arxiv: { feed: dto, category } } }
 });
 try { return renderToStaticMarkup(createElement(RouterProvider, { router })); }
 finally { router.dispose(); }
}
test("rendered latest-zero notice with five historical candidates and explicit archive heading", () => {
 const html = render(feed());
 assert.ok(html.includes("本批次暂无已完成初筛的论文，下方为历史候选"));
 assert.ok(html.includes("候选档案（含历史）"));
 for (const paper of feed().items) assert.ok(html.includes(paper.title_zh));
 assert.ok(!html.includes("尚未同步报告"));
});

test("rendered zero-SELECT batch shows historical archive, not no-new-paper message", () => {
 const html = render(feed({ latestBatch: { paperCount: 3, selectedCount: 0, outcome: "no_selected_papers" } }));
 assert.ok(html.includes("本批次没有合适精选，下方为历史候选"));
 assert.ok(!html.includes("本批次没有新增论文"));
});
test("rendered no-report empty state is distinct from filtered and paginated archives", () => {
 const html = render(feed({ items: [], total: 0, latestBatch: null, mode: null, issueDate: null }));
 assert.ok(html.includes("尚未同步报告，候选档案暂无数据。"));
 assert.ok(!html.includes("该方向暂无候选"));
 assert.ok(!html.includes("本批次没有"));
});
test("rendered category empty keeps latest selected batch separate from filter result", () => {
 const html = render(feed({ items: [], total: 0, latestBatch: { paperCount: 22, selectedCount: 5, outcome: "selected" } }), "astro-ph.SR");
 assert.ok(html.includes("该方向暂无候选，请尝试其他方向或全部方向。"));
 assert.ok(!html.includes("尚未同步报告"));
 assert.ok(!html.includes("本批次没有"));
});
test("rendered legal overflow page is not a missing report or empty category", () => {
 const html = render(feed({ items: [], total: 5, page: 2, latestBatch: { paperCount: 22, selectedCount: 5, outcome: "selected" } }));
 assert.ok(html.includes("此页暂无候选，请返回上一页。"));
 assert.ok(!html.includes("尚未同步报告"));
 assert.ok(!html.includes("该方向暂无候选"));
});
