// S1 — the official announcement feed read as a SOURCE OF PAPERS.
//
// This file is deliberately DB-free: it covers the reading rules of the new RSS-native paper reader
// (packages/backend/src/arxiv/rss-paper.ts) — what is kept verbatim, what is refused, and above all
// what is NEVER invented. The feed carries no submission or update instant, so the reader must not
// synthesize one from the announcement day, from the ID's month or from the collection clock.
//
// Follows the repository convention for a module under construction: the import is lazy and guarded,
// so a missing reader fails as a named assertion instead of a module-resolution error.
import test from 'node:test';
import assert from 'node:assert/strict';

async function reader() {
  const module = await import('../packages/backend/src/arxiv/rss-paper.ts').catch(() => null);
  assert.equal(typeof module?.parseArxivRssFeed, 'function', 'the RSS-native paper reader must exist');
  assert.equal(typeof module?.rssPaperMetadata, 'function');
  assert.equal(typeof module?.rssAbstract, 'function');
  assert.equal(typeof module?.parseRssCreators, 'function');
  return module!;
}
const { parseArxivRssFeed, rssPaperMetadata, rssAbstract, parseRssCreators } = await reader();
// The identity red lines live in ONE reader (announcements.ts) that both entries share, so the tests
// about identity address that reader directly as well as through the paper reader.
const { parseArxivAnnouncements } = await import('../packages/backend/src/arxiv/announcements.ts');

