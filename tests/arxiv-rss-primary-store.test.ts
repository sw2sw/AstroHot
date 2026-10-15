// S2 — the raw evidence and the real papers of an RSS batch.
//
// The assertion this file exists for: the official announcement feed produces ANALYZABLE raw papers
// — real rows in arxiv_raw_papers with real insert counts — and the evidence they hang off is the
// announcement batch they were read from, never an Atom archive batch that does not exist.
//
// Everything here drives the exact seam the collector uses: ingestArxivAnnouncements writes the
// evidence batch, persistRssArxivBatch reads the papers out of the same raw document, and both run
// inside the caller's own transaction — so all three tables land together or none of them do.
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tx } from '../packages/backend/src/db.ts';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { ingestArxivAnnouncements } from '../packages/backend/src/arxiv/announcements.ts';
import { persistRssArxivBatch, ingestRawArxivCollection, rawMetadataDigest, adoptDeferredAuthorCorrection, readPendingRawArxivPapers } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivRssFeed, rssPaperMetadata } from '../packages/backend/src/arxiv/rss-paper.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { gate, stub } from './setup.ts';

// The paid answer and the abstract it must quote — the same proven pair the analysis suite uses,
// so a REAL analyzePendingArxiv run can complete against the local stub in this file too.
const ABSTRACT = 'Original abstract. We measure $4\\%$ with uncertainty. Final result.';
const ANSWER = {
  title_zh: '宇宙观测研究', summary_zh: '研究宇宙观测数据，结果仍需全文核查。', reason_zh: '摘要提出可核查的观测结果。',
  verdict: 'REVIEW', study_type: 'observation',
  evidence_excerpt_index: 1,
  fulltext_review_question: '全文如何控制系统误差？',
};
const INVALID_ANSWER = {};

const COLLECTED_AT = '2026-10-07T12:00:00Z';
const DAYS: Record<string, string> = { '05': 'Mon', '06': 'Tue', '07': 'Wed', '08': 'Thu', '09': 'Fri' };

