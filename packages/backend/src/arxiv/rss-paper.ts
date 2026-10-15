// The official announcement feed read as a SOURCE OF PAPERS, not only as announcement evidence.
//
// The feed is published once a day and carries, per item, everything a title-and-abstract screening
// needs: the title, the abstract, the creators, the categories, the versioned identity and the
// announcement type/day. Reading it directly is what lets the ordinary path store normal papers
// without depending on the export API at all.
//
// What the feed does NOT carry is a submission or update instant — those are Atom/API fields. The
// rule here is that an unknown date stays unknown: `submitted_at`/`updated_at` are stored as null and
// nothing is synthesized from the announcement day, the ID's month or the collection timestamp. A
// consumer that needs a day reads the announcement day, which is a real source day with a real
// meaning.
//
// The document is validated by the SAME reader that validates announcement evidence (announcements.ts)
// before a single paper is read out of it, so the identity, version, category, namespace and
// link-vs-guid red lines are shared rather than re-implemented: an item that violates them still
// rejects the whole batch. Only a CONTENT deficiency that is safe to isolate — a missing title, a
// description with no abstract section, a missing creator — is isolated per item, with its raw text
// and its concrete reason, while every other item of the same batch is stored normally.

import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ArxivAnnouncement } from './announcements.ts';
import { parseArxivAnnouncements } from './announcements.ts';

const DC_NS = 'http://purl.org/dc/elements/1.1/';

/** How much of a failed item stays in the isolation row. */
const ITEM_EXCERPT_LIMIT = 4000;

type Node = Record<string, unknown>;

/**
 * One announcement read as a paper. `authors_original` is the source text verbatim; `authors` is the
 * parsed list only when the official comma format could be read, and `authors_quality` says which of
 * the two a consumer is looking at — a corporate or otherwise unusual creator string is never split
 * on a guess.
 */
export interface RssArxivItem {
  arxiv_id: string;
  base_id: string;
  version: number;
  announce_type: ArxivAnnouncement['announce_type'];
  /** Source announcement calendar day (see batchDay). A real source day, never a submission date. */
  announced_on: string;
  title_original: string;
  abstract_original: string;
  authors: string[];
  authors_original: string;
  authors_quality: 'parsed' | 'unparsed';
  categories: string[];
  url: string;
}

export interface RssItemIsolation {
  itemSha256: string;
  arxivId: string | null;
  reason: 'title_missing' | 'abstract_missing' | 'creator_missing';
  excerpt: string;
  truncated: boolean;
}

export interface ParsedArxivRssFeed {
  /** Every usable item, in feed order, one per versioned identity. */
  items: RssArxivItem[];
  /** Content deficiencies safe to isolate; the batch around them still commits. */
  isolated: RssItemIsolation[];
  /** Total `<item>` elements the channel carried, including isolated ones. */
  itemCount: number;
  /** How many items the announcement reader accepted (identity/version/type evidence). */
  announcementCount: number;
}

