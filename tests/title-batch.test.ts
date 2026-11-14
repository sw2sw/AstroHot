import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { enqueueTitleBatch, processArticle, processTitleBatch, queueProcessing, recordNewsRoundUsage, sweepUnprocessed } from "@aihot/backend/jobs/content";
import type { TitleBatchItem, TitleBatchRound } from "@aihot/backend/editorial/title-batch";
import { parseSelectionMaterial } from "@aihot/backend/editorial/selection-material";
import { publishArticle } from "@aihot/backend/publication/publish";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const requests: string[][] = [];
const reviewCounts: number[] = [];
const primary = "A public observatory measured three transits of Neptune, finding a repeatable spectral feature in all three measurements.";
const provider = await stub((_hit, request) => {
  const payload = JSON.parse(request.body);
  const { items: rows, reviews } = JSON.parse(payload.messages.at(-1).content) as { items: { n: number; title: string }[]; reviews: { n: number }[] };
  requests.push(rows.map((r) => r.title));
  reviewCounts.push(reviews.length);
  return { choices: [{ message: { content: JSON.stringify({ items: rows.map(({ n, title }) => ({
    n, relevance: title.includes("rocket") ? "block" : title.includes("Mystery") ? "unknown" : "pass",
    titleZh: null, category: null, review: title.includes("Spectra"), sameAs: title.includes("second report") ? 1 : null,
  })), reviews: reviews.map(({ n }) => ({ n, verdict: "select", titleZh: "海王星凌星观测", summaryZh: "三次观测均看到同一光谱特征。", evidence: primary, material: 1 })) }) } }] };
});
process.env.PREFILTER_MODEL = "qwen3.7-flash";
process.env.DASHSCOPE_BASE_URL = provider.url;
process.env.DASHSCOPE_API_KEY = "test-key";
const { config } = await import("@aihot/backend/config");
config.titleBatchEnabled = true;
const source = "title-batch-" + tag();

after(async () => { await stopBoss(); await provider.close(); await closeDb(); });

