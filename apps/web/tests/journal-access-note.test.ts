// The reader-facing boundary note of a summary-backed intro: one short line on the item page, in the
// server's own wording (packages/backend/src/publication/rules.ts readerNote), never repeated as a
// second risk paragraph, and never invented by the web layer.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the item page shows the server's access note exactly once", async () => {
  const item = await source("../app/routes/item.tsx");
  assert.match(item, /const accessNote = item\.accessNote \?\? \(summaryOnly \?/, "a summary-only page keeps its own fallback wording");
  const rendered = item.match(/accessNote && <p[^>]*>\{accessNote\}<\/p>/g) ?? [];
  assert.equal(rendered.length, 1, "the boundary is stated in one place, not as several risk paragraphs");
  assert.doesNotMatch(item, /访问限制|subscription|paywall/, "no internal state or English machinery reaches the page");
});

test("a browsing card does not repeat it: the intro's boundary is stated once, where it is read", async () => {
  const card = await source("../app/features/feed/FeedItem.tsx");
  assert.doesNotMatch(card, /accessNote/);
  const pool = await source("../app/routes/all.tsx");
  assert.doesNotMatch(pool, /accessNote/);
});
