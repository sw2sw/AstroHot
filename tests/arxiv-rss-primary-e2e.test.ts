// S4 — the whole RSS-primary chain, end to end, on the real seams and with a fake model.
//
// This file exists to answer the one question the unit-level files cannot: does a normal paper really
// travel the WHOLE road — official feed → raw evidence → paid analysis → persisted report → public
// reader — without the export API being touched even once, and does a second run of the same day cost
// no second paid call?
//
// It deliberately uses the real entries (collectScheduledArxiv, analyzePendingArxiv, loadArxivFeed)
// and a fake transport / fake model, never a pre-baked analysis result standing in for an execution.
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { stub } from './setup.ts';
import { collectScheduledArxiv, isScheduledSkip } from '../packages/backend/src/arxiv/collection-budget.ts';
import { loadArxivFeed } from '../packages/backend/src/publication/arxiv.ts';

type Slot = Awaited<ReturnType<typeof collectScheduledArxiv>>;
type CollectRun = Exclude<NonNullable<Slot>, { reason: string }>;
const ran = (value: Slot): CollectRun => {
  assert.ok(value !== undefined && !isScheduledSkip(value), 'expected the tick to run collection');
  return value as CollectRun;
};
const at = (stamp: string) => () => new Date(stamp);
const enable = () => Object.assign(process.env, { COLLECT_ENABLED: 'true', ARXIV_NATIVE_COLLECT_ENABLED: 'true' });
const withoutSupplement = () => { delete process.env.ARXIV_API_SUPPLEMENT_ENABLED; };

const ANSWER = {
  title_zh: '宇宙观测研究', summary_zh: '研究宇宙观测数据，结果仍需全文核查。', reason_zh: '摘要提出可核查的观测结果。',
  verdict: 'SELECT', study_type: 'observation',
  evidence_excerpt_index: 1,
  fulltext_review_question: '全文如何控制系统误差？',
};
/** The abstract the paid step must really be given, LaTeX and all. */
const ABSTRACT = 'Original abstract. We measure $4\\%$ with uncertainty. Final result.';