// ---------------------------------------------------------------------------------------------
// A real official feed: one <item> per announcement, with the fields the source really publishes.
// dc: is bound to its real namespace, and scientific text that contains markup is XML-escaped the
// way the publisher escapes it.
// ---------------------------------------------------------------------------------------------
interface ItemSpec {
  id: string;
  title?: string | null;
  description?: string | null;
  creators?: string | null;
  categories?: string[];
  type?: string;
  date?: string;
  link?: string;
}
const DATE = (weekday: string, day: string) => `${weekday}, ${day} Oct 2026 00:00:00 -0400`;
const item = (spec: ItemSpec) => {
  const base = spec.id.replace(/v\d+$/, '');
  const type = spec.type ?? 'new';
  const description = spec.description === null ? undefined
    : spec.description ?? `arXiv:${spec.id} Announce Type: ${type} \nAbstract: Abstract of ${spec.id}.`;
  return [
    '<item>',
    spec.title === null ? '' : `<title>${spec.title ?? `Title of ${spec.id}`}</title>`,
    `<link>${spec.link ?? `https://arxiv.org/abs/${base}`}</link>`,
    description === undefined ? '' : `<description>${description}</description>`,
    `<guid>oai:arXiv.org:${spec.id}</guid>`,
    ...(spec.categories ?? ['astro-ph.CO']).map((category) => `<category>${category}</category>`),
    `<pubDate>${spec.date ?? DATE('Wed', '07')}</pubDate>`,
    spec.creators === null ? '' : `<dc:creator>${spec.creators ?? 'Alice Author, Bob Builder'}</dc:creator>`,
    `<arxiv:announce_type>${type}</arxiv:announce_type>`,
    '</item>',
  ].join('');
};
const feed = (items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>astro-ph updates</title><link>https://rss.arxiv.org/rss/astro-ph</link>${items.join('')}</channel></rss>`;

// ---------------------------------------------------------------------------------------------

test('a real feed item becomes a complete paper, and no submission instant is invented', () => {
  const parsed = parseArxivRssFeed(feed([item({ id: '2610.01983v1' })]));
  assert.equal(parsed.itemCount, 1, 'the channel carried one item');
  assert.equal(parsed.announcementCount, 1);
  assert.deepEqual(parsed.isolated, [], 'a complete item is not an anomaly');
  const [paper] = parsed.items;
  assert.equal(paper!.arxiv_id, '2610.01983v1');
  assert.equal(paper!.base_id, '2610.01983');
  assert.equal(paper!.version, 1);
  assert.equal(paper!.announce_type, 'new');
  assert.equal(paper!.announced_on, '2026-10-07');
  assert.equal(paper!.title_original, 'Title of 2610.01983v1');
  assert.equal(paper!.abstract_original, 'Abstract of 2610.01983v1.');
  assert.deepEqual(paper!.authors, ['Alice Author', 'Bob Builder']);
  assert.equal(paper!.authors_original, 'Alice Author, Bob Builder');
  assert.equal(paper!.authors_quality, 'parsed');
  assert.deepEqual(paper!.categories, ['astro-ph.CO']);
  assert.equal(paper!.url, 'https://arxiv.org/abs/2610.01983v1');
});

test('the paper metadata has no submission/update instant at all, and no Atom-only field', () => {
  const [paper] = parseArxivRssFeed(feed([item({ id: '2610.01983v1' })])).items;
  const meta = rssPaperMetadata(paper!);
  // The feed states neither instant. The announcement day, the ID's month (2610 -> October) and the
  // collection clock all happen to name a date here; none of them may be promoted to submitted_at.
  assert.equal(meta.submitted_at, null);
  assert.equal(meta.updated_at, null);
  assert.equal(meta.source, 'rss');
  assert.equal(meta.announce_type, 'new');
  assert.equal(meta.announced_on, '2026-10-07');
  assert.deepEqual(Object.keys(meta).sort(), [
    'abstract_original', 'announce_type', 'announced_on', 'arxiv_id', 'authors', 'authors_original',
    'authors_quality', 'base_id', 'categories', 'source', 'submitted_at', 'title_original',
    'updated_at', 'url',
  ].sort(), 'the metadata contract is exactly the Atom reader keys plus the RSS source facts');
});

test('the announcement day is the SOURCE calendar day, never converted through UTC', () => {
  for (const [date, day] of [
    [DATE('Fri', '09'), '2026-10-09'],
    ['Fri, 09 Oct 2026 23:30:00 -0400', '2026-10-09'], // already the 10th in UTC
    ['Fri, 09 Oct 2026 00:30:00 -0400', '2026-10-09'],
    ['Fri, 09 Oct 2026 23:30:00 +1400', '2026-10-09'], // the offset is validated, not applied
  ] as const) {
    const [paper] = parseArxivRssFeed(feed([item({ id: '2610.01983v1', date })])).items;
    assert.equal(paper!.announced_on, day, date);
  }
});

test('the abstract is everything after the publisher marker, kept verbatim', () => {
  // rssAbstract works on the text the XML parser already decoded.
  const decoded = 'arXiv:2610.01983v1 Announce Type: new \nAbstract: We fit $\\alpha$ & $\\beta$ with <b>bold</b> data.\r\nSecond line keeps   spacing.';
  assert.equal(rssAbstract(decoded),
    'We fit $\\alpha$ & $\\beta$ with <b>bold</b> data.\nSecond line keeps   spacing.');
  // The same text as the publisher really sends it: XML-escaped. The entities are decoded by the XML
  // parser and the scientific content — LaTeX, the literal "<" of the bold markup — comes back intact.
  const escaped = 'arXiv:2610.01983v1 Announce Type: new \nAbstract: We fit $\\alpha$ &amp; $\\beta$ with &lt;b&gt;bold&lt;/b&gt; data.\r\nSecond line keeps   spacing.';
  const [paper] = parseArxivRssFeed(feed([item({ id: '2610.01983v1', description: escaped })])).items;
  assert.equal(paper!.abstract_original,
    'We fit $\\alpha$ & $\\beta$ with <b>bold</b> data.\nSecond line keeps   spacing.');
  // The scaffolding before the marker is publisher metadata, not abstract text.
  assert.doesNotMatch(paper!.abstract_original, /Announce Type/);
  // No marker at all is an absence, not an empty abstract.
  assert.equal(rssAbstract('arXiv:2610.01983v1 Announce Type: new \n'), undefined);
  assert.equal(rssAbstract(''), undefined);
});

test('creators keep their source text, and an unreadable list is never split on a guess', () => {
  assert.deepEqual(parseRssCreators('Alice Author, Bob Builder, Carol Cole'),
    { authors: ['Alice Author', 'Bob Builder', 'Carol Cole'], quality: 'parsed' });
  // A comma without a following space is part of the name, not the official separator.
  assert.deepEqual(parseRssCreators('Smith,John'), { authors: ['Smith,John'], quality: 'unparsed' });
  assert.deepEqual(parseRssCreators('The LIGO Scientific Collaboration'),
    { authors: ['The LIGO Scientific Collaboration'], quality: 'unparsed' });
  const [paper] = parseArxivRssFeed(feed([item({ id: '2610.01983v1', creators: 'The LIGO  Scientific Collaboration' })])).items;
  assert.equal(paper!.authors_original, 'The LIGO  Scientific Collaboration', 'the source text is verbatim');
  assert.deepEqual(paper!.authors, ['The LIGO Scientific Collaboration'], 'the parsed list is whitespace-normalized');
  assert.equal(paper!.authors_quality, 'unparsed');
});

test('all four announcement types and old-style identifiers are read the same way', () => {
  for (const type of ['new', 'cross', 'replace', 'replace-cross']) {
    const [paper] = parseArxivRssFeed(feed([item({ id: 'astro-ph/9901001v2', type })])).items;
    assert.equal(paper!.announce_type, type);
    assert.equal(paper!.arxiv_id, 'astro-ph/9901001v2');
    assert.equal(paper!.base_id, 'astro-ph/9901001');
    assert.equal(paper!.version, 2);
    assert.equal(paper!.url, 'https://arxiv.org/abs/astro-ph/9901001v2');
  }
});

test('every category is kept in feed order and no list position becomes "the primary category"', () => {
  const [paper] = parseArxivRssFeed(feed([item({ id: '2610.01983v1', categories: ['astro-ph.HE', 'gr-qc', 'astro-ph.CO'] })])).items;
  assert.deepEqual(paper!.categories, ['astro-ph.HE', 'gr-qc', 'astro-ph.CO']);
  assert.equal(Object.hasOwn(paper!, 'primary_category'), false);
  assert.equal(Object.hasOwn(rssPaperMetadata(paper!), 'primary_category'), false);
});

test('a content deficiency is isolated with its raw text; every other item is still read', () => {
  const parsed = parseArxivRssFeed(feed([
    item({ id: '2610.02001v1' }),
    item({ id: '2610.02002v1', title: null }),
    item({ id: '2610.02003v1', description: null }),
    item({ id: '2610.02004v1', creators: null }),
    item({ id: '2610.02005v1' }),
  ]));
  assert.equal(parsed.itemCount, 5, 'the channel really carried five items');
  assert.deepEqual(parsed.items.map((paper) => paper.arxiv_id), ['2610.02001v1', '2610.02005v1']);
  assert.deepEqual(parsed.isolated.map((row) => [row.arxivId, row.reason]), [
    ['2610.02002v1', 'title_missing'],
    ['2610.02003v1', 'abstract_missing'],
    ['2610.02004v1', 'creator_missing'],
  ]);
  for (const row of parsed.isolated) {
    assert.match(row.itemSha256, /^[0-9a-f]{64}$/);
    assert.match(row.excerpt, new RegExp(`oai:arXiv\\.org:${row.arxivId!.replace('.', '\\.')}`), 'the raw item travels with the isolation');
    assert.equal(row.truncated, false);
  }
  // Same item, same reason: the digest of the raw text is what identifies it, not its position.
  const again = parseArxivRssFeed(feed([item({ id: '2610.02002v1', title: null })]));
  assert.equal(again.isolated[0]!.itemSha256, parsed.isolated[0]!.itemSha256);
});

test('an oversized raw item is kept truncated, and the truncation is stated', () => {
  const parsed = parseArxivRssFeed(feed([item({ id: '2610.02100v1', description: 'y'.repeat(5000) })]));
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.isolated.length, 1);
  assert.equal(parsed.isolated[0]!.reason, 'abstract_missing', 'a description with no abstract section is an absence');
  assert.equal(parsed.isolated[0]!.truncated, true);
  assert.equal(parsed.isolated[0]!.excerpt.length, 4000);
});

