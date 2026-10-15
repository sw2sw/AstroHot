// S3 — an RSS-read paper reaches analysis, reporting and the reader without inventing a date.
//
// Two questions are answered here:
//   1. Is a paper the feed carried actually analyzable and readable, and does everything downstream
//      say "the announcement day is the only day I know" instead of filling in a submission instant?
//   2. Does everything the paid path already owns — the claim, the receipt, the stored result, the
//      metadata hash a second analysis would key on — stay exactly as it is when the other source
//      later describes the same version?
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { stub, gate } from './setup.ts';
import { ingestArxivAnnouncements } from '../packages/backend/src/arxiv/announcements.ts';
import { persistRssArxivBatch, ingestRawArxivCollection, readPendingRawArxivPapers, rawMetadataDigest } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { loadArxivFeed } from '../packages/backend/src/publication/arxiv.ts';
import { importArxivReport } from '../packages/backend/src/arxiv/store.ts';
import { validateArxivReport } from '../packages/backend/src/arxiv/report.ts';
import type { Tx } from '../packages/backend/src/db.ts';

const ANSWER = {
  title_zh: '宇宙观测研究', summary_zh: '研究宇宙观测数据，结果仍需全文核查。', reason_zh: '摘要提出可核查的观测结果。',
  verdict: 'REVIEW', study_type: 'observation',
  evidence_excerpt_index: 1,
  fulltext_review_question: '全文如何控制系统误差？',
};
const ABSTRACT = 'Original abstract. We measure $4\\%$ with uncertainty. Final result.';

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).toUTCString().slice(0, 3);
/** An RFC-822 pubDate naming the given source calendar day, in the feed's own US Eastern offset. */
const pubDate = (day: string) => `${weekdayOf(day)}, ${day.slice(8)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)} 00:00:00 -0400`;

