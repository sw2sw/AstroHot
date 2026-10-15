// The arXiv candidate archive's page-number navigation (features/arxiv/ArxivPagination.tsx).
//
// The route is server-rendered through the real module, so these assertions are about the markup a
// reader and a crawler actually receive: real links with the filter and page size preserved, the
// current page marked with aria-current, and no link to a page that does not exist.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });

const paper = {
  paper_key: "test", title_zh: "论文中文标题", title_original: "Paper original title", summary_zh: "研究摘要与科学结果",
  reason_zh: "理由", study_type: "observation", categories: ["astro-ph.GA"], arxiv_id: "2610.03572v1",
  submitted_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", url: "https://arxiv.org/abs/2610.03572",
};
const feedOf = (over: Record<string, unknown> = {}) => ({
  page: 1, pageSize: 20, total: 1, mode: "pilot", issueDate: "2026-10-05", lastSyncedAt: null, coverage: null,
  note: "", contentTag: "", admittedAt: null, groups: [], latestBatch: { outcome: "selected", paperCount: 1, selectedCount: 1 },
  items: [paper], ...over,
});
async function render(feed: unknown, category: string | null = null) {
  const { ArxivPageContent } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
  return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ArxivPageContent as never, { feed, category })));
}
/** The hrefs the reader can really click, with the HTML escaping undone. */
const hrefs = (html: string) => [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

test("a multi-page archive offers clickable page numbers and marks the current page", async () => {
  const html = await render(feedOf({ page: 1, pageSize: 20, total: 205 }));
  // 205 / 20 = 10.25 -> 11 pages, and the reader is told both numbers.
  assert.match(html, /第 1 页 · 共 11 页 · 205 条/);
  assert.match(html, /<nav aria-label="候选分页"/);
  assert.match(html, /aria-current="page"/);
  const links = hrefs(html);
  assert.ok(links.includes("/arxiv?page=2&pageSize=20"), "the second page is a real link");
  assert.ok(links.includes("/arxiv?page=11&pageSize=20"), "the last page is reachable in one click");
  // Every page link is a real anchor, so the whole control is keyboard reachable and shareable.
  for (const p of [2, 11]) assert.match(html, new RegExp(`<a[^>]*href="/arxiv\\?page=${p}&amp;pageSize=20"`));
});

test("the filter and the page size travel with every page link", async () => {
  const html = await render(feedOf({ page: 2, pageSize: 50, total: 400 }), "astro-ph.GA");
  const links = hrefs(html);
  assert.ok(links.includes("/arxiv?page=3&pageSize=50&category=astro-ph.GA"), "the next page keeps the filter and the page size");
  assert.ok(links.includes("/arxiv?page=1&pageSize=50&category=astro-ph.GA"), "and so does the previous page");
  // The filter chips themselves always point at the first page of their own filter.
  const all = links.filter((href) => href.includes("category=astro-ph.HE"));
  assert.ok(all.length > 0);
  for (const href of all) assert.ok(!href.includes("page=2"), "changing the filter starts from page 1");
});

test("the ends of the archive are honest: no previous on the first page, no next on the last", async () => {
  const first = await render(feedOf({ page: 1, pageSize: 20, total: 205 }));
  assert.doesNotMatch(first, /上一页/, "the first page has nothing before it");
  assert.match(first, /下一页/);
  const last = await render(feedOf({ page: 11, pageSize: 20, total: 205 }));
  assert.doesNotMatch(last, /下一页/, "the last page has nothing after it");
  assert.match(last, /上一页/);
  assert.match(last, /第 11 页 · 共 11 页 · 205 条/);
  assert.doesNotMatch(last, /page=12/, "no link points past the last page");
});

test("a long archive collapses the far pages into an ellipsis but keeps the first, last and neighbours", async () => {
  const html = await render(feedOf({ page: 6, pageSize: 20, total: 205 }));
  assert.match(html, /…/, "the gap between the neighbours and the ends collapses");
  const links = hrefs(html);
  for (const p of [1, 5, 6, 7, 11]) assert.ok(links.includes(`/arxiv?page=${p}&pageSize=20`), `page ${p} stays reachable`);
  assert.ok(!links.includes("/arxiv?page=3&pageSize=20"), "a far page is not rendered");
  assert.ok(!links.includes("/arxiv?page=9&pageSize=20"), "a far page is not rendered");
});

test("an empty archive and a single-page one render no pager at all", async () => {
  const empty = await render(feedOf({ page: 1, pageSize: 20, total: 0, items: [] }));
  assert.doesNotMatch(empty, /候选分页/, "nothing to page through");
  assert.doesNotMatch(empty, /上一页|下一页/);
  const single = await render(feedOf({ page: 1, pageSize: 20, total: 7 }));
  assert.doesNotMatch(single, /候选分页/, "one page needs no pager");
  assert.doesNotMatch(single, /上一页|下一页/);
});

test("a hand-typed page past the end is clamped instead of producing a broken link", async () => {
  const html = await render(feedOf({ page: 99, pageSize: 20, total: 205 }));
  const links = hrefs(html);
  assert.match(html, /第 11 页 · 共 11 页 · 205 条/);
  assert.ok(links.includes("/arxiv?page=10&pageSize=20"));
  assert.doesNotMatch(html, /page=100|page=99/, "the clamped page is what the pager links to");
});

test("the page list is the same control whatever the page size", async () => {
  const narrow = await render(feedOf({ page: 2, pageSize: 20, total: 205 }));
  const wide = await render(feedOf({ page: 2, pageSize: 50, total: 205 }));
  assert.match(narrow, /共 11 页/);
  assert.match(wide, /共 5 页/);
});

test("the page window itself keeps the first, last and neighbours", async () => {
  const { pageWindow, pageCountOf } = await vite.ssrLoadModule("/app/features/arxiv/ArxivPagination.tsx");
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 11), [1, 2, null, 11]);
  assert.deepEqual(pageWindow(6, 11), [1, null, 5, 6, 7, null, 11]);
  assert.deepEqual(pageWindow(11, 11), [1, null, 10, 11]);
  assert.deepEqual(pageWindow(2, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(1, 0), []);
  // The count is floored at one, so an empty archive is "1 page", never "0 pages".
  assert.equal(pageCountOf(0, 20), 1);
  assert.equal(pageCountOf(20, 20), 1);
  assert.equal(pageCountOf(21, 20), 2);
  assert.equal(pageCountOf(205, 20), 11);
  assert.equal(pageCountOf(10, 0), 10, "a nonsensical page size never divides by zero");
});

