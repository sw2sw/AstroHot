import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchApod } from '../packages/backend/src/imagery/apod.ts';

const record = (overrides: Record<string, unknown> = {}) => ({
  date: '2025-02-28', title: 'Stars', explanation: '<p>Dust scatters light.</p>',
  permalink: 'https://apod.nasa.gov/apod/ap250228.html', media_type: 'image',
  credit: '', copyright: null, hdurl: null, ...overrides,
});
const fetchRecord = (value: unknown): typeof fetch => async () => new Response(JSON.stringify(value));

test('rights provenance retains exact upstream strings and labelled safe links without interpreting markup', async () => {
  const credit = '<p>Credit: <a href="https://author.example/portfolio?q=1&amp;view=2" onclick="bad()">Alice &amp; Bob</a></p><p>Tomorrow\'s picture: contributor</p><script>bad()</script>';
  const copyright = '© <a href="https://science.nasa.gov/rights">NASA rights</a> / <a href="javascript:alert(1)">unsafe</a> / <a href="https://user:pass@author.example/">credentials</a> / <a href="/relative">relative</a>';
  const item = await fetchApod('2025-02-28', { fetchImpl: fetchRecord(record({ credit, copyright })) });
  assert.ok(item);
  assert.equal(item.rawCreditHtml, credit);
  assert.equal(item.rawCopyrightHtml, copyright);
  assert.equal(item.credit, "Credit: Alice & Bob Tomorrow's picture: contributor");
  assert.equal(item.copyright, '© NASA rights / unsafe / credentials / relative');
  assert.deepEqual(item.creditLinks, [{ label: 'Alice & Bob', url: 'https://author.example/portfolio?q=1&view=2' }]);
  assert.deepEqual(item.copyrightLinks, [{ label: 'NASA rights', url: 'https://science.nasa.gov/rights' }]);
  assert.equal(item.sourceUrl, 'https://apod.nasa.gov/apod/ap250228.html');
});


test('APOD rejects required content that becomes empty after sanitizing', async () => {
  for (const overrides of [
    {title: ' \n '}, {title: '<script>bad()</script><style>bad</style>'},
    {explanation: '<p>&nbsp;</p>'}, {explanation: '<script>bad()</script>'},
    {explanation: "<p>Tomorrow's picture: next</p>"},
  ]) await assert.rejects(fetchApod('2025-02-28', {fetchImpl: fetchRecord(record(overrides))}), /Invalid APOD metadata/);
});
