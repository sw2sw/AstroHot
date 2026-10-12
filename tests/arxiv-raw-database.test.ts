import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { ingestRawArxivCollection, readPendingRawArxivPapers } from '../packages/backend/src/arxiv/raw-store.ts';
import type { RawArxivDatabase } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';

function entry(id = '2601.00001v1', title = 'Original title') {
  return `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title><summary>Original abstract</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name><arxiv:affiliation>Institute</arxiv:affiliation></author><category term="astro-ph.CO"/><arxiv:primary_category term="astro-ph.CO"/></entry>`;
}
function collection(entries = entry(), suffix = '') {
  const raw_atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${entries ? 1 : 0}</opensearch:totalResults>${entries}</feed>${suffix}`;
  return { raw_atom, papers: parseArxivAtom(raw_atom), collected_at_utc: '2026-01-03T12:00:00Z' };
}

test('isolated PostgreSQL raw archive acceptance', { skip: !process.env.ARXIV_RAW_TEST_URL }, async (t) => {
  const url = new URL(process.env.ARXIV_RAW_TEST_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/astrohot_raw_[a-z0-9]+_test$/);
  const sql = postgres(url.toString(), { max: 8, onnotice: () => {} });
  const db: RawArxivDatabase = { begin: async (fn) => sql.begin(fn) as ReturnType<typeof fn> };
  try {
    // Pending admission now joins durable retry/announcement/window state. Use an isolated
    // fully migrated empty template, not a historical two-table raw-only schema.
    assert.equal((await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name='0062_arxiv_collection_state.sql'`)[0]!.n, 1);
    const reset = async () => { await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches CASCADE`; };

    await t.test('first save stores exact XML, timestamp, originals and pending status without analysis or receipts', async () => {
      const input = collection();
      const result = await ingestRawArxivCollection(input, db);
      assert.equal(result.status, 'imported');
      assert.equal(result.paperCount, 1);
      assert.equal(result.batchHash, createHash('sha256').update(input.raw_atom).digest('hex'));
      const [batch] = await sql`SELECT * FROM arxiv_raw_batches`;
      assert.equal(batch!.raw_atom, input.raw_atom);
      assert.equal(batch!.collected_at.toISOString(), '2026-01-03T12:00:00.000Z');
      const [paper] = await sql`SELECT * FROM arxiv_raw_papers`;
      assert.deepEqual(paper!.metadata, input.papers[0]);
      assert.equal(paper!.analysis_status, 'pending');
      assert.equal(paper!.version, 1);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_papers`)[0]!.n, 0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, 0);
    });

    await t.test('duplicate exact batch preserves first collection timestamp and future analyzed status', async () => {
      await sql`UPDATE arxiv_raw_papers SET analysis_status='analyzed'`;
      const result = await ingestRawArxivCollection({ ...collection(), collected_at_utc: '2026-01-04T00:00:00Z' }, db);
      assert.equal(result.status, 'unchanged');
      const [batch] = await sql`SELECT * FROM arxiv_raw_batches`;
      assert.equal(batch!.collected_at.toISOString(), '2026-01-03T12:00:00.000Z');
      assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers`)[0]!.analysis_status, 'analyzed');
    });

    await t.test('different XML same metadata archives batch without resetting analyzed status', async () => {
      await ingestRawArxivCollection(collection(entry(), '\n'), db);
      assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers`)[0]!.analysis_status, 'analyzed');
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_batches`)[0]!.n, 2);
    });

    await t.test('all versions retained, older arrivals never displace latest and latest analyzed hides older pending', async () => {
      await reset();
      await ingestRawArxivCollection(collection(entry('2601.00001v3')), db);
      await ingestRawArxivCollection(collection(entry('2601.00001v1')), db);
      await ingestRawArxivCollection(collection(entry('2601.00001v2')), db);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_papers`)[0]!.n, 3);
      assert.deepEqual((await readPendingRawArxivPapers(10, db)).map(r => r.arxiv_id), ['2601.00001v3']);
      await sql`UPDATE arxiv_raw_papers SET analysis_status='analyzed' WHERE version=3`;
      assert.equal((await readPendingRawArxivPapers(10, db)).length, 0);
    });

    await t.test('same version conflict rolls back batch and earlier inserted new paper', async () => {
      await reset();
      await ingestRawArxivCollection(collection(), db);
      await assert.rejects(ingestRawArxivCollection(collection(entry('2601.00002v1') + entry('2601.00001v1', 'Changed title')), db), /conflict/i);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_batches`)[0]!.n, 1);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_papers`)[0]!.n, 1);
      assert.equal((await sql`SELECT metadata FROM arxiv_raw_papers`)[0]!.metadata.title_original, 'Original title');
    });

    await t.test('SQL-looking title is stored literally using parameters', async () => {
      await reset();
      const title = "x'); DROP TABLE arxiv_raw_batches; --";
      await ingestRawArxivCollection(collection(entry('2601.00001v1', title)), db);
      assert.equal((await sql`SELECT metadata FROM arxiv_raw_papers`)[0]!.metadata.title_original, title);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_batches`)[0]!.n, 1);
    });

    await t.test('genuine zero-entry feed persists as zero batch', async () => {
      await reset();
      const result = await ingestRawArxivCollection(collection(''), db);
      assert.equal(result.paperCount, 0);
      assert.equal((await sql`SELECT paper_count FROM arxiv_raw_batches`)[0]!.paper_count, 0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_papers`)[0]!.n, 0);
    });

    await t.test('concurrent identical first ingest yields one imported and remaining unchanged', async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 6 }, () => ingestRawArxivCollection(collection(), db)));
      assert.equal(results.filter(r => r.status === 'imported').length, 1);
      assert.equal(results.filter(r => r.status === 'unchanged').length, 5);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_papers`)[0]!.n, 1);
    });

    await t.test('concurrent differing metadata for same version rejects exactly one atomic batch', async () => {
      await reset();
      const results = await Promise.allSettled([
        ingestRawArxivCollection(collection(entry('2601.00001v1', 'One')), db),
        ingestRawArxivCollection(collection(entry('2601.00001v1', 'Two')), db),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const rejected = results.find(r => r.status === 'rejected');
      assert.ok(rejected?.status === 'rejected' && /conflict/i.test(String(rejected.reason)));
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_batches`)[0]!.n, 1);
      assert.equal((await sql`SELECT count(*)::int AS n FROM arxiv_raw_papers`)[0]!.n, 1);
    });

    await t.test('bounded reader deterministic ordering and default limit', async () => {
      await reset();
      const entries = Array.from({ length: 25 }, (_, i) => entry(`2601.${String(i + 1).padStart(5, '0')}v1`)).reverse().join('');
      await ingestRawArxivCollection(collection(entries), db);
      const first = await readPendingRawArxivPapers(1, db);
      assert.deepEqual(first.map(r => r.arxiv_id), ['2601.00001v1']);
      assert.equal((await readPendingRawArxivPapers(undefined, db)).length, 20);
    });

    await t.test('legacy arXiv identity retains version and base separately', async () => {
      await reset();
      await ingestRawArxivCollection(collection(entry('astro-ph/9901001v2')), db);
      const [row] = await readPendingRawArxivPapers(10, db);
      assert.equal(row!.base_id, 'astro-ph/9901001');
      assert.equal(row!.version, 2);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
