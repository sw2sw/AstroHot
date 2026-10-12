import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildArxivQuery, parseArxivAtom, collectArxivMetadata } from '../packages/backend/src/arxiv/collect.ts';

const ATOM_NS = 'http://www.w3.org/2005/Atom';
const API_BASE = 'https://export.arxiv.org/api/query';
const CATEGORIES = ['astro-ph.CO', 'astro-ph.GA', 'astro-ph.EP', 'astro-ph.HE', 'astro-ph.IM', 'astro-ph.SR'];

function feed(entries: string, opts: { xmlns?: string; root?: string } = {}): string {
  const xmlns = opts.xmlns ?? ATOM_NS;
  const root = opts.root ?? 'feed';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${xmlns}" xmlns:arxiv="http://arxiv.org/schemas/atom">\n<title>arXiv Query Results</title>\n${entries}\n</${root}>`;
}

interface EntryOpts {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  authors?: string[];
  categories?: string[];
  primary?: string;
  omit?: string[];
}

function entry(o: EntryOpts = {}): string {
  const omit = new Set(o.omit ?? []);
  const parts: string[] = [];
  if (!omit.has('id')) parts.push(`<id>${o.id ?? 'http://arxiv.org/abs/2401.00001v2'}</id>`);
  if (!omit.has('updated')) parts.push(`<updated>${o.updated ?? '2024-01-03T00:00:00Z'}</updated>`);
  if (!omit.has('published')) parts.push(`<published>${o.published ?? '2024-01-02T00:00:00Z'}</published>`);
  if (!omit.has('title')) parts.push(`<title>${o.title ?? 'Test Title'}</title>`);
  if (!omit.has('summary')) parts.push(`<summary>${o.summary ?? 'Test abstract.'}</summary>`);
  if (!omit.has('authors')) for (const a of o.authors ?? ['Alice', 'Bob']) parts.push(`<author><name>${a}</name></author>`);
  if (!omit.has('categories')) for (const c of o.categories ?? ['astro-ph.CO']) parts.push(`<category term="${c}"/>`);
  if (o.primary) parts.push(`<arxiv:primary_category term="${o.primary}"/>`);
  return `<entry>\n${parts.join('\n')}\n</entry>`;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function endlessStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start() { /* never enqueues or closes */ } });
}

describe('buildArxivQuery', () => {
  test('defaults to 20 results and a canonical arXiv API URL', () => {
    const url = new URL(buildArxivQuery());
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'export.arxiv.org');
    assert.equal(url.pathname, '/api/query');
    assert.equal(url.searchParams.get('start'), '0');
    assert.equal(url.searchParams.get('max_results'), '20');
    assert.equal(url.searchParams.get('sortBy'), 'submittedDate');
    assert.equal(url.searchParams.get('sortOrder'), 'descending');
  });

  test('search_query contains exactly the six astro-ph categories joined by OR', () => {
    const q = new URL(buildArxivQuery(20)).searchParams.get('search_query') ?? '';
    const terms = q.split(' OR ').map((t) => t.trim());
    assert.deepEqual(terms, CATEGORIES.map((c) => `cat:${c}`));
  });

  test('accepts the documented boundaries 1 and 100', () => {
    assert.equal(new URL(buildArxivQuery(1)).searchParams.get('max_results'), '1');
    assert.equal(new URL(buildArxivQuery(100)).searchParams.get('max_results'), '100');
  });

  test('rejects non-integer and out-of-range maxResults', () => {
    for (const bad of [0, 101, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => buildArxivQuery(bad), /maxResults/);
    }
  });

  test('rejects non-number maxResults', () => {
    assert.throws(() => buildArxivQuery('20' as unknown as number), /maxResults/);
  });

  test('never targets a host other than export.arxiv.org', () => {
    assert.ok(buildArxivQuery().startsWith(API_BASE + '?'));
  });
});

