// The AI4S column page: a registered route, and compact text-first cards that state a limited intro's
// basis, show the discipline domain and the verified AI4A badge only when earned, never invent a score
// or an image, and keep the original link. Synthetic items rendered through the shared card.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Ai4sItemSummary } from "@aihot/contracts/site";

let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });

const item = (over: Partial<Ai4sItemSummary> = {}): Ai4sItemSummary => ({
  id: "a1", title: "格点定义证明", summary: "一个短摘要。", reason: null,
  source: { name: "SYNTHETIC Science" }, publishedAt: "2026-11-15T22:00:01.000Z", timelineAt: "2026-11-15T22:00:01.000Z",
  category: null, tags: [], score: null, selected: false, channel: "news", x: null,
  originalTitle: "A lattice proof of the Standard Model", links: { original: "https://example.invalid/ai4s/research-demo" },
  domain: null, ai4a: null, accessNote: null, ...over,
});

async function renderCard(it: Ai4sItemSummary) {
  const { Ai4sCard } = await vite.ssrLoadModule("/app/routes/ai4s.tsx");
  const router = createMemoryRouter([{ path: "/", element: createElement(Ai4sCard, { item: it, read: false, onOpen: () => {}, at: it.timelineAt }) }]);
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test("the AI4S column is a registered route reading the shared API", () => {
  assert.match(readFileSync(new URL("../app/routes.ts", import.meta.url), "utf8"), /route\("ai4s", "routes\/ai4s.tsx"\)/);
  const src = readFileSync(new URL("../app/routes/ai4s.tsx", import.meta.url), "utf8");
  assert.match(src, /\/api\/site\/ai4s/, "the page reads the public API, not the database");
  assert.doesNotMatch(src, /@aihot\/backend\/db|from "\.\.\/\.\.\/\.\.\/packages\/backend/, "no DB bypass");
});

test("the desktop sidebar and phone more page list the AI4S column as an in-app route", async () => {
  const { SIDEBAR } = await vite.ssrLoadModule("/app/components/shell/nav.ts") as typeof import("../app/components/shell/nav");
  const entry = SIDEBAR.flatMap((s) => s.items).find((i) => i.to === "/ai4s");
  assert.ok(entry, "AI4S appears in the desktop sidebar menu");
  assert.match(entry.label, /AI4S/);
  assert.equal(entry.reloadDocument, undefined, "a React route, no document reload");
  const { Sidebar } = await vite.ssrLoadModule("/app/components/shell/Sidebar.tsx");
  const { default: More } = await vite.ssrLoadModule("/app/routes/more.tsx");
  for (const Component of [Sidebar, More]) {
    const router = createMemoryRouter([{ id: "root", path: "/", element: createElement(Component, { changelogVersion: null }) }]);
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    assert.match(html, /href="\/ai4s"/, "the rendered navigation links to /ai4s");
    assert.match(html, /AI4S 科研/);
  }
});

test("a limited intro shows its basis and source, with no score and no image; the original link lives in the detail", async () => {
  const html = await renderCard(item({ domain: "research-meta", ai4a: false, accessNote: "本介绍依据原文公开摘要整理。" }));
  assert.match(html, /格点定义证明/);
  assert.match(html, /一个短摘要。/);
  assert.match(html, /SYNTHETIC Science/);
  assert.match(html, /本介绍依据原文公开摘要整理。/);
  assert.match(html, /科研动态与政策/, "the domain is shown as its label, not a backend enum");
  assert.match(html, /href="\/items\/a1"/, "the card opens the native detail, where the original link lives");
  assert.doesNotMatch(html, /href="https:\/\/example\.invalid/, "the external original link is in the detail, not on the card");
  assert.doesNotMatch(html, /原文 ↗/, "no card-footer original anchor");
  assert.doesNotMatch(html, /AI 评分/, "no invented score on an unscored intro");
  assert.doesNotMatch(html, /<img/, "text-only: the column has no image permission");
  assert.doesNotMatch(html, /天文相关/, "a non-astronomy item carries no AI4A badge");
});

test("the original title goes through the math renderer and is marked English (long formula stays contained)", async () => {
  const html = await renderCard(item({ originalTitle: "A long result $$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$ end" }));
  assert.match(html, /lang="en"/, "the original title is marked as the source language");
  assert.match(html, /katex/, "a formula in the original title is rendered, not left as raw TeX");
  assert.match(html, /math-(inline|block)/, "the formula uses the site's contained math element, not a raw string");
  assert.doesNotMatch(html, /\$\$\\int/, "the raw delimiter is not exposed");
});

test("empty states describe the current filter only, never guessing backend state", async () => {
  const { Ai4sPageContent } = await vite.ssrLoadModule("/app/routes/ai4s.tsx");
  const empty = (over: Record<string, unknown>) => ({
    tab: "all", domain: null, items: [], page: 1, pageCount: 1, total: 0, updatedAt: null, contentTag: "tag-empty", groups: [], ...over,
  });
  const render = (data: unknown) => {
    const router = createMemoryRouter([{ path: "/", element: createElement(Ai4sPageContent, { data }) }]);
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  };
  const selected = render(empty({ tab: "selected" }));
  assert.match(selected, /这个筛选下暂无精选内容/);
  assert.doesNotMatch(selected, /人工精选尚未开始|尚未开始/, "no claim about whether manual selection ever started");
  const astro = render(empty({ domain: "astro" }));
  assert.match(astro, /当前筛选下没有经过原文证据核验的天文相关/);
  const all = render(empty({}));
  assert.match(all, /当前筛选下暂无已收录的科研进展/);
  assert.doesNotMatch(all, /来源启用并完成首批导入/, "no guess about source enablement or first import");
});

test("the AI4S detail intro is bilingual: Chinese beside the published original text on wide screens, stacked on phones", async () => {
  const { Ai4sIntro } = await vite.ssrLoadModule("/app/features/item/Ai4sIntro.tsx");
  const html = renderToStaticMarkup(createElement(Ai4sIntro, {
    summary: "中文导读。", originalAbstract: "The official English abstract.", originalLabel: "官方摘要（原文）", label: "摘要",
  }));
  assert.match(html, /lg:grid-cols-2/, "wide screens place the two languages side by side");
  assert.match(html, /中文导读。/);
  assert.match(html, /lang="en"/, "the original text is marked English");
  assert.match(html, /The official English abstract\./);
  assert.match(html, /官方摘要（原文）/, "the heading is the server's label for what the text actually is");
  // A readable fragment is not an official abstract: the heading follows the label it was sent.
  const fragment = renderToStaticMarkup(createElement(Ai4sIntro, {
    summary: "中文导读。", originalAbstract: "Only the opening paragraph was readable.", originalLabel: "公开可读片段（原文）", label: "摘要",
  }));
  assert.match(fragment, /公开可读片段（原文）/);
  assert.doesNotMatch(fragment, /官方摘要（原文）/, "a public fragment is never presented as an official abstract");
  const stacked = renderToStaticMarkup(createElement(Ai4sIntro, { summary: "中文导读。", originalAbstract: null, label: "摘要" }));
  assert.doesNotMatch(stacked, /lg:grid-cols-2/, "without a foreign excerpt there is nothing to place beside the intro");
  assert.doesNotMatch(stacked, /官方摘要（原文）/);
  const src = readFileSync(new URL("../app/routes/item.tsx", import.meta.url), "utf8");
  assert.match(src, /contentScope === "ai4s"/, "the bilingual intro is scoped to the AI4S column, leaving astronomy's detail unchanged");
  assert.match(src, /<Ai4sIntro/, "the detail wires the bilingual intro");
  assert.match(src, /item\.originalAbstractLabel/, "the detail passes the server's label instead of inventing one");
});

test("the AI4A badge appears only for a verified astronomy application, and the astronomy domain is not printed twice beside it", async () => {
  const verified = await renderCard(item({ domain: "astronomy-astrophysics", ai4a: true, score: 85, accessNote: null }));
  assert.match(verified, /天文相关（AI4A）/);
  assert.doesNotMatch(verified, /天文与天体物理/, "the badge already says the astronomy application; the domain label would repeat it");
  assert.match(verified, /85/);
  const unverified = await renderCard(item({ domain: "astronomy-astrophysics", ai4a: null }));
  assert.doesNotMatch(unverified, /天文相关/, "an ungrounded claim is not a verified astronomy application");
  assert.match(unverified, /天文与天体物理/, "a domain chip on its own still shows");
  const groundedOtherDomain = await renderCard(item({ domain: "methods-tools", ai4a: true }));
  assert.match(groundedOtherDomain, /天文相关（AI4A）/);
  assert.match(groundedOtherDomain, /科研方法与工具/, "a non-astronomy domain is a separate fact from the AI4A badge, so both stay");
  const both = await renderCard(item({ domain: "physics", ai4a: true }));
  assert.match(both, /天文相关（AI4A）/);
  assert.match(both, /物理/);
});
test("the astronomy AI4A filter is labelled as the verified subset it is", () => {
  const src = readFileSync(new URL("../app/routes/ai4s.tsx", import.meta.url), "utf8");
  assert.match(src, /\{ key: "astro", label: "天文相关（AI4A）" \}/, "the filter names the AI4A subset, not a second discipline");
});
test("the list remembers which card opened an article, so closing it returns focus there", async () => {
  const src = readFileSync(new URL("../app/routes/ai4s.tsx", import.meta.url), "utf8");
  assert.match(src, /rememberOrigin\(item\.id\)/, "the card records itself before navigating");
  assert.match(src, /useReturnFocus\(\)/, "the list claims the record and restores focus");
});