interface Spec { id: string; type?: string; day?: string; abstract?: string | null }
const rssItem = (spec: Spec) => {
  const type = spec.type ?? 'new';
  const day = spec.day ?? '07';
  // `abstract: null` drops the description entirely: a real content deficiency the batch isolates
  // per item while every other item of the same feed is stored normally.
  const description = spec.abstract === null ? undefined
    : `arXiv:${spec.id} Announce Type: ${type} \nAbstract: ${spec.abstract ?? ABSTRACT}`;
  return [
    '<item>',
    `<title>Title of ${spec.id}</title>`,
    `<link>https://arxiv.org/abs/${spec.id.replace(/v\d+$/, '')}</link>`,
    description === undefined ? '' : `<description>${description}</description>`,
    `<guid>oai:arXiv.org:${spec.id}</guid>`,
    '<category>astro-ph.CO</category>',
    `<pubDate>Wed, ${day} Oct 2026 00:00:00 -0400</pubDate>`,
    '<dc:creator>Alice Author, Bob Builder</dc:creator>',
    `<arxiv:announce_type>${type}</arxiv:announce_type>`,
    '</item>',
  ].join('');
};
const rssFeed = (items: Spec[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>astro-ph updates</title>${items.map(rssItem).join('')}</channel></rss>`;

interface RequestLog { rss: number; api: number }
/**
 * The fake transport. Without an `api` handler the export endpoint throws, so "the API was never
 * touched" is proved by the run succeeding, not merely by a counter reading zero.
 */
const transport = (feed: () => string, log: RequestLog): typeof fetch => async input => {
  const url = new URL(String(input));
  if (url.hostname === 'rss.arxiv.org') { log.rss += 1; return new Response(feed()); }
  log.api += 1;
  throw new Error('no export-API request is allowed here');
};

/** Starts the paid path against a local stub and keeps every request body it was given. */
async function withModel() {
  const api = await import('../packages/backend/src/arxiv/analyze.ts');
  const bodies: string[] = [];
  const server = await stub(async (_hit, req) => {
    bodies.push(req.body);
    return { choices: [{ message: { content: JSON.stringify(ANSWER) } }] };
  });
  Object.assign(process.env, { LLM_BASE_URL: server.url, LLM_API_KEY: 'local-fake', LLM_MODEL: 'qwen3.8:27b' });
  return { api, server, bodies };
}

const clean = async () => {
  await sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_rss_item_isolations,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_collection_state,arxiv_collection_day,arxiv_collection_schedule,arxiv_rss_cache,arxiv_analysis_claims,arxiv_analysis_retry,arxiv_papers,arxiv_reports,ops_error_events,job_runs CASCADE`;
  await sql`DELETE FROM receipts`;
};
/** The analysis floor, written the way the collector's own state row is configured. */
const setStartOn = (day: string) => sql`INSERT INTO arxiv_collection_state (key, analysis_start_on) VALUES ('astro-ph', ${day}::date) ON CONFLICT (key) DO UPDATE SET analysis_start_on = EXCLUDED.analysis_start_on`;

test('a normal paper goes feed -> raw evidence -> one paid analysis -> report -> reader with zero export-API requests', async () => {
  await clean();
  await setStartOn('2026-09-01');
  enable();
  withoutSupplement();
  const model = await withModel();
  const log: RequestLog = { rss: 0, api: 0 };
  try {
    const feed = transport(() => rssFeed([{ id: '2610.09001v1' }]), log);
    const run = ran(await collectScheduledArxiv({ fetch: feed, sleep: async () => {}, now: at('2026-10-07T01:00:00Z') }));

    // 1. Collection: the feed alone, and not one export-API request.
    assert.equal(log.api, 0, 'the whole chain never asks the export API');
    assert.equal(run.insertedPaperCount, 1);
    assert.equal(run.rssItemCount, 1);
    const [raw] = await sql<{ source: string; metadata: Record<string, unknown> }[]>`
      SELECT source, metadata FROM arxiv_raw_papers`;
    assert.equal(raw!.source, 'rss');
    assert.equal(raw!.metadata.submitted_at, null, 'the feed states no submission instant');
    assert.equal(raw!.metadata.announced_on, '2026-10-07');

    // 2. Analysis: the real paid entry, on the real abstract, exactly once.
    const first = await model.api.analyzePendingArxiv({ limit: 5, model: 'default' });
    assert.equal(first.analyzed, 1, 'the RSS paper really went through the paid step');
    assert.equal(model.server.hits(), 1, 'exactly one paid call');
    // The prompt really carried the abstract the feed published — LaTeX and all — so this is an
    // execution on the source text, never a pre-baked result standing in for one.
    const sent = JSON.parse(JSON.parse(model.bodies[0]!).messages[1].content) as { evidence_excerpts: { text: string }[] };
    const excerptText = sent.evidence_excerpts.map(excerpt => excerpt.text).join('');
    assert.ok(excerptText.includes('Original abstract') && excerptText.includes('Final result'),
      'the whole abstract reached the paid step');
    assert.ok(excerptText.includes('$4\\%$'), 'including its LaTeX, which was never stripped on the way');

    // 3. The persisted report and the public reader both say "the announcement day is what I know".
    const [paper] = await sql<{ paper: Record<string, unknown>; analysis_status: string }[]>`
      SELECT p.paper, r.analysis_status FROM arxiv_papers p JOIN arxiv_raw_papers r ON r.arxiv_id = p.paper->>'arxiv_id'`;
    assert.equal(paper!.analysis_status, 'analyzed');
    assert.equal(paper!.paper.submitted_at, null, 'no instant is invented on the way to the reader');
    assert.equal(paper!.paper.updated_at, null);
    assert.equal(paper!.paper.announced_on, '2026-10-07', 'the announcement day travels with the paper');
    assert.equal(paper!.paper.verdict, 'SELECT');

    const reader = await loadArxivFeed({ page: 1, pageSize: 20, category: null });
    assert.equal(reader.total, 1);
    const item = reader.items[0]!;
    assert.equal(item.arxiv_id, '2610.09001v1');
    assert.equal(item.submitted_at, null, 'the reader is told the instant is unknown, not handed a 1970 date');
    assert.equal(item.announced_on, '2026-10-07');
    assert.equal(item.verdict, 'SELECT');

    // 4. A later round of the same version is not a second insert and not a second paid call. The
    // document really differs (the version is re-announced as a cross-list) so a fresh batch of
    // evidence is imported; the version itself is the one already stored.
    await sql`DELETE FROM arxiv_rss_cache`;
    const second = ran(await collectScheduledArxiv({
      fetch: transport(() => rssFeed([{ id: '2610.09001v1', type: 'cross' }]), log), sleep: async () => {}, now: at('2026-10-08T01:00:00Z'),
    }));
    assert.equal(second.duplicateCount, 1, 'the version is already stored under its one identity');
    assert.equal(second.insertedPaperCount, 0);
    assert.equal(log.api, 0, 'and the later round still never asks the export API');
    const again = await model.api.analyzePendingArxiv({ limit: 5, model: 'default' });
    assert.equal(again.analyzed, 0, 'nothing is analyzed twice');
    assert.equal(model.server.hits(), 1, 'and nothing is paid for twice');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 1, 'one paper, one row');
  } finally { await model.server.close(); }
});

