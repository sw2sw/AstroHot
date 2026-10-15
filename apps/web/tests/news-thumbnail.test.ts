import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { FeedItemSummary } from "@aihot/contracts/site";

let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });
const item: FeedItemSummary = {
  id: "news-1", title: "哈勃发现新线索", summary: "新闻摘要", reason: null,
  source: { name: "ESA Hubble" }, publishedAt: "2026-10-06T00:00:00Z", timelineAt: "2026-10-06T00:00:00Z",
  category: null, tags: [], score: null, selected: false, channel: "news", x: null,
};
const thumbnail = {
  kind: "image" as const, url: "/api/media/hubble", srcSet: "/api/media/hubble-small 320w, /api/media/hubble 640w",
  width: 2000, height: 1000, alt: "Artist’s concept", poster: null,
  caption: "艺术家概念图（非实拍）", credit: "NASA, ESA, L. Hustak (STScI)", attributionUrl: "https://esahubble.org/images/heic2613a/",
};
async function render(value: FeedItemSummary) {
  const { FeedItem } = await vite.ssrLoadModule("/app/features/feed/FeedItem.tsx");
  return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(FeedItem, { item: value })));
}

test("approved news image is compact, responsive and preserves full caption and credit outside the whole-card link", async () => {
  const html = await render({ ...item, thumbnail });
  const image = html.match(/<img\b[^>]*>/)?.[0];
  assert.ok(image, "approved thumbnail must render");
  assert.match(image, /src="\/api\/media\/hubble"/);
  assert.match(image, /srcSet="[^"]+320w[^"]+640w"/);
  assert.match(image, /sizes="[^"]+"/);
  assert.match(image, /loading="lazy"/);
  assert.match(image, /decoding="async"/);
  assert.match(image, /object-contain/);
  assert.match(html, /max-w-\[220px\]/);
  assert.match(html, /data-news-layout="image-text"/);
  assert.match(html, /@\[520px\]:grid-cols-\[220px_minmax\(0,1fr\)\]/);
  assert.match(html, /aspect-\[16\/9\]/);
  const caption = html.match(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/)?.[0];
  assert.ok(caption);
  assert.match(caption, /艺术家概念图（非实拍）/);
  assert.match(caption, /NASA, ESA, L\. Hustak \(STScI\)/);
  assert.match(caption, /truncate/);
  assert.match(caption, /title="艺术家概念图（非实拍） · NASA, ESA, L\. Hustak \(STScI\)"/);
  assert.match(caption, /aria-label="艺术家概念图（非实拍） · NASA, ESA, L\. Hustak \(STScI\)；打开详情查看完整署名"/);
  assert.match(caption, /href="\/items\/news-1"/);
  assert.doesNotMatch(caption, /href="https:|target="_blank"/);
  assert.match(caption, /relative z-10/);
  const cardLink = [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0]).find(a => a.includes('href="/items/news-1"') && a.includes('after:absolute'));
  assert.ok(cardLink);
  assert.match(cardLink, /class="[^"]*after:absolute after:inset-0/);
  for (const [anchor] of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) assert.equal([...anchor.matchAll(/<a\b/g)].length, 1, "anchors must not nest");
});