describe('parseArxivAtom, normal documents', () => {
  test('parses a singleton entry into every required field', () => {
    const papers = parseArxivAtom(feed(entry()));
    assert.equal(papers.length, 1);
    const p = papers[0];
    assert.equal(p.arxiv_id, '2401.00001v2');
    assert.equal(p.base_id, '2401.00001');
    assert.equal(p.title_original, 'Test Title');
    assert.equal(p.abstract_original, 'Test abstract.');
    assert.deepEqual(p.authors, ['Alice', 'Bob']);
    assert.deepEqual(p.categories, ['astro-ph.CO']);
    assert.equal(p.submitted_at, '2024-01-02T00:00:00Z');
    assert.equal(p.updated_at, '2024-01-03T00:00:00Z');
    assert.equal(p.url, 'https://arxiv.org/abs/2401.00001v2');
  });

  test('returns an empty array for a zero-entry feed', () => {
    assert.deepEqual(parseArxivAtom(feed('')), []);
  });

  test('decodes XML entities while preserving the text', () => {
    const papers = parseArxivAtom(feed(entry({ title: 'Q&amp;A &lt;core&gt;' })));
    assert.equal(papers[0].title_original, 'Q&A <core>');
  });

  test('retains astro-ph cross-listed categories and ignores foreign ones', () => {
    const papers = parseArxivAtom(feed(entry({ categories: ['astro-ph.CO', 'cond-mat.mes-hall', 'astro-ph.HE'] })));
    assert.deepEqual(papers[0].categories, ['astro-ph.CO', 'astro-ph.HE']);
  });

  test('parses a legacy identifier with an explicit version', () => {
    const papers = parseArxivAtom(feed(entry({ id: 'http://arxiv.org/abs/astro-ph/9901001v1' })));
    assert.equal(papers[0].arxiv_id, 'astro-ph/9901001v1');
    assert.equal(papers[0].base_id, 'astro-ph/9901001');
    assert.equal(papers[0].url, 'https://arxiv.org/abs/astro-ph/9901001v1');
  });
});