test("new headlines share one request, ordinary items retain their RSS intro or no intro, and the next round can review a candidate with primary material", async () => {
  assert.equal((await enqueueTitleBatch()).enqueued, false);
  assert.equal(provider.hits(), 0);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES (${source},'Astronomy','rss','T1','editorial',true,'2100-01-01')`;
  const captions = ["Bright galaxy", "Bright galaxy second report", "Commercial rocket", "Mystery", "Spectra of Neptune"];
  const items: TitleBatchItem[] = [];
  for (const [i, title] of captions.entries()) {
    const { articleId: id } = await upsertMaterial({
      sourceId: source, title, url: `https://example.org/${source}/${i}`, via: "fetch",
      excerpt: i === 0 ? "The original RSS introduction." : null,
      bodyText: i === 1 ? "Previously fetched content must not stand in for a missing RSS introduction." : null,
      bodyStatus: i === 1 ? "ok" : "pending", publishedAt: new Date(),
    });
    assert.equal(await queueProcessing(id), null);
    items.push({ id, revision: 1, title });
  }
  assert.equal((await processArticle(items[0]!.id)).state, "waiting-for-title-batch");
  assert.equal(provider.hits(), 0);
  await sql`UPDATE articles SET updated_at = now() - interval '2 minutes' WHERE source_id = ${source}`;
  assert.equal((await sweepUnprocessed()).enqueued, 0);
  assert.equal((await enqueueTitleBatch()).enqueued, true);
  assert.equal((await enqueueTitleBatch()).enqueued, false);
  const [job] = await sql<{ data: TitleBatchRound }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUES.titleBatch}`;
  assert.deepEqual(job?.data.items, items);
  const result = await processTitleBatch(job!.data);
  assert.ok("pass" in result);
  assert.deepEqual([result.screened, result.pass, result.block, result.unknown, result.review], [5, 3, 1, 1, 1]);
  assert.deepEqual(requests, [captions]);
  assert.equal((await processTitleBatch(job!.data)).screened, 0);
  assert.equal(provider.hits(), 1);

  const [withIntro, withoutIntro, blocked, unknown, candidate] = await Promise.all(items.map(async ({ id }) =>
    (await sql`SELECT title,summary,eligible,selected,body_mode,visibility FROM publications WHERE article_id = ${id}`)[0]!));
  assert.deepEqual(withIntro, { title: "Bright galaxy", summary: "The original RSS introduction.", eligible: true, selected: false, body_mode: "summary", visibility: "public" });
  assert.deepEqual(withoutIntro, { title: "Bright galaxy second report", summary: null, eligible: true, selected: false, body_mode: "summary", visibility: "public" });
  assert.equal(blocked?.visibility, "withdrawn");
  assert.equal(unknown?.visibility, "withdrawn");
  assert.equal(candidate?.selected, false);
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/items?mode=all" });
    assert.equal(response.statusCode, 200);
    const listed = response.json().items;
    assert.ok(listed.some((item: { id: string; summary: string | null; links: { original: string } }) =>
      item.id === items[1]!.id && item.summary === null && item.links.original === `https://example.org/${source}/1`));
    assert.ok(!listed.some((item: { id: string }) => [items[2]!.id, items[3]!.id].includes(item.id)));
  } finally {
    await app.close();
  }
  const calls = await sql`SELECT name, data->>'articleId' AS id FROM pgboss.job WHERE name IN (${QUEUES.extractBody}, ${QUEUES.analyze}, ${QUEUES.group})`;
  assert.deepEqual([...calls], []);
  const [duplicate] = await sql`SELECT output->>'possibleDuplicateOf' AS hint FROM analyses WHERE article_id = ${items[1]!.id}`;
  assert.equal(duplicate?.hint, items[0]!.id);

  const [review] = await sql<{ processing_attempt_tag: string }[]>`UPDATE articles SET body_status='unconfirmed' WHERE id = ${items[4]!.id} RETURNING processing_attempt_tag`;
  assert.equal((await processArticle(items[4]!.id, { attemptTag: review!.processing_attempt_tag })).state, "waiting-for-news-round");
  assert.equal(provider.hits(), 1);

  const evidence = parseSelectionMaterial('<meta name="citation_abstract" content="' + primary + '">', 'https://www.nature.com/articles/s41550-026-00000-0');
  assert.ok(evidence);
  assert.equal(parseSelectionMaterial('<meta name="description" content="' + primary + '">', evidence.url), null);
  const { articleId: fresh } = await upsertMaterial({ sourceId: source, title: "Saturn at opposition", url: "https://example.org/" + source + "/fresh", via: "fetch", publishedAt: new Date() });
  const next: TitleBatchRound = { items: [{ id: fresh, revision: 1, title: "Saturn at opposition" }],
    reviews: [{ ...items[4]!, tag: review!.processing_attempt_tag, materials: [evidence] }], selected: [] };
  await sql`UPDATE receipt_attempts SET origin='live' WHERE receipt_id=${result.receiptId}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('dashscope', 20, 20, 1)
    ON CONFLICT (service) DO UPDATE SET per_minute=20, per_hour=20, per_day=1`;
  const delayed = await processTitleBatch(next);
  assert.ok("waiting" in delayed);
  assert.equal(delayed.waiting, 3600);
  assert.equal(provider.hits(), 1, "batched review respects the provider's daily budget");
  await sql`UPDATE budgets SET per_day=20 WHERE service='dashscope'`;
  const combined = await processTitleBatch(next);
  assert.ok("selected" in combined);
  assert.equal(combined.screened, 1);
  assert.equal(combined.selected, 1);
  assert.equal(provider.hits(), 2);
  assert.equal((await sql`SELECT count(*)::int AS count FROM receipt_attempts WHERE service='dashscope'`)[0]!.count, 2);
  assert.deepEqual(reviewCounts, [0, 1]);
  await sql`UPDATE receipt_attempts SET started_at='2026-11-14T12:00:00+08', origin='live',
    usage='{"prompt_tokens":100,"completion_tokens":25,"total_tokens":125}'
    WHERE receipt_id=${combined.receiptId}`;
  await sql`UPDATE receipt_attempts SET started_at='2026-11-14T12:01:00+08', usage=NULL WHERE receipt_id=${result.receiptId}`;
  const nextDay = new Date("2026-11-15T00:10:00+08:00");
  assert.deepEqual(await recordNewsRoundUsage(nextDay),
    { date: "2026-11-14", calls: 2, withUsage: 1, tokensIn: 100, tokensOut: 25, tokensTotal: 125 });
  assert.equal((await processTitleBatch(next)).screened, 0);
  assert.equal((await sql`SELECT selected FROM publications WHERE article_id = ${items[4]!.id}`)[0]!.selected, true);
  await sql`UPDATE analyses SET selected = false WHERE article_id = ${items[4]!.id} AND output->>'batchedReview'='true'`;
  await publishArticle(items[4]!.id);
  const [ordinary] = await sql`SELECT title,summary,eligible,selected FROM publications WHERE article_id = ${items[4]!.id}`;
  assert.deepEqual(ordinary, { title: "Spectra of Neptune", summary: null, eligible: true, selected: false });
});
