import './setup.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { ingestArxivAnnouncements, parseArxivAnnouncements } from '../packages/backend/src/arxiv/announcements.ts';

const officialRss = readFileSync(new URL('fixtures/arxiv-announcements-20261007.rss', import.meta.url), 'utf8');
const repeatedIds = ['2612.92019v1', '2612.92029v1'];
// The two previous source days are from the read-only database audit. Its old raw RSS
// was not captured: reconstruct only the prior observation, never the incoming feed.
const previousItems = [...officialRss.matchAll(/<item>[\s\S]*?<\/item>/g)]
  .map(match => match[0]).filter(item => repeatedIds.some(id => item.includes(`oai:arXiv.org:${id}<`)))
  .map(item => item.replaceAll('Wed, 07 Oct 2026', 'Tue, 06 Oct 2026'));
const previousRss = `<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>Reconstructed previous observations</title>${previousItems.join('')}</channel></rss>`;
after(closeDb);

test('official RSS repeated replacements across days do not roll back the other 28 announcements', async () => {
  assert.equal(previousItems.length, 2);
  const parsed = parseArxivAnnouncements(officialRss);
  assert.equal(parsed.length, 30);
  assert.deepEqual(Object.fromEntries(['new', 'replace', 'cross', 'replace-cross'].map(type =>
    [type, parsed.filter(p => p.announce_type === type).length])), { new: 18, replace: 6, cross: 4, 'replace-cross': 2 });
  await ingestArxivAnnouncements(previousRss, '2026-10-07T02:47:25.508Z');
  const before = await sql`SELECT * FROM arxiv_announcements ORDER BY arxiv_id,announce_type`;
  const firstBatch = await sql`SELECT * FROM arxiv_announcement_batches`;
  const result = await ingestArxivAnnouncements(officialRss, '2026-10-08T02:35:03Z');
  assert.equal(result.status, 'imported');
  assert.equal(result.paperCount, 30);
  assert.deepEqual(await sql`SELECT * FROM arxiv_announcements WHERE arxiv_id IN ${sql(repeatedIds)} ORDER BY arxiv_id,announce_type`, before);
  assert.deepEqual(await sql`SELECT * FROM arxiv_announcement_batches WHERE content_hash=${firstBatch[0]!.content_hash}`, firstBatch);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements`)[0]!.n, 30);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements WHERE first_batch_hash=${result.batchHash}`)[0]!.n, 28);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcements WHERE announce_type='new'`)[0]!.n, 18);
  const batch = (await sql`SELECT * FROM arxiv_announcement_batches WHERE content_hash=${result.batchHash}`)[0]!;
  assert.equal(batch.raw_rss, officialRss);
  assert.equal(batch.paper_count, 30);
  assert.equal(batch.collected_at.toISOString(), '2026-10-08T02:35:03.000Z');
  const snapshot = await sql`SELECT * FROM arxiv_announcements ORDER BY arxiv_id,announce_type`;
  assert.deepEqual(await ingestArxivAnnouncements(officialRss, '2026-10-09T02:35:03Z'), { ...result, status: 'unchanged' });
  assert.deepEqual(await sql`SELECT * FROM arxiv_announcements ORDER BY arxiv_id,announce_type`, snapshot);
  assert.deepEqual((await sql`SELECT * FROM arxiv_announcement_batches WHERE content_hash=${result.batchHash}`)[0], batch);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n, 2);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n, 0);
});
