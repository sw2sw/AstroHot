// 观测指南（/observing-guides）与首页日历卡里的新入口：收录名单、卡片映射、诚实状态。
// fixture 是合成的公开详情形状快照，只用于渲染与状态测试；它不是生产数据，也不触发任何模型调用。
// 本发行包不附带任何第三方指南条目：OBSERVING_GUIDE_IDS 为空，页面显示诚实的空态。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { createServer, type ViteDevServer } from "vite";
import { OBSERVING_GUIDE_IDS, guidesState, guidesView, toGuideCard } from "../app/features/observing-guides/guides.ts";

const GUIDE_A = "SYNTH_GUIDE_A";
const GUIDE_B = "SYNTH_GUIDE_B";
/** fixture 里两条合成指南的 id，顺序即构建视图的顺序。 */
const FIXTURE_IDS = [GUIDE_A, GUIDE_B];
/** 本发行包的收录名单为空，与 OBSERVING_GUIDE_IDS 一致：不附带任何第三方指南条目。 */
const GUIDE_IDS: string[] = [];

/** 合成 fixture：卡片用到的字段，形状照公开详情，内容为合成占位，不是真实条目。 */
const DETAIL_FIXTURE: Record<string, Record<string, unknown>> = {
  [GUIDE_A]: {
    id: GUIDE_A,
    title: "合成观测指南：本周夜空示例",
    originalTitle: "Synthetic sample guide one",
    summary: "合成摘要一：仅用于渲染与状态测试，不是真实观测指南。",
    source: { name: "合成示例来源一" },
    publishedAt: "2026-10-09T08:56:00.000Z",
    discoveredAt: "2026-10-11T01:42:59.165Z",
    timelineAt: "2026-10-09T08:56:00.000Z",
    score: 13,
    selected: false,
  },
  [GUIDE_B]: {
    id: GUIDE_B,
    title: "合成观测指南：本周星空示例",
    originalTitle: "Synthetic sample guide two",
    summary: "合成摘要二：仅用于渲染与状态测试。",
    source: { name: "合成示例来源二" },
    publishedAt: "2026-10-09T05:00:00.000Z",
    discoveredAt: "2026-10-11T01:42:59.359Z",
    timelineAt: "2026-10-09T05:00:00.000Z",
    score: 25,
    selected: false,
  },
};

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(view: unknown) {
  return vite.ssrLoadModule("/app/routes/observing-guides.tsx").then((m) =>
    renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(m.ObservingGuidesPage, { view }))));
}

function renderHomeCard(today: string) {
  return vite.ssrLoadModule("/app/routes/home.tsx").then((m) =>
    renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(m.HomeCalendarCard, { today }))));
}

let vite: ViteDevServer;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
});
after(async () => { await vite?.close(); });

// —— 收录名单 ——

test("公开发行包保持空人工名单，自动读取不按分数或精选筛选", () => {
  assert.deepEqual([...OBSERVING_GUIDE_IDS], GUIDE_IDS);
  assert.equal(new Set(OBSERVING_GUIDE_IDS).size, GUIDE_IDS.length, "每篇只收录一次");
  const route = source("../app/routes/observing-guides.tsx");
  // 一次有界栏目查询，不扫分页池、不按热度或精选门槛挑。
  assert.match(route, /\/api\/site\/observing-guides/, "使用公共指南读取层");
  assert.doesNotMatch(route, /\/api\/site\/(pool|timeline)/, "不从分页池推断收录名单");
  assert.doesNotMatch(route, /\b(score|selected)\b/, "不设精选分数门槛");
  assert.doesNotMatch(route, /openai|chatapi|model|prompt/i, "不新增模型调用或 AI 分类");
});

test("卡片只搬公开详情自己的字段，来源没给发布时间时不拿采集时间顶上", () => {
  const card = toGuideCard(DETAIL_FIXTURE[GUIDE_A] as never);
  assert.deepEqual(card, {
    id: GUIDE_A,
    title: DETAIL_FIXTURE[GUIDE_A]!.title,
    summary: DETAIL_FIXTURE[GUIDE_A]!.summary,
    sourceName: "合成示例来源一",
    publishedAt: "2026-10-09T08:56:00.000Z",
  });
  const undated = toGuideCard({ ...DETAIL_FIXTURE[GUIDE_A], publishedAt: null } as never);
  assert.equal(undated.publishedAt, null, "没有发布时间就留空，不编造");
  const guides = source("../app/features/observing-guides/guides.ts");
  assert.doesNotMatch(guides, /discoveredAt|timelineAt/, "采集时间与时间线时刻都不当发布时间用");
  assert.doesNotMatch(guides, /originalTitle/, "卡片不假称双语：摘要卡没有 originalTitle 字段");
});

