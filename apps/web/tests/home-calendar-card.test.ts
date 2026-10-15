import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import { readFileSync } from "node:fs";
const events = JSON.parse(readFileSync(new URL("../app/features/calendar/events.json", import.meta.url), "utf8"));

let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });

async function card(today: string) {
  const { HomeCalendarCard } = await vite.ssrLoadModule("/app/routes/home.tsx");
  return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(HomeCalendarCard, { today })));
}

test("home calendar card shows date line, event line and calendar link on separate rows", async () => {
  const html = await card("20261005");
  assert.match(html, /10月5日/);
  assert.match(html, /星期一/);
  assert.match(html, /合成示例天象：示例条目/);
  assert.match(html, /天象日历/);
  assert.match(html, /href="\/calendar\?date=2026-10-05"/);
  const rows = [...html.matchAll(/data-home-row/g)].length;
  assert.equal(rows, 3);
  assert.doesNotMatch(html, /来源：|2026 年 10–12 月/);
});

test("without events the event row is absent and empty date stays quiet", async () => {
  const html = await card("20261007");
  assert.match(html, /10月7日/);
  assert.doesNotMatch(html, /今日天象|data-home-row="event"/);
  assert.match(html, /天象日历/);
  const rows = [...html.matchAll(/data-home-row/g)].length;
  assert.equal(rows, 2);
});

test("today defaults to Shanghai and stays consistent with the calendar", async () => {
  const { shanghaiDate } = await vite.ssrLoadModule("/app/features/calendar/model.ts");
  const html = await card(shanghaiDate());
  assert.ok(html.includes("天象日历"));
  assert.ok(events.some((e: { title: string; date: string }) => html.includes(e.title.slice(0, 4))) === events.some((e: { title: string; date: string }) => e.date === shanghaiDate()));
});
