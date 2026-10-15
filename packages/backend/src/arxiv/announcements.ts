import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Tx } from '../db.ts';
import type { RawArxivDatabase } from './raw-store.ts';

export interface ArxivAnnouncement {
  arxiv_id: string; base_id: string; version: number;
  announce_type: 'new' | 'cross' | 'replace' | 'replace-cross';
  /** Source batch calendar day. Never an inferred first-visible wall-clock timestamp. */
  announced_on: string;
}
const ARXIV_NS = 'http://arxiv.org/schemas/atom';
const TYPES = new Set(['new', 'cross', 'replace', 'replace-cross']);
const CATEGORIES = new Set(['astro-ph','astro-ph.CO','astro-ph.EP','astro-ph.GA','astro-ph.HE','astro-ph.IM','astro-ph.SR']);
type Node = Record<string, unknown>;
function object(value: unknown, label: string): Node {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Malformed RSS ${label}`);
  return value as Node;
}
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) return text((value as Node)['#text']);
  return '';
}
function list(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function namespaces(node: Node, inherited: Record<string, string>): Record<string, string> {
  const result = { ...inherited };
  for (const [key,value] of Object.entries(node)) if (key.startsWith('@_xmlns:') && typeof value === 'string') result[key.slice(8)] = value;
  return result;
}
function assertRssNamespace(node: Node, inherited = ''): void {
  const ns = typeof node['@_xmlns'] === 'string' ? node['@_xmlns'] : inherited;
  if (ns !== '') throw new Error('RSS elements must not rebind their default namespace');
  for (const [key,value] of Object.entries(node)) {
    if (key.startsWith('@') || key.startsWith('#') || key.startsWith('?') || key.includes(':')) continue;
    for (const child of list(value)) if (child && typeof child === 'object') assertRssNamespace(child as Node, ns);
  }
}
export function arxivIdentity(id: string): { baseId: string; version: number } {
  const match = /^(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[A-Za-z][A-Za-z0-9.-]*\/\d{7})v([1-9]\d*)$/.exec(id);
  if (!match) throw new Error(`Invalid versioned arXiv identifier: ${id}`);
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version > 2147483647) throw new Error('arXiv version out of range');
  return { baseId: match[1]!, version };
}
/**
 * The identity the publisher itself prints at the head of an item's description:
 * `arXiv:<versioned id> Announce Type: <type>`.
 *
 * The feed's scaffolding is not decoration — it NAMES the paper the description is about. An item whose
 * canonical guid says one identity while its own description announces another would otherwise have a
 * complete, plausible-looking abstract stored under the wrong identifier, which is exactly the kind of
 * silent identity corruption the design's red lines exist to prevent. Only a prefix in this exact
 * official shape is read: free-form scientific text is never scanned for identity, so it can neither be
 * mistaken for one nor "cleaned" into one.
 *
 * Exported so the RSS-native paper reader can state the same reading, and undefined is meaningful: it
 * means the document claimed no identity at all (a legitimate absence handled per item downstream).
 */
export function descriptionIdentity(description: string):
  { id: string; announceType: string } | undefined {
  const match = /^\s*arXiv:\s*(\S+)\s+Announce\s+Type:\s*([A-Za-z][A-Za-z-]*)\b/.exec(description);
  return match === null ? undefined : { id: match[1]!, announceType: match[2]! };
}
/**
 * The SOURCE calendar day of an RFC-822 announcement date. The feed publishes in US Eastern time
 * (-0400/-0500), and the day it names is the announcement's own day, so the offset is validated but
 * never used to convert: an announcement dated 20:00 -0400 belongs to that same named day.
 *
 * Exported because the RSS-native paper reader validates its items against exactly this reading of
 * `pubDate` — one function, so the two entries can never disagree about which day they saw.
 */
export function batchDay(value: string): string {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!m) throw new Error('Invalid RSS announcement date');
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[3]!) + 1;
  const day = `${m[4]}-${String(month).padStart(2,'0')}-${m[2]!.padStart(2,'0')}`;
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0,10) !== day ||
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][calendar.getUTCDay()] !== m[1] ||
      Number(m[5]) > 23 || Number(m[6]) > 59 || Number(m[7]) > 59 ||
      Number(m[9]) > 14 || Number(m[10]) > 59 || (Number(m[9]) === 14 && Number(m[10]) !== 0)) throw new Error('Invalid RSS announcement calendar date');
  return day;
}
export function parseArxivAnnouncements(xml: string): ArxivAnnouncement[] {
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid official RSS XML');
  const parsed = new XMLParser({ ignoreAttributes:false, parseTagValue:false, parseAttributeValue:false, trimValues:true }).parse(xml) as Node;
  const roots = Object.keys(parsed).filter(k => !k.startsWith('?') && !k.startsWith('#'));
  if (roots.length !== 1 || roots[0] !== 'rss') throw new Error('Official RSS must have exactly one rss root');
  const rss = object(parsed.rss,'root');
  if (rss['@_version'] !== '2.0') throw new Error('Official RSS requires version 2.0');
  assertRssNamespace(rss);
  const channel = object(rss.channel,'channel');
  if (!text(channel.title)) throw new Error('RSS channel title is missing');
  const rootNs = namespaces(channel,namespaces(rss,{}));
  const seen = new Map<string,ArxivAnnouncement>();
  const items=list(channel.item);
  if(items.length>2000) throw new Error('RSS entry limit exceeded');
  for (const value of items) {
    const item = object(value,'item');
    const guid = text(item.guid);
    if (!guid.startsWith('oai:arXiv.org:')) throw new Error('RSS item canonical guid missing');
    const id = guid.slice('oai:arXiv.org:'.length);
    const {baseId,version} = arxivIdentity(id);
    const categories = list(item.category).map(text);
    if (!categories.some(c => CATEGORIES.has(c))) throw new Error('RSS item has no target astronomy category');
    const ns = namespaces(item,rootNs);
    const types = Object.entries(item).filter(([key]) => key.includes(':') && key.split(':')[1] === 'announce_type').map(([key,v]) => {
      const fieldNs = v && typeof v === 'object' ? namespaces(v as Node,ns) : ns;
      if (fieldNs[key.split(':')[0]!] !== ARXIV_NS) throw new Error('Invalid announcement namespace');
      return text(v);
    });
    if (types.length !== 1 || !TYPES.has(types[0]!)) throw new Error('RSS announcement type missing or unsupported');
    // The description the publisher attached to THIS item states an identity too, and that identity has
    // to be the one the canonical guid already named. A description announcing another base id, another
    // version or another announcement type is a document that disagrees with itself: the whole batch is
    // rejected, because the item could be stored as a complete-looking paper under the wrong identity.
    const stated = descriptionIdentity(text(item.description));
    if (stated !== undefined) {
      if (stated.id !== id) throw new Error('RSS description identity disagrees with its canonical identifier');
      if (stated.announceType !== types[0]) throw new Error('RSS description announcement type disagrees with the structured type');
    }
    const date = batchDay(text(item.pubDate));
    const link = text(item.link);
    if (!link) throw new Error('RSS item original link missing');
    const url = new URL(link);
    if (!['https:','http:'].includes(url.protocol) || url.hostname !== 'arxiv.org' || url.username || url.password || url.port || url.search || url.hash ||
        ![`/abs/${baseId}`,`/abs/${id}`].includes(url.pathname)) throw new Error('RSS original link disagrees with canonical identifier');
    const row: ArxivAnnouncement = {arxiv_id:id,base_id:baseId,version,announce_type:types[0] as ArxivAnnouncement['announce_type'],announced_on:date};
    const key = `${id}|${row.announce_type}`;
    const previous = seen.get(key);
    if (previous && previous.announced_on !== date) throw new Error('Conflicting announcement dates in official RSS');
    seen.set(key,row);
  }
  return [...seen.values()];
}
export async function ingestArxivAnnouncements(rawRss: string, collectedAtUtc: string, database?: RawArxivDatabase) {
  const papers = parseArxivAnnouncements(rawRss);
  const collected = new Date(collectedAtUtc);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00)$/.test(collectedAtUtc) ||
      !Number.isFinite(collected.getTime()) || collected.toISOString().slice(0,10) !== collectedAtUtc.slice(0,10)) throw new Error('Invalid UTC collection timestamp');
  const batchHash = createHash('sha256').update(rawRss).digest('hex');
  const db = database ?? { begin: async <T>(fn:(tx:Tx)=>Promise<T>):Promise<T> => (await import('../db.ts')).sql.begin(fn) as Promise<T> };
  return db.begin(async tx => {
    const inserted = await tx`INSERT INTO arxiv_announcement_batches(content_hash,raw_rss,collected_at,paper_count)
      VALUES(${batchHash},${rawRss},${collectedAtUtc},${papers.length}) ON CONFLICT(content_hash) DO NOTHING RETURNING content_hash`;
    if (!inserted.length) return {status:'unchanged' as const,paperCount:papers.length,batchHash};
    for (const paper of papers) {
      const saved = await tx`INSERT INTO arxiv_announcements(arxiv_id,base_id,version,announce_type,announced_on,first_batch_hash)
        VALUES(${paper.arxiv_id},${paper.base_id},${paper.version},${paper.announce_type},${paper.announced_on},${batchHash})
        ON CONFLICT(arxiv_id,announce_type) DO NOTHING RETURNING arxiv_id`;
      if (!saved.length) {
        const existing = await tx`SELECT base_id,version,announced_on::text AS announced_on FROM arxiv_announcements
          WHERE arxiv_id=${paper.arxiv_id} AND announce_type=${paper.announce_type}`;
        // Repeated revision/cross notices can move to a later RSS day; keep the first evidence.
        if (existing[0]?.base_id !== paper.base_id || existing[0]?.version !== paper.version ||
            (existing[0]?.announced_on !== paper.announced_on && paper.announce_type !== 'replace' && paper.announce_type !== 'replace-cross' && paper.announce_type !== 'cross')) throw new Error('Official announcement evidence conflict');
      }
    }
    return {status:'imported' as const,paperCount:papers.length,batchHash};
  });
}