describe('parseArxivAtom, rejection and validation', () => {
  test('rejects DOCTYPE declarations', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE feed><feed xmlns="${ATOM_NS}"></feed>`;
    assert.throws(() => parseArxivAtom(xml), /DOCTYPE/);
  });

  test('rejects ENTITY declarations', () => {
    assert.throws(() => parseArxivAtom(`<!ENTITY x "y"><feed xmlns="${ATOM_NS}"></feed>`), /ENTITY/);
  });

  test('rejects a feed in an impostor namespace', () => {
    assert.throws(() => parseArxivAtom(feed('', { xmlns: 'http://example.com/not-atom' })), /Atom namespace/);
  });

  test('rejects a document whose root element is not feed', () => {
    assert.throws(() => parseArxivAtom(`<notfeed xmlns="${ATOM_NS}"></notfeed>`), /must be <feed>/);
  });

  test('rejects arXiv API error entries', () => {
    const xml = feed(entry({ id: 'http://arxiv.org/api/errors#incorrect_id', omit: ['summary'] }));
    assert.throws(() => parseArxivAtom(xml), /error entry/);
  });

  test('rejects entries with missing required fields', () => {
    for (const field of ['id', 'title', 'summary', 'published', 'updated']) {
      assert.throws(() => parseArxivAtom(feed(entry({ omit: [field] }))), /missing/, `expected ${field} to be required`);
    }
  });

  test('rejects entries with invalid dates', () => {
    assert.throws(() => parseArxivAtom(feed(entry({ published: 'not-a-date' }))), /Invalid <published>/);
    assert.throws(() => parseArxivAtom(feed(entry({ updated: '2024-13-99' }))), /Invalid <updated>/);
  });

  test('rejects ids without a version', () => {
    assert.throws(() => parseArxivAtom(feed(entry({ id: 'http://arxiv.org/abs/2401.00001' }))), /version/);
  });

  test('rejects ids that are not arXiv abs URLs', () => {
    assert.throws(() => parseArxivAtom(feed(entry({ id: 'https://example.com/abs/2401.00001v2' }))), /abs URL/);
  });

  test('rejects entries without any astro-ph category', () => {
    assert.throws(() => parseArxivAtom(feed(entry({ categories: ['cond-mat.mes-hall'] }))), /astro-ph category/);
  });
});

describe('parseArxivAtom, identity handling', () => {
  test('deduplicates identical ids', () => {
    const papers = parseArxivAtom(feed(entry({ id: 'http://arxiv.org/abs/2401.00001v1' }) + entry({ id: 'http://arxiv.org/abs/2401.00001v1', title: 'Duplicate' })));
    assert.equal(papers.length, 1);
    assert.equal(papers[0].title_original, 'Test Title');
  });

  test('keeps distinct versions of the same base id', () => {
    const papers = parseArxivAtom(feed(entry({ id: 'http://arxiv.org/abs/2401.00001v1' }) + entry({ id: 'http://arxiv.org/abs/2401.00001v2' })));
    assert.equal(papers.length, 2);
    assert.deepEqual(papers.map((p) => p.arxiv_id), ['2401.00001v1', '2401.00001v2']);
    assert.equal(papers[0].base_id, papers[1].base_id);
  });
});

describe('collectArxivMetadata, fetch behavior', () => {
  const atom = feed(entry());

  test('returns papers, the exact raw_atom, and an ISO timestamp', async () => {
    const fetchImpl = (async () => new Response(atom, { status: 200 })) as unknown as typeof fetch;
    const result = await collectArxivMetadata({ fetch: fetchImpl });
    assert.equal(result.papers.length, 1);
    assert.equal(result.raw_atom, atom);
    assert.equal(result.papers[0].arxiv_id, '2401.00001v2');
    assert.ok(!Number.isNaN(Date.parse(result.collected_at_utc)));
  });

  test('requests the canonical URL with redirect:error and an abort signal', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(atom, { status: 200 });
    }) as unknown as typeof fetch;
    await collectArxivMetadata({ fetch: fetchImpl, maxResults: 5 });
    assert.ok(seenUrl.startsWith(API_BASE));
    assert.equal(new URL(seenUrl).searchParams.get('max_results'), '5');
    assert.equal(seenInit?.redirect, 'error');
    assert.ok(seenInit?.signal instanceof AbortSignal);
  });

  test('supports a zero-entry response', async () => {
    const fetchImpl = (async () => new Response(feed(''), { status: 200 })) as unknown as typeof fetch;
    const result = await collectArxivMetadata({ fetch: fetchImpl });
    assert.deepEqual(result.papers, []);
    assert.equal(result.raw_atom, feed(''));
  });

  test('rejects HTTP error responses', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(() => collectArxivMetadata({ fetch: fetchImpl }), /HTTP 500/);
  });

  test('rejects redirect responses instead of following them', async () => {
    const fetchImpl = (async () => new Response('', { status: 302, headers: { location: 'https://example.com/' } })) as unknown as typeof fetch;
    await assert.rejects(() => collectArxivMetadata({ fetch: fetchImpl }), /HTTP 302/);
  });

  test('propagates fetch failures', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    await assert.rejects(() => collectArxivMetadata({ fetch: fetchImpl }), /network down/);
  });

  test('rejects a response with no body', async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => collectArxivMetadata({ fetch: fetchImpl }), /body is empty/);
  });

  test('rejects a body larger than maxBytes while streaming', async () => {
    const big = new Uint8Array(200).fill(65);
    const fetchImpl = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => collectArxivMetadata({ fetch: fetchImpl, maxBytes: 64 }), /maxBytes/);
  });

  test('enforces the deadline while reading the body', async () => {
    const fetchImpl = (async () => new Response(endlessStream(), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => collectArxivMetadata({ fetch: fetchImpl, timeoutMs: 30 }), /timed out/);
  });
});

describe('collectArxivMetadata, parameter validation', () => {
  function spyFetch() {
    let calls = 0;
    const fn = (async () => { calls += 1; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    return { fn, calls: () => calls };
  }

  test('rejects invalid maxResults without calling fetch', async () => {
    const spy = spyFetch();
    await assert.rejects(() => collectArxivMetadata({ fetch: spy.fn, maxResults: 0 }), /maxResults/);
    assert.equal(spy.calls(), 0);
  });

  test('rejects invalid maxBytes without calling fetch', async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      const spy = spyFetch();
      await assert.rejects(() => collectArxivMetadata({ fetch: spy.fn, maxBytes: bad }), /maxBytes/);
      assert.equal(spy.calls(), 0);
    }
  });

  test('rejects invalid timeoutMs without calling fetch', async () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const spy = spyFetch();
      await assert.rejects(() => collectArxivMetadata({ fetch: spy.fn, timeoutMs: bad }), /timeoutMs/);
      assert.equal(spy.calls(), 0);
    }
  });
});
