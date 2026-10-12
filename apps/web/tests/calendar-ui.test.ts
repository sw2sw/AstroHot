import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { createServer, type ViteDevServer } from "vite";

test("calendar route starts with Shanghai today and is discoverable from desktop and phone", async () => {
  const routes = readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /route\("calendar", "routes\/calendar.tsx"\)/);
  for (const file of ["components/shell/nav.ts", "routes/more.tsx"]) {
    assert.match(readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8"), /["']\/calendar["']/);
  }
  const route = await vite.ssrLoadModule("/app/routes/calendar.tsx");
  const { shanghaiDate } = await import(new URL("../app/features/calendar/model.ts", import.meta.url).href);
  assert.equal(route.loader({ request: new Request("http://localhost/calendar") }).today, shanghaiDate());
  assert.equal(route.handle.name, "天象日历");
});

test("calendar deep links select valid dates and reject malformed or impossible dates", async () => {
  const { loader, CalendarPageContent } = await vite.ssrLoadModule("/app/routes/calendar.tsx");
  const load = (date: string) => loader({ request: new Request(`http://localhost/calendar?date=${date}`) });
  const valid = load("2026-12-02");
  assert.equal(valid.initialDate, "20261202");
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(CalendarPageContent, valid)));
  assert.match(html, /2026 年 12 月/);
  for (const date of ["2026-02-30", "2026-13-01", "20261202", "2026-1-02", "nope"]) {
    const result = load(date);
    assert.equal(result.initialDate, result.today);
  }
  assert.equal(load("2024-02-29").initialDate, "20240229");
});

test("观测参考 links follow calendar content without becoming empty-day fallback or source", async () => {
  const { CalendarPageContent } = await vite.ssrLoadModule("/app/routes/calendar.tsx");
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(CalendarPageContent, { today: "20261007" })));
  assert.doesNotMatch(html, /来源：合成示例数据/);
  assert.match(html, /观测参考/);
  assert.match(html, /href="https:\/\/stellarium-web.org\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/laysky.com\/" target="_blank" rel="noopener noreferrer"/);
  assert.ok(html.indexOf("所选日期的天象") < html.indexOf("观测参考"));
  const events = html.split('aria-label="所选日期的天象"')[1]!.split("</section>")[0]!;
  assert.doesNotMatch(events, /<a|data-calendar-event|暂无|没有/);
});

test("calendar omits header small print while keeping event attribution", async () => {
  const { CalendarPageContent } = await vite.ssrLoadModule("/app/routes/calendar.tsx");
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(CalendarPageContent, { today: "20261005" })));
  assert.match(html, /来源：合成示例数据/);
  assert.doesNotMatch(html, /2026 年 10–12 月/);
  assert.doesNotMatch(html, /Asia\/Shanghai|共 68 条|标题中的时间|用户提供|私人演示|不代表获得|收录范围外|不属于日历条目来源|选择日期，点击/);
});

test("home calendar card keeps entry copy without explanatory small print", async () => {
  const { HomeCalendarCard } = await vite.ssrLoadModule("/app/routes/home.tsx");
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(HomeCalendarCard, { today: "20261005" })));
  assert.match(html, /天象日历/);
  assert.doesNotMatch(html, /来源：|2026 年 10–12 月|按日期浏览/);
});

let vite: ViteDevServer;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" });
});
after(async () => { await vite?.close(); });

test("whole event cards open a native detail with source text and a 44px close target", async () => {
  const html = await calendar("20261002");
  assert.match(html, /<button[^>]*data-calendar-event/);
  assert.match(html, /2026-10-02 · 来源：合成示例数据/);
  const { CalendarDialog } = await vite.ssrLoadModule("/app/features/calendar/CalendarDialog.tsx");
  const item = { id: "SYNTH_test", date: "20261002", title: "合成示例标题（04:52）", description: "示例说明\n第二行" };
  const detail = renderToStaticMarkup(createElement(CalendarDialog, { item, onClose: () => {}, returnFocusTo: null }));
  assert.match(detail, /<dialog[^>]*aria-labelledby/);
  assert.ok(detail.indexOf(item.title) < detail.indexOf("2026-10-02 · 来源：合成示例数据"));
  assert.match(detail, /2026-10-02 · 来源：合成示例数据/);
  assert.ok(detail.includes(item.description));
  assert.match(detail, /min-h-11 min-w-11/);
  const empty = renderToStaticMarkup(createElement(CalendarDialog, { item: { ...item, description: "" }, onClose: () => {}, returnFocusTo: null }));
  assert.doesNotMatch(empty, /data-event-description/);
});

