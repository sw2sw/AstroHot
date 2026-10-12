import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });
const image = { kind: "image", url: "/api/img-proxy?u=first&mode=body", srcSet: "/api/first-720 720w, /api/first-1440 1440w", width: 2000, height: 1000, alt: "恒星形成", poster: null, caption: "艺术家概念图", credit: "NASA, ESA, L. Hustak (STScI)", attributionUrl: "https://esahubble.org/images/heic2613a/" };
test("article lead image is responsive, uncropped and retains complete attribution", async () => {
 const { NewsImage } = await vite.ssrLoadModule("/app/features/item/NewsImage.tsx");
 const html = renderToStaticMarkup(createElement(NewsImage, { image, title: "新闻标题" }));
 assert.match(html, /<img\b/); assert.match(html, /object-contain/); assert.match(html, /loading="eager"/);
 assert.match(html, /720w/); assert.match(html, /1440w/); assert.match(html, /sizes=/);
 assert.match(html, /艺术家概念图/); assert.match(html, /NASA, ESA, L\. Hustak \(STScI\)/);
 assert.match(html, /href="https:\/\/esahubble.org\/images\/heic2613a\/"/);
 const caption=html.match(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/)?.[0]; assert.ok(caption); assert.doesNotMatch(caption, /truncate|line-clamp/);
});
test("missing approved image stays text-only without a placeholder", async () => {
 const { NewsImage } = await vite.ssrLoadModule("/app/features/item/NewsImage.tsx");
 assert.equal(renderToStaticMarkup(createElement(NewsImage, { image: null, title: "新闻" })), "");
});
test("both loaded article and phone preview use the shared lead-image renderer", async () => {
 const src = await readFile(new URL("../app/routes/item.tsx", import.meta.url), "utf8");
 assert.match(src, /NewsImage[^\n]*image=\{item\.newsImage\}/);
 assert.match(src, /NewsImage[^\n]*image=\{preview\.thumbnail\}/);
});