test('an identity conflict rejects the whole document instead of being isolated', () => {
  const good = item({ id: '2610.03000v1' });
  for (const [label, bad] of [
    ['no target astronomy category', item({ id: '2610.03738v1', categories: ['hep-th'] })],
    ['link disagrees with the canonical id', item({ id: '2610.03738v1', link: 'https://arxiv.org/abs/2610.99999' })],
    ['untrusted host', item({ id: '2610.03738v1', link: 'https://evil.test/abs/2610.03738' })],
    ['link carries a query', item({ id: '2610.03738v1', link: 'https://arxiv.org/abs/2610.03738v1?x=1' })],
    ['version zero', item({ id: '2610.03738v0' })],
    ['unversioned id', item({ id: '2610.03738' })],
    ['unsupported announce type', item({ id: '2610.03738v1', type: 'announced' })],
  ] as const) {
    assert.throws(() => parseArxivRssFeed(feed([good, bad])), label);
  }
  // A missing canonical guid is a document-level red line too, and it is not isolatable either.
  assert.throws(() => parseArxivRssFeed(feed([good]).replace('<guid>oai:arXiv.org:2610.03000v1</guid>', '<guid>oai:arXiv.org:2610.03001v1</guid>')));
  assert.throws(() => parseArxivRssFeed(feed([good]).replace(/<guid>.*?<\/guid>/, '')));
});

