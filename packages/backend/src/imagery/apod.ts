import { load } from 'cheerio';
import { guardedFetch } from '../lib/http-fetch.ts';
import { validateApodDate } from './date.ts';
import type { ImageryRightsLink } from '../../../contracts/src/imagery.ts';

export interface ApodMetadata {
  source: 'nasa-apod'; sourceDate: string; sourceId: string;
  titleEn: string; explanationEn: string; credit: string; copyright: string | null;
  rawCreditHtml?: string | null; rawCopyrightHtml?: string | null;
  creditLinks?: ImageryRightsLink[]; copyrightLinks?: ImageryRightsLink[];
  sourceUrl: string; mediaType: 'image' | 'video' | 'iframe';
  imageUrl: string | null; mediaUrl: string | null; altEn: string | null;
}
function plain(value: string, explanation = false): string {
  const $ = load(value);
  $('script,style').remove();
  if (explanation) $('p').each((_i, el) => { if (/Tomorrow['’]?s picture:/i.test($(el).text())) $(el).remove(); });
  $('p,br,div').each((_i, el) => { $(el).append(' '); });
  return $.root().text().replace(/\s+/g, ' ').trim();
}
function https(value: unknown, official = false): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (official && !['apod.nasa.gov','science.nasa.gov'].includes(u.hostname)) return null;
    return value;
  } catch { return null; }
}
function rightsLinks(value: unknown): ImageryRightsLink[] {
  if (typeof value !== 'string') return [];
  const $ = load(value);
  $('script,style').remove();
  const links: ImageryRightsLink[] = [];
  $('a[href]').each((_i, el) => {
    const url = https($(el).attr('href'));
    const label = plain($(el).html() ?? '');
    if (url && label) links.push({label,url});
  });
  return links;
}
async function injectedBody(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('APOD request timeout'));
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const {done,value} = await Promise.race([reader.read(),aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('APOD response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort',abort);
    void reader.cancel().catch(() => {});
  }
}
export async function fetchApod(date: string, opts: {fetchImpl?: typeof fetch; now?: Date} = {}): Promise<ApodMetadata | null> {
  validateApodDate(date,opts.now);
  const id = date.slice(2).replaceAll('-','');
  const endpoint = `https://science.nasa.gov/wp-json/wp/v2/apod-basic/${id}`;
  let status: number; let text: string;
  if (opts.fetchImpl) {
    const signal = AbortSignal.timeout(20_000);
    const res = await opts.fetchImpl(endpoint,{redirect:'error',signal});
    status = res.status;
    if (status !== 200) { void res.body?.cancel().catch(() => {}); if (status === 404) return null; throw new Error('APOD upstream unavailable'); }
    text = await injectedBody(res,signal);
  } else {
    const res = await guardedFetch(endpoint,{timeoutMs:20_000,maxBytes:2*1024*1024,maxRedirects:0});
    status = res.status; if (status === 404) return null;
    if (status !== 200) throw new Error('APOD upstream unavailable');
    text = res.text();
  }
  const r: unknown = JSON.parse(text);
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Invalid APOD metadata');
  const v = r as Record<string,unknown>;
  const sourceUrl = https(v.permalink,true);
  if (v.date !== date || typeof v.title !== 'string' || typeof v.explanation !== 'string' || !sourceUrl || !['image','video','iframe'].includes(String(v.media_type))) throw new Error('Invalid APOD metadata');
  const titleEn = plain(v.title);
  const explanationEn = plain(v.explanation,true);
  if (!titleEn || !explanationEn) throw new Error('Invalid APOD metadata');
  const optional = (x: unknown) => typeof x === 'string' ? plain(x) || null : null;
  return {
    source:'nasa-apod', sourceDate:date, sourceId:String(v.post_id ?? id), titleEn, explanationEn,
    rawCreditHtml:typeof v.credit === 'string' ? v.credit : null,
    rawCopyrightHtml:typeof v.copyright === 'string' ? v.copyright : null,
    creditLinks:rightsLinks(v.credit), copyrightLinks:rightsLinks(v.copyright),
    credit:optional(v.credit) ?? '', copyright:optional(v.copyright), sourceUrl,
    mediaType:v.media_type as ApodMetadata['mediaType'],
    imageUrl:v.media_type === 'image' ? https(v.hdurl) : null,
    mediaUrl:v.media_type === 'image' || v.url === v.permalink ? null : https(v.url), altEn:optional(v.alt),
  };
}