// —— 状态 ——

test("一个 id 的结果不影响另一个：撤回不留占位卡，读不到不等于没有指南", () => {
  const guide = (id: string) => ({ kind: "guide" as const, card: toGuideCard(DETAIL_FIXTURE[id] as never) });

  const both = guidesView([guide(GUIDE_A), guide(GUIDE_B)]);
  assert.deepEqual(both.guides.map((g) => g.id), FIXTURE_IDS, "保持名单顺序");
  assert.equal(guidesState(both), "guides");

  const oneFailed = guidesView([guide(GUIDE_A), { kind: "unreadable" }]);
  assert.equal(oneFailed.guides.length, 1, "单项异常不阻塞正常项");
  assert.equal(guidesState(oneFailed), "guides");
  assert.equal(oneFailed.unreadable, 1);

  const oneWithdrawn = guidesView([guide(GUIDE_A), { kind: "withdrawn" }]);
  assert.equal(oneWithdrawn.guides.length, 1);
  assert.equal(oneWithdrawn.withdrawn, 1, "404 记为撤回，静默去掉");
  assert.equal(guidesState(oneWithdrawn), "guides");

  const allWithdrawn = guidesView([{ kind: "withdrawn" }, { kind: "withdrawn" }]);
  assert.equal(guidesState(allWithdrawn), "empty", "确实没有可用指南");

  const allUnreadable = guidesView([{ kind: "unreadable" }, { kind: "unreadable" }]);
  assert.equal(guidesState(allUnreadable), "unavailable", "读不到不能说成没有指南");

  assert.equal(guidesState(guidesView([])), "empty", "名单为空也是空态");
});

// —— 加载器 ——

test("加载器一次请求公共指南页，保留具体标题、日期、分页及诚实错误态", async () => {
  const { loader } = await vite.ssrLoadModule("/app/routes/observing-guides.tsx");
  const original = globalThis.fetch;
  const called: URL[] = [];
  const fixture = { guides: FIXTURE_IDS.map((id) => toGuideCard(DETAIL_FIXTURE[id] as never)), withdrawn: 0, unreadable: 0, nextCursor: "guides1.synthetic" };
  try {
    globalThis.fetch = (async (input: unknown) => {
      called.push(new URL(String(input)));
      return jsonResponse(fixture);
    }) as typeof fetch;
    const view = await loader({ request: new Request("http://localhost/observing-guides?cursor=guides1.previous") } as never);
    assert.equal(called.length, 1);
    assert.equal(called[0]!.pathname, "/api/site/observing-guides");
    assert.equal(called[0]!.searchParams.get("ids"), GUIDE_IDS.join(","));
    assert.equal(called[0]!.searchParams.get("cursor"), "guides1.previous");
    assert.deepEqual(view, fixture);
    const html = await renderPage(view);
    assert.match(html, /href="\/?\?cursor=guides1.synthetic"/);
    assert.match(html, /2026-10-09 16:56/);
    assert.ok(!html.includes("2026-10-11 09:42"), "采集时间不显示为文章发布时间");
    const undated = await renderPage({ ...view, guides: [{ ...view.guides[0], publishedAt: null }] });
    assert.doesNotMatch(undated, /2026-10-09 16:56/);
    globalThis.fetch = (async () => jsonResponse({}, 503)) as typeof fetch;
    assert.equal(guidesState(await loader({ request: new Request("http://localhost/observing-guides") } as never)), "unavailable");
  } finally { globalThis.fetch = original; }
});

// —— 页面 ——

