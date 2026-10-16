// S4 — the RSS-primary round, and the optional API supplement that may never endanger it.
//
// The ordinary round reads the official announcement feed and stores the papers the feed carries; it
// issues ZERO export-API requests. That is proved here by a transport that counts every request by
// host and REFUSES the export endpoint wherever it must not be reached, so a stray API call fails the
// test instead of passing unnoticed.
//
// The optional supplement is a separate, explicitly-enabled step. When it fails, the papers the feed
// already stored stay exactly as they are, the ordinary counters survive, and the round closes as a
// PARTIAL one — the day is not re-run six hours later and the result is not rewritten as a total
// failure. The one failure that is deliberately never swallowed is a shared HTTP429: it freezes the
// whole channel through the durable hold, so no later RSS or API request is made either.
//
// Everything below drives the real scheduled entry (collectScheduledArxiv) against a fake transport.
// No test reaches the network: the tests that must prove "no request was made" count requests, they
// do not assume.
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { config } from '../packages/backend/src/config.ts';
import { collectScheduledArxiv, isScheduledSkip } from '../packages/backend/src/arxiv/collection-budget.ts';
import { findArxivHttpError } from '../packages/backend/src/arxiv/http.ts';

/** Where recordOpsError keeps the documents it is told to keep offline. */
const evidenceDir = path.join(config.dataDir, 'ops', 'error-evidence');
const evidenceRow = (code: string) => sql<{
  evidence_ref: string | null; evidence_sha256: string | null; evidence_truncated: boolean;
  details: Record<string, unknown>;
}[]>`
  SELECT evidence_ref,evidence_sha256,evidence_truncated,details FROM ops_error_events
  WHERE stage='arxiv.collect' AND code=${code}`;

type Slot = Awaited<ReturnType<typeof collectScheduledArxiv>>;
type CollectRun = Exclude<NonNullable<Slot>, { reason: string }>;
const ran = (value: Slot): CollectRun => {
  assert.ok(value !== undefined && !isScheduledSkip(value), 'expected the tick to run collection');
  return value as CollectRun;
};
const skipped = (value: Slot) => {
  assert.ok(value !== undefined && isScheduledSkip(value), 'expected the tick to be skipped');
  return value;
};
const at = (stamp: string) => () => new Date(stamp);
const enable = () => Object.assign(process.env, { COLLECT_ENABLED: 'true', ARXIV_NATIVE_COLLECT_ENABLED: 'true' });
/** The supplement is OFF unless a test turns it on: this IS the production default under test. */
const withoutSupplement = () => { delete process.env.ARXIV_API_SUPPLEMENT_ENABLED; };
const withSupplement = () => { process.env.ARXIV_API_SUPPLEMENT_ENABLED = 'true'; };
/**
 * The LEGACY ordinary submission-date window is a SEPARATE switch, also off unless a test asks for it.
 * Nothing here enables it implicitly: asking for the supplement must never bring the window back, and
 * that is exactly what several tests below assert with a transport that counts every request.
 */
const withoutWindow = () => { delete process.env.ARXIV_API_WINDOW_ENABLED; };
const withWindow = () => { process.env.ARXIV_API_WINDOW_ENABLED = 'true'; };

interface FeedItem { id: string; type?: string; day?: string; abstract?: string | null }
/**
 * A feed shaped like the official one. `abstract: null` drops the description entirely, which is the
 * one content deficiency that leaves the ANNOUNCEMENT in place while the item cannot become a paper —
 * exactly the shape of "a real gap the optional supplement could ask the API about".
 */
