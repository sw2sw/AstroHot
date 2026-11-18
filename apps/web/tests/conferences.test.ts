// 学术会议页：注册的路由、只读公开接口、整卡是按钮（不嵌套链接）、日期与截止只按日呈现，
// 近期模块没有数据时整块不渲染。渲染走 vite SSR + react-router memory router，与既有页面测试同路。
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ConferenceSummary } from "@aihot/contracts/site";

let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });

const item = (over: Partial<ConferenceSummary> = {}): ConferenceSummary => ({
  id: 1, name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届",
  startDate: "2026-11-24", endDate: "2026-11-28", phase: "upcoming",
  city: "西安", venue: null, online: false, organizer: "国家天文科学数据中心",
  officialUrl: "https://nadc.china-vo.org/events/cvo2026/", registrationUrl: null,
  deadlines: [{ kind: "abstract", date: "2026-10-15", state: "closed" }],
  scheduleStatus: "scheduled", domain: "astro",
  notice: { id: "czoy84lxbox8b7t0zxmu6n0zf", title: "第25届 CVO 研讨会通知", summary: "会议将在中国西安召开。", source: "国家天文科学数据中心", url: "https://nadc.china-vo.org/events/cvo2026/", publishedAt: null },
  verifiedAt: "2026-11-17T04:00:00.000Z", ...over,
});

async function render(node: "card" | "recent" | "page", props: Record<string, unknown>) {
  const mod = node === "card"
    ? await vite.ssrLoadModule("/app/routes/conferences.tsx")
    : node === "recent" ? await vite.ssrLoadModule("/app/features/conferences/Recent.tsx") : await vite.ssrLoadModule("/app/routes/conferences.tsx");
  const element = node === "card"
    ? createElement(mod.ConferenceCard, props)
    : node === "recent" ? createElement(mod.ConferenceRecent, props) : createElement(mod.ConferencesPageContent, props);
  const router = createMemoryRouter([{ path: "/", element }]);
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test("the hub is a registered route reading the shared public API", () => {
  assert.match(readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8"), /route\("conferences", "routes\/conferences\.tsx"\)/);
  const src = readFileSync(new URL("../app/routes/conferences.tsx", import.meta.url), "utf8");
  assert.match(src, /\/api\/site\/conferences/, "会议页读公开接口");
  assert.doesNotMatch(src, /@aihot\/backend\/db|packages\/backend/, "页面不直连数据库");
});

test("the phone 更多 page lists 学术会议 and no new top-level tab is added", async () => {
  const more = readFileSync(new URL("../app/routes/more.tsx", import.meta.url), "utf8");
  assert.match(more, /to: "\/conferences", label: "学术会议"/);
  const nav = await vite.ssrLoadModule("/app/components/shell/nav.ts") as { SIDEBAR: Array<{ items: Array<{ to: string }> }> };
  assert.equal(nav.SIDEBAR.flatMap((g) => g.items).some((i) => i.to === "/conferences"), false, "不新增主导航一级");
});

test("a whole card is a button, carries no nested anchor, and states date, place and deadline", async () => {
  const html = await render("card", { item: item(), onOpen: () => {} });
  assert.match(html, /<button[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<a\s/, "卡内没有链接");
  assert.match(html, /2026-11-24 — 2026-11-28/);
  assert.match(html, /西安/);
  assert.match(html, /摘要截止 2026-10-15（已截止）/);
});

test("an undated conference says 日期待定 instead of inventing a date", async () => {
  const html = await render("card", { item: item({ startDate: null, endDate: null, phase: "undated" }), onOpen: () => {} });
  assert.match(html, /日期待定/);
  assert.doesNotMatch(html, /2026-11-24/);
});

test("a cancelled conference shows its manual state, and an online one says 线上", async () => {
  const html = await render("card", { item: item({ phase: "cancelled", scheduleStatus: "cancelled", online: true, city: null }), onOpen: () => {} });
  assert.match(html, /已取消/);
  assert.match(html, /线上/);
});

test("B4 a cancelled or unsettled event is never shown as ongoing or ended", async () => {
  // The state outranks the clock: a cancelled event inside its dates, and one whose new dates are not
  // settled and whose old dates have passed, must not wear the clock's labels.
  const cancelled = await render("card", {
    item: item({ phase: "cancelled", scheduleStatus: "cancelled", startDate: "2026-11-16", endDate: "2026-11-19" }), onOpen: () => {},
  });
  assert.match(cancelled, /已取消/);
  assert.doesNotMatch(cancelled, /进行中/);

  const postponed = await render("card", {
    item: item({ phase: "postponed", scheduleStatus: "postponed", startDate: "2026-11-10", endDate: "2026-11-11" }), onOpen: () => {},
  });
  assert.match(postponed, /已延期/);
  assert.doesNotMatch(postponed, /已结束/);

  // And the hub files them in their own group instead of dropping them or calling them upcoming.
  const page = await render("page", {
    data: {
      scope: "all", total: 1, page: 1, pageCount: 1, pageSize: 20, updatedAt: null,
      items: [item({ id: 3, phase: "cancelled", scheduleStatus: "cancelled" })],
    },
  });
  assert.match(page, /已取消 \/ 已延期/);
  assert.doesNotMatch(page, /id="conf-upcoming"/);
});

test("the recent entry renders at most what it is given, and nothing at all when empty", async () => {
  const empty = await render("recent", { items: [], scope: "astro" });
  assert.equal(empty, "");
  const html = await render("recent", { items: [item(), item({ id: 2, name: "另一个会议", startDate: "2026-12-01", endDate: "2026-12-01", phase: "ongoing" })], scope: "astro" });
  assert.match(html, /近期学术会议/);
  assert.match(html, /查看全部/);
  assert.match(html, /\/conferences\?scope=astro/);
  assert.equal((html.match(/<li/g) ?? []).length, 2);
});