test('a rebound dc namespace is refused rather than trusted', () => {
  assert.throws(
    () => parseArxivRssFeed(feed([item({ id: '2610.03001v1' })]).replace('http://purl.org/dc/elements/1.1/', 'http://attacker.invalid/dc')),
    /namespace/);
});

// ---------------------------------------------------------------------------------------------
// RSS-U1. The publisher scaffolding is not decoration: when the feed states an identity in the
// description, that identity is what the item is ABOUT, and it has to be the one the canonical guid
// names. A document that disagrees with itself is refused as a whole, exactly like a link that
// disagrees with the identifier — one item cannot be trusted to describe two versions.
// ---------------------------------------------------------------------------------------------

/** The `<item>` body without its wrapper, so a test can add or replace the item's own attributes. */
const itemBody = (id: string, type = 'new') => [
  `<title>Title of ${id}</title>`,
  `<link>https://arxiv.org/abs/${id.replace(/v\d+$/, '')}</link>`,
  `<guid>oai:arXiv.org:${id}</guid>`,
  '<category>astro-ph.CO</category>',
  `<pubDate>${DATE('Wed', '07')}</pubDate>`,
  `<arxiv:announce_type>${type}</arxiv:announce_type>`,
].join('');
const CREATOR = '<dc:creator>Alice Author, Bob Builder</dc:creator>';

/** An `<item>` assembled from explicit parts, so a test controls the item's own namespace bindings. */
const rawItem = (parts: { id: string; description?: string; attributes?: string; creator?: string }) =>
  `<item${parts.attributes ?? ''}>${itemBody(parts.id)}` +
  `${parts.description === undefined ? '' : `<description>${parts.description}</description>`}` +
  `${parts.creator ?? CREATOR}</item>`;
const described = (id: string, description: string, extra: { attributes?: string; creator?: string } = {}) =>
  rawItem({ id, description, ...extra });

test('a description whose official prefix names another identity rejects the whole document', () => {
  const good = item({ id: '2610.03100v1' });
  const cases: [string, string][] = [
    ['another base id', described('2610.03101v1', 'arXiv:2610.03102v1 Announce Type: new \nAbstract: Abstract of someone else.')],
    ['another version of the same base', described('2610.03101v1', 'arXiv:2610.03101v2 Announce Type: new \nAbstract: Abstract of v2.')],
    ['another announcement type', described('2610.03101v1', 'arXiv:2610.03101v1 Announce Type: replace \nAbstract: Abstract of the replacement.')],
  ];
  for (const [label, bad] of cases) {
    // The healthy item is listed FIRST, so a partial import would have stored it before the conflict
    // was seen: the red line is that the batch is refused as a whole, not that it is truncated.
    assert.throws(() => parseArxivRssFeed(feed([good, bad])), label);
  }
  // The SAME reader validates the announcement evidence, so both entries refuse the same document for
  // the same reason instead of each keeping its own idea of what the identity is.
  for (const [label, bad] of cases) {
    assert.throws(() => parseArxivAnnouncements(feed([good, bad])), label);
  }
});

test('an unrecognisable description is a content absence, not an identity conflict', () => {
  // No publisher prefix at all: nothing claims an identity, so the item is isolated per item (no
  // abstract section) and the batch around it commits. Free-form scientific text is never parsed for
  // identity, so it can never be "cleaned" into one either.
  const parsed = parseArxivRssFeed(feed([
    item({ id: '2610.03201v1' }),
    described('2610.03202v1', 'A paragraph that names no arXiv identity at all.'),
    // A prefix that AGREES with the item is obviously not a conflict: the same reader accepts it.
    described('2610.03203v1', 'arXiv:2610.03203v1 Announce Type: new \nAbstract: A real abstract.'),
  ]));
  assert.deepEqual(parsed.items.map((paper) => paper.arxiv_id), ['2610.03201v1', '2610.03203v1']);
  assert.deepEqual(parsed.isolated.map((row) => [row.arxivId, row.reason]), [
    ['2610.03202v1', 'abstract_missing'],
  ]);
  assert.equal(parsed.items[1]!.abstract_original, 'A real abstract.');
});

