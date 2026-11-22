// Synthetic public projections on a real migrated PostgreSQL database; no provider or collection.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { AI4S_PAGE_SIZE, loadAi4sFeed } from "../packages/backend/src/publication/ai4s.ts";

const T = tag();
const SRC = `ai4s-order-${T}`;
const now = new Date("2026-11-22T12:00:00Z");
// Seven rows per timestamp deliberately put a tie across the 40-row page boundary.
const fixtures = Array.from({ length: 83 }, (_, i) => ({
  id: `order-${T}-${String((i * 37) % 83).padStart(3, "0")}`,
  timelineAt: new Date(Date.UTC(2026, 10, 1 + Math.floor(i / 7))),
  ai4a: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
  domain: i % 2 === 0 ? "physics" : "methods-tools",
}));
// Scrambled IDs ensure timestamp order and the tie-breaker are independently exercised.
const expected = [...fixtures].sort((a, b) =>
  b.timelineAt.getTime() - a.timelineAt.getTime() || (a.id < b.id ? 1 : -1));
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((row) => row.id);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, enabled) VALUES (${SRC}, '排序合成源', 'rss', false)`;
  for (const row of fixtures) {
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, content_scope)
      VALUES (${row.id}, ${SRC}, ${row.id}, ${`https://example.invalid/${row.id}`}, '合成科研结果', ${now}, ${row.timelineAt}, 'ai4s')`;
    await sql`INSERT INTO publications (article_id, source_id, channel, url, title, summary, reason, score,
      discovered_at, published_at, sort_at, timeline_at, content_scope, eligible, selected, visible_after, domain, ai4a)
      VALUES (${row.id}, ${SRC}, 'news', ${`https://example.invalid/${row.id}`}, '合成科研结果', '合成摘要', '合成精选理由', 88,
        ${now}, ${now}, ${now}, ${row.timelineAt}, 'ai4s', true, true, ${row.timelineAt}, ${row.domain}, ${row.ai4a})`;
  }
});
after(closeDb);

test("selected and all order mixed true/false/null AI4A by timeline, not AI4A priority", async () => {
  for (const tab of ["selected", "all"] as const) {
    const feed = await loadAi4sFeed({ tab, now });
    assert.deepEqual(ids(feed.items), ids(expected.slice(0, 40)), `${tab}: global reverse chronology`);
    assert.equal(feed.total, 83);
    assert.equal(feed.pageCount, 3);
    assert.equal(feed.groups.length, 83);
    for (const item of feed.items) {
      const fixture = fixtures.find((row) => row.id === item.id)!;
      assert.equal(item.timelineAt, fixture.timelineAt.toISOString());
      assert.equal(item.ai4a, fixture.ai4a, "AI4A badge state is preserved, including null");
      assert.equal(item.domain, fixture.domain);
      assert.equal(item.selected, true);
      assert.equal(item.score, 88);
      assert.equal(item.reason, "合成精选理由");
    }
  }
});

test("timestamp ties use article id DESC consistently across 40-row pages without gaps or duplicates", async () => {
  assert.equal(AI4S_PAGE_SIZE, 40);
  assert.equal(expected[39]!.timelineAt.getTime(), expected[40]!.timelineAt.getTime(), "tie spans pages 1 and 2");
  for (const tab of ["selected", "all"] as const) {
    const pages = [];
    for (const page of [1, 2, 3]) {
      const feed = await loadAi4sFeed({ tab, page, now });
      assert.equal(feed.page, page);
      assert.deepEqual(ids(feed.items), ids(expected.slice((page - 1) * 40, page * 40)), `${tab} page ${page}`);
      pages.push(...feed.items);
    }
    assert.deepEqual(ids(pages), ids(expected));
    assert.equal(new Set(ids(pages)).size, 83);
    assert.deepEqual(ids((await loadAi4sFeed({ tab, page: 2, now })).items), ids(expected.slice(40, 80)), "repeat is stable");
    assert.equal((await loadAi4sFeed({ tab, page: 4, now })).items.length, 0);
  }
});

test("AI4A and discipline filters retain their independent membership and chronological order", async () => {
  for (const tab of ["selected", "all"] as const) {
    for (const domain of ["astro", "physics"]) {
      const matching = expected.filter((row) => domain === "astro" ? row.ai4a === true : row.domain === domain);
      const feed = await loadAi4sFeed({ tab, domain, now });
      const second = await loadAi4sFeed({ tab, domain, page: 2, now });
      assert.deepEqual(ids([...feed.items, ...second.items]), ids(matching));
      assert.equal(feed.total, matching.length);
      assert.equal(feed.groups.length, matching.length);
      if (domain === "astro") assert.ok(feed.items.every((item) => item.ai4a === true));
      else assert.ok(feed.items.some((item) => item.ai4a === false) && feed.items.some((item) => item.ai4a === null));
    }
  }
});
