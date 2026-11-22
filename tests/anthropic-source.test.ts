// The Anthropic science source has no official feed: its listing is read from the page's own
// structure (documented rows first, card links second), both official entries merge into ONE source
// identity deduplicated by URL, and a date is taken from the row or the detail page — never invented
// from a sitemap's lastmod. Synthetic pages on a local server; no external request.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { config, REPO_ROOT } from "@aihot/backend/config";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

config.allowPrivateNetworkFetch = true;

const T = tag();

const SCIENCE_HTML = `<!doctype html><html><body><main>
  <article class="card">
    <a href="/research/claude-black-hole-physics"><h3>Claude and the Hawking–Page transition</h3></a>
    <p>A model-assisted calculation of the Hawking–Page phase transition.</p>
    <time datetime="2026-11-17T00:00:00.000Z">Nov 17, 2026</time>
  </article>
  <article class="slide">
    <a href="/research/claude-shaped-science" aria-hidden="true"><img alt="A collage" src="/a.jpg"></a>
    <h3>Claude-shaped science</h3>
    <time>Nov 4, 2026</time>
  </article>
  <nav><a href="/research/team/alignment">Alignment</a></nav>
</main></body></html>`;

const SEARCH_HTML = `<!doctype html><html><body><ul>
  <details class="b8YdvG_details b8YdvG_card">
    <summary>
      <div class="b8YdvG_header"><p class="b8YdvG_category">Announcements</p><p class="b8YdvG_date">Oct 28, 2026</p></div>
      <div class="b8YdvG_title"><p>AI for Science expands to foundations and institutions</p></div>
    </summary>
    <div class="b8YdvG_content"><p>We are highlighting twenty scientific institutions.</p>
      <a data-component="AnchorButton" href="/news/ai-for-science-expands">View article</a></div>
  </details>
  <li data-article-id="a1">
    <a href="/research/claude-black-hole-physics"><h3>Claude and the Hawking–Page transition</h3></a>
    <p>A model-assisted calculation of the Hawking–Page phase transition.</p>
    <time datetime="2026-11-17T00:00:00.000Z">Nov 17, 2026</time>
  </li>
  <li data-article-id="a2">
    <a href="/news/introducing-a-chat-product"><h3>Introducing a new chat product</h3></a>
    <p>A consumer chat product update.</p>
  </li>
  <li data-article-id="a3">
    <a href="/research/grounded-materials-discovery"><h3>Grounded materials discovery with models</h3></a>
    <time datetime="2026-11-16">Nov 16, 2026</time>
  </li>
</ul></body></html>`;

let server: http.Server;
let base = "";
const pages: Record<string, string> = {};

before(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const body = pages[path];
    if (!body) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  pages["/science"] = SCIENCE_HTML;
  pages["/search"] = SEARCH_HTML;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const source = (overrides: Record<string, unknown> = {}) => ({
  id: `anthropic-science-${T}`, name: "Anthropic · Science（测试）", kind: "web_list",
  config: {
    url: `${base}/science`, supplementaryUrl: `${base}/search?topic=discovery`, adapter: "anthropic_science", parseMode: "html",
    allowUrlPrefixes: [`${base}/research/`, `${base}/news/`], publishedAtUtcOffset: "+00:00",
    // The shipped config's article shape: a team page under /research/ is navigation, not an article.
    // `allowed()` compares over https, so the pattern is written the same way.
    allowUrlRegex: `^${base.replace(/^http:/, "https:")}/(research/(?!team/)[^/?#]+|news/[^/?#]+)`,
    ...overrides,
  },
  tier: "T1", participation_mode: "editorial", first_party: true, interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0,
}) as never;

test("A14 both official entries merge into one identity, deduplicated by canonical URL", async () => {
  const out = await fetchWebList(source());
  const urls = out.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length, "no duplicate URL survives the merge");
  assert.ok(urls.some((u) => u.endsWith("/research/claude-black-hole-physics")), "the main entry's card is found");
  assert.ok(urls.some((u) => u.endsWith("/news/introducing-a-chat-product")), "the supplementary entry adds its rows");
  assert.equal(urls.filter((u) => u.includes("claude-black-hole-physics")).length, 1);
});

test("A16 the published date comes from the row; a row without one gets none", async () => {
  const out = await fetchWebList(source());
  const blackHole = out.find((c) => c.url.endsWith("/research/claude-black-hole-physics"))!;
  assert.equal(blackHole.publishedAt?.toISOString(), "2026-11-17T00:00:00.000Z");
  const undated = out.find((c) => c.url.endsWith("/news/introducing-a-chat-product"))!;
  assert.equal(undated.publishedAt, undefined, "no date is invented for a row that states none");
});

test("A16 a main entry that matches nothing fails instead of reporting zero new articles as success", async () => {
  pages["/empty"] = "<html><body><main><p>No cards here.</p></main></body></html>";
  await assert.rejects(() => fetchWebList(source({ url: `${base}/empty` })), /no items matched/);
});

test("A16 a failed supplementary entry leaves the main listing intact", async () => {
  const out = await fetchWebList(source({ supplementaryUrl: `${base}/missing` }));
  assert.equal(out.length, 2, "both cards of the main entry survive");
  assert.ok(out.every((c) => c.url.startsWith(`${base}/research/`)));
});

test("A15 a search-result <details> row yields its own title and plain-paragraph date", async () => {
  const only = await fetchWebList(source({ url: `${base}/search?topic=discovery`, supplementaryUrl: undefined }));
  const hit = only.find((c) => c.url.endsWith("/news/ai-for-science-expands"));
  assert.ok(hit, "the row's article link is found");
  assert.equal(hit!.title, "AI for Science expands to foundations and institutions", "the title, not the 'View article' button");
  assert.equal(hit!.publishedAt?.toISOString(), "2026-10-28T00:00:00.000Z", "the date paragraph is read");
});

test("A15 an undated carousel slide does not shadow the card that carries the date", async () => {
  const out = await fetchWebList(source({ supplementaryUrl: undefined }));
  const card = out.find((c) => c.url.endsWith("/research/claude-shaped-science"));
  assert.ok(card, "the article appears once");
  assert.equal(card!.title, "Claude-shaped science", "the heading, not the image link's empty text");
  assert.equal(card!.publishedAt?.toISOString(), "2026-11-04T00:00:00.000Z");
});

test("A15 a team page under /research/ is not an article", async () => {
  const out = await fetchWebList(source({ supplementaryUrl: undefined }));
  assert.equal(out.filter((c) => c.url.includes("/research/team/")).length, 0);
});

test("the shipped source config is what the collector accepts, disabled, and the only shared-scope sources", () => {
  const cfg = (source() as unknown as { config: Record<string, unknown> }).config;
  assert.deepEqual(unsupportedConfig("web_list", cfg), []);
  const shipped = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as {
    sources: Array<{ id: string; enabled?: boolean; kind: string; config: Record<string, unknown> }>;
  };
  const anthropic = shipped.sources.find((s) => s.id === "anthropic-science");
  assert.ok(anthropic, "the source exists under its own id");
  assert.equal(anthropic!.enabled, false, "the candidate does not switch production collection on");
  assert.equal(anthropic!.config.sharedPrefilter, true);
  assert.equal(anthropic!.kind, "web_list");
  assert.deepEqual(unsupportedConfig("web_list", anthropic!.config), []);
  const shared = shipped.sources.filter((s) => s.config.sharedPrefilter === true).map((s) => s.id).sort();
  assert.deepEqual(shared, ["anthropic-science", "rss-journal-nature", "rss-journal-scientific-american"], "exactly the three intended sources");
});
