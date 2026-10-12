import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
let vite: ViteDevServer;
// fileURLToPath, not `.pathname`: on Windows the latter is `/D:/…`, which Vite resolves to `D:\D:\…`.
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });

test("the topic document is served at its resource route with the bundled banner", async () => {
  assert.match(readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8"), /route\("nobel", "routes\/nobel.ts"\)/);
  const route = await vite.ssrLoadModule("/app/routes/nobel.ts");
  // A resource route: no component export, the document is returned as-is.
  assert.equal(route.default, undefined);
  const response = route.loader();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/html/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const html = await response.text();
  assert.match(html, /合成演示/);
  assert.match(html, /非真实获奖信息/);
  assert.match(html, /2 项待揭晓/);
  // The placeholder is replaced by the bundled asset, and no unresolved path survives.
  assert.match(html, /nobel-demo-banner/);
  assert.doesNotMatch(html, /merged-assets\//);
  assert.doesNotMatch(html, /\{\{NOBEL_PENDING_SUMMARY\}\}/);
  assert.match(html, /<dialog id="prizeDialog"/);
  for (const id of ["mergeSearch", "filters", "detailNav", "closeDetail", "mobileTheme"]) assert.ok(html.includes(`id="${id}"`), id);
  for (const href of ["/", "/all", "/arxiv", "/imagery", "/calendar", "/more"]) assert.ok(html.includes(`href="${href}"`), href);
});

test("the shipped document carries no third-party text, laureates or award facts", async () => {
  const source = readFileSync(new URL("../app/features/nobel/demo.html", import.meta.url), "utf8");
  // The document is written by this project, so it must say so and must not borrow a real record.
  assert.match(source, /合成演示数据 · 非真实获奖信息/);
  assert.doesNotMatch(source, /Kagan|Soai|Carson|Pillay|NobelPrize\.org|nobelprize\.org/i);
  assert.doesNotMatch(source, /https?:\/\/(?!www\.w3\.org)/i);
});

test("pending summary follows calendar states without claiming official verification", async () => {
  const route = await vite.ssrLoadModule("/app/routes/nobel.ts");
  const source = readFileSync(new URL("../app/features/nobel/demo.html", import.meta.url), "utf8");
  const calendarStart = source.indexOf('<section class="card cal"');
  assert.ok(calendarStart > 0, "the demo document keeps a calendar section");
  const prefix = source.slice(0, calendarStart);
  const calendar = source.slice(calendarStart);
  for (const pending of [2, 1, 0]) {
    let remaining = 2 - pending;
    const updated = calendar.replace(/>待揭晓<\/span>/g, (status) => remaining-- > 0 ? '>已揭晓</span>' : status);
    const html = route.pendingSummary(prefix + updated);
    assert.ok(html.includes(`${pending} 项待揭晓`), `${pending} 项待揭晓`);
    assert.doesNotMatch(html, /待官方核验|\{\{NOBEL_PENDING_SUMMARY\}\}/);
  }
});

test("homepage exposes a prominent topic banner above the card row", async () => {
  const { HomeNobelLink } = await vite.ssrLoadModule("/app/routes/home.tsx");
  assert.equal(typeof HomeNobelLink, "function");
  const router = createMemoryRouter([{ path: "/", element: createElement(HomeNobelLink) }]);
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  assert.match(html, /href="\/nobel"/);
  assert.match(html, /诺贝尔奖 2026 专题/);
  assert.match(html, /查看专题/);
  assert.match(html, /非真实获奖信息/);
});

test("desktop sidebar and phone more page expose navigation to the topic", async () => {
  const { SIDEBAR } = await vite.ssrLoadModule("/app/components/shell/nav.ts") as typeof import("../app/components/shell/nav");
  assert.equal(SIDEBAR.flatMap(s => s.items).find(i => i.to === "/nobel")?.reloadDocument, true);
  const { Sidebar } = await vite.ssrLoadModule("/app/components/shell/Sidebar.tsx");
  const { default: More } = await vite.ssrLoadModule("/app/routes/more.tsx");
  for (const Component of [Sidebar, More]) {
    const router = createMemoryRouter([{ id: "root", path: "/", element: createElement(Component, { changelogVersion: null }) }]);
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    assert.match(html, /href="\/nobel"/);
    assert.match(html, /诺贝尔奖 2026/);
  }
});