interface RssItemSpec {
  id: string;
  title?: string | null;
  description?: string | null;
  creators?: string | null;
  categories?: string[];
  type?: string;
  day?: string;
}
function rssItem(spec: RssItemSpec): string {
  const base = spec.id.replace(/v\d+$/, '');
  const type = spec.type ?? 'new';
  const day = spec.day ?? '07';
  const description = spec.description === null ? undefined
    : spec.description ?? `arXiv:${spec.id} Announce Type: ${type} \nAbstract: Abstract of ${spec.id}.`;
  return [
    '<item>',
    spec.title === null ? '' : `<title>${spec.title ?? `Title of ${spec.id}`}</title>`,
    `<link>https://arxiv.org/abs/${base}</link>`,
    description === undefined ? '' : `<description>${description}</description>`,
    `<guid>oai:arXiv.org:${spec.id}</guid>`,
    ...(spec.categories ?? ['astro-ph.CO']).map((category) => `<category>${category}</category>`),
    `<pubDate>${DAYS[day]}, ${day} Oct 2026 00:00:00 -0400</pubDate>`,
    spec.creators === null ? '' : `<dc:creator>${spec.creators ?? 'Alice Author, Bob Builder'}</dc:creator>`,
    `<arxiv:announce_type>${type}</arxiv:announce_type>`,
    '</item>',
  ].join('');
}
const rssFeed = (items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>astro-ph updates</title><link>https://rss.arxiv.org/rss/astro-ph</link>${items.join('')}</channel></rss>`;

const atomFeed = (ids: string[]) => atomEntries(ids.map((id) => ({ id })));
/** An export-API answer whose science a test controls, so equivalence can be stated exactly. */
const atomEntries = (entries: { id: string; title?: string; summary?: string }[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${entries.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>${entries.map(({ id, title, summary }) => `<entry><id>https://arxiv.org/abs/${id}</id><title>${title ?? `API title ${id}`}</title><summary>${summary ?? `API summary ${id}`}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;

/** The collector's own seam: the evidence batch, the announcements and the papers in ONE transaction. */
async function ingestRss(rawRss: string, collectedAt = COLLECTED_AT) {
  return sql.begin(async (tx) => {
    const ambient = { begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(tx) };
    const stored = await ingestArxivAnnouncements(rawRss, collectedAt, ambient);
    const papers = stored.status === 'imported'
      ? await persistRssArxivBatch(tx, rawRss, stored.batchHash, collectedAt)
      : undefined;
    return { stored, papers };
  });
}

const clean = () => sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_rss_item_isolations,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_same_version_conflicts,arxiv_analysis_claims,arxiv_analysis_retry,arxiv_rss_cache CASCADE`;

/** The paid path against a local stub, with a hold/release valve — the same mechanism the analysis suite uses. */
async function withModel() {
  const api = await import('../packages/backend/src/arxiv/analyze.ts');
  let response: unknown = ANSWER;
  let wait: ReturnType<typeof gate> | null = null;
  let entered: ReturnType<typeof gate> | null = null;
  const server = await stub(async () => {
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

const RAW = rssFeed([
  rssItem({ id: '2610.07001v1', categories: ['astro-ph.CO', 'astro-ph.GA'] }),
  rssItem({ id: '2610.07002v1', type: 'cross', day: '07' }),
  rssItem({ id: 'astro-ph/9912345v3', type: 'replace' }),
]);

test('a complete feed stores the announcements, the analyzable papers and one shared evidence batch', async () => {
  await clean();
  const { stored, papers } = await ingestRss(RAW);
  assert.equal(stored.status, 'imported');
  assert.equal(papers!.itemCount, 3);
  assert.equal(papers!.announcementCount, 3);
  assert.deepEqual(papers!.insertedIds, ['2610.07001v1', '2610.07002v1', 'astro-ph/9912345v3']);
  assert.deepEqual(papers!.duplicateIds, []);
  assert.deepEqual(papers!.isolated, []);

  const batches = await sql<{ content_hash: string; paper_count: number; raw_rss: string }[]>`
    SELECT content_hash, paper_count, raw_rss FROM arxiv_announcement_batches`;
  assert.equal(batches.length, 1, 'one evidence document');
  assert.equal(batches[0]!.paper_count, 3);
  assert.equal(batches[0]!.raw_rss, RAW, 'the raw bytes are kept exactly as received');

  const rows = await sql<{ arxiv_id: string; base_id: string; version: number; source: string; analysis_status: string; first_batch_hash: string | null; first_rss_batch_hash: string | null }[]>`
    SELECT arxiv_id, base_id, version, source, analysis_status, first_batch_hash, first_rss_batch_hash
    FROM arxiv_raw_papers ORDER BY arxiv_id`;
  assert.equal(rows.length, 3, 'three real papers, not just three announcements');
  for (const row of rows) {
    assert.equal(row.source, 'rss');
    assert.equal(row.analysis_status, 'pending', 'a normal RSS paper is analyzable');
    assert.equal(row.first_batch_hash, null);
    assert.equal(row.first_rss_batch_hash, batches[0]!.content_hash, 'the evidence is the announcement batch it was read from');
  }
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_batches`)[0]!.n, 0, 'no Atom batch was invented');
});

test('the stored metadata is re-derived from the raw feed, never taken from the caller', async () => {
  await clean();
  await ingestRss(RAW);
  for (const item of parseArxivRssFeed(RAW).items) {
    const expected = rssPaperMetadata(item);
    const [row] = await sql<{ metadata: Record<string, unknown>; metadata_hash: string }[]>`
      SELECT metadata, metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = ${item.arxiv_id}`;
    assert.deepEqual(row!.metadata, expected, `${item.arxiv_id}: the row states exactly what the feed states`);
    assert.equal(row!.metadata_hash, rawMetadataDigest(expected), 'and the hash is the hash of that document');
    assert.equal(row!.metadata.submitted_at, null);
    assert.equal(row!.metadata.updated_at, null);
    assert.equal(row!.metadata.announced_on, item.announced_on);
  }
});

test('the DB itself refuses an evidence pointer that disagrees with the source column', async () => {
  await clean();
  await ingestRss(rssFeed([rssItem({ id: '2610.07010v1' })]));
  const rssBatch = (await sql<{ content_hash: string }[]>`SELECT content_hash FROM arxiv_announcement_batches`)[0]!.content_hash;
  const rawAtom = atomFeed(['2610.07011v1']);
  await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: COLLECTED_AT });
  const atomBatch = (await sql<{ content_hash: string }[]>`SELECT content_hash FROM arxiv_raw_batches`)[0]!.content_hash;
  const insert = (source: string, atomHash: string | null, rssHash: string | null) => sql`
    INSERT INTO arxiv_raw_papers (arxiv_id, base_id, version, metadata, metadata_hash, first_batch_hash, first_rss_batch_hash, first_collected_at, analysis_status, source)
    VALUES ('2610.07099v1', '2610.07099', 1, '{}'::jsonb, ${'a'.repeat(64)}, ${atomHash}, ${rssHash}, ${COLLECTED_AT}::timestamptz, 'pending', ${source})`;
  // Exactly one document is the origin of a row, and it is the one the source column names.
  await assert.rejects(insert('rss', null, null), /arxiv_raw_papers_evidence_check/, 'an RSS row must name its announcement batch');
  await assert.rejects(insert('rss', atomBatch, rssBatch), /arxiv_raw_papers_evidence_check/, 'and must not also name an Atom batch');
  await assert.rejects(insert('atom', null, null), /arxiv_raw_papers_evidence_check/, 'an Atom row must name its archive batch');
  await assert.rejects(insert('atom', null, rssBatch), /arxiv_raw_papers_evidence_check/, 'and must not name the RSS one instead');
  await assert.rejects(insert('feed', atomBatch, null), /arxiv_raw_papers_(evidence|source)_check/, 'an unknown source is refused');
  // An RSS row whose evidence batch does not exist is refused by the foreign key, so no row can ever
  // point at a document nobody kept.
  await assert.rejects(insert('rss', null, 'f'.repeat(64)), /arxiv_raw_papers_first_rss_batch_hash_fkey/);
});

test('replaying the very same feed inserts nothing a second time', async () => {
  await clean();
  const first = await ingestRss(RAW);
  const second = await ingestRss(RAW);
  assert.equal(second.stored.status, 'unchanged', 'the identical document is the same evidence batch');
  assert.equal(second.stored.batchHash, first.stored.batchHash);
  assert.equal(second.papers, undefined, 'nothing is read out of a batch that was already imported');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n, 1);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements`)[0]!.n, 3);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 3);
});

test('the same version announced again in a NEW batch is a duplicate, and the first document stands', async () => {
  await clean();
  await ingestRss(RAW);
  const before = await sql<{ arxiv_id: string; metadata: Record<string, unknown> }[]>`
    SELECT arxiv_id, metadata FROM arxiv_raw_papers ORDER BY arxiv_id`;
  // A later day re-announces the same versions (a cross-listing notice). The science is identical —
  // only the announcement type and day moved — so it is a genuine duplicate: the first document
  // stands, is not rewritten, and the announcement evidence IS kept for the new day.
  const again = await ingestRss(rssFeed([
    rssItem({ id: '2610.07001v1', type: 'cross', day: '08' }),
    rssItem({ id: '2610.07002v1', type: 'replace', day: '08' }),
  ]), '2026-10-08T12:00:00Z');
  assert.equal(again.stored.status, 'imported');
  assert.deepEqual(again.papers!.insertedIds, [], 'a repeated version is not a new paper');
  assert.deepEqual([...again.papers!.duplicateIds].sort(), ['2610.07001v1', '2610.07002v1']);
  assert.deepEqual(again.papers!.conflictedIds, [], 'identical science is not a conflict');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_same_version_conflicts`)[0]!.n, 0);
  assert.deepEqual(await sql<{ arxiv_id: string; metadata: Record<string, unknown> }[]>`
    SELECT arxiv_id, metadata FROM arxiv_raw_papers ORDER BY arxiv_id`, before, 'the first stored document is not rewritten');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 3);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n, 2);

  // Now the SAME version comes back with a different title: the science has changed under one
  // identity, and nothing in the document can say which of the two is right. The incoming batch is
  // refused AS A WHOLE — the healthy item beside it is not imported either — and the disagreement is
  // kept where the rollback cannot take it away.
  const drift = rssFeed([
    rssItem({ id: '2610.07001v1', type: 'replace', day: '09', title: 'Title of 2610.07001v1 (changed)' }),
    rssItem({ id: '2610.07003v1', day: '09' }),
  ]);
  await assert.rejects(ingestRss(drift, '2026-10-09T12:00:00Z'), /RSS content drift/i);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id='2610.07003v1'`)[0]!.n, 0,
    'the healthy neighbour of a drifting version is not imported either');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n, 2, 'the refused batch left no evidence batch behind');
  const conflicts = await sql<{
    arxiv_id: string; base_id: string; kind: string; stored_source: string; arriving_source: string;
    stored_metadata_sha256: string; arriving_document_sha256: string; defers_analysis: boolean;
    detail: Record<string, unknown>; resolved_at: Date | null;
  }[]>`SELECT * FROM arxiv_same_version_conflicts`;
  assert.equal(conflicts.length, 1, 'the disagreement is recorded durably, outside the rolled-back batch');
  assert.equal(conflicts[0]!.arxiv_id, '2610.07001v1');
  assert.equal(conflicts[0]!.kind, 'same_source_drift');
  assert.equal(conflicts[0]!.stored_source, 'rss');
  assert.equal(conflicts[0]!.arriving_source, 'rss');
  assert.match(conflicts[0]!.stored_metadata_sha256, /^[0-9a-f]{64}$/);
  assert.match(conflicts[0]!.arriving_document_sha256, /^[0-9a-f]{64}$/);
  assert.equal(conflicts[0]!.defers_analysis, true, 'a doubt about the science holds the version back');
  assert.equal(conflicts[0]!.resolved_at, null, 'and nothing resolves it automatically');
  assert.equal(conflicts[0]!.detail.stored_title, 'Title of 2610.07001v1');
  assert.equal(conflicts[0]!.detail.arriving_title, 'Title of 2610.07001v1 (changed)');
  // The stored document — the input a paid analysis would key on — is byte-identical.
  assert.deepEqual(await sql<{ arxiv_id: string; metadata: Record<string, unknown> }[]>`
    SELECT arxiv_id, metadata FROM arxiv_raw_papers ORDER BY arxiv_id`, before);
});

test('an RSS row is never rewritten by a later Atom document of the same version', async () => {
  await clean();
  // The feed states one document; the API later states the SAME science with a different presentation
  // (line wrapping and indentation), which is a formatting difference and not a disagreement.
  await ingestRss(rssFeed([rssItem({
    id: '2610.07100v1', title: 'A shared title',
    description: 'arXiv:2610.07100v1 Announce Type: new \nAbstract: The shared abstract.\r\nWrapped   here.',
  })]));
  const storedBefore = (await sql<{ metadata: Record<string, unknown>; metadata_hash: string }[]>`
    SELECT metadata, metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = '2610.07100v1'`)[0]!;

  const sameRaw = atomEntries([{ id: '2610.07100v1', title: ' A shared title ', summary: 'The shared abstract. Wrapped here.' }]);
  const result = await ingestRawArxivCollection({ papers: parseArxivAtom(sameRaw), raw_atom: sameRaw, collected_at_utc: '2026-10-08T12:00:00Z' });
  assert.deepEqual(result.crossSourceOverlaps, ['2610.07100v1'], 'the overlap is reported, not swallowed');
  assert.deepEqual(result.contentConflictIds, [], 'presentation is not a disagreement');
  assert.equal(result.insertedPaperCount, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_same_version_conflicts`)[0]!.n, 0,
    'a document that only wraps its text differently is not recorded as a conflict');
  const storedAfter = (await sql<{ metadata: Record<string, unknown>; metadata_hash: string; source: string }[]>`
    SELECT metadata, metadata_hash, source FROM arxiv_raw_papers WHERE arxiv_id = '2610.07100v1'`)[0]!;
  assert.deepEqual(storedAfter.metadata, storedBefore.metadata, 'the analyzed input is not replaced');
  assert.equal(storedAfter.metadata_hash, storedBefore.metadata_hash, 'so the paid-analysis identity is unchanged');
  assert.equal(storedAfter.source, 'rss', 'and its first evidence is still the announcement batch');
  assert.equal(storedAfter.metadata.announced_on, '2026-10-07', 'the honest announcement day survives');

  // The API then states a DIFFERENT abstract for the same version. Both originals are kept, the stored
  // one is not overwritten, and the version is held back from starting a new analysis until a human
  // has compared the two documents.
  const differentRaw = atomEntries([{ id: '2610.07100v1', title: 'A shared title', summary: 'A completely different abstract.' }]);
  const conflict = await ingestRawArxivCollection({ papers: parseArxivAtom(differentRaw), raw_atom: differentRaw, collected_at_utc: '2026-10-09T12:00:00Z' });
  assert.deepEqual(conflict.crossSourceOverlaps, [], 'a disagreement is not reported as a plain overlap');
  assert.deepEqual(conflict.contentConflictIds, ['2610.07100v1'], 'it is reported as a conflict, and it is not silent');
  const recorded = await sql<{ kind: string; stored_source: string; arriving_source: string; defers_analysis: boolean; detail: Record<string, unknown>; resolved_at: Date | null }[]>`
    SELECT kind, stored_source, arriving_source, defers_analysis, detail, resolved_at FROM arxiv_same_version_conflicts`;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'cross_source_difference');
  assert.equal(recorded[0]!.stored_source, 'rss');
  assert.equal(recorded[0]!.arriving_source, 'atom');
  assert.equal(recorded[0]!.defers_analysis, true);
  assert.equal(recorded[0]!.resolved_at, null);
  assert.equal(recorded[0]!.detail.verdict, 'different');
  assert.equal(recorded[0]!.detail.arriving_abstract, 'A completely different abstract.');
  // Both originals survive: the stored row is byte-identical and the Atom archive keeps its document.
  const stillStored = (await sql<{ metadata: Record<string, unknown>; metadata_hash: string }[]>`
    SELECT metadata, metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = '2610.07100v1'`)[0]!;
  assert.deepEqual(stillStored.metadata, storedBefore.metadata, 'the stored row is byte-identical');
  assert.equal(stillStored.metadata_hash, storedBefore.metadata_hash, 'so the identity is untouched');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_batches WHERE raw_atom LIKE '%A completely different abstract%'`)[0]!.n, 1,
    'the arriving document is archived, so the disagreement is reviewable offline');
});

test('a same-source creator correction is classified rather than silently dropped', async () => {
  await clean();
  const raw = rssFeed([rssItem({ id: '2610.07600v1', creators: 'Alice Author' })]);
  await ingestRss(raw);
  const hashBefore = (await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash;

  // The creator list is corrected (a second author was missing). The science is untouched, so this is
  // an ordinary metadata correction and is adopted; every other stored field, and the announcement day
  // the first document established, stay exactly as they were.
  const corrected = rssFeed([rssItem({ id: '2610.07600v1', creators: 'Alice Author, Carol Cole' })]);
  const adopted = await ingestRss(corrected, '2026-10-08T12:00:00Z');
  assert.deepEqual(adopted.papers!.adoptedAuthorUpdates, ['2610.07600v1']);
  assert.deepEqual(adopted.papers!.deferredAuthorUpdates, []);
  assert.deepEqual(adopted.papers!.duplicateIds, []);
  const row = (await sql<{ metadata: Record<string, unknown>; metadata_hash: string }[]>`
    SELECT metadata, metadata_hash FROM arxiv_raw_papers`)[0]!;
  assert.deepEqual(row.metadata.authors, ['Alice Author', 'Carol Cole']);
  assert.equal(row.metadata.announced_on, '2026-10-07', 'the correction does not move the announcement day it first named');
  assert.notEqual(row.metadata_hash, hashBefore, 'the identity follows the corrected document');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_same_version_conflicts`)[0]!.n, 0,
    'an adopted correction is not left open as a conflict');

  // The same correction arriving while a paid analysis is in flight is DEFERRED and classified, so the
  // in-flight run keeps the hash it started under and the change is not lost.
  await sql`INSERT INTO arxiv_analysis_claims (arxiv_id, metadata_hash, token)
    VALUES ('2610.07600v1', ${row.metadata_hash}, 'test-claim')`;
  const hashUnderClaim = row.metadata_hash;
  const third = rssFeed([rssItem({ id: '2610.07600v1', creators: 'Alice Author, Carol Cole, Dave Doe' })]);
  const deferred = await ingestRss(third, '2026-10-09T12:00:00Z');
  assert.deepEqual(deferred.papers!.deferredAuthorUpdates, ['2610.07600v1']);
  assert.deepEqual(deferred.papers!.adoptedAuthorUpdates, []);
  assert.deepEqual(deferred.papers!.duplicateIds, [], 'a deferred correction is classified, not silently counted as a duplicate');
  assert.equal((await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash, hashUnderClaim,
    'the in-flight run keeps the hash it started under');
  const pending = await sql<{ kind: string; defers_analysis: boolean; resolved_at: Date | null }[]>`
    SELECT kind, defers_analysis, resolved_at FROM arxiv_same_version_conflicts`;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, 'author_correction_deferred');
  assert.equal(pending[0]!.defers_analysis, false, 'a creator correction must not stall a paper whose science is not in question');
  assert.equal(pending[0]!.resolved_at, null);
});

// Waits (bounded) until the ingest's own connection is really parked on the per-paper advisory
// boundary. The lock is what proves the correction path asks for the boundary BEFORE it reads and
// decides, instead of deciding and then writing unconditionally.
async function waitForBoundaryWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted AND a.query LIKE '%pg_advisory_xact_lock%'`)[0]!.n;
    if (waiting > 0) return;
    if (Date.now() > deadline) throw new Error('the correction never asked for the per-paper boundary');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a creator correction is decided under the per-paper boundary a live claim holds, never over it', async () => {
  await clean();
  await ingestRss(rssFeed([rssItem({ id: '2610.07700v1', creators: 'Alice Author' })]));
  const hashBefore = (await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash;

  // The SAME boundary the code takes, held by somebody else on its own connection.
  const held = gate();
  const holder = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('arxiv_raw_papers:' || ${'2610.07700v1'}, 0))`;
    await held.promise;
  });
  try {
    let settled = false;
    const ingest = ingestRss(
      rssFeed([rssItem({ id: '2610.07700v1', creators: 'Alice Author, Carol Cole' })]), '2026-10-08T12:00:00Z',
    ).then((value) => { settled = true; return value; });
    await waitForBoundaryWaiter();
    assert.equal(settled, false, 'the correction is not decided while the boundary is held');
    assert.equal((await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash, hashBefore,
      'and nothing has been written under it');

    // A paid analysis claims the paper while the correction waits — the interleaving that used to
    // overwrite the document the claim owns and then pay for the same science a second time.
    await sql`INSERT INTO arxiv_analysis_claims (arxiv_id, metadata_hash, token)
      VALUES ('2610.07700v1', ${hashBefore}, 'live')`;
    held.open(undefined);
    const result = await ingest;

    assert.deepEqual(result.papers!.adoptedAuthorUpdates, [], 'the correction is never adopted over a live claim');
    assert.deepEqual(result.papers!.deferredAuthorUpdates, ['2610.07700v1'], 'it is deferred and classified instead');
    assert.deepEqual(result.papers!.duplicateIds, []);
    assert.equal((await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash, hashBefore,
      'the document the claim owns is byte-identical and keeps its hash');
    const pending = await sql<{ kind: string; defers_analysis: boolean; resolved_at: Date | null }[]>`
      SELECT kind, defers_analysis, resolved_at FROM arxiv_same_version_conflicts`;
    assert.equal(pending.length, 1, 'the correction is kept as a reviewable record rather than lost');
    assert.equal(pending[0]!.kind, 'author_correction_deferred');
    assert.equal(pending[0]!.defers_analysis, false, 'a creator correction still never stalls the science');
    assert.equal(pending[0]!.resolved_at, null);
  } finally {
    held.open(undefined);
    await holder;
  }
});

test('a deferred creator correction is adopted only by the controlled procedure, and never re-pays', async () => {
  await clean();
  await ingestRss(rssFeed([rssItem({ id: '2610.07710v1', creators: 'Alice Author' })]));
  const hashBefore = (await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash;

  // The correction arrives while a paid analysis owns the paper: deferred, classified, kept.
  await sql`INSERT INTO arxiv_analysis_claims (arxiv_id, metadata_hash, token) VALUES ('2610.07710v1', ${hashBefore}, 'live')`;
  const deferredIngest = await ingestRss(
    rssFeed([rssItem({ id: '2610.07710v1', creators: 'Alice Author, Carol Cole' })]), '2026-10-08T12:00:00Z');
  assert.deepEqual(deferredIngest.papers!.deferredAuthorUpdates, ['2610.07710v1']);
  const [conflict] = await sql<{ id: number; resolved_at: Date | null }[]>`
    SELECT id, resolved_at FROM arxiv_same_version_conflicts WHERE kind = 'author_correction_deferred'`;
  assert.ok(conflict && conflict.resolved_at === null, 'the correction is recorded and open');

  // The controlled adoption respects the live claim: it moves no document and closes nothing.
  assert.deepEqual(await adoptDeferredAuthorCorrection(conflict!.id),
    { status: 'deferred', arxivId: '2610.07710v1', storedMetadataHash: hashBefore });
  assert.equal((await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash,
    hashBefore, 'the document the claim owns is untouched');

  // The run finishes and releases its claim. Nothing else consumed the correction meanwhile —
  // replaying the announcement alone is a no-op — so an operator adopts it now. The adoption
  // re-derives the correction from the ARCHIVED feed, sends no request and starts no analysis.
  await sql`DELETE FROM arxiv_analysis_claims WHERE arxiv_id = '2610.07710v1'`;
  const outcome = await adoptDeferredAuthorCorrection(conflict!.id);
  assert.equal(outcome.status, 'adopted');
  const row = (await sql<{ metadata: { authors: string[] }; metadata_hash: string; analysis_status: string }[]>`
    SELECT metadata, metadata_hash, analysis_status FROM arxiv_raw_papers WHERE arxiv_id = '2610.07710v1'`)[0]!;
  assert.deepEqual(row.metadata.authors, ['Alice Author', 'Carol Cole']);
  assert.equal(row.metadata_hash, outcome.storedMetadataHash, 'the retry guard follows the adopted document');
  assert.equal(row.analysis_status, 'pending', 'adoption is metadata-only: nothing is analysed by it');
  assert.ok((await sql<{ resolved_at: Date | null }[]>`
    SELECT resolved_at FROM arxiv_same_version_conflicts WHERE id = ${conflict!.id}`)[0]!.resolved_at !== null,
    'the correction is closed only once it is really applied');

  // Adopting twice is a no-op, not a second adoption.
  assert.equal((await adoptDeferredAuthorCorrection(conflict!.id)).status, 'already_resolved');
});

test('an adopted creator correction keeps a REAL completed analysis: the admission never pays for the same science twice', async () => {
  await clean();
  await sql`DELETE FROM arxiv_papers`;
  await sql`DELETE FROM arxiv_reports`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM arxiv_collection_state`;
  await sql`INSERT INTO arxiv_collection_state (key, analysis_start_on) VALUES ('astro-ph', '2026-09-01'::date)`;
  await ingestRss(rssFeed([rssItem({ id: '2610.07730v1', creators: 'Alice Author',
    description: `arXiv:2610.07730v1 Announce Type: new \nAbstract: ${ABSTRACT}` })]));
  const hashBefore = (await sql<{ metadata_hash: string }[]>`SELECT metadata_hash FROM arxiv_raw_papers`)[0]!.metadata_hash;

  const model = await withModel();
  try {
    // The guard's history is REAL, not a fixture: one genuinely invalid model answer is a real paid
    // call, rejected by the strict schema and recorded by the production failure writer. The paper
    // is then cooling, so the test moves the wall clock past the cooldown — to a FIXED instant, so
    // the "cooldown untouched" assertion below can be exact.
    model.setResponse(INVALID_ANSWER);
    assert.equal((await model.api.analyzePendingArxiv({ limit: 1, model: 'default' })).failed, 1);
    assert.equal(model.server.hits(), 1, 'the invalid answer was a real paid call');
    const guard = (await sql<{ validation_failures: number; blocked_reason: string | null }[]>`
      SELECT validation_failures, blocked_reason FROM arxiv_analysis_retry`)[0]!;
    assert.equal(guard.validation_failures, 1);
    assert.equal(guard.blocked_reason, null);
    await sql`UPDATE arxiv_analysis_retry SET next_attempt_at = '2026-10-08T00:00:00Z'::timestamptz`;

    // The real admission claims the paper and calls the model, which the test HOLDS — the exact
    // interleaving that could have cost a second payment for the same science.
    model.setResponse(ANSWER);
    const entered = model.hold();
    const work = model.api.analyzePendingArxiv({ limit: 1, model: 'default' });
    await entered.promise;
    assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM arxiv_analysis_claims WHERE arxiv_id = '2610.07730v1'`)[0]!.n, 1,
      'the live claim is the analysis run\'s own claim, not a fixture');

    // The correction arrives while that claim is live: deferred, classified, kept.
    const deferredIngest = await ingestRss(
      rssFeed([rssItem({ id: '2610.07730v1', creators: 'Alice Author, Carol Cole',
        description: `arXiv:2610.07730v1 Announce Type: new \nAbstract: ${ABSTRACT}` })]), '2026-10-08T12:00:00Z');
    assert.deepEqual(deferredIngest.papers!.deferredAuthorUpdates, ['2610.07730v1']);
    const [conflict] = await sql<{ id: number }[]>`
      SELECT id FROM arxiv_same_version_conflicts WHERE kind = 'author_correction_deferred'`;
    assert.equal((await adoptDeferredAuthorCorrection(conflict!.id)).status, 'deferred',
      'the controlled adoption respects the live claim: it moves no document and closes nothing');

    // Released, the ORIGINAL analysis completes through the real write path: analyzed, report,
    // completed receipt, claim released.
    model.release();
    const result = await work;
    assert.equal(result.analyzed, 1);
    assert.equal(model.server.hits(), 2, 'one invalid call, one completed call — nothing else');
    assert.equal((await sql<{ analysis_status: string }[]>`
      SELECT analysis_status FROM arxiv_raw_papers WHERE arxiv_id = '2610.07730v1'`)[0]!.analysis_status, 'analyzed');
    const [receipt] = await sql<{ status: string; attempts: number; error: string | null }[]>`SELECT status, attempts, error FROM receipts ORDER BY id`;
    assert.deepEqual({ ...receipt }, { status: 'completed', attempts: 2, error: null },
      'the invalid answer and the completing answer are two ATTEMPTS of one paid identity: receipts.ts lets a failed attempt retry on the same receipt row, so there is exactly one receipt and it is completed');
    assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM arxiv_analysis_claims`)[0]!.n, 0,
      'the run released its own claim');

    // The controlled adoption moves the document, and ONLY the document.
    const outcome = await adoptDeferredAuthorCorrection(conflict!.id);
    assert.equal(outcome.status, 'adopted');
    const row = (await sql<{ metadata: { authors: string[] }; metadata_hash: string; analysis_status: string }[]>`
      SELECT metadata, metadata_hash, analysis_status FROM arxiv_raw_papers WHERE arxiv_id = '2610.07730v1'`)[0]!;
    assert.deepEqual(row.metadata.authors, ['Alice Author', 'Carol Cole']);
    assert.equal(row.metadata_hash, outcome.storedMetadataHash);
    assert.equal(row.analysis_status, 'analyzed',
      'a completed analysis is NOT reset: the author list is reader-facing metadata, not a license to pay again');

    // Everything the paid run wrote stays byte for byte: one report, its paper with the ORIGINAL
    // author list (the adoption rewrites nobody's report), and still exactly two receipts.
    const [report] = await sql<{ run_id: string }[]>`SELECT run_id FROM arxiv_reports ORDER BY generated_at DESC LIMIT 1`;
    const papers = await sql<{ run_id: string; paper: { authors: string[] } }[]>`
      SELECT run_id, paper FROM arxiv_papers WHERE paper_key = 'arxiv:2610.07730'`;
    assert.equal(papers.length, 1, 'the existing analysis result is untouched');
    assert.equal(papers[0]!.run_id, report!.run_id, 'it is still the report the original paid run wrote');
    assert.deepEqual(papers[0]!.paper.authors, ['Alice Author'], 'byte for byte — the adoption rewrites nobody\'s report');
    assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM receipts`)[0]!.n, 1,
      'adoption triggers no model and mints no receipt');

    // The retry guard follows the adopted document: the REAL history row migrates, not a fixture.
    const retry = (await sql<{ metadata_hash: string; validation_failures: number; next_attempt_at: Date; blocked_reason: string | null }[]>`
      SELECT metadata_hash, validation_failures, next_attempt_at, blocked_reason
      FROM arxiv_analysis_retry WHERE arxiv_id = '2610.07730v1'`)[0]!;
    assert.equal(retry.metadata_hash, outcome.storedMetadataHash, 'the guard tracks the document, not the old hash');
    assert.equal(retry.validation_failures, 1, 'history is never reset by an adoption');
    assert.equal(new Date(retry.next_attempt_at).toISOString(), '2026-10-08T00:00:00.000Z', 'the cooldown is untouched');
    assert.equal(retry.blocked_reason, null);

    // The NEXT round runs the real admission entry — not just a pending read: it pays ZERO for this
    // identity and starts no claim.
    assert.deepEqual((await readPendingRawArxivPapers(10)).map(paper => paper.arxiv_id), [],
      'the next paid round is offered no pending work for this paper');
    const next = await model.api.analyzePendingArxiv({ limit: 10, model: 'default' });
    assert.deepEqual({ analyzed: next.analyzed, failed: next.failed, skipped: next.skipped }, { analyzed: 0, failed: 0, skipped: 0 });
    assert.equal(model.server.hits(), 2, 'the adopted identity is never paid for a second time');
    assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM arxiv_analysis_claims WHERE arxiv_id = '2610.07730v1'`)[0]!.n, 0,
      'adoption starts no claim of its own, and neither does the next round');
  } finally { model.release(); await model.server.close(); }
});