interface Spec { id: string; day?: string; type?: string; abstract?: string; title?: string; categories?: string[] }
const rssItem = (spec: Spec) => {
  const base = spec.id.replace(/v\d+$/, '');
  const type = spec.type ?? 'new';
  const day = spec.day ?? '2026-10-07';
  return [
    '<item>',
    `<title>${spec.title ?? `Title of ${spec.id}`}</title>`,
    `<link>https://arxiv.org/abs/${base}</link>`,
    `<description>arXiv:${spec.id} Announce Type: ${type} \nAbstract: ${spec.abstract ?? ABSTRACT}</description>`,
    `<guid>oai:arXiv.org:${spec.id}</guid>`,
    ...(spec.categories ?? ['astro-ph.CO']).map((category) => `<category>${category}</category>`),
    `<pubDate>${pubDate(day)}</pubDate>`,
    '<dc:creator>Alice Author, Bob Builder</dc:creator>',
    `<arxiv:announce_type>${type}</arxiv:announce_type>`,
    '</item>',
  ].join('');
};
const rssFeed = (items: Spec[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>astro-ph updates</title>${items.map(rssItem).join('')}</channel></rss>`;
const atomFeed = (ids: string[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${ids.length}</opensearch:itemsPerPage>${ids.map((id) => `<entry><id>https://arxiv.org/abs/${id}</id><title>API title ${id}</title><summary>API summary ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
/** An Atom answer whose science the test states, so "the same paper" is a real claim and not a guess. */
const atomSameAs = (ids: string[], title: (id: string) => string, summary: (id: string) => string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${ids.length}</opensearch:itemsPerPage>${ids.map((id) => `<entry><id>https://arxiv.org/abs/${id}</id><title>${title(id)}</title><summary>${summary(id)}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;

async function ingestRss(items: Spec[], collectedAt = '2026-10-07T12:00:00Z') {
  const rawRss = rssFeed(items);
  return sql.begin(async (tx) => {
    const ambient = { begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(tx) };
    const stored = await ingestArxivAnnouncements(rawRss, collectedAt, ambient);
    const papers = stored.status === 'imported' ? await persistRssArxivBatch(tx, rawRss, stored.batchHash, collectedAt) : undefined;
    return { stored, papers };
  });
}
const setStartOn = (day: string) => sql`INSERT INTO arxiv_collection_state (key, analysis_start_on) VALUES ('astro-ph', ${day}::date) ON CONFLICT (key) DO UPDATE SET analysis_start_on = EXCLUDED.analysis_start_on`;

const clean = async () => {
  await sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_rss_item_isolations,arxiv_same_version_conflicts,arxiv_rss_cache,arxiv_analysis_claims,arxiv_analysis_retry,arxiv_collection_state,arxiv_papers,arxiv_reports CASCADE`;
  await sql`DELETE FROM receipts`;
};

/** Starts the paid path against the local stub; returns the api module and the hit counter. */
async function withModel() {
  const api = await import('../packages/backend/src/arxiv/analyze.ts');
  let response: unknown = ANSWER;
  let wait: ReturnType<typeof gate> | null = null;
  let entered: ReturnType<typeof gate> | null = null;
  const server = await stub(async (_hit, req) => {
    const body = JSON.parse(req.body);
    if (typeof body.messages?.[1]?.content === 'string' && body.messages[1].content.startsWith('{')) {
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.evidence_excerpts[1].text, ' We measure $4\\%$ with uncertainty.');
    }
    entered?.open(undefined);
    if (wait) await wait.promise;
    return { choices: [{ message: { content: JSON.stringify(response) } }] };
  });
  Object.assign(process.env, { LLM_BASE_URL: server.url, LLM_API_KEY: 'local-fake', LLM_MODEL: 'qwen3.8:27b' });
  return {
    api, server,
    setResponse: (value: unknown) => { response = value; },
    hold: () => { wait = gate(); entered = gate(); return entered; },
    release: () => { wait?.open(undefined); wait = null; },
  };
}

test('an RSS new paper with no submission instant is admitted, analyzed once and reported with its announcement day', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    await ingestRss([{ id: '2610.09001v1' }]);
    const [raw] = await sql<{ metadata: Record<string, unknown>; first_batch_hash: string | null }[]>`
      SELECT metadata, first_batch_hash FROM arxiv_raw_papers`;
    assert.equal(raw!.metadata.submitted_at, null);
    assert.equal(raw!.first_batch_hash, null, 'an RSS row is not waiting on an Atom batch');

    // The unknown submission instant does not keep it out: the feed's own `new` evidence admits it.
    assert.deepEqual((await readPendingRawArxivPapers(10)).map((p) => p.arxiv_id), ['2610.09001v1']);

    const first = await model.api.analyzePendingArxiv({ limit: 1, model: 'default' });
    assert.equal(first.analyzed, 1);
    assert.equal(model.server.hits(), 1, 'exactly one paid call');
    const [paper] = await sql<{ paper: Record<string, unknown>; analysis_status: string }[]>`
      SELECT p.paper, r.analysis_status FROM arxiv_papers p JOIN arxiv_raw_papers r ON r.arxiv_id = p.paper->>'arxiv_id'`;
    assert.equal(paper!.analysis_status, 'analyzed');
    assert.equal(paper!.paper.submitted_at, null, 'no submission instant is invented for the reader');
    assert.equal(paper!.paper.updated_at, null);
    assert.equal(paper!.paper.announced_on, '2026-10-07', 'the announcement day is what is known');
    assert.equal(paper!.paper.verdict, 'REVIEW');
    assert.equal(paper!.paper.evidence_abstract_quote, ' We measure $4\\%$ with uncertainty.');

    // The persisted report carries the same honest shape.
    const [report] = await sql<{ report: { items: Record<string, unknown>[] } }[]>`
      SELECT report FROM arxiv_reports ORDER BY generated_at DESC LIMIT 1`;
    assert.equal(report!.report.items[0]!.submitted_at, null);
    assert.equal(report!.report.items[0]!.updated_at, null);
    assert.equal(report!.report.items[0]!.announced_on, '2026-10-07');

    // Nothing is analyzed or paid for a second time.
    const again = await model.api.analyzePendingArxiv({ limit: 1, model: 'default' });
    assert.equal(again.analyzed, 0);
    assert.equal(model.server.hits(), 1);
  } finally { await model.server.close(); }
});

test('an RSS announcement older than the analysis floor is not widened into the analysis', async () => {
  await clean();
  await setStartOn('2026-10-01');
  const model = await withModel();
  try {
    await ingestRss([{ id: '2610.09201v1', day: '2026-09-20' }, { id: '2610.09202v1', day: '2026-10-05' }], '2026-10-06T12:00:00Z');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 2, 'both versions are stored and readable');
    const pending = (await readPendingRawArxivPapers(10)).map((p) => p.arxiv_id);
    assert.deepEqual(pending, ['2610.09202v1'], 'only the announcement inside the floor is admitted');
    const result = await model.api.analyzePendingArxiv({ limit: 10, model: 'default' });
    assert.equal(result.analyzed, 1);
    assert.equal(model.server.hits(), 1);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims WHERE arxiv_id='2610.09201v1'`)[0]!.n, 0);
  } finally { await model.server.close(); }
});

test('eligibility is decided before the LIMIT, and only the newest version of a base id is analyzed', async () => {
  await clean();
  await setStartOn('2026-10-01');
  const model = await withModel();
  try {
    // An OLD (ineligible) row is collected first, so it is the one a post-LIMIT filter would return.
    await ingestRss([{ id: '2610.09301v1', day: '2026-09-01' }], '2026-10-01T12:00:00Z');
    await ingestRss([{ id: '2610.09302v1', day: '2026-10-05' }], '2026-10-02T12:00:00Z');
    // The same base id also has a newer version, which is the only one that may be analyzed.
    await ingestRss([{ id: '2610.09302v2', day: '2026-10-06' }], '2026-10-06T12:00:00Z');
    const one = (await readPendingRawArxivPapers(1)).map((p) => p.arxiv_id);
    assert.deepEqual(one, ['2610.09302v2'], 'a single slot goes to the eligible newest version, not to an older ineligible row');
    assert.deepEqual((await readPendingRawArxivPapers(10)).map((p) => p.arxiv_id), ['2610.09302v2']);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE base_id='2610.09302'`)[0]!.n, 2, 'both versions are stored');
  } finally { await model.server.close(); }
});