async function calendar(date: string) {
  const { Calendar } = await vite.ssrLoadModule("/app/features/calendar/Calendar.tsx");
  return renderToStaticMarkup(createElement(Calendar, { initialDate: date }));
}

test("selected day shows only its original events and empty days stay blank", async () => {
  const html = await calendar("20261002");
  assert.match(html, /合成示例天象：示例条目（04:52）/);
  assert.match(html, /合成示例天象：同日第二条/);
  const details = html.split('aria-label="所选日期的天象"')[1]!.split("</section>")[0]!;
  assert.doesNotMatch(details, /月初示例条目/);
  assert.match(html, /2026 年 10 月/);
  assert.match(html, /上一月/);
  assert.match(html, /下一月/);
  assert.match(html, /今天/);
  assert.doesNotMatch(html, /2026 年 10–12 月/);
  assert.match(html, /aria-pressed="true"/);
  const empty = await calendar("20261007");
  assert.doesNotMatch(empty, /data-calendar-event|暂无|无天象|没有|fallback/);
});

test("day cells expose original titles without nested controls and keep empty dates blank", async () => {
  const rows: { date: string; title: string }[] = JSON.parse(readFileSync(new URL("../app/features/calendar/events.json", import.meta.url), "utf8"));
  const html = await calendar("20261002");
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  for (const date of ["20261002", "20261007", ...new Set(rows.filter((r) => r.date.startsWith("202610")).map((r) => r.date))]) {
    const label = `${date.slice(0,4)}年${Number(date.slice(4,6))}月${Number(date.slice(6))}日`;
    const cell = buttons.find(b => b[1].includes(`aria-label="${label}"`))!;
    const items = rows.filter((r) => r.date === date);
    for (const event of items.slice(0, 2)) assert.ok(cell[2].includes(event.title), event.title);
    assert.doesNotMatch(cell[2], /<button|<a /);
    assert.equal((cell[2].match(/data-calendar-title/g) ?? []).length, Math.min(2, items.length));
    if (items.length > 2) assert.ok(cell[2].includes(`+${items.length - 2}`));
  }
});

test("daily masthead links to its report date and summarizes only that date's static events", async () => {
  const { ReportPaper } = await vite.ssrLoadModule("/app/features/report/ReportPaper.tsx");
  const render = (kind: string, key: string) => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ReportPaper, {
    report: { kind, key, issueNumber: 1, metrics: {}, readingMinutes: 1, sections: [], flashes: [], highlights: [], prev: null, next: null }, index: [],
  })));
  const html = render("daily", "2026-10-02");
  assert.match(html, /href="\/calendar\?date=2026-10-02"/);
  assert.match(html, /天象日历/);
  const summary = html.split('data-report-events=""')[1]!.split("</p>")[0]!;
  assert.match(summary, /今日天象：/);
  assert.doesNotMatch(summary, /来源：合成示例数据/);
  assert.match(html, /tracking-\[0\.36em\]/);
  assert.match(summary, /合成示例天象：示例条目（04:52）/);
  assert.match(summary, /合成示例天象：同日第二条/);
  assert.doesNotMatch(summary, /月初示例条目/);
  assert.match(html, /<canvas/); // Publication mini-calendar is still present.
  const empty = render("daily", "2026-10-07");
  assert.doesNotMatch(empty, /href="\/calendar\?date=2026-10-07"|今日天象|天象日历/);
  assert.doesNotMatch(empty, /data-report-events|暂无天象/);
  for (const [kind, key] of [["weekly", "2026-W40"], ["monthly", "2026-10"]]) {
    assert.doesNotMatch(render(kind, key), /data-report-events|天象日历|\/calendar\?date=/);
  }
});
