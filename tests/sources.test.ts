// Listing parsers on the page shapes a text-extraction proxy returns for real sites: card links that
// wrap an image, a title attribute, http links under https prefixes, and navigation that is no post.
// Also what made articles flip between versions: in-page anchors of an HTML listing and promotions a
// feed rotates inside its posts. And a script-navigated single-page homepage whose posts have no links
// in its HTML: read without its adapter, it gave the menu (Northwind Desktop, 简体中文) as articles.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sanitizeBody, trimTrailingChrome } from "@aihot/backend/content/sanitize";
import { fetchDetail, fetchWebList, fromHtml, fromMarkdown } from "@aihot/backend/sources/web-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { noiseFiltered } from "@aihot/backend/sources/collect";

const source = (config: Record<string, unknown>) => ({ id: "test-list", config }) as never;

// A synthetic single-page site whose listing rows navigate by script, cut down: rows that carry no link
// in the HTML, the runtime's chunk map, the route table naming the homepage's chunks, and the chunk
// with the Blog list among the menu, the model cards, the other sections and a Paper list built at run
// time. The whole fixture is written for this test; no page was captured from any live site.
const pages: Record<string, (cdn: string) => string> = {
  "/": (cdn) =>
    `<html><head><script defer src="${cdn}static/js/lib-react.a6be410a.js"></script><script defer src="${cdn}static/js/4752.2908c99e.js"></script>` +
    `<script defer src="${cdn}static/js/index.c5195ace.js"></script></head><body><a href="/zh/index">简体中文</a><a href="/cli">Northwind CLI</a>` +
    `<a href="/go/desktop">Northwind Desktop</a><a href="/#paper">Paper</a><a href="/#blog">Blog</a><a href="/#joinUs">Join Us</a><div id="blog-list">` +
    `<div class="blogRow-kPt4Cj" data-font-interactive="true"><h3 data-font-text="true">Measuring and Reducing Tool-Call Repetition in Northwind-1</h3></div></div></body></html>`,
  // A redesign that moved the list elsewhere.
  "/redesigned/": (cdn) => `<html><head><script defer src="${cdn}static/js/lib-react.a6be410a.js"></script></head><body><a href="/go/desktop">Northwind Desktop</a></body></html>`,
  // A feed whose teaser ends in "Read the full story", next to a post whose feed carries it whole.
  "/feed.xml": () =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<entry><title>Northwind Labs opens its research archive</title><link rel="alternate" href="https://example.org/archive"/><published>2026-09-28T17:31:35-04:00</published>` +
    `<summary type="html">Northwind Labs announced today that it is opening its research archive.</summary>` +
    `<content type="html"><![CDATA[<p>${"Northwind Labs announced today that it is opening its research archive to outside readers. ".repeat(8)}</p><p>Read the full story at Northwind Labs.</p>]]></content></entry>` +
    `<entry><title>A whole post</title><link rel="alternate" href="https://example.org/whole"/><published>2026-09-28T10:00:00Z</published>` +
    `<content type="html"><![CDATA[<p>${"The feed carries this post whole, paragraph after paragraph. ".repeat(30)}</p>]]></content></entry></feed>`,
  // A list API that gives calendar days as yyyymmdd.
  "/days.json": () => JSON.stringify({ data: { list: [{ seq: 695, ttl: "MCFlow", day: "20260922" }, { seq: 1, ttl: "Bad day", day: "20260230" }] } }),
  // A blog that carries no date in the feed or in meta tags, only in JSON-LD.
  "/ld-post": () =>
    `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Blog"},` +
    `{"@type":"BlogPosting","headline":"Structured data for a listing page","datePublished":"2026-09-24"}]}</script></head><body><p>Post</p></body></html>`,
  "/cdn/static/js/lib-react.a6be410a.js": () => '"use strict";(self.webpackChunk=self.webpackChunk||[]).push([["lib-react"],{}]);',
  "/cdn/static/js/index.c5195ace.js": (cdn) =>
    '(()=>{var e={},a={};function t(d){return a[d]}t.u=e=>"static/js/async/"+e+"."+({6159:"4efb0769",7298:"a1b2c3d4",8557:"2d420be2"})[e]+".js",' +
    `t.miniCssF=e=>""+e+".css",t.p="${cdn}",t.rv=()=>"1.3.12"})();`,
  "/cdn/static/js/4752.2908c99e.js": () =>
    '(self.webpackChunk=self.webpackChunk||[]).push([["4752"],{1:function(e,a,t){let r=[{path:"/",element:o.createElement(S),filePath:"en/index.mdx",' +
    'preload:async()=>(await S.preload(),Promise.all([t.e("7298"),t.e("6159"),t.e("8557")]).then(t.bind(t,57573))),lang:"en",version:""},' +
    '{path:"/blog/northwind-1-tool-call-repetition",element:o.createElement(k),filePath:"en/blog/northwind-1-tool-call-repetition.mdx",' +
    'preload:async()=>(await k.preload(),Promise.all([t.e("7298"),t.e("3583"),t.e("8421")]).then(t.bind(t,1105))),lang:"en",version:""}]}}]);',
  "/cdn/static/js/async/7298.a1b2c3d4.js": () => '(self.webpackChunk=self.webpackChunk||[]).push([["7298"],{2:function(){}}]);',
  "/cdn/static/js/async/6159.4efb0769.js": () => '(self.webpackChunk=self.webpackChunk||[]).push([["6159"],{3:function(e,i,t){t.d(i,{H:()=>n})}}]);',
  "/cdn/static/js/async/8557.2d420be2.js": () =>
    '(self.webpackChunk=self.webpackChunk||[]).push([["8557"],{57573:function(e,i,t){function h(e){return(0,n.jsxs)(a.Me,{children:[' +
    '(0,n.jsx)(m.H,{models:[{name:"Northwind-1 series",desc:"Frontier intelligence, all the modalities, built in public.",imageKey:"northwind-1",link:"/northwind-1"}]}),' +
    '(0,n.jsx)(d.z,{sectionTitle:"Build with Northwind",experiences:[{title:"Northwind Gallery",link:"/northwind-gallery/",desc:"Step into the world created by Northwind-1"}]}),' +
    '(0,n.jsx)(r.K,{sectionId:"paper",sectionTitle:"Paper",blogs:l.G.slice().reverse().map(e=>({title:e.title,link:`/paper/${e.slug}`,desc:(0,l.V)(e.date,!1)}))}),' +
    '(0,n.jsx)(r.K,{sectionTitle:"Blog",initialVisibleCount:8,blogs:[' +
    '{title:"Measuring and Reducing Tool-Call Repetition in Northwind-1",link:"/blog/northwind-1-tool-call-repetition",desc:"A lesson from scaling RL: the reward blind spot in optimizing for correctness."},' +
    '{title:"Introducing the Northwind-1 series",link:"/northwind-1",desc:"Frontier intelligence, all the modalities, built in public."},' +
    '{title:"How Northwind-1-Pro Speeds Up Materials R\\u0026D",link:"/blog/northwind-1-materials",desc:"From literature review to \\"dry-lab\\" experiments."},' +
    '{title:"Northwind-0.5-Pro",link:"/northwind-0-5-pro/index.html",desc:"A leap in agentic and long horizon coherence."},' +
    '{title:"Northwind Language Capability Assessment",link:"/blog/northwind-1-hss",desc:"Northwind Language Capability Assessment"}]}),' +
    '(0,n.jsx)(c.Q,{sectionTitle:"Join Us",positions:[{title:"Research Scientist - Pre-training",link:"joinUs/pre-training"}],contactEmail:"hello@example.org"})]})}}}]);',
};
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  const found = Object.hasOwn(pages, path);
  res.writeHead(found ? 200 : 404, { "content-type": path.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8" });
  res.end(found ? pages[path]!(`${site}/cdn/`) : "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("proxy card links become posts with their own titles", () => {
  const md = [
    "[Skip to main content](http://example.org/blog/#main)",
    "[![Image 1: hero](https://cdn.example.org/a.jpg) ##### 示例发布GE-Act 2.0 新闻资讯 | 2026-09-20](https://example.org/blog/220.html \"示例发布GE-Act 2.0\")",
    "[![Image 2](https://cdn.example.org/b.png) ##### 示例 18 Pro Max 测评 尾巴视频](http://example.org/blog/784.html)",
    "[![Image 3](https://cdn.example.org/c.png)](https://example.org/blog/carousel.html)",
    "# [Introducing v6](http://example.org/blog/introducing-v6)",
    "[2026](http://example.org/blog/2026) [Algorithms & Theory](http://example.org/blog/label/algorithms) [Next page](http://example.org/blog/page/2)",
  ].join("\n\n");
  const out = fromMarkdown(md, "https://example.org", source({ url: "https://r.jina.ai/http://example.org/blog/", allowUrlPrefixes: ["https://example.org/blog/"] }));
  assert.deepEqual(out, [
    { url: "https://example.org/blog/220.html", title: "示例发布GE-Act 2.0" },
    { url: "https://example.org/blog/784.html", title: "示例 18 Pro Max 测评 尾巴视频" },
    { url: "https://example.org/blog/introducing-v6", title: "Introducing v6" },
  ]);
});

test("anchors into the listing page itself are navigation, not posts", () => {
  // A script-navigated homepage links its own sections (#paper, #blog, #join): all one address once the fragment goes.
  const html = [
    '<a href="/#paper">Paper</a>', '<a href="/#blog">Blog</a>', '<a href="https://example.org/#join">Join Us</a>',
    '<a href="/">Home</a>', '<a href="/blog/northwind-1-tool-call">Reducing Tool-Call Repetition</a>',
  ].join("");
  const out = fromHtml(html, "https://example.org/", source({ url: "https://example.org/" }));
  assert.deepEqual(out.map((c) => c.url), ["https://example.org/blog/northwind-1-tool-call"]);
});

test("posts addressed by a query on the listing's path are posts, its pages and filters are not", () => {
  // WordPress plain permalinks: every post is /?p=N on the listing's own path.
  const links: [string, string][] = [
    ["/?p=123", "First research announcement"], ["/?p=456&lang=en", "Second research announcement"],
    ["/?utm_source=nav", "Home with tracking"], ["/?paged=2", "Older posts page"], ["/?cat=3", "Research category"], ["/#about", "About this site"],
  ];
  const html = links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("");
  const md = links.map(([href, text]) => `[${text}](https://example.org${href})`).join("\n\n");
  const posts = ["https://example.org/?p=123", "https://example.org/?p=456&lang=en"];
  assert.deepEqual(fromHtml(html, "https://example.org/", source({ url: "https://example.org/" })).map((c) => c.url), posts);
  assert.deepEqual(fromMarkdown(md, "https://example.org/", source({ url: "https://r.jina.ai/https://example.org/" })).map((c) => c.url), posts);
  // The listing's own query in another order, with tracking and a page number, is still the listing.
  const filtered = source({ url: "https://example.org/news?lang=en&kind=ai" });
  const out = fromHtml('<a href="/news?kind=ai&lang=en&utm_medium=x&page=2">Next page of news</a><a href="/news?kind=ai&lang=en&id=7">A news post</a>', "https://example.org/", filtered);
  assert.deepEqual(out.map((c) => c.url), ["https://example.org/news?kind=ai&lang=en&id=7"]);
  // Hosts still compare as written: www is another host.
  assert.equal(fromHtml('<a href="https://www.example.org/">Home on www</a>', "https://example.org/", source({ url: "https://example.org/" })).length, 1);
});

test("promotions a feed rotates inside its posts are left out of the body", () => {
  // A research feed puts a different podcast or product promotion into each post on every load.
  const promo = (label: string, name: string) =>
    `<div class="border-bottom border-top mt-5 mb-5 sample-promo text-center alignwide" data-bi-aN="promo">` +
    `<p class="sample-promo__label text-uppercase"><span>${label}</span></p><div class="row"><div class="sample-promo__content">` +
    `<h2 class="h4">${name}</h2><p>Join our researchers.</p><a href="https://example.org/podcast">Listen now</a></div></div></div>`;
  const post = (p: string) => `<p>Our runtime is now available in the tools scientists use.</p>${p}<p>From community release to native integration.</p>`;
  const a = sanitizeBody(post(promo("PODCAST SERIES", "Ideas Weekly")), "https://example.org/post");
  const b = sanitizeBody(post(promo("", "Foundry Weekly")), "https://example.org/post");
  assert.equal(a, b, "the same post whichever promotion it carried");
  assert.ok(!/PODCAST SERIES|Ideas Weekly|Foundry Weekly|Listen now/.test(a));
  assert.ok(a.includes("native integration"), "the post's own text stays");
});

test("a script-navigated homepage lists its posts and model pages, not its menu", async () => {
  const out = await fetchWebList(source({ url: `${site}/`, adapter: "mimo_home" }));
  assert.deepEqual(out, [
    { url: `${site}/blog/northwind-1-tool-call-repetition`, title: "Measuring and Reducing Tool-Call Repetition in Northwind-1", excerpt: "A lesson from scaling RL: the reward blind spot in optimizing for correctness." },
    { url: `${site}/northwind-1`, title: "Introducing the Northwind-1 series", excerpt: "Frontier intelligence, all the modalities, built in public." },
    { url: `${site}/blog/northwind-1-materials`, title: "How Northwind-1-Pro Speeds Up Materials R&D", excerpt: 'From literature review to "dry-lab" experiments.' },
    { url: `${site}/northwind-0-5-pro/index.html`, title: "Northwind-0.5-Pro", excerpt: "A leap in agentic and long horizon coherence." },
    { url: `${site}/blog/northwind-1-hss`, title: "Northwind Language Capability Assessment", excerpt: null },
  ]);
});

test("a script-navigated homepage without the list fails the fetch instead of listing its menu", async () => {
  await assert.rejects(fetchWebList(source({ url: `${site}/redesigned/`, adapter: "mimo_home" })), /mimo_home/);
});

test("a listing that links other articles in its teasers takes only the links that begin a line", () => {
  // A news index through a text-extraction proxy: each headline stands on its own line; its teaser links older stories inline.
  const md = [
    "### [Panel critics question the agency's new draft rule](https://example.org/2026/09/27/panel)",
    "[![Image 3: Briefing](https://example.org/a.jpg)](https://example.org/2026/09/27/briefing)",
    "[Scoop: the agency's chair to meet industry groups](https://example.org/2026/09/27/briefing)",
    "[How the coastal survey lost three weeks to storms](https://example.org/2026/09/25/survey)[![Image 12: Survey](https://example.org/b.jpg)](https://example.org/2026/09/25/survey)",
    "The survey's two harbour stations were closed Friday, capping a [turbulent three weeks](https://example.org/2026/09/15/survey-loop).",
    "**Why it matters:** compute is energy-hungry. [Budget debates](https://example.org/2026/09/24/budget) can slow progress.",
    "[Go deeper (3 min. read)](https://example.org/2026/09/25/survey)",
  ].join("\n\n");
  const config = { url: "https://r.jina.ai/https://example.org/technology", allowUrlPrefixes: ["https://example.org/2"], linksStartLine: true };
  assert.deepEqual(fromMarkdown(md, "https://example.org", source(config)).map((c) => c.title), [
    "Panel critics question the agency's new draft rule",
    "Scoop: the agency's chair to meet industry groups",
    "How the coastal survey lost three weeks to storms",
  ]);
  assert.equal(fromMarkdown(md, "https://example.org", source({ ...config, linksStartLine: undefined })).length, 5, "without the option prose links count");
});

test("feed text that only teases the article is a summary: the page is fetched before judging", async () => {
  const read = await fetchRss({ id: "test-feed", config: { feedUrl: `${site}/feed.xml` }, participation_mode: "editorial", cursor: null } as never, { force: true });
  const [teaser, whole] = read.candidates;
  assert.equal(teaser!.bodyStatus, "pending");
  assert.equal(teaser!.bodyText, null);
  assert.equal(teaser!.excerpt, "Northwind Labs announced today that it is opening its research archive.");
  assert.equal(whole!.bodyStatus, "ok");
  assert.ok(whole!.bodyText!.length > 1200);
  // Discussion sources only need what the feed says.
  const signal = await fetchRss({ id: "test-feed", config: { feedUrl: `${site}/feed.xml` }, participation_mode: "hot_signal", cursor: null } as never, { force: true });
  assert.equal(signal.candidates[0]!.bodyStatus, "ok");
});

test("hidden page parts are dropped whole, and a news page's closing blocks are trimmed", () => {
  // A model vendor's posts carry <template> blocks of base64 that became 330,000 characters of "body".
  const html = sanitizeBody(
    `<p>Our transcription model is our most capable transcription model.</p><template><div><p>${"QUFB".repeat(500)}</p></div></template>` +
      `<svg><text>chart label</text></svg><p>Energy <math><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></math> matters.</p>`,
    "https://example.org/post",
  );
  assert.ok(!/QUFB|chart label|mc\^2/.test(html), html);
  assert.ok(html.includes("most capable transcription model") && html.includes("Energy E matters"));
  // A linked chart in a paragraph of its own survives, also when a translation is cleaned again.
  const chart = '<p><a href="https://example.org/chart.png"><img src="https://example.org/chart.png" alt="GPU prices"></a></p>';
  assert.ok(sanitizeBody(sanitizeBody(`<p>Prices doubled.</p>${chart}<p> </p>`)).includes('alt="GPU prices"'));
  assert.equal(sanitizeBody("<p>Text.</p><p> <br></p><p><a href=\"https://example.org/\"></a></p>"), "<p>Text.</p>");
  // A tech news site ends every article the same way.
  const article = "<p>The vendor’s shares dropped by more than 17%.</p><h2>Topics</h2><p>More on the deal.</p><p>Subscribe to our plan to get the API.</p>";
  assert.equal(trimTrailingChrome(`${article}<p>Topics</p><p>Subscribe for the industry’s biggest tech news</p><h2>Latest in AI</h2>`), article);
  assert.equal(trimTrailingChrome(article), article);
});

test("noise words match whatever their case", () => {
  // 笔记本 is noise, but the lower-case exemption agent keeps a post about an Agent product.
  const source = { config: { ingestNoiseFilter: { dropMarkers: ["笔记本", "iphone"], keepIfMatches: ["agent"] } } } as never;
  const c = (title: string, excerpt: string) => ({ url: "https://example.org/a", title, excerpt }) as never;
  assert.equal(noiseFiltered(c("示例：正组建团队开发面向国内市场的产品", "与笔记本厂商合作的 Agent 产品"), source), false);
  assert.equal(noiseFiltered(c("新款笔记本开售", "首发价 4999 元"), source), true);
  assert.equal(noiseFiltered(c("iPhone 18 开售", ""), source), true);
});

test("dates in yyyymmdd and in JSON-LD are read", async () => {
  const days = await fetchJsonList({ id: "test-json", config: { url: `${site}/days.json`, itemsPath: "data.list", titlePaths: ["ttl"], urlTemplate: "https://example.org/blog/view?seq={seq}", publishedAtPath: "day", publishedAtUnit: "yyyymmdd" } } as never);
  assert.deepEqual(days.map((c) => c.publishedAt?.toISOString() ?? null), ["2026-09-22T00:00:00.000Z", null], "February 30 is no date");
  const got = await fetchDetail(`${site}/ld-post`, { id: "test-feed", config: { detail: { maxFetches: 20 } } } as never, { date: true, title: false, summary: false, body: false });
  assert.equal(got.publishedAt?.toISOString(), "2026-09-24T00:00:00.000Z");
});