function object(value: unknown, label: string): Node {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Malformed RSS ${label}`);
  return value as Node;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return text((value as Node)['#text']);
  return '';
}

function list(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function namespaces(node: Node, inherited: Record<string, string>): Record<string, string> {
  const result = { ...inherited };
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_xmlns:') && typeof value === 'string') result[key.slice(8)] = value;
  }
  return result;
}

/** The text of a prefixed field, refused unless the prefix really resolves to the expected namespace. */
function prefixedText(node: Node, prefix: string, local: string, expected: string, inherited: Record<string, string>): string | undefined {
  const found = Object.entries(node).filter(([key]) => {
    const colon = key.indexOf(':');
    return colon > 0 && key.slice(0, colon) === prefix && key.slice(colon + 1) === local;
  });
  if (found.length === 0) return undefined;
  if (found.length > 1) throw new Error(`Duplicate RSS ${prefix}:${local}`);
  const [key, value] = found[0]!;
  const ns = value && typeof value === 'object' ? namespaces(value as Node, inherited) : inherited;
  if (ns[prefix] !== expected) throw new Error(`Invalid ${prefix}:${local} namespace`);
  return text(value);
}

/**
 * The abstract section of the RSS description. The feed emits
 * `arXiv:<id>v<n> Announce Type: <type>` followed by `Abstract: <text>`; everything before the marker
 * is publisher scaffolding and everything after it is the abstract verbatim.
 *
 * Only two transformations happen, and neither can change scientific content: line endings are
 * normalized to "\n" and the result is trimmed. Entities were already decoded by the XML parser;
 * no tag stripping is attempted, so a literal "<" inside LaTeX survives exactly as published.
 */
export function rssAbstract(description: string): string | undefined {
  const marker = /\bAbstract:\s*/.exec(description);
  if (!marker) return undefined;
  const abstract = description.slice(marker.index + marker[0].length).replace(/\r\n?/g, '\n').trim();
  return abstract.length === 0 ? undefined : abstract;
}

/**
 * The creator list in the official comma-separated form. A string that cannot be read that way is
 * kept WHOLE as a single author and flagged `unparsed`: guessing where one author ends and the next
 * begins would silently invent identities.
 */
export function parseRssCreators(original: string): { authors: string[]; quality: 'parsed' | 'unparsed' } {
  const trimmed = original.trim().replace(/\s+/g, ' ');
  const parts = trimmed.split(/,\s*/).map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length <= 1) return { authors: [trimmed], quality: 'unparsed' };
  // A comma that is not followed by whitespace is part of the name (e.g. "Smith,John" is not the
  // official separator), so such a string is left whole rather than split on a guess.
  if (/,[^\s]/.test(trimmed)) return { authors: [trimmed], quality: 'unparsed' };
  return { authors: parts, quality: 'parsed' };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Reads the whole document into announcements plus papers. The document-level and item-level red
 * lines are delegated to `parseArxivAnnouncements`, which throws (and therefore rejects the batch)
 * for a broken document, an identity/version conflict, a non-target category or a link that disagrees
 * with the canonical identifier. What is left to decide here is only whether an item carries enough
 * CONTENT to become a paper.
 */
export function parseArxivRssFeed(xml: string): ParsedArxivRssFeed {
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Invalid official RSS XML');
  }
  const announcements = parseArxivAnnouncements(xml);
  const parsed = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: true,
  }).parse(xml) as Node;
  const rss = object(parsed.rss, 'root');
  const channel = object(rss.channel, 'channel');
  const rootNs = namespaces(channel, namespaces(rss, {}));
  const items = list(channel.item).map((value) => object(value, 'item'));
  if (items.length > 2000) throw new Error('RSS entry limit exceeded');

  // The announcement reader already proved every item's identity, so a guid index can never miss.
  const byGuid = new Map<string, Node>();
  for (const item of items) {
    const guid = text(item.guid);
    if (guid.startsWith('oai:arXiv.org:') && !byGuid.has(guid)) byGuid.set(guid, item);
  }

  const out: RssArxivItem[] = [];
  const isolated: RssItemIsolation[] = [];
  const seenIds = new Set<string>();
  for (const announcement of announcements) {
    const item = byGuid.get(`oai:arXiv.org:${announcement.arxiv_id}`);
    if (!item) continue;
    // The creator is read in the ITEM's own namespace context — the channel's bindings plus whatever
    // the item declared for itself — because a prefix is bound per element, not per document. Reading
    // only the channel's context would trust an item that rebound `dc:` to a foreign namespace for
    // itself, and would refuse a document that declares dc on the item and nowhere else. `prefixedText`
    // then layers the field's own declaration on top of this, so the narrowest binding always wins.
    const itemNs = namespaces(item, rootNs);
    const serialized = JSON.stringify(item);
    const excerpt = serialized.slice(0, ITEM_EXCERPT_LIMIT);
    const truncated = serialized.length > excerpt.length;
    const isolate = (reason: RssItemIsolation['reason']) => {
      isolated.push({ itemSha256: sha256Hex(serialized), arxivId: announcement.arxiv_id, reason, excerpt, truncated });
    };
    const title = text(item.title).trim();
    if (!title) { isolate('title_missing'); continue; }
    const abstract = rssAbstract(text(item.description));
    if (!abstract) { isolate('abstract_missing'); continue; }
    const creator = prefixedText(item, 'dc', 'creator', DC_NS, itemNs);
    if (creator === undefined || creator.trim() === '') { isolate('creator_missing'); continue; }
    if (seenIds.has(announcement.arxiv_id)) continue;
    seenIds.add(announcement.arxiv_id);
    const { authors, quality } = parseRssCreators(creator);
    out.push({
      arxiv_id: announcement.arxiv_id,
      base_id: announcement.base_id,
      version: announcement.version,
      announce_type: announcement.announce_type,
      announced_on: announcement.announced_on,
      title_original: title,
      abstract_original: abstract,
      authors,
      authors_original: creator,
      authors_quality: quality,
      // Every category of the item is kept, in the order the feed listed them: the list order is NOT
      // promoted to "the primary category", which the feed does not state.
      categories: list(item.category).map((value) => text(value).trim()).filter((value) => value.length > 0),
      url: `https://arxiv.org/abs/${announcement.arxiv_id}`,
    });
  }
  return { items: out, isolated, itemCount: items.length, announcementCount: announcements.length };
}

/**
 * The metadata document of a raw paper row that came from RSS. It deliberately carries the SAME keys
 * the Atom reader produces, so a consumer that already reads raw metadata keeps working, plus the
 * source facts an RSS row needs: which document it came from, the announcement type/day, and the
 * creator text verbatim beside the parsed list.
 *
 * `submitted_at`/`updated_at` are null because the feed does not state them. Nothing fills them in.
 */
export interface RssRawArxivPaper {
  arxiv_id: string;
  base_id: string;
  title_original: string;
  abstract_original: string;
  authors: string[];
  authors_original: string;
  authors_quality: 'parsed' | 'unparsed';
  categories: string[];
  submitted_at: null;
  updated_at: null;
  url: string;
  source: 'rss';
  announce_type: ArxivAnnouncement['announce_type'];
  announced_on: string;
}

export function rssPaperMetadata(item: RssArxivItem): RssRawArxivPaper {
  return {
    arxiv_id: item.arxiv_id,
    base_id: item.base_id,
    title_original: item.title_original,
    abstract_original: item.abstract_original,
    authors: [...item.authors],
    authors_original: item.authors_original,
    authors_quality: item.authors_quality,
    categories: [...item.categories],
    submitted_at: null,
    updated_at: null,
    url: item.url,
    source: 'rss',
    announce_type: item.announce_type,
    announced_on: item.announced_on,
  };
}