test('the creator is read in the ITEM’s namespace context, not only the channel’s', () => {
  const REAL_DC = 'http://purl.org/dc/elements/1.1/';
  const abstract = (id: string) => `arXiv:${id} Announce Type: new \nAbstract: A real abstract.`;
  const onlyCreator = '<dc:creator>Alice Author</dc:creator>';

  // The channel declares no dc at all and the item declares the real one for itself: the creator is
  // real and must be read. (Reading only the channel's context refused a legitimate document.)
  const withoutChannelDc = feed([
    described('2610.03301v1', abstract('2610.03301v1'), { attributes: ` xmlns:dc="${REAL_DC}"`, creator: onlyCreator }),
  ]).replace(` xmlns:dc="${REAL_DC}"`, '');
  const [paper] = parseArxivRssFeed(withoutChannelDc).items;
  assert.equal(paper!.arxiv_id, '2610.03301v1');
  assert.equal(paper!.authors_original, 'Alice Author');

  // The channel is correct, but the ITEM rebinds dc to a foreign namespace: the rebinding is an
  // identity red line, not a missing creator — the creator text comes from a namespace the feed never
  // declared for it, and the whole document is refused.
  assert.throws(
    () => parseArxivRssFeed(feed([
      described('2610.03302v1', abstract('2610.03302v1'), { attributes: ' xmlns:dc="http://attacker.invalid/dc"', creator: onlyCreator }),
    ])),
    /namespace/,
  );
  // The same rebinding is refused when it is narrower still: the creator field declares the foreign
  // namespace for itself while the item and channel are both correct.
  assert.throws(
    () => parseArxivRssFeed(feed([
      described('2610.03303v1', abstract('2610.03303v1'), { creator: `<dc:creator xmlns:dc="http://attacker.invalid/dc">Alice Author</dc:creator>` }),
    ])),
    /namespace/,
  );
  // …and a field-local declaration of the real namespace is honoured even when the item rebound it,
  // because the field states its own namespace.
  const [local] = parseArxivRssFeed(feed([
    described('2610.03304v1', abstract('2610.03304v1'), { attributes: ' xmlns:dc="http://attacker.invalid/dc"', creator: `<dc:creator xmlns:dc="${REAL_DC}">Alice Author</dc:creator>` }),
  ])).items;
  assert.equal(local!.arxiv_id, '2610.03304v1');
  assert.equal(local!.authors_original, 'Alice Author');
});

test('an empty channel is valid and yields nothing, while a broken document is refused', () => {
  assert.deepEqual(parseArxivRssFeed(feed([])), { items: [], isolated: [], itemCount: 0, announcementCount: 0 });
  for (const xml of ['', '<rss>', '<html>Unavailable</html>', '<rss version="2.0"><channel><item/></channel></rss>',
    '<rss version="2.0"><channel/></rss><rss version="2.0"><channel/></rss>']) {
    assert.throws(() => parseArxivRssFeed(xml), xml.slice(0, 40));
  }
  assert.throws(() => parseArxivRssFeed('<!DOCTYPE rss [<!ENTITY x "data">]>' + feed([item({ id: '2610.03001v1' })])));
});

test('a repeated entry is one announcement and one paper, not two', () => {
  const repeated = item({ id: '2610.03002v1' });
  const parsed = parseArxivRssFeed(feed([repeated, repeated]));
  assert.equal(parsed.itemCount, 2, 'the channel really listed it twice');
  assert.equal(parsed.announcementCount, 1);
  assert.equal(parsed.items.length, 1);
});

test('the reader is deterministic: the same raw bytes read twice give byte-identical papers', () => {
  const xml = feed([
    item({ id: '2610.04001v1', categories: ['astro-ph.GA'] }),
    item({ id: 'astro-ph/0501002v3', type: 'replace-cross', creators: 'The Collaboration' }),
    item({ id: '2610.04003v1', description: 'arXiv:2610.04003v1 Announce Type: new \nAbstract: $\\gamma$ &amp; \\delta' }),
  ]);
  assert.equal(JSON.stringify(parseArxivRssFeed(xml)), JSON.stringify(parseArxivRssFeed(xml)));
});