test('a cross-announcement is stored as evidence but stays out of the paid analysis, and the round still touches no API', async () => {
  await clean();
  await setStartOn('2026-09-01');
  enable();
  withoutSupplement();
  const model = await withModel();
  const log: RequestLog = { rss: 0, api: 0 };
  try {
    const feed = transport(() => rssFeed([{ id: '2610.09101v1' }, { id: '2610.09102v1', type: 'cross' }]), log);
    const run = ran(await collectScheduledArxiv({ fetch: feed, sleep: async () => {}, now: at('2026-10-07T01:00:00Z') }));
    assert.equal(log.api, 0, 'a cross-announcement is no reason to reach for the export API');
    assert.equal(run.insertedPaperCount, 2, 'both versions are real raw papers');

    // Both versions are real raw papers, and the paid path admits exactly the `new` announcement: a
    // cross announcement with no submission instant has no honest day inside the analysis window, and
    // the paid path must not widen to it.
    const result = await model.api.analyzePendingArxiv({ limit: 10, model: 'default' });
    assert.equal(result.analyzed, 1, 'exactly the new announcement was admitted');
    assert.equal(model.server.hits(), 1, 'and exactly one paid call was made');
    assert.deepEqual(
      (await sql<{ arxiv_id: string }[]>`SELECT arxiv_id FROM arxiv_raw_papers WHERE analysis_status='pending' ORDER BY arxiv_id`).map(row => row.arxiv_id),
      ['2610.09102v1'],
      'the cross version keeps its evidence and waits, it is not analysed and not dropped',
    );
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id='2610.09101v1' AND analysis_status='analyzed'`)[0]!.n, 1);
  } finally { await model.server.close(); }
});

test('an unreadable feed item is isolated with its own reason while its neighbour still reaches the reader', async () => {
  await clean();
  await setStartOn('2026-09-01');
  enable();
  withoutSupplement();
  const model = await withModel();
  const log: RequestLog = { rss: 0, api: 0 };
  try {
    const feed = transport(() => rssFeed([{ id: '2610.09201v1' }, { id: '2610.09202v1', abstract: null }]), log);
    const run = ran(await collectScheduledArxiv({ fetch: feed, sleep: async () => {}, now: at('2026-10-07T01:00:00Z') }));
    assert.equal(log.api, 0, 'one unreadable item is no reason to reach for the export API');
    assert.equal(run.insertedPaperCount, 1, 'the readable item was stored');
    assert.equal(run.isolatedCount, 1, 'and the unreadable one was isolated, not silently dropped');

    // The isolation is a real row with its own reason and its own raw text, committed beside the batch.
    const isolated = await sql<{ reason: string; item_sha256: string; raw_item_excerpt: string; arxiv_id: string | null }[]>`
      SELECT reason, item_sha256, raw_item_excerpt, arxiv_id FROM arxiv_rss_item_isolations`;
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0]!.reason, 'abstract_missing');
    assert.equal(isolated[0]!.arxiv_id, '2610.09202v1');
    assert.match(isolated[0]!.raw_item_excerpt, /2610\.09202v1/, 'the failed item is kept verbatim for review');
    assert.equal(isolated[0]!.item_sha256.length, 64, 'and identified by its own digest');

    // The bounded anomaly is one warning on the existing error platform, never a failed collection.
    const warnings = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE stage='arxiv.collect' AND code='rss_item_isolated'`;
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0]!.details.reasons, ['abstract_missing']);

    // And the neighbour really goes on: paid analysis, report, reader.
    assert.equal((await model.api.analyzePendingArxiv({ limit: 5, model: 'default' })).analyzed, 1);
    assert.equal(model.server.hits(), 1);
    const reader = await loadArxivFeed({ page: 1, pageSize: 20, category: null });
    assert.equal(reader.total, 1);
    assert.equal(reader.items[0]!.arxiv_id, '2610.09201v1');
    assert.equal(reader.items[0]!.submitted_at, null);
    assert.equal(reader.items[0]!.announced_on, '2026-10-07');
  } finally { await model.server.close(); }
});

test.after(async () => { await closeDb(); });