test("指南页按视图渲染每张整卡并指向自己的详情，提示只有一条", async () => {
  const view = guidesView(FIXTURE_IDS.map((id) => ({ kind: "guide" as const, card: toGuideCard(DETAIL_FIXTURE[id] as never) })));
  const html = await renderPage(view);
  for (const id of FIXTURE_IDS) {
    assert.ok(html.includes(`data-guide-id="${id}"`), `${id} 有卡`);
    assert.match(html, new RegExp(`<a[^>]+href="/items/${id}"`), "整卡指向详情");
  }
  assert.match(html, /合成示例来源一/);
  assert.match(html, /合成示例来源二/);
  assert.match(html, /2026-10-09 16:56/, "按原始发布时间显示（北京时间）");
  assert.match(html, /本周星空示例/);
  assert.equal((html.match(/观测条件因地点与时区而异/g) ?? []).length, 1, "地点与时区提示只有一条");
  assert.doesNotMatch(html, /待揭晓|有效截止|当地观测时间/, "不把国外周报日期改造成本地可见期");
  assert.equal((html.match(/data-guides-state="guides"/g) ?? []).length, 1);
});

test("读不到与确实没有是两种话，都不透露内部用语", async () => {
  const unavailable = await renderPage(guidesView([{ kind: "unreadable" }, { kind: "unreadable" }]));
  assert.match(unavailable, /data-guides-state="unavailable"/);
  assert.match(unavailable, /暂时打不开/);
  assert.doesNotMatch(unavailable, /暂时没有可用的观测指南/, "不开的指南不等于本站没有指南");

  const empty = await renderPage(guidesView([{ kind: "withdrawn" }, { kind: "withdrawn" }]));
  assert.match(empty, /data-guides-state="empty"/);
  assert.match(empty, /暂时没有可用的观测指南/);
  assert.doesNotMatch(empty, /打不开|没有读到/, "空态不说成故障");

  for (const html of [unavailable, empty]) {
    assert.doesNotMatch(html, /\/api\/|404|503|upstream|fixture|上游|接口|调试|TODO/i, "对读者不出现内部用语");
    assert.doesNotMatch(html, /data-guide-id/, "没有伪造的卡片");
  }
});

test("部分失败时正常项照常可用，只用一句话说明还有没读到的", async () => {
  const view = guidesView([{ kind: "guide", card: toGuideCard(DETAIL_FIXTURE[GUIDE_A] as never) }, { kind: "unreadable" }]);
  const html = await renderPage(view);
  assert.match(html, new RegExp(`data-guide-id="${GUIDE_A}"`));
  assert.equal((html.match(/data-guide-id/g) ?? []).length, 1);
  assert.match(html, /部分观测指南这次没有读到/);
  assert.doesNotMatch(html, /data-guides-state="unavailable"/);
});

// —— 首页入口 ——

test("首页日历卡是两个同级链接：日历与指南各自可点、键盘可达、没有嵌套", async () => {
  const html = await renderHomeCard("20261011");
  assert.ok(html.startsWith("<div"), "整卡不再是一个 anchor");
  assert.equal((html.match(/<a\b/g) ?? []).length, 2, "恰好两个链接");
  assert.ok(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(html), "没有嵌套 anchor");
  assert.match(html, /<a[^>]+href="\/calendar\?date=2026-10-11"[^>]*>天象日历 →<\/a>/);
  assert.match(html, /<a[^>]+href="\/observing-guides"[^>]*>观测指南 →<\/a>/);
  assert.equal((html.match(/focus-visible:outline-2/g) ?? []).length, 2, "两个链接都键盘可达");
  assert.doesNotMatch(html, /group-hover/, "两个动作各有自己的悬停状态");
});

test("原日期、星期、天象文字与日历深链逐字保留", async () => {
  const html = await renderHomeCard("20261005");
  assert.match(html, /10月5日/);
  assert.match(html, /星期一/);
  assert.match(html, /合成示例天象：示例条目/, "合成样本文字逐字保留");
  assert.match(html, /data-home-row="event"/);
  assert.equal((html.match(/data-home-row/g) ?? []).length, 3, "三行布局不变");
});

test("没有天象的那天也照样有两个入口，日历深链仍然指向当天", async () => {
  const html = await renderHomeCard("20261013");
  assert.match(html, /10月13日/);
  assert.doesNotMatch(html, /data-home-row="event"/);
  assert.equal((html.match(/data-home-row/g) ?? []).length, 2, "无天象时少一行，不改其它行");
  assert.match(html, /href="\/calendar\?date=2026-10-13"/);
  assert.match(html, /href="\/observing-guides"/);
});
