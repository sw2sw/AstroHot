// Reduced local fixtures of CAS URL shapes; no live collection or paid readers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "../packages/backend/src/config.ts";
import { fetchDetail, fromHtml, fromMarkdown } from "../packages/backend/src/sources/web-list.ts";
import { unsupportedConfig } from "../packages/backend/src/sources/config-keys.ts";
import { identityKeyForUrl } from "../packages/backend/src/lib/url.ts";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";

const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
const cases = [
  ["web-bao-research", "https://www.bao.ac.cn/news/ky/", "202604/t20260401_8180092.html", ["index_7.html", "index.html", "../"]],
  ["web-pmo-research", "https://pmo.cas.cn/xwdt2019/kyjz2019/", "202604/t20260401_8180092.html", ["index_7.html", "index_4.html", "index.html", "../"]],
  ["web-shao-research", "https://shao.cas.cn/2020Ver/xwdt/kyjz/", "202604/t20260401_8180092.html", ["index_26.html", "/2020Ver/tztg/", "index.html", "../"]],
] as const;

for (const [id, base, article, navigation] of cases) {
  test(`${id}: navigation is excluded while real article links survive HTML and Markdown`, () => {
    const source = sources.find((s: SourceRow) => s.id === id) as SourceRow;
    const links = [article, ...navigation, "https://example.org/202604/t20260401_8180092.html", article + "/extra"];
    const html = `<ul class="comment_list">${links.map(href => `<li><div><a class="box-title" href="${href}">天文学科研进展新闻</a><span class="box-date right">2026/04/01</span></div></li>`).join("\n")}</ul>`;
    const md = links.map(href => `[天文学科研进展新闻](${new URL(href, base)})`).join("\n");
    const expected = [new URL(article, base).href];
    assert.deepEqual(fromHtml(html, base, source).map(c => c.url), expected);
    assert.deepEqual(fromMarkdown(md, base, source).map(c => c.url), expected);
  });
}

const fixture = readFileSync(new URL("./fixtures/cas-pmo-article.html", import.meta.url), "utf8");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/missing" ? fixture.replace("发布时间：2026年04月01日", "") : fixture);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>(resolve => server.close(() => resolve())));

test("PMO detail uses the explicit Chinese publication byline, not unrelated dates", async () => {
  const source = sources.find((s: SourceRow) => s.id === "web-pmo-research") as SourceRow;
  const got = await fetchDetail(`${local}/article`, source, { date: true, title: false, summary: false });
  assert.equal(got.publishedAt?.toISOString(), "2026-03-31T16:00:00.000Z");
  const missing = await fetchDetail(`${local}/missing`, source, { date: true, title: false, summary: false });
  assert.equal(missing.publishedAt, null, "missing authoritative byline must not use metadata or related posts");
});

// Characterize the existing identity contract: do not replace it with title-based deduplication.
test("real PMO URL aliases share identity while pagination URLs never masquerade as aliases", () => {
  const url = "https://pmo.cas.cn/xwdt2019/kyjz2019/202604/t20260401_8180092.html";
  for (const alias of [url, url + "?utm_source=repeat#top", url.replace("https:", "http:")]) {
    assert.equal(identityKeyForUrl(alias), identityKeyForUrl(url));
  }
  assert.notEqual(identityKeyForUrl(url), identityKeyForUrl(url.replace("8180092", "8180093")));
  const base = "https://pmo.cas.cn/xwdt2019/kyjz2019/";
  assert.notEqual(identityKeyForUrl(base + "index_7.html"), identityKeyForUrl(base + "index_4.html"));
});

test("seed hygiene rules are supported and unrelated sources keep list-like article URLs", () => {
  for (const source of sources) assert.deepEqual(unsupportedConfig(source.kind, source.config), []);
  const source: SourceRow = { ...sources[0], config: { url: "https://example.org/news/" } };
  assert.equal(fromHtml('<a href="/product/index.html">A real product announcement</a>', source.config.url, source).length, 1);
});