test('the controlled adoption refuses every document it cannot honestly re-derive', async () => {
  await clean();
  assert.deepEqual(await adoptDeferredAuthorCorrection(9999), { status: 'not_found' });

  // A SCIENTIFIC conflict is never adopted: releasing one is an explicit operator UPDATE, so the
  // procedure refuses instead of quietly taking sides in a disagreement about the science.
  await ingestRss(rssFeed([rssItem({ id: '2610.07720v1', creators: 'Alice Author' })]));
  const driftHash = (await sql<{ metadata_hash: string }[]>`
    SELECT metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = '2610.07720v1'`)[0]!.metadata_hash;
  const [drift] = await sql<{ id: number }[]>`
    INSERT INTO arxiv_same_version_conflicts
      (arxiv_id, base_id, kind, stored_source, arriving_source, stored_metadata_sha256, arriving_document_sha256, detail, defers_analysis)
    VALUES ('2610.07720v1', '2610.07720', 'same_source_drift', 'rss', 'rss',
      ${driftHash}, ${'b'.repeat(64)}, '{}'::jsonb, true)
    RETURNING id`;
  await assert.rejects(() => adoptDeferredAuthorCorrection(drift!.id), /never adopted/);

  // hash_moved: the stored document moved after this correction was recorded (a hand adoption, or a
  // later one), so the recorded correction is stale: it must be re-reviewed, never re-applied.
  await sql`INSERT INTO arxiv_analysis_claims (arxiv_id, metadata_hash, token) VALUES ('2610.07720v1', ${driftHash}, 'live')`;
  await ingestRss(rssFeed([rssItem({ id: '2610.07720v1', creators: 'Alice Author, Carol Cole' })]), '2026-10-08T12:00:00Z');
  const [moved] = await sql<{ id: number }[]>`
    SELECT id FROM arxiv_same_version_conflicts
    WHERE arxiv_id = '2610.07720v1' AND kind = 'author_correction_deferred'`;
  await sql`DELETE FROM arxiv_analysis_claims WHERE arxiv_id = '2610.07720v1'`;
  const stored = (await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM arxiv_raw_papers WHERE arxiv_id = '2610.07720v1'`)[0]!.metadata;
  const byHand = { ...stored, authors: ['Alice Author', 'Carol Cole'] };
  await sql`UPDATE arxiv_raw_papers SET metadata = ${sql.json(byHand)}::text::jsonb,
    metadata_hash = ${rawMetadataDigest(byHand)} WHERE arxiv_id = '2610.07720v1'`;
  const movedOutcome = await adoptDeferredAuthorCorrection(moved!.id);
  assert.equal(movedOutcome.status, 'hash_moved');
  assert.equal(movedOutcome.storedMetadataHash, rawMetadataDigest(byHand), 'it names what IS stored now, and writes nothing');

  // document_missing: the arriving document the conflict points at is not archived, so the
  // correction cannot be re-derived from a preserved original — nothing is invented.
  await ingestRss(rssFeed([rssItem({ id: '2610.07721v1', creators: 'Alice Author' })]));
  const h21 = (await sql<{ metadata_hash: string }[]>`
    SELECT metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = '2610.07721v1'`)[0]!.metadata_hash;
  const [missing] = await sql<{ id: number }[]>`
    INSERT INTO arxiv_same_version_conflicts
      (arxiv_id, base_id, kind, stored_source, arriving_source, stored_metadata_sha256, arriving_document_sha256, detail, defers_analysis)
    VALUES ('2610.07721v1', '2610.07721', 'author_correction_deferred', 'rss', 'rss',
      ${h21}, ${'c'.repeat(64)}, '{}'::jsonb, false)
    RETURNING id`;
  assert.deepEqual(await adoptDeferredAuthorCorrection(missing!.id),
    { status: 'document_missing', arxivId: '2610.07721v1' });

  // superseded: the stored authors already match the archived document, so there is nothing left to
  // adopt and the conflict is stale bookkeeping, not a pending correction.
  await ingestRss(rssFeed([rssItem({ id: '2610.07722v1', creators: 'Alice Author, Carol Cole' })]));
  const h22 = (await sql<{ metadata_hash: string }[]>`
    SELECT metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = '2610.07722v1'`)[0]!.metadata_hash;
  const duplicate = await ingestRss(
    rssFeed([rssItem({ id: '2610.07722v1', creators: 'Alice Author, Carol Cole' })]), '2026-10-08T12:00:00Z');
  const [superseded] = await sql<{ id: number }[]>`
    INSERT INTO arxiv_same_version_conflicts
      (arxiv_id, base_id, kind, stored_source, arriving_source, stored_metadata_sha256, arriving_document_sha256, detail, defers_analysis)
    VALUES ('2610.07722v1', '2610.07722', 'author_correction_deferred', 'rss', 'rss',
      ${h22}, ${duplicate.stored.batchHash}, '{}'::jsonb, false)
    RETURNING id`;
  assert.equal((await adoptDeferredAuthorCorrection(superseded!.id)).status, 'superseded');
});

test('an Atom window page that overlaps stored RSS papers does not fail the batch', async () => {
  await clean();
  await ingestRss(rssFeed([rssItem({ id: '2610.07200v1' }), rssItem({ id: '2610.07201v1' })]));
  // The ordinary submission-date window returns one already stored version beside a genuinely new one.
  // The already stored version is stated by the API with the SAME science, so it is an overlap and the
  // batch is not failed by it — only the genuinely new version is stored.
  const rawAtom = atomEntries([
    { id: '2610.07200v1', title: 'Title of 2610.07200v1', summary: 'Abstract of 2610.07200v1.' },
    { id: '2610.07202v1' },
  ]);
  const result = await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: '2026-10-07T12:00:00Z' });
  assert.equal(result.status, 'imported');
  assert.deepEqual(result.crossSourceOverlaps, ['2610.07200v1']);
  assert.deepEqual(result.contentConflictIds, []);
  assert.equal(result.insertedPaperCount, 1, 'the genuinely new version is still stored');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id='2610.07202v1'`)[0]!.n, 1);
});