/**
 * The route's loader against a fake API. The read layer accepts any positive page and echoes it back
 * with an EMPTY list, so a deep page (hand-typed, bookmarked, or left over after the data shrank) must
 * be corrected in the DATA — the URL, the paper list and the pager have to name the same page. Clamping
 * only the pager's own numbers would show "page 11 of 10" over an empty list.
 */
test("an out-of-range page is corrected in the data and the URL, not only in the pager", async () => {
  const { loader } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
  const lastPage = feedOf({ page: 3, pageSize: 20, total: 45 });
  const api = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    // Every page beyond the third is a legal request the read layer answers with an empty list.
    const body = page === 3 ? lastPage : feedOf({ page, pageSize: 20, total: 45, items: [] });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = api;
  try {
    const thrown = await loader({ request: new Request("http://web.test/arxiv?page=99&pageSize=20&category=astro-ph.GA") }).then(
      () => undefined, (error: unknown) => error,
    );
    assert.ok(thrown instanceof Response, "the loader corrects the page instead of rendering an empty one");
    assert.equal((thrown as Response).status, 302);
    assert.equal(
      (thrown as Response).headers.get("Location"),
      "/arxiv?page=3&pageSize=20&category=astro-ph.GA",
      "the URL names the last page that really exists, with the filter kept",
    );
    // The corrected URL then really loads that page's papers: the list and the page number agree.
    const data = await loader({ request: new Request("http://web.test/arxiv?page=3&pageSize=20&category=astro-ph.GA") }) as {
      feed: { page: number; items: unknown[] };
    };
    assert.equal(data.feed.page, 3);
    assert.equal(data.feed.items.length, 1, "the corrected page carries real papers, not an empty list");
  } finally {
    globalThis.fetch = original;
  }
});

test("a bookmarked deep page whose data shrank lands on the new last page", async () => {
  const { loader } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
  const api = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    const body = page === 2 ? feedOf({ page: 2, pageSize: 20, total: 25 }) : feedOf({ page, pageSize: 20, total: 25, items: [] });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = api;
  try {
    const thrown = await loader({ request: new Request("http://web.test/arxiv?page=5&pageSize=20") }).then(
      () => undefined, (error: unknown) => error,
    );
    assert.ok(thrown instanceof Response);
    assert.equal((thrown as Response).headers.get("Location"), "/arxiv?page=2&pageSize=20");
  } finally {
    globalThis.fetch = original;
  }
});

test("an in-range page is served as it is, with no redirect", async () => {
  const { loader } = await vite.ssrLoadModule("/app/routes/arxiv.tsx");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(feedOf({ page: 2, pageSize: 20, total: 45 })), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const data = await loader({ request: new Request("http://web.test/arxiv?page=2&pageSize=20") }) as { feed: { page: number } };
    assert.equal(data.feed.page, 2);
  } finally {
    globalThis.fetch = original;
  }
});