test('a same-version Atom document arriving later costs no second paid call and disturbs nothing owned', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    await ingestRss([{ id: '2610.09401v1' }]);
    assert.equal((await model.api.analyzePendingArxiv({ limit: 1, model: 'default' })).analyzed, 1);
    assert.equal(model.server.hits(), 1);
    const before = await sql<{ metadata_hash: string; analysis_status: string }[]>`SELECT metadata_hash, analysis_status FROM arxiv_raw_papers`;
    const receiptsBefore = await sql`SELECT id, status, purpose, subject FROM receipts ORDER BY id`;
    const papersBefore = await sql`SELECT * FROM arxiv_papers ORDER BY base_id`;
    const reportsBefore = await sql`SELECT * FROM arxiv_reports ORDER BY run_id`;

    // The API states the SAME paper: the same title, and the same abstract with the line wrapping the
    // summary simply does not carry. That is what makes this an overlap of one identity and not a
    // second document — the test states the equivalence instead of assuming two different texts are one.
    const rawAtom = atomSameAs(['2610.09401v1'], (id) => `Title of ${id}`, () => ABSTRACT.replace(/\s+/g, ' '));
    const overlap = await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: '2026-10-09T12:00:00Z' });
    assert.deepEqual(overlap.crossSourceOverlaps, ['2610.09401v1']);
    assert.deepEqual(overlap.contentConflictIds, [], 'an equivalent document is not a conflict');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_same_version_conflicts`)[0]!.n, 0);

    const after = await sql<{ metadata_hash: string; analysis_status: string }[]>`SELECT metadata_hash, analysis_status FROM arxiv_raw_papers`;
    assert.deepEqual(after, before, 'the identity the analysis ran under is unchanged');
    assert.deepEqual(await sql`SELECT id, status, purpose, subject FROM receipts ORDER BY id`, receiptsBefore);
    assert.deepEqual(await sql`SELECT * FROM arxiv_papers ORDER BY base_id`, papersBefore);
    assert.deepEqual(await sql`SELECT * FROM arxiv_reports ORDER BY run_id`, reportsBefore);
    // And the next ordinary run pays for nothing.
    assert.equal((await model.api.analyzePendingArxiv({ limit: 5, model: 'default' })).analyzed, 0);
    assert.equal(model.server.hits(), 1);
  } finally { await model.server.close(); }
});

test('a same-version Atom document that states different science defers the paper instead of analysing it', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    // The feed paper is stored and analyzed under its own document.
    await ingestRss([{ id: '2610.09701v1' }, { id: '2610.09702v1' }]);
    assert.equal((await model.api.analyzePendingArxiv({ limit: 1, model: 'default' })).analyzed, 1);
    assert.equal(model.server.hits(), 1);
    const analyzed = (await sql<{ arxiv_id: string }[]>`SELECT arxiv_id FROM arxiv_raw_papers WHERE analysis_status='analyzed'`)[0]!.arxiv_id;
    const identity = (await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers WHERE analysis_status='analyzed'`)[0]!.metadata_hash;
    const receiptsBefore = await sql`SELECT id, status, purpose, subject FROM receipts ORDER BY id`;
    const retriesBefore = await sql`SELECT * FROM arxiv_analysis_retry ORDER BY arxiv_id`;
    const papersBefore = await sql`SELECT * FROM arxiv_papers ORDER BY base_id`;

    // The API states a DIFFERENT abstract for the version that is still pending.
    const pending = (await sql<{ arxiv_id: string }[]>`SELECT arxiv_id FROM arxiv_raw_papers WHERE analysis_status='pending'`)[0]!.arxiv_id;
    const rawAtom = atomSameAs([pending], (id) => `Title of ${id}`, () => 'A completely different abstract.');
    const conflict = await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: '2026-10-09T12:00:00Z' });
    assert.deepEqual(conflict.contentConflictIds, [pending]);
    assert.deepEqual(conflict.crossSourceOverlaps, [], 'a disagreement is never reported as a plain overlap');

    // The version is deferred: it is NOT analysed under a document nobody can vouch for, and the
    // already-analysed version is untouched.
    assert.deepEqual((await readPendingRawArxivPapers(10)).map((p) => p.arxiv_id), [], 'the disputed version is held back');
    const next = await model.api.analyzePendingArxiv({ limit: 10, model: 'default' });
    assert.equal(next.analyzed, 0, 'no new paid call is made while the disagreement is open');
    assert.equal(model.server.hits(), 1, 'the run before the conflict is still the only one that was paid for');
    assert.equal((await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers WHERE arxiv_id=${analyzed}`)[0]!.metadata_hash, identity);
    assert.deepEqual(await sql`SELECT id, status, purpose, subject FROM receipts ORDER BY id`, receiptsBefore, 'no receipt is added or reset');
    assert.deepEqual(await sql`SELECT * FROM arxiv_analysis_retry ORDER BY arxiv_id`, retriesBefore, 'no retry counter or cooldown is touched');
    assert.deepEqual(await sql`SELECT * FROM arxiv_papers ORDER BY base_id`, papersBefore);

    // Resolution is an operator decision, and it is what releases the paper again — nothing automatic
    // ever decides which of the two documents was right.
    await sql`UPDATE arxiv_same_version_conflicts SET resolved_at = clock_timestamp() WHERE resolved_at IS NULL`;
    assert.deepEqual((await readPendingRawArxivPapers(10)).map((p) => p.arxiv_id), [pending], 'the released version is eligible again');
    assert.equal((await model.api.analyzePendingArxiv({ limit: 10, model: 'default' })).analyzed, 1);
    assert.equal(model.server.hits(), 2);
  } finally { await model.server.close(); }
});

test('a same-version Atom document arriving while the claim is in flight leaves the claim and the run alone', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    await ingestRss([{ id: '2610.09501v1' }]);
    const entered = model.hold();
    const work = model.api.analyzePendingArxiv({ limit: 1, model: 'default' });
    await entered.promise; // the claim is committed, the paid call is in flight
    const hashBefore = (await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash;
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims WHERE arxiv_id='2610.09501v1'`)[0]!.n, 1);

    const rawAtom = atomSameAs(['2610.09501v1'], (id) => `Title of ${id}`, () => ABSTRACT.replace(/\s+/g, ' '));
    const overlap = await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: '2026-10-09T12:00:00Z' });
    assert.deepEqual(overlap.crossSourceOverlaps, ['2610.09501v1']);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims WHERE arxiv_id='2610.09501v1'`)[0]!.n, 1, 'the live claim is untouched');
    assert.equal((await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash, hashBefore);

    model.release();
    const result = await work;
    assert.equal(result.analyzed, 1, 'the in-flight run still completes');
    assert.equal(model.server.hits(), 1);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE analysis_status='analyzed'`)[0]!.n, 1);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims`)[0]!.n, 0);
  } finally { await model.server.close(); }
});

test('the reader orders by the day it can honestly name, and a row with no day at all sorts last', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    // An RSS-sourced candidate: its day is the announcement day and it has no submission instant.
    model.setResponse({ ...ANSWER, verdict: 'SELECT' });
    await ingestRss([{ id: '2610.09601v1', categories: ['astro-ph.CO'] }]);
    assert.equal((await model.api.analyzePendingArxiv({ limit: 5, model: 'default' })).analyzed, 1);
    // An Atom-sourced candidate from a report import: a real submission instant, no announcement.
    const original = JSON.parse(readFileSync(new URL('fixtures/arxiv-pilot.json', import.meta.url), 'utf8')) as { items: Record<string, unknown>[] };
    const atomItem = { ...original.items[0]!, verdict: 'SELECT', categories: ['astro-ph.CO'], submitted_at: '2026-10-02T12:00:00Z', updated_at: '2026-10-02T12:00:00Z', arxiv_id: '2610.09603v1', base_id: '2610.09603', paper_key: 'arxiv:2610.09603', url: 'https://arxiv.org/abs/2610.09603v1' };
    // A record that states no submission instant and carries its own announcement day (the RSS shape),
    // but whose base id has no stored `new` announcement: the record's own day is the day it names.
    const undatedItem = { ...original.items[0]!, verdict: 'SELECT', categories: ['astro-ph.CO'], submitted_at: null, updated_at: null, announced_on: '2026-10-01', arxiv_id: '2610.09602v1', base_id: '2610.09602', paper_key: 'arxiv:2610.09602', url: 'https://arxiv.org/abs/2610.09602v1' };
    const report = { ...original, run_id: 'rss-primary-reader', items: [atomItem, undatedItem], paper_count: 2, candidate_pool_count: 2, counts: { SELECT: 2, REVIEW: 0, DEFER: 0 }, ranked_selected_ids: [atomItem.arxiv_id, undatedItem.arxiv_id] };
    await importArxivReport(validateArxivReport(report));
    // A candidate that names NO day at all, deliberately given the base id that would sort first if an
    // unknown day were treated as the newest one.
    await sql`INSERT INTO arxiv_papers (paper_key, base_id, version, generated_at, run_id, paper, admitted_at) VALUES ('arxiv:2000.00001', '2000.00001', 1,
      clock_timestamp(), 'rss-primary-reader',
      ${sql.json({ arxiv_id: '2000.00001v1', paper_key: 'arxiv:2000.00001', title_original: 'Undated', title_zh: '无日期', authors: ['A'], categories: ['astro-ph.CO'], submitted_at: null, updated_at: null, url: 'https://arxiv.org/abs/2000.00001v1', verdict: 'SELECT', study_type: 'theory', summary_zh: '摘要', reason_zh: '理由', evidence_abstract_quote: 'Abstract.', fulltext_review_question: '问题？', peer_review_status: 'unverified', analysis_scope: 'title_and_abstract_only', publication_status: 'candidate_only' })},
      clock_timestamp())`;

    const feed = await loadArxivFeed({ page: 1, pageSize: 20, category: null });
    assert.equal(feed.total, 4);
    const order = feed.items.map((item) => item.arxiv_id);
    assert.deepEqual(order, ['2610.09601v1', '2610.09603v1', '2610.09602v1', '2000.00001v1'],
      'announcement evidence, then the submission day, then the record\'s own day, then the row with no day at all');
    const [rss, dated, ownDay, unknown] = feed.items;
    assert.equal(rss!.announced_on, '2026-10-07');
    assert.equal(rss!.submitted_at, null, 'the reader is told the instant is unknown, not given a guessed one');
    assert.equal(dated!.announced_on, undefined);
    assert.equal(dated!.submitted_at, '2026-10-02T12:00:00Z');
    assert.equal(ownDay!.submitted_at, null);
    assert.equal(ownDay!.announced_on, '2026-10-01');
    assert.equal(unknown!.submitted_at, null);
    assert.equal(unknown!.announced_on, undefined, 'nothing on that row names a day, so the reader must say so');
    // Paging stays consistent with the ordering.
    for (const page of [1, 2, 3, 4]) {
      const single = await loadArxivFeed({ page, pageSize: 1, category: null });
      assert.deepEqual(single.items.map((item) => item.arxiv_id), [order[page - 1]!]);
    }
  } finally { await model.server.close(); }
});

test('a scientific conflict committed after the pending read still refuses the claim, so no second paid call is made', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    // Two feed papers. The first is put in flight; the second was enumerated by the SAME pending read
    // — it is next in line and has no claim yet when the conflict arrives.
    await ingestRss([{ id: '2610.09801v1' }, { id: '2610.09802v1' }]);
    assert.deepEqual((await readPendingRawArxivPapers(5)).map((p) => p.arxiv_id),
      ['2610.09801v1', '2610.09802v1'], 'both were enumerated together, before any conflict existed');
    const entered = model.hold();
    const work = model.api.analyzePendingArxiv({ limit: 5, model: 'default' });
    await entered.promise; // the claim is committed and the paid call is in flight

    // While the first is in flight, the export API states DIFFERENT science for the second. The
    // disagreement is committed on its own connection, so it is already visible by the time the run
    // comes to claim the second paper — the gap the pending read cannot close.
    const rawAtom = atomSameAs(['2610.09802v1'], (id) => `Title of ${id}`, () => 'A completely different abstract.');
    const conflict = await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: '2026-10-09T12:00:00Z' });
    // The first is claimed and in flight, the second is held back: neither is a candidate any more.
    const stillPending = (await readPendingRawArxivPapers(5)).map((p) => p.arxiv_id);
    // Released before anything is asserted: a failed assertion must not leave the stub holding a
    // request open, which would make the server unable to close.
    model.release();
    const result = await work;

    assert.deepEqual(conflict.contentConflictIds, ['2610.09802v1'], 'the disagreement really was recorded');
    assert.deepEqual(stillPending, [], 'the disputed version is held back, and the claimed one is not re-enumerated');
    assert.equal(result.analyzed, 1, 'only the run that was already in flight completes');
    assert.equal(result.skipped, 1, 'the disputed version is skipped, not analyzed');
    assert.equal(model.server.hits(), 1, 'the disputed version never starts a paid call of its own');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims`)[0]!.n, 0, 'no claim is left behind');
    // The driver returns its own Array subclass, so the rows are mapped out rather than
    // compared by prototype.
    assert.deepEqual((await sql<{ arxiv_id: string; analysis_status: string }[]>`
      SELECT arxiv_id, analysis_status FROM arxiv_raw_papers ORDER BY arxiv_id`)
      .map((r) => ({ arxiv_id: r.arxiv_id, analysis_status: r.analysis_status })),
    [{ arxiv_id: '2610.09801v1', analysis_status: 'analyzed' }, { arxiv_id: '2610.09802v1', analysis_status: 'pending' }],
    'the disputed version keeps its own document and stays pending until a human compares the two');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_papers`)[0]!.n, 1);
  } finally { await model.server.close(); }
});

test('an analysis whose stored document moved while the model ran never reports a completed analysis', async () => {
  await clean();
  await setStartOn('2026-09-01');
  const model = await withModel();
  try {
    await ingestRss([{ id: '2610.09901v1' }]);
    const entered = model.hold();
    const work = model.api.analyzePendingArxiv({ limit: 1, model: 'default' });
    await entered.promise;
    // The stored document moves while the paid call is in flight. The per-paper boundary is what keeps
    // this from happening by itself; it is injected here so the guard behind it is exercised as well.
    const before = (await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM arxiv_raw_papers WHERE arxiv_id='2610.09901v1'`)[0]!.metadata;
    const corrected = { ...before, authors: ['Alice Author', 'Carol Cole'] };
    await sql`UPDATE arxiv_raw_papers SET metadata=${sql.json(corrected)}, metadata_hash=${rawMetadataDigest(corrected)}
      WHERE arxiv_id='2610.09901v1'`;
    model.release();
    const result = await work;

    assert.equal(result.analyzed, 0, 'the run does not report a completion it did not earn');
    assert.equal(result.failed, 0, 'and it is not dressed up as a failed analysis either');
    assert.equal(result.skipped, 1);
    assert.equal(model.server.hits(), 1, 'the paid call it already made is not repeated');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_papers`)[0]!.n, 0,
      'nothing is imported for a document that is no longer the one stored');
    assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE status='completed'`)[0]!.n, 0);
    assert.equal((await sql<{ analysis_status: string }[]>`
      SELECT analysis_status FROM arxiv_raw_papers WHERE arxiv_id='2610.09901v1'`)[0]!.analysis_status, 'pending',
    'the corrected document is left for the run that owns it');
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims`)[0]!.n, 0);
  } finally { await model.server.close(); }
});

test('the report contract accepts an honest RSS shape and still accepts the Atom shape', () => {
  const base = JSON.parse(readFileSync(new URL('fixtures/arxiv-pilot.json', import.meta.url), 'utf8')) as Record<string, unknown> & { items: Record<string, unknown>[] };
  // Atom: both instants present, no announcement day needed.
  assert.doesNotThrow(() => validateArxivReport(structuredClone(base)));
  // RSS: neither instant is known, and the announcement day is what stands for them.
  const rss = structuredClone(base);
  rss.items[0]!.submitted_at = null; rss.items[0]!.updated_at = null; rss.items[0]!.announced_on = '2026-10-07';
  const validated = validateArxivReport(rss);
  assert.equal(validated.items[0]!.submitted_at, null);
  assert.equal(validated.items[0]!.announced_on, '2026-10-07');
  // A null instant with no honest day beside it is refused, and the failure names the absent field.
  const liars = structuredClone(base);
  liars.items[0]!.submitted_at = null; liars.items[0]!.updated_at = null;
  assert.throws(() => validateArxivReport(liars), /submitted_at.*announced_on|announced_on.*submitted_at/s);
  // The shape is not a licence to synthesize: a real instant with a different announcement day is
  // still validated on its own terms.
  const both = structuredClone(base);
  both.items[0]!.announced_on = '2026-10-07';
  assert.equal(validateArxivReport(both).items[0]!.announced_on, '2026-10-07');
});

test.after(async () => { await closeDb(); });
