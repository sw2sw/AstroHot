import './setup.ts';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { ingestArxivAnnouncements } from '../packages/backend/src/arxiv/announcements.ts';

const oldDay = 'Tue, 06 Oct 2026 00:00:00 -0400';
const nextDay = 'Wed, 07 Oct 2026 00:00:00 -0400';
function item(type: string, day = oldDay, id = '2512.19652v3') {
  return `<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id}</link><category>astro-ph.GA</category><pubDate>${day}</pubDate><arxiv:announce_type>${type}</arxiv:announce_type></item>`;
}
function rss(items: string, title = 'astro-ph') {
  return `<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>${title}</title>${items}</channel></rss>`;
}
async function snapshot() {
  return {
    announcements: await sql`SELECT * FROM arxiv_announcements ORDER BY arxiv_id,announce_type`,
    batches: await sql`SELECT * FROM arxiv_announcement_batches ORDER BY content_hash`,
  };
}
beforeEach(async () => {
  await sql`DELETE FROM arxiv_announcements`;
  await sql`DELETE FROM arxiv_announcement_batches`;
});
after(closeDb);

test('replace-cross repeated on another source day preserves the first observation and batch', async () => {
  await ingestArxivAnnouncements(rss(item('replace-cross')), '2026-10-07T02:47:25Z');
  const before = await snapshot();
  const result = await ingestArxivAnnouncements(rss(item('replace-cross', nextDay)), '2026-10-08T02:35:03Z');
  assert.equal(result.status, 'imported');
  const after = await snapshot();
  assert.deepEqual(after.announcements, before.announcements);
  assert.equal(after.batches.length, 2);
  assert.deepEqual(after.batches.find(b => b.content_hash === before.batches[0]!.content_hash), before.batches[0]);
});

for (const type of ['new', 'cross', 'replace', 'replace-cross']) {
  test(`${type} same identity and source day in a different batch is idempotent evidence`, async () => {
    await ingestArxivAnnouncements(rss(item(type)), '2026-10-07T02:47:25Z');
    const before = await snapshot();
    const result = await ingestArxivAnnouncements(rss(item(type), 'A different batch'), '2026-10-08T02:35:03Z');
    assert.equal(result.status, 'imported');
    const after = await snapshot();
    assert.deepEqual(after.announcements, before.announcements);
    assert.equal(after.batches.length, 2);
    assert.deepEqual(after.batches.find(b => b.content_hash === before.batches[0]!.content_hash), before.batches[0]);
  });
}

// A repeated cross notice may also move to a later RSS day: the publisher re-lists an identity when it
// recrosses a category, and the standings for that day still name the paper. Treating that as a
// contradiction would roll back the whole incoming feed, including that day's new papers. As with the
// two revision notices, the first observation and its batch are kept.
test('cross repeated on another source day preserves the first observation and batch', async () => {
  await ingestArxivAnnouncements(rss(item('cross')), '2026-10-07T02:47:25Z');
  const before = await snapshot();
  const result = await ingestArxivAnnouncements(rss(item('cross', nextDay)), '2026-10-08T02:35:03Z');
  assert.equal(result.status, 'imported');
  const after = await snapshot();
  assert.deepEqual(after.announcements, before.announcements);
  assert.equal(after.batches.length, 2);
  assert.deepEqual(after.batches.find(b => b.content_hash === before.batches[0]!.content_hash), before.batches[0]);
});

// A new notice has no such latitude: the publisher announces a paper once, so a different source day
// for the same identity is a real contradiction and nothing from the incoming batch may be written.
for (const type of ['new']) {
  test(`${type} contradictory source day rejects and rolls back the entire incoming batch`, async () => {
    await ingestArxivAnnouncements(rss(item(type)), '2026-10-07T02:47:25Z');
    const before = await snapshot();
    // A valid new item precedes the conflict, proving writes are rolled back as well.
    await assert.rejects(ingestArxivAnnouncements(rss(item('new', nextDay, '2610.05001v1') + item(type, nextDay)), '2026-10-08T02:35:03Z'), /Official announcement evidence conflict/);
    assert.deepEqual(await snapshot(), before);
  });
}

// Identity and version are red lines for every repeatable type, cross included: the tolerated latitude
// is the source day alone, never a disagreement about which paper or which version a notice names.
for (const field of ['base_id', 'version'] as const) {
  for (const type of ['replace', 'replace-cross', 'cross']) {
    test(`${type} mismatched stored ${field} still rejects and rolls back the entire batch`, async () => {
      await ingestArxivAnnouncements(rss(item(type)), '2026-10-07T02:47:25Z');
      if (field === 'base_id') await sql`UPDATE arxiv_announcements SET base_id='2512.19653'`;
      else await sql`UPDATE arxiv_announcements SET version=4`;
      const before = await snapshot();
      await assert.rejects(ingestArxivAnnouncements(rss(item('new', nextDay, '2610.05001v1') + item(type, nextDay)), '2026-10-08T02:35:03Z'), /Official announcement evidence conflict/);
      assert.deepEqual(await snapshot(), before);
    });
  }
}