const feedFor = (items: FeedItem[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>astro-ph updates</title>${items.map(item => {
    const type = item.type ?? 'new';
    const day = item.day ?? '07';
    const description = item.abstract === null ? undefined
      : `arXiv:${item.id} Announce Type: ${type} \nAbstract: ${item.abstract ?? `Abstract of ${item.id}.`}`;
    return [
      '<item>',
      `<title>Title of ${item.id}</title>`,
      `<link>https://arxiv.org/abs/${item.id.replace(/v\d+$/, '')}</link>`,
      description === undefined ? '' : `<description>${description}</description>`,
      `<guid>oai:arXiv.org:${item.id}</guid>`,
      '<category>astro-ph.CO</category>',
      `<pubDate>Wed, ${day} Oct 2026 00:00:00 -0400</pubDate>`,
      '<dc:creator>Alice Author, Bob Builder</dc:creator>',
      `<arxiv:announce_type>${type}</arxiv:announce_type>`,
      '</item>',
    ].join('');
  }).join('')}</channel></rss>`;

/** A well-formed export-API page answering exactly the ids it was asked about. */
const atomFor = (ids: string[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${ids.length}</opensearch:itemsPerPage>${ids.map(id => `<entry><id>https://arxiv.org/abs/${id}</id><title>API title ${id}</title><summary>API summary ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;

interface RequestLog { rss: number; api: number; hrefs: string[] }
const newLog = (): RequestLog => ({ rss: 0, api: 0, hrefs: [] });
/**
 * The fake transport for both official endpoints. It counts every request by host and keeps the hrefs,
 * so a test asserts on what was REALLY asked for. Without an `api` handler the export endpoint throws
 * — the strongest possible statement of "this request must not happen".
 */
const transport = (options: { feed: () => string; api?: (url: URL) => Response | Promise<Response>; log: RequestLog }): typeof fetch => async input => {
  const url = new URL(String(input));
  options.log.hrefs.push(url.href);
  if (url.hostname === 'rss.arxiv.org') { options.log.rss += 1; return new Response(options.feed()); }
  options.log.api += 1;
  if (options.api === undefined) throw new Error('no export-API request is allowed here');
  return options.api(url);
};
const apiIds = (log: RequestLog) => log.hrefs.filter(href => href.startsWith('https://export.arxiv.org'))
  .map(href => new URL(href).searchParams.get('id_list'));
/** The legacy window's own requests: the ones that carry a submission-date range instead of an id_list. */
const windowQueries = (log: RequestLog) => log.hrefs
  .filter(href => href.startsWith('https://export.arxiv.org'))
  .map(href => new URL(href))
  .filter(url => url.searchParams.has('search_query'));

const clean = async () => {
  await sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_rss_item_isolations,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_collection_state,arxiv_collection_day,arxiv_collection_schedule,arxiv_rss_cache,arxiv_analysis_claims,arxiv_analysis_retry,arxiv_papers,arxiv_reports,ops_error_events,job_runs CASCADE`;
  await sql`DELETE FROM receipts`;
};
const day = async (key: string) => (await sql<{ attempts: number; last_outcome: string | null; completed_at: Date | null }[]>`
  SELECT attempts,last_outcome,completed_at FROM arxiv_collection_day WHERE day=${key}::date`)[0]!;
const rawRows = () => sql<{ arxiv_id: string; source: string; first_batch_hash: string | null; first_rss_batch_hash: string | null; metadata: Record<string, unknown> }[]>`
  SELECT arxiv_id,source,first_batch_hash,first_rss_batch_hash,metadata FROM arxiv_raw_papers ORDER BY arxiv_id`;
const events = (code: string) => sql<{ severity: string; details: Record<string, unknown> }[]>`
  SELECT severity,details FROM ops_error_events WHERE stage='arxiv.collect' AND code=${code}`;

// ---------------------------------------------------------------------------------------------
// The ordinary round: the feed alone, and not one export-API request.
// ---------------------------------------------------------------------------------------------

test('the default RSS round issues zero export-API requests, even though that endpoint would throw if asked', async () => {
  await clean();
  enable();
  withoutSupplement();
  withoutWindow();
  const log = newLog();
  // No `api` handler at all: reaching the export endpoint is an immediate, unmistakable failure.
  const fake = transport({ feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', type: 'cross' }]), log });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.equal(log.api, 0, 'the ordinary round never asks the export API');
  assert.equal(log.rss, 1, 'and it really read the announcement feed exactly once');
  assert.equal(run.apiSupplementAttempted, false, 'the supplement is off by default and was not attempted');
  assert.equal(run.status, 'imported');
  assert.equal(run.rssItemCount, 2, 'the feed really listed two items');
  assert.equal(run.insertedPaperCount, 2, 'and both normal papers were really stored from the feed');

  const rows = await rawRows();
  assert.deepEqual(rows.map(row => row.arxiv_id), ['2610.07001v1', '2610.07002v1']);
  for (const row of rows) {
    assert.equal(row.source, 'rss', 'the row names the feed as its origin');
    assert.equal(row.first_batch_hash, null, 'it is not waiting on an Atom batch that never existed');
    assert.notEqual(row.first_rss_batch_hash, null, 'its evidence is the announcement batch it was read from');
    assert.equal(row.metadata.submitted_at, null, 'the feed states no submission instant, so none is invented');
    assert.equal(row.metadata.updated_at, null);
    assert.equal(row.metadata.announced_on, '2026-10-07', 'the announcement day is the only day that is known');
  }
  assert.equal((await day('2026-10-07')).last_outcome, 'collected', 'a round that really stored papers closes the day');
});

test('a round whose feed carries already-stored versions stores nothing new and is empty, not productive', async () => {
  await clean();
  enable();
  withoutSupplement();
  withoutWindow();
  const log = newLog();
  const dayOne = transport({ feed: () => feedFor([{ id: '2610.07001v1' }]), log });
  assert.equal(ran(await collectScheduledArxiv({ fetch: dayOne, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') })).insertedPaperCount, 1);
  // Day two publishes a DIFFERENT document — the same version re-announced as a cross-list — so a
  // brand-new batch of evidence is really imported while the version itself is already stored. The
  // cache row is cleared so the next day really refetches instead of replaying the cached answer.
  await sql`DELETE FROM arxiv_rss_cache`;
  const dayTwo = transport({ feed: () => feedFor([{ id: '2610.07001v1', type: 'cross' }]), log });
  const second = ran(await collectScheduledArxiv({ fetch: dayTwo, sleep: async () => {}, now: at('2026-10-08T05:30:00Z') }));
  assert.equal(second.rssItemCount, 1, 'the feed really listed one item');
  assert.equal(second.duplicateCount, 1, 'and that version was already stored, from the first source that described it');
  assert.equal(second.insertedPaperCount, 0, 'nothing new was really stored');
  assert.ok(second.newContentCount > 0, 'the re-announcement is still real evidence this round carried');
  assert.equal(log.api, 0, 'and a feed of only duplicates still never reaches the export API');
  const state = await day('2026-10-08');
  assert.equal(state.last_outcome, 'empty', 'a feed of only duplicates is not a productive round');
  assert.equal(state.completed_at, null, 'so the day keeps its retry budget');
  // One paper, one identity: the second document added evidence, never a second row.
  assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07001v1']);
});

// ---------------------------------------------------------------------------------------------
// The optional supplement: default-off, gap-only, and never able to rewrite the RSS result.
// ---------------------------------------------------------------------------------------------

test('the supplement is only attempted when explicitly enabled, and its hydration asks for exactly the version the feed could not store', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  // One usable item and one whose description carries no abstract: the announcement is real evidence,
  // the item cannot become a paper, and that gap is the ONLY thing the supplement may ask about.
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: url => new Response(atomFor((url.searchParams.get('id_list') ?? '').split(',').filter(Boolean))),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.equal(run.apiSupplementAttempted, true, 'the explicitly enabled supplement really ran');
  assert.equal(run.isolatedCount, 1, 'the feed item with no abstract was isolated rather than dropped');
  // The only per-id request the round made is the one gap the feed left: the version the feed already
  // stored is never asked about again.
  assert.deepEqual(apiIds(log).filter((ids): ids is string => ids !== null), ['2610.07002v1']);
  assert.equal(log.api, 1, 'the explicitly enabled supplement is ONE request — the gap-fill — and the ordinary window stays closed');
  assert.deepEqual(windowQueries(log), [], 'and not one submission-date window query was issued by the supplement');
  assert.equal(run.hydrationCandidates, 1, 'and the round saw exactly that one candidate');
  assert.equal(run.hydrationIngested, 1, 'which the API really answered');
  assert.equal(run.insertedPaperCount, 2, 'the feed paper and the supplemented one were both really stored');

  const rows = await rawRows();
  assert.deepEqual(rows.map(row => row.arxiv_id), ['2610.07001v1', '2610.07002v1']);
  assert.equal(rows[0]!.source, 'rss', 'the first paper is the feed\'s own row');
  assert.equal(rows[0]!.metadata.submitted_at, null, 'and it still invents no submission instant');
  assert.equal(rows[1]!.source, 'atom', 'the gap was filled by the API, so its row names the API as the origin');
  assert.notEqual(rows[1]!.metadata.submitted_at, null, 'and it carries the instant the API really stated');

  assert.equal(run.apiSupplementFailed, undefined, 'a supplement that worked reports no failure');
  assert.equal(run.partial, false);
  assert.equal(run.complete, true);
  assert.equal((await day('2026-10-07')).last_outcome, 'collected');
});

test('a supplement that fails at the HTTP level only records its own failure: the stored RSS papers and result survive', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => new Response('the export API is unwell today', { status: 503 }),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.equal(run.apiSupplementAttempted, true);
  assert.match(String(run.apiSupplementFailed), /503/, 'the supplement failure is named on the result');
  assert.equal(run.insertedPaperCount, 1, 'the paper the feed already stored is still counted');
  assert.equal(run.status, 'imported', 'the main-path status is kept, not rewritten as a failure');
  assert.equal(run.partial, true, 'the round is partial: something real was stored, something else was not');
  assert.equal(log.api, 1, 'the round does not go on to scan the ordinary submission window after the API failed');

  // The paper is still in the table, still an RSS row with its honest, date-free metadata.
  const rows = await rawRows();
  assert.deepEqual(rows.map(row => row.arxiv_id), ['2610.07001v1']);
  assert.equal(rows[0]!.source, 'rss');
  assert.equal(rows[0]!.metadata.submitted_at, null);

  const state = await day('2026-10-07');
  assert.equal(state.last_outcome, 'partial', 'a partial round that stored something closes the day');
  assert.notEqual(state.completed_at, null, 'and it is not re-run six hours later');

  const supplement = await events('api_supplement_failed');
  assert.equal(supplement.length, 1, 'the supplement failure is its own, single, visible record');
  assert.equal(supplement[0]!.severity, 'warning', 'and it is a warning, not a failed collection');
  assert.equal(supplement[0]!.details.hydrationCandidates, 1, 'naming the gap it was trying to fill');
  assert.equal((await events('source_http_failed')).length, 0,
    'the supplement failure is not duplicated into a main-path source failure');
  assert.equal((await events('rate_limited')).length, 0, 'and it is not dressed up as a rate limit');
});

test('a supplement that times out is the same kind of its own failure, and the feed still never costs a second request', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => { throw new Error('arXiv request timed out after 90000ms'); },
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.match(String(run.apiSupplementFailed), /timed out/);
  assert.equal(run.insertedPaperCount, 1);
  assert.equal(run.partial, true);
  assert.equal(log.api, 1, 'a supplement that could not reach the API is not retried as an ordinary window scan');
  assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07001v1']);
  assert.equal((await day('2026-10-07')).last_outcome, 'partial');
  assert.equal((await events('api_supplement_failed')).length, 1);
});

test('a supplement that answers with something that is not Atom fails the same way, without touching the stored papers', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => new Response('<html><body>not an Atom feed at all</body></html>'),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.ok(run.apiSupplementFailed !== undefined, 'a body that is not Atom is a supplement failure too');
  assert.equal(run.insertedPaperCount, 1, 'and it cannot reach back and undo the stored feed papers');
  assert.equal(run.partial, true);
  assert.equal(log.api, 1);
  assert.equal((await events('api_supplement_failed')).length, 1);
});

test('a supplement batch rejected by the version red line is its own classification, beside kept RSS papers', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  // The gap is 2610.07002v1; the API answers the same BASE id as a DIFFERENT version. That is not a
  // hiccup — the batch is judged and refused as a whole, and nothing of it is stored.
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => new Response(atomFor(['2610.07002v2'])),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.match(String(run.apiSupplementBatchRejected), /whole batch rejected/,
    'the rejection is named on the result as the rejection it is');
  assert.equal(run.apiSupplementFailed, undefined, 'it is NOT flattened into the ordinary transport failure');
  assert.equal(run.partial, true);
  assert.equal(run.insertedPaperCount, 1, 'the feed paper is untouched by the rejected batch');
  assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07001v1'],
    'the ordinary RSS paper of this round is kept — the rejection never rolls it back');
  assert.equal((await day('2026-10-07')).last_outcome, 'partial');

  const rejected = await events('api_supplement_batch_rejected');
  assert.equal(rejected.length, 1, 'the settlement classifies the rejection on its own event');
  assert.equal(rejected[0]!.severity, 'warning');
  assert.deepEqual(rejected[0]!.details.ordinaryRssPapersKept, true,
    'and it states explicitly that the round keeps its ordinary RSS result beside the refusal');
  assert.deepEqual(
    { responses: rejected[0]!.details.supplementResponses, ingested: rejected[0]!.details.supplementIngested, inserted: rejected[0]!.details.supplementInserted },
    { responses: 0, ingested: 0, inserted: 0 },
    'a wholly rejected first batch has committed nothing of its own');
  assert.equal((await events('batch_rejected')).length, 1,
    'the batch\'s own offline rejection record exists beside the settlement event');
  assert.equal((await events('api_supplement_failed')).length, 0,
    'and the rejection is never double-reported as an ordinary supplement failure');
});

test('an ordinary supplement HTTP failure carries the response evidence the transport captured', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => new Response('the export API is unwell today', { status: 503 }),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  assert.match(String(run.apiSupplementFailed), /503/);
  assert.equal(run.apiSupplementBatchRejected, undefined, 'a 503 is a transport fault, not a judged refusal');
  const supplement = await events('api_supplement_failed');
  assert.equal(supplement.length, 1);
  const details = supplement[0]!.details;
  assert.equal(details.httpStatus, 503, 'the event carries the real HTTP status');
  assert.equal(details.failedBodyBytes, Buffer.byteLength('the export API is unwell today'),
    'and how many bytes of the origin\'s own error body were really kept');
  assert.equal(details.failedBodyTruncated, false, 'and that the body was not cut to the byte budget');
  assert.deepEqual(
    { responses: details.supplementResponses, ingested: details.supplementIngested, inserted: details.supplementInserted },
    { responses: 0, ingested: 0, inserted: 0 },
    'nothing of the failed batch was committed, and the event says so');

  // The bytes are not just COUNTED — the origin's own response document is kept offline through the
  // SAME evidence channel every other collect failure uses, so the event can be judged without the
  // connection. The record names the endpoint that really answered and the status it answered with.
  const [kept] = await evidenceRow('api_supplement_failed');
  assert.ok(kept!.evidence_ref, 'the failure body is written offline, not just measured');
  assert.ok(kept!.evidence_sha256, 'and it is hashed');
  assert.equal(kept!.evidence_truncated, false);
  const storedBody = await readFile(path.join(evidenceDir, `${kept!.evidence_sha256}.txt`), 'utf8');
  assert.equal(storedBody, 'the export API is unwell today', 'the kept file is the origin\'s own body, byte for byte');
  assert.equal(kept!.evidence_sha256,
    createHash('sha256').update(Buffer.from('the export API is unwell today', 'utf8')).digest('hex'),
    'the hash names exactly the bytes that were kept');
  assert.equal(kept!.details.evidenceHost, 'export.arxiv.org', 'the evidence names the endpoint that answered');
  assert.equal(kept!.details.evidencePath, '/api/query');
  assert.equal(kept!.details.evidenceStatus, 503);
});

test('a supplement failure body cut by the byte budget keeps the real prefix as evidence and says so', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  // The budget bounds the feed too, so derive it from the feed itself: the feed passes intact, the
  // failure body does not.
  const feed = feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]);
  const budget = Buffer.byteLength(feed) + 16;
  const oversized = 'X'.repeat(budget + 500);
  const fake = transport({ feed: () => feed, api: () => new Response(oversized, { status: 503 }), log });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'), maxBytes: budget }));

  assert.match(String(run.apiSupplementFailed), /503/);
  const [kept] = await evidenceRow('api_supplement_failed');
  assert.ok(kept!.evidence_ref, 'the retained prefix is still real evidence and is kept offline');
  assert.equal(kept!.evidence_truncated, true, 'and the record says the body was cut, never "complete"');
  const storedBody = await readFile(path.join(evidenceDir, `${kept!.evidence_sha256}.txt`), 'utf8');
  assert.equal(storedBody, 'X'.repeat(budget), 'the file is the received prefix, cut exactly where the budget ends');
  assert.equal(kept!.details.failedBodyBytes, budget);
  assert.equal(kept!.details.failedBodyTruncated, true);
  assert.equal(kept!.details.evidenceStatus, 503);
});

test('a supplement timeout honestly reports that no response evidence exists at all', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => { throw new Error('arXiv request timed out after 90000ms'); },
    log,
  });
  ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));

  const details = (await events('api_supplement_failed'))[0]!.details;
  assert.equal(details.httpStatus, null, 'a timeout never saw an origin response, so no status is invented');
  assert.equal(details.failedBodyBytes, 0, 'and no bytes are claimed for a body that never arrived');
  assert.equal(details.failedBodyTruncated, false);
  // A timeout carries NO evidence of any kind: no offline body is forged, nothing is hashed, and no
  // endpoint fields are dressed up as if a document had been kept.
  const [kept] = await evidenceRow('api_supplement_failed');
  assert.equal(kept!.evidence_ref, null, 'no offline body is forged for a response that never arrived');
  assert.equal(kept!.evidence_sha256, null);
  assert.equal(kept!.evidence_truncated, false);
  assert.equal(kept!.details.evidenceHost, undefined, 'and no evidence source is claimed without a body');
  assert.equal(kept!.details.evidenceStatus, undefined);
});

test('a dead feed stays THE failure even when the supplement beside it committed real work', async () => {
  await clean();
  enable();
  withoutSupplement();
  withoutWindow();
  // Round one (day 07): a good feed with one gap and the supplement off — the announcement for the
  // gap is now recorded with no raw version behind it, so a LATER round has something to supplement.
  const firstLog = newLog();
  const first = ran(await collectScheduledArxiv({
    fetch: transport({ feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]), log: firstLog }),
    sleep: async () => {}, now: at('2026-10-07T05:30:00Z'),
  }));
  assert.equal(first.insertedPaperCount, 1);
  assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07001v1']);

  // Round two (day 08): the feed is DEAD — not one parseable byte — while the supplement answers its
  // gap normally and commits. The round reports the FEED failure, now carrying that committed work.
  withSupplement();
  const log = newLog();
  await assert.rejects(
    () => collectScheduledArxiv({
      fetch: transport({
        feed: () => '<html><body>this is not the announcement feed</body></html>',
        api: url => new Response(atomFor((url.searchParams.get('id_list') ?? '').split(',').filter(Boolean))),
        log,
      }),
      sleep: async () => {}, now: at('2026-10-08T05:30:00Z'),
    }),
    (error: Error & { supplementCommittedBesideTheFailure?: { responses: number; ingested: number; inserted: number } }) => {
      assert.match(error.message, /arXiv announcement feed failed/,
        'the main-source failure is what the round reports — not a productive partial');
      assert.match(error.message, /committed beside this failure: 1 response\(s\), 1 ingested, 1 inserted\)$/,
        'and the committed auxiliary work is stated on the failure itself');
      assert.deepEqual(error.supplementCommittedBesideTheFailure, { responses: 1, ingested: 1, inserted: 1 },
        'as a structured field as well as in the message');
      return true;
    });
  assert.equal(log.api, 1, 'the supplement really ran beside the dead feed and committed its one answer');
  assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07001v1', '2610.07002v1'],
    'the supplemented version is really stored — a failed feed does not erase committed auxiliary work');
  assert.equal((await day('2026-10-08')).last_outcome, 'failed',
    'the day is NOT closed on a dead feed, however much auxiliary work was stored');
});

// ---------------------------------------------------------------------------------------------
// The one failure that is never swallowed: a shared 429 freezes the whole channel.
// ---------------------------------------------------------------------------------------------

test('a 429 during the supplement establishes the shared hold and still keeps the productive feed result', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: () => new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } }),
    log,
  });
  const thrown = await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') })
    .then(() => undefined, (error: unknown) => error);
  // RSS-U4: a 429 on the SUPPLEMENT is an auxiliary failure. The shared hold is established first and
  // the source stops, but the round is NOT rewritten as a total failure — the papers the feed really
  // stored keep their result, and the day closes on what was really collected.
  assert.equal(thrown, undefined, 'a supplement 429 is not a failed round');
  assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07001v1'],
    'the papers the feed stored before the API refused us are kept — a hold freezes the source, it never rolls back committed content');
  assert.equal(log.api, 1, 'the 429 aborts the round: nothing further is dispatched at all');
  assert.deepEqual(windowQueries(log), [], 'and the legacy window is not opened as a consolation');

  const held = (await sql<{ lease_until: Date | null; owner: string | null }[]>`
    SELECT lease_until,owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0];
  assert.notEqual(held?.lease_until ?? null, null, 'the durable hold really is on the row');
  assert.equal(held?.owner ?? null, null, 'and it is an ownerless hold, exactly like a manual pause');

  const rateLimited = await events('rate_limited');
  assert.equal(rateLimited.length, 1, 'the 429 is recorded as a shared rate limit');
  assert.equal(rateLimited[0]!.details.holdConfirmed, true, 'with the hold confirmed, not merely attempted');
  assert.equal((await events('api_supplement_failed')).length, 0, 'and it is never demoted to a supplement failure');

  const state = await day('2026-10-07');
  assert.equal(state.last_outcome, 'partial', 'a round that stored something real and then lost the API is a partial one');
  assert.notEqual(state.completed_at, null, 'and it closes the day on the papers that were really stored');

  // The hold still bounds the channel. The day is finished, so the tick reports that first, and the
  // hold is left exactly where the 429 put it: nothing is dispatched and nothing is cleared.
  const issued = log.hrefs.length;
  const blocked = skipped(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T11:30:22.909Z') }));
  assert.equal(blocked.reason, 'completed', 'the day is done, and it is reported as done');
  assert.equal(log.hrefs.length, issued, 'and not one further RSS or API request is made');
  const stillHeld = (await sql<{ lease_until: Date | null }[]>`
    SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0];
  assert.equal(new Date(stillHeld!.lease_until!).getTime(), new Date(held!.lease_until!).getTime(),
    'the durable hold survives the refused tick untouched');
});

test('a 429 on a round that stored nothing keeps the day open, and the hold is what blocks the retry', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  // One gap and nothing else: the feed cannot turn the item into a paper, so the supplement asks and
  // is refused. Nothing was stored anywhere, so the day must stay open for its own retry budget.
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07009v1', abstract: null }]),
    api: () => new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } }),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(run.insertedPaperCount, 0, 'nothing was really stored');
  assert.equal(run.partial, true);
  assert.equal((await day('2026-10-07')).completed_at, null, 'so the day keeps its retry budget');

  const issued = log.hrefs.length;
  const blocked = skipped(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T11:30:22.909Z') }));
  assert.equal(blocked.reason, 'rate_limited', 'the live shared hold is what refuses the retry');
  assert.equal(log.hrefs.length, issued, 'and it dispatches nothing at all');
});

test('a supplement 429 whose hold cannot be persisted fails closed instead of reporting a clean round', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07011v1' }, { id: '2610.07012v1', abstract: null }]),
    api: () => new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } }),
    log,
  });
  // RSS-U4, the half a productive result must NOT be bought with: when the 429's pause cannot be made
  // durable, this run has no right to report anything clean. The database refuses every handover to an
  // ownerless hold — the owner-conditioned write AND the conservative fallback — so the pause really is
  // unpersistable, and the run must say so instead of resolving as a partial it cannot vouch for.
  await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_hold() RETURNS trigger AS $$
   BEGIN
    IF OLD.owner IS NOT NULL AND NEW.owner IS NULL
     THEN RAISE EXCEPTION 'hold refused by the harness'; END IF;
    RETURN NEW;
   END $$ LANGUAGE plpgsql`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
  await sql`CREATE TRIGGER arxiv_test_block_hold BEFORE UPDATE ON arxiv_collection_state
   FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_hold()`;
  try {
    const thrown = await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') })
      .then(() => undefined, (error: unknown) => error);
    assert.ok(thrown !== undefined, 'an unpersistable pause is not a resolved round');
    assert.ok(thrown instanceof AggregateError, 'both facts are reported together');
    assert.ok(findArxivHttpError(thrown, 429), 'the 429 that really happened is still part of the report');
    assert.match(String(thrown), /durable cooldown commit failed/, 'and so is the pause that could not be committed');
    assert.match(String(thrown), /during the API supplement/, 'the auxiliary step it happened in is named');
    assert.match(String(thrown), /Set a durable pause as an operator before collection resumes/,
      'the operator action the failed hold demands is stated, not implied');

    // The papers the feed really stored before the API refused us are still committed: a hold that
    // could not be written never rolls content back, it only forbids pretending the round was clean.
    assert.deepEqual((await rawRows()).map(row => row.arxiv_id), ['2610.07011v1']);
    assert.equal(log.api, 1, 'the round stops at the 429: nothing further is dispatched');
    assert.deepEqual(windowQueries(log), [], 'and the legacy window is not opened as a consolation');

    // The state the run was not entitled to assume is "no pause was needed", so the lease is left owned
    // (and its term in place) rather than released into an ownerless, hold-free row.
    const state = (await sql<{ owner: string | null; lease_until: Date | null }[]>`
      SELECT owner,lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
    assert.ok(state.owner, 'the lease is kept instead of cleared into "no hold"');
    assert.ok(state.lease_until, 'and its term is left in place');

    // The warning is written even when the hold could not be: it states the hold is NOT confirmed, which
    // is the operator signal, and it is still the shared rate limit rather than a supplement failure.
    const rateLimited = await events('rate_limited');
    assert.equal(rateLimited.length, 1, 'the shared rate limit is recorded once');
    assert.equal(rateLimited[0]!.details.holdConfirmed, false, 'and it says the hold was NOT confirmed');
    assert.equal((await events('api_supplement_failed')).length, 0, 'a 429 is never demoted to a supplement failure');
  } finally {
    await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
    await sql`DROP FUNCTION IF EXISTS arxiv_test_block_hold()`;
  }
});

// ---------------------------------------------------------------------------------------------
// RSS-U3: the supplement walks a bounded amount of the backlog, and never reopens the legacy window.
// ---------------------------------------------------------------------------------------------

test('the supplement never reopens the legacy submission window, and the window still works behind its own switch', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const fake = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }, { id: '2610.07002v1', abstract: null }]),
    api: url => new Response(atomFor((url.searchParams.get('id_list') ?? '').split(',').filter(Boolean))),
    log,
  });
  const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(run.apiSupplementAttempted, true, 'the supplement really ran');
  assert.equal(log.api, 1, 'and the gap-fill is the round\'s ONLY export-API request');
  assert.deepEqual(windowQueries(log), [], 'the submission-date window stays closed even though the supplement ran');
  // The window is not consumed, not reset and not shortened while it is off: its own state is exactly
  // what it was, so a window that is later enabled resumes the same fixed range.
  const untouched = (await sql<{ next_start: number; completed_through: Date | null }[]>`
    SELECT next_start,completed_through FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  assert.equal(untouched.next_start, 0);
  assert.equal(untouched.completed_through, null);

  // The window is still there — behind its OWN switch. Nothing about the supplement changed it.
  await clean();
  withoutSupplement();
  withWindow();
  const windowed = newLog();
  const windowOnly = transport({
    feed: () => feedFor([{ id: '2610.07001v1' }]),
    api: () => new Response(atomFor([])),
    log: windowed,
  });
  const second = ran(await collectScheduledArxiv({ fetch: windowOnly, sleep: async () => {}, now: at('2026-10-08T05:30:00Z') }));
  assert.equal(second.apiSupplementAttempted, false, 'the supplement is off and was not attempted');
  assert.equal(windowQueries(windowed).length, 1, 'the window really walked its fixed range');
  assert.equal(second.complete, true);
});

test('one round spends a bounded supplement budget and leaves the rest as candidates for a later round', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  const log = newLog();
  const gaps = ['2610.07801v1', '2610.07802v1', '2610.07803v1', '2610.07804v1', '2610.07805v1'];
  const fake = transport({
    feed: () => feedFor(gaps.map(id => ({ id, abstract: null }))),
    api: url => new Response(atomFor((url.searchParams.get('id_list') ?? '').split(',').filter(Boolean))),
    log,
  });
  const first = ran(await collectScheduledArxiv({
    fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'),
    supplementBatchIds: 2, supplementMaxRequests: 1,
  }));
  // The read is bounded by what the round could actually send, so a switch can never answer a large
  // backlog with a large burst of requests.
  assert.equal(first.hydrationCandidates, 2, 'the round only READ what its budget could send');
  assert.equal(log.api, 1, 'one round issues at most its request budget');
  assert.deepEqual(apiIds(log).filter((ids): ids is string => ids !== null), ['2610.07801v1,2610.07802v1']);
  assert.equal(first.insertedPaperCount, 2);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 2);
  // The versions it did not reach are untouched: not requested, not rejected, not turned into failures.
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions`)[0]!.n, 0,
    'an unreached version is not a failure, it is simply next round\'s work');

  // The NEXT round asks for the ids after those, and never re-asks for the ones it already stored.
  const secondLog = newLog();
  const second = ran(await collectScheduledArxiv({
    fetch: transport({ feed: () => feedFor([]), api: url => new Response(atomFor((url.searchParams.get('id_list') ?? '').split(',').filter(Boolean))), log: secondLog }),
    sleep: async () => {}, now: at('2026-10-08T05:30:00Z'),
    supplementBatchIds: 2, supplementMaxRequests: 1,
  }));
  assert.deepEqual(apiIds(secondLog).filter((ids): ids is string => ids !== null), ['2610.07803v1,2610.07804v1'],
    'the backlog continues where the previous round stopped, with no id asked for twice');
  assert.equal(second.insertedPaperCount, 2);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 4);
});

test('a failed feed is the failure the round reports, and the supplement never steps over it', async () => {
  await clean();
  enable();
  withSupplement();
  withoutWindow();
  // A real gap the supplement CAN act on, so "the supplement also ran and also failed" is on the table
  // rather than hypothetical: yesterday's announcement with no raw version behind it.
  await sql`INSERT INTO arxiv_announcement_batches(content_hash, raw_rss, collected_at, paper_count)
    VALUES (${'b'.repeat(64)}, '<rss/>', ${'2026-10-07T00:00:00Z'}::timestamptz, 1)`;
  await sql`INSERT INTO arxiv_announcements(arxiv_id, base_id, version, announce_type, announced_on, first_batch_hash)
    VALUES ('2610.07901v1', '2610.07901', 1, 'new', '2026-10-07', ${'b'.repeat(64)})`;
  const log = newLog();
  const fake = transport({
    feed: () => { throw new Error('the feed is down'); },
    api: () => new Response('the export API is unwell today', { status: 503 }),
    log,
  });
  const thrown = await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') })
    .then(() => undefined, (error: unknown) => error);
  assert.match(String(thrown), /announcement feed failed/,
    'the main source failure is what the caller reads, never the auxiliary one');
  const state = await day('2026-10-07');
  assert.equal(state.last_outcome, 'failed', 'a dead main source is never softened into a partial day');
  assert.equal(state.completed_at, null, 'and the day stays open for its own retry budget');
  // BOTH failures keep their own record: nothing is dressed up as the other.
  assert.equal((await events('rss_parse_failed')).length, 1, 'the feed failure keeps its own record');
  assert.equal((await events('api_supplement_failed')).length, 1, 'and the supplement failure keeps its own');
});

// ---------------------------------------------------------------------------------------------
// What the round keeps from the schedule it already had.
// ---------------------------------------------------------------------------------------------

test('an operator pause is never lifted, shortened or paid for by the RSS-primary round', async () => {
  await clean();
  enable();
  withoutSupplement();
  withoutWindow();
  // An ownerless term with its own deadline: the durable hold, or a human pause. The round must not
  // lift it, must not shorten it, and must not reach either endpoint while it stands.
  await sql`INSERT INTO arxiv_collection_state(key,owner,lease_until)
    VALUES('astro-ph',NULL,clock_timestamp()+interval '2 hours')`;
  const log = newLog();
  const fake = transport({ feed: () => feedFor([{ id: '2610.07001v1' }]), log });
  const paused = skipped(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(paused.reason, 'rate_limited', 'the manual pause still freezes the channel');
  assert.equal(log.hrefs.length, 0, 'and the round reaches neither endpoint');
  assert.equal((await day('2026-10-07')).attempts, 0, 'an attempt that never ran is still given back');
  const held = (await sql<{ lease_until: Date | null }[]>`SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0];
  assert.notEqual(held?.lease_until ?? null, null, 'and the pause itself is left exactly where it was');
});

test('a round that stored nothing keeps the day open, and its retry runs exactly six real hours later', async () => {
  await clean();
  enable();
  withoutSupplement();
  withoutWindow();
  const log = newLog();
  // An empty feed: the ordinary round really ran, really read the feed, and really stored nothing — so
  // the six hours the schedule owes are what is under test, not a day that closed on a stored paper.
  const fake = transport({ feed: () => feedFor([]), log });
  const first = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:20.000Z') }));
  assert.equal(first.newContentCount, 0);
  assert.equal(log.api, 0, 'an empty feed still never reaches the export API');
  assert.equal((await day('2026-10-07')).completed_at, null, 'an unproductive day stays open for its retry');
  const issued = log.hrefs.length;
  const early = skipped(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T11:30:19.999Z') }));
  assert.equal(early.reason, 'not_due', 'one millisecond early is still early');
  assert.equal(log.hrefs.length, issued, 'and the tick before the due instant touches nothing at all');
  const retry = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T11:30:20.000Z') }));
  assert.equal(retry.retry, true, 'exactly six hours later the day\'s retry really runs');
  assert.equal(retry.attempt, 2);
});

test.after(async () => { await closeDb(); });
