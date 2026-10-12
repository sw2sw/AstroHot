import assert from 'node:assert/strict';
import test from 'node:test';

const record = (overrides: Record<string, unknown> = {}) => ({
  date: '2025-02-28', post_id: '250228', title: 'Stars &amp; Dust',
  permalink: 'https://apod.nasa.gov/apod/ap250228.html', media_type: 'image',
  explanation: '<p>Dust <b>scatters</b> light.</p><p>Tomorrow\'s picture: <a href="next">Next</a></p>',
  credit: '<a href="https://example.org">Alice &amp; Bob</a>', copyright: '<b>Alice</b>',
  alt: '<i>Stars</i>', url: 'https://apod.nasa.gov/apod/ap250228.html',
  hdurl: 'https://apod.nasa.gov/apod/image/2502/stars.jpg', basic_html: '', ...overrides,
});
const fake = (value: unknown, calls: string[] = []): typeof fetch => async (input, init) => {
  calls.push(String(input));
  assert.equal(init?.redirect, 'error');
  assert.ok(init?.signal);
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
};

test('dated APOD maps image metadata and plain text without guessing image from url', async () => {
  const { fetchApod } = await import('../packages/backend/src/imagery/apod.ts');
  const calls: string[] = [];
  const result = await fetchApod('2025-02-28', { fetchImpl: fake(record(), calls) });
  assert.deepEqual(calls, ['https://science.nasa.gov/wp-json/wp/v2/apod-basic/250228']);
  assert.deepEqual(result, {
    source: 'nasa-apod', sourceDate: '2025-02-28', sourceId: '250228', titleEn: 'Stars & Dust',
    explanationEn: 'Dust scatters light.', credit: 'Alice & Bob', copyright: 'Alice',
    rawCreditHtml: record().credit, rawCopyrightHtml: record().copyright,
    creditLinks: [{label:'Alice & Bob',url:'https://example.org'}], copyrightLinks: [],
    sourceUrl: 'https://apod.nasa.gov/apod/ap250228.html', mediaType: 'image',
    imageUrl: 'https://apod.nasa.gov/apod/image/2502/stars.jpg', mediaUrl: null, altEn: 'Stars',
  });
  const noImage = await fetchApod('2025-02-28', { fetchImpl: fake(record({ hdurl: null })) });
  assert.ok(noImage);
  assert.equal(noImage.mediaType, 'image');
  assert.equal(noImage.imageUrl, null);
});

const NOW = new Date('2026-10-05T12:00:00Z');
test('date validation preserves literal valid dates and rejects invalid ranges', async () => {
  const { validateApodDate } = await import('../packages/backend/src/imagery/date.ts');
  for (const date of ['1995-06-16', '2000-02-29', '2026-10-05']) assert.equal(validateApodDate(date, NOW), date);
  for (const date of ['1995-06-15', '2026-10-06', '2025-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-01', ' 2026-01-01', '2026-01-01T00:00:00Z', '0099-01-01', '2026-01-01\n']) {
    assert.throws(() => validateApodDate(date, NOW), Error, date);
  }
  assert.throws(() => validateApodDate('2026-01-01', new Date('invalid')));
});
