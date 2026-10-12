import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestRawArxivCollection, readPendingRawArxivPapers, rawMetadataDigest } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';

export function atom(version = 1, title = 'Original title'): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2601.00001v${version}</id><title>${title}</title><summary>Original abstract</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name><arxiv:affiliation>Institute</arxiv:affiliation></author><category term="astro-ph.CO"/><arxiv:primary_category term="astro-ph.CO"/></entry></feed>`;
}
export function collection(xml = atom()) {
  return { raw_atom: xml, papers: parseArxivAtom(xml), collected_at_utc: '2026-01-03T12:00:00Z' };
}
const noDb = { begin: async () => { throw new Error('DB must not be reached'); } };

test('canonical metadata hash is independent of object key order', () => {
  assert.equal(rawMetadataDigest({ b: 2, a: { d: 4, c: 3 } }), rawMetadataDigest({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(rawMetadataDigest({ a: [1, 2] }), rawMetadataDigest({ a: [2, 1] }));
});
test('tampered result is rejected before opening transaction', async () => {
  const input = collection();
  input.papers[0]!.title_original = 'invented';
  await assert.rejects(ingestRawArxivCollection(input, noDb), /match|mismatch/i);
});
test('invalid calendar collection timestamp is rejected before DB', async () => {
  await assert.rejects(ingestRawArxivCollection({ ...collection(), collected_at_utc: '2026-02-30T00:00:00Z' }, noDb), /date|timestamp|collected/i);
});
test('empty entry is not a valid zero-result feed', async () => {
  await assert.rejects(ingestRawArxivCollection({ raw_atom: '<feed xmlns="http://www.w3.org/2005/Atom"><entry/></feed>', papers: [], collected_at_utc: '2026-01-03T00:00:00Z' }, noDb), /entry|malformed/i);
});
test('invalid IDs and version range rejected before DB', async () => {
  for (const id of ['2601.00001v0', "2601.00001v1';DROP", '2601.00001v2147483648', '2601.00001v9007199254740993']) {
    const xml = atom().replace('2601.00001v1', id);
    let papers: ReturnType<typeof parseArxivAtom>;
    try { papers = parseArxivAtom(xml); } catch { papers = []; }
    await assert.rejects(ingestRawArxivCollection({ raw_atom: xml, papers, collected_at_utc: '2026-01-03T00:00:00Z' }, noDb), /id|version|unsupported/i);
  }
});
test('invalid supplied identities, missing papers and duplicate supplied rows are rejected', async () => {
  const input = collection();
  for (const papers of [[], [...input.papers, ...input.papers], [{ ...input.papers[0]!, base_id: 'different' }]]) {
    await assert.rejects(ingestRawArxivCollection({ ...input, papers }, noDb), /match|mismatch/i);
  }
});
test('malformed XML, API error and nested namespace rebinding are rejected before DB', async () => {
  const xmls = [
    '<feed>', '',
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#bad</id></entry></feed>',
    atom().replace('<author>', '<author xmlns="urn:evil">'),
    atom().replace('<name>', '<name xmlns="urn:evil">'),
  ];
  for (const raw_atom of xmls) {
    await assert.rejects(ingestRawArxivCollection({ raw_atom, papers: [], collected_at_utc: '2026-01-03T00:00:00Z' }, noDb), /Atom|XML|error|namespace/i);
  }
});
test('non-UTC and impossible collection timestamps rejected before DB', async () => {
  for (const collected_at_utc of ['2026-01-01', '2026-01-01T00:00:00+08:00', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', '0000-01-01T00:00:00Z']) {
    await assert.rejects(ingestRawArxivCollection({ ...collection(), collected_at_utc }, noDb), /timestamp|collected/i);
  }
});
test('reader limits are bounded before opening DB', async () => {
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
    await assert.rejects(readPendingRawArxivPapers(limit, noDb), /limit/i);
  }
});