test('a content deficiency is isolated in the SAME transaction as the papers around it', async () => {
  await clean();
  const raw = rssFeed([
    rssItem({ id: '2610.07300v1' }),
    rssItem({ id: '2610.07301v1', title: null }),
    rssItem({ id: '2610.07302v1' }),
  ]);
  await ingestRss(raw);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 2);
  const isolated = await sql<{ arxiv_id: string; reason: string; batch_hash: string; raw_item_excerpt: string; raw_item_truncated: boolean }[]>`
    SELECT arxiv_id, reason, batch_hash, raw_item_excerpt, raw_item_truncated FROM arxiv_rss_item_isolations`;
  assert.equal(isolated.length, 1);
  assert.equal(isolated[0]!.arxiv_id, '2610.07301v1');
  assert.equal(isolated[0]!.reason, 'title_missing');
  assert.match(isolated[0]!.raw_item_excerpt, /2610\.07301v1/, 'the unusable item text is kept');
  assert.equal(isolated[0]!.raw_item_truncated, false);
  const batch = (await sql<{ content_hash: string }[]>`SELECT content_hash FROM arxiv_announcement_batches`)[0]!.content_hash;
  assert.equal(isolated[0]!.batch_hash, batch, 'the isolation belongs to the batch that carried it');
  // Replaying the same feed must not accumulate a second isolation row for the same raw item.
  await ingestRss(raw);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_rss_item_isolations`)[0]!.n, 1);
});

test('any later failure in the same round rolls back the evidence, the announcements AND the papers', async () => {
  await clean();
  await assert.rejects(
    sql.begin(async (tx) => {
      const ambient = { begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(tx) };
      const stored = await ingestArxivAnnouncements(RAW, COLLECTED_AT, ambient);
      await persistRssArxivBatch(tx, RAW, stored.batchHash, COLLECTED_AT);
      throw new Error('a later step of the round failed');
    }),
    /a later step of the round failed/);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 0, 'not one paper of the rejected round survives');
});

test('an identity red line still rejects the whole incoming document, before anything is written', async () => {
  await clean();
  // Two healthy items around one whose identity disagrees with its own link: the batch is refused as a
  // whole, so the healthy pair must not slip through as a partial import.
  const bad = rssFeed([
    rssItem({ id: '2610.07400v1' }),
    rssItem({ id: '2610.07401v1' }),
    rssItem({ id: '2610.07402v1' }).replace('https://arxiv.org/abs/2610.07402', 'https://arxiv.org/abs/2610.99999'),
  ]);
  await assert.rejects(ingestRss(bad), /disagrees with canonical identifier|Official announcement evidence conflict/i);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 0);
});

test('versions that already exist from the Atom path keep their own evidence when RSS arrives later', async () => {
  await clean();
  // Atom first: the export API stored this version with its real instants, and the feed later states the
  // SAME science for it — so the feed adds announcement evidence and nothing else.
  const rawAtom = atomEntries([{ id: '2610.07500v1', title: 'Title of 2610.07500v1', summary: 'Abstract of 2610.07500v1.' }]);
  await ingestRawArxivCollection({ papers: parseArxivAtom(rawAtom), raw_atom: rawAtom, collected_at_utc: '2026-10-07T09:00:00Z' });
  const atomRow = (await sql<{ metadata: Record<string, unknown>; first_batch_hash: string | null; source: string }[]>`
    SELECT metadata, first_batch_hash, source FROM arxiv_raw_papers WHERE arxiv_id='2610.07500v1'`)[0]!;
  assert.equal(atomRow.source, 'atom');
  assert.notEqual(atomRow.first_batch_hash, null);
  const { papers } = await ingestRss(rssFeed([
    rssItem({ id: '2610.07500v1' }),
    rssItem({ id: '2610.07501v1' }),
    rssItem({ id: '2610.07502v1' }),
  ]));
  assert.deepEqual(papers!.duplicateIds, ['2610.07500v1']);
  assert.deepEqual(papers!.conflictedIds, [], 'agreeing sources are a plain duplicate, not a conflict');
  assert.deepEqual(papers!.insertedIds, ['2610.07501v1', '2610.07502v1']);
  const after = (await sql<{ metadata: Record<string, unknown>; first_batch_hash: string | null; source: string; first_rss_batch_hash: string | null }[]>`
    SELECT metadata, first_batch_hash, source, first_rss_batch_hash FROM arxiv_raw_papers WHERE arxiv_id='2610.07500v1'`)[0]!;
  assert.deepEqual(after.metadata, atomRow.metadata, 'the verified Atom metadata is what the reader sees');
  assert.equal(after.source, 'atom');
  assert.notEqual(after.first_batch_hash, null);
  assert.equal(after.first_rss_batch_hash, null, 'its evidence still points at its own Atom batch');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements WHERE arxiv_id='2610.07500v1'`)[0]!.n, 1, 'the announcement evidence was still recorded');

  // The other order of the same disagreement: the feed states a different abstract for a version the
  // API already stored. It is not a duplicate and not an overlap — it is a recorded conflict, and the
  // Atom document (with its real instants) is the one that stays.
  const disagreeing = rssFeed([
    rssItem({ id: '2610.07500v1', description: 'arXiv:2610.07500v1 Announce Type: new \nAbstract: A different abstract entirely.' }),
  ]);
  const second = await ingestRss(disagreeing, '2026-10-08T12:00:00Z');
  assert.deepEqual(second.papers!.conflictedIds, ['2610.07500v1']);
  assert.deepEqual(second.papers!.duplicateIds, [], 'a disagreement is never counted as a successful duplicate');
  assert.deepEqual(second.papers!.insertedIds, []);
  const conflict = (await sql<{ kind: string; stored_source: string; arriving_source: string; detail: Record<string, unknown> }[]>`
    SELECT kind, stored_source, arriving_source, detail FROM arxiv_same_version_conflicts`)[0]!;
  assert.equal(conflict.kind, 'cross_source_difference');
  assert.equal(conflict.stored_source, 'atom');
  assert.equal(conflict.arriving_source, 'rss');
  assert.equal(conflict.detail.verdict, 'different');
  assert.deepEqual((await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM arxiv_raw_papers WHERE arxiv_id='2610.07500v1'`)[0]!.metadata, atomRow.metadata,
  'the API document that already carried real instants is not overwritten by the feed');
});

test.after(async () => { await closeDb(); });
