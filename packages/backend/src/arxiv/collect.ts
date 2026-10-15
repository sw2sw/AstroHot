import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ArxivHttpError, boundedFailureBody } from './http.ts';

export interface RawArxivPaper {
  arxiv_id: string;
  base_id: string;
  title_original: string;
  abstract_original: string;
  authors: string[];
  categories: string[];
  /**
   * The API's `published`/`updated` instants. The official RSS announcement feed states no such
   * fields, so a raw paper read out of that feed carries null here — an unknown date stays unknown
   * and is never synthesized from the announcement day, the ID's month or the collection timestamp.
   * A consumer that needs a day reads the announcement day instead (see rss-paper.ts).
   */
  submitted_at: string | null;
  updated_at: string | null;
  url: string;
}

export interface CollectionResult {
  papers: RawArxivPaper[];
  raw_atom: string;
  collected_at_utc: string;
}

const API_BASE = 'https://export.arxiv.org/api/query';
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const ASTRO_PH_CATEGORIES = [
  'astro-ph.CO',
  'astro-ph.GA',
  'astro-ph.EP',
  'astro-ph.HE',
  'astro-ph.IM',
  'astro-ph.SR',
];

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

const MODERN_ID = /^\d{4}\.\d{4,5}$/;
const LEGACY_ID = /^[A-Za-z][A-Za-z0-9.-]*\/\d{7}$/;
// Version must be strictly positive: v0 is rejected, and leading zeros are not valid.
const VERSION_SUFFIX = /v([1-9]\d*)$/;
const ALLOWED_ASTRO_PH_CATEGORIES = new Set<string>([...ASTRO_PH_CATEGORIES, 'astro-ph']);

function assertMaxResults(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`maxResults must be an integer between 1 and 100, received ${String(value)}`);
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${String(value)}`);
  }
}

export interface ArxivQueryOptions {
  start?: number;
  submittedFrom?: string;
  submittedThrough?: string;
  idList?: string[];
}
function assertQueryMinute(value: string): void {
  if (!/^\d{12}$/.test(value)) throw new Error('arXiv query date must be YYYYMMDDHHmm UTC');
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:00Z`;
  if (!isValidIsoUtcDateTime(iso)) throw new Error('Invalid arXiv query calendar date');
}
export function buildArxivQuery(maxResults: number = DEFAULT_MAX_RESULTS, options: ArxivQueryOptions = {}): string {
  assertMaxResults(maxResults);
  const start = options.start ?? 0;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('arXiv start must be a nonnegative integer');
  const url = new URL(API_BASE);
  if (options.idList !== undefined) {
    if (options.submittedFrom !== undefined || options.submittedThrough !== undefined || start !== 0 ||
        !Array.isArray(options.idList) || options.idList.length < 1 || options.idList.length > 100 ||
        new Set(options.idList).size !== options.idList.length) throw new Error('Invalid arXiv ID hydration query');
    for (const id of options.idList) {
      if (typeof id !== 'string') throw new Error('Invalid arXiv ID token');
      const identity = parseArxivIdentity(`https://arxiv.org/abs/${id}`);
      if (identity.arxivId !== id) throw new Error('Invalid literal arXiv ID token');
    }
    url.searchParams.set('id_list', options.idList.join(','));
  } else {
    let query = ASTRO_PH_CATEGORIES.map((c) => `cat:${c}`).join(' OR ');
    if (options.submittedFrom !== undefined || options.submittedThrough !== undefined) {
      if (typeof options.submittedFrom !== 'string' || typeof options.submittedThrough !== 'string') throw new Error('Both query window bounds are required');
      assertQueryMinute(options.submittedFrom); assertQueryMinute(options.submittedThrough);
      if (options.submittedFrom > options.submittedThrough) throw new Error('Reversed arXiv query window');
      query = `(${query}) AND submittedDate:[${options.submittedFrom} TO ${options.submittedThrough}]`;
    }
    url.searchParams.set('search_query', query);
  }
  url.searchParams.set('start', String(start));
  url.searchParams.set('max_results', String(maxResults));
  url.searchParams.set('sortBy', 'submittedDate');
  url.searchParams.set('sortOrder', 'descending');
  return url.toString();
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>)['#text'] === 'string') {
    return (value as Record<string, unknown>)['#text'] as string;
  }
  return undefined;
}

const ISO_UTC_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]00:00)$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Strict ISO-8601 UTC datetime with real calendar validation. Date.parse
// silently normalizes impossible dates (e.g. 2024-02-30 -> 2024-03-01), so the
// calendar fields are validated explicitly and a UTC designator is required.
function isValidIsoUtcDateTime(value: string): boolean {
  const match = ISO_UTC_DATETIME.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined
  ) {
    return false;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysInMonth[month - 1];
  return maxDay !== undefined && day >= 1 && day <= maxDay;
}

interface NamespaceContext {
  defaultNs: string | undefined;
  prefixes: Record<string, string>;
}

function localNamespaceContext(node: Record<string, unknown>): NamespaceContext {
  let defaultNs: string | undefined;
  const prefixes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string') continue;
    if (key === '@_xmlns') defaultNs = value;
    else if (key.startsWith('@_xmlns:')) prefixes[key.slice('@_xmlns:'.length)] = value;
  }
  return { defaultNs, prefixes };
}

// Conservative namespace walk over the parsed tree. This parser only supports
// the unprefixed Atom format the arXiv API emits. Every unprefixed element must
// resolve to the Atom namespace, so a nested xmlns rebinding (e.g. on <entry>
// or any required child such as <author>/<name>/<category>/<id>) cannot smuggle
// fields past the check: the walk recurses through nested Atom elements and the
// effective inherited default namespace is tracked at every level. Prefixed
// elements are foreign metadata and are never interpreted as Atom content; a
// prefixed element that claims the Atom namespace is rejected as ambiguous.
// Limitation: real arXiv feeds carry extra prefixed (non-Atom) metadata such as
// arxiv:* and opensearch:* elements; those are permitted and ignored.
function walkAtomElements(node: Record<string, unknown>, inherited: NamespaceContext, path: string): void {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key.startsWith('#') || key.startsWith('?')) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === null || item === undefined || typeof item === 'string') continue;
      if (typeof item !== 'object') continue;
      const element = item as Record<string, unknown>;
      const local = localNamespaceContext(element);
      const context: NamespaceContext = {
        defaultNs: local.defaultNs !== undefined ? local.defaultNs : inherited.defaultNs,
        prefixes: { ...inherited.prefixes, ...local.prefixes },
      };
      const childPath = `${path}/${key}`;
      const colon = key.indexOf(':');
      if (colon >= 0) {
        const prefix = key.slice(0, colon);
        const ns = context.prefixes[prefix];
        if (ns === undefined) {
          throw new Error(`element <${key}> at ${childPath} uses an undeclared namespace prefix`);
        }
        if (ns === ATOM_NS) {
          throw new Error(`prefixed Atom element <${key}> at ${childPath} is not supported`);
        }
        continue;
      }
      if (context.defaultNs !== ATOM_NS) {
        throw new Error(
          `element <${key}> at ${childPath} is not in the required Atom namespace (${ATOM_NS})`,
        );
      }
      walkAtomElements(element, context, childPath);
    }
  }
}

function absUrlError(rawId: string): Error {
  return new Error(`unsupported arXiv id, expected an http(s) arxiv.org/abs URL: ${rawId}`);
}

function parseArxivIdentity(rawId: string): { arxivId: string; baseId: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawId);
  } catch {
    throw absUrlError(rawId);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw absUrlError(rawId);
  if (parsed.username !== '' || parsed.password !== '') throw absUrlError(rawId);
  if (parsed.hostname !== 'arxiv.org') throw absUrlError(rawId);
  if (!parsed.pathname.startsWith('/abs/')) throw absUrlError(rawId);

  let id: string;
  try {
    id = decodeURIComponent(parsed.pathname.slice('/abs/'.length));
  } catch {
    throw absUrlError(rawId);
  }

  if (MODERN_ID.test(id) || LEGACY_ID.test(id)) {
    throw new Error(`arXiv id is missing a version: ${id}`);
  }

  if (VERSION_SUFFIX.test(id)) {
    const baseCandidate = id.replace(VERSION_SUFFIX, '');
    if (MODERN_ID.test(baseCandidate) || LEGACY_ID.test(baseCandidate)) {
      return { arxivId: id, baseId: baseCandidate };
    }
  }

  throw absUrlError(rawId);
}

export function parseArxivAtom(xml: string): RawArxivPaper[] {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new Error('Atom document is empty');
  }

  // Reject DTD / entity declarations before any parsing (XXE / entity expansion).
  if (/<!DOCTYPE/i.test(xml)) {
    throw new Error('DOCTYPE declarations are not allowed in the Atom document');
  }
  if (/<!ENTITY/i.test(xml)) {
    throw new Error('ENTITY declarations are not allowed in the Atom document');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const detail = validation && typeof validation === 'object' && validation.err
      ? `${validation.err.code}: ${validation.err.msg}`
      : 'invalid XML';
    throw new Error(`Atom document failed XML validation (${detail})`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    allowBooleanAttributes: true,
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`failed to parse Atom document: ${(err as Error).message}`);
  }

  const root = parsed as Record<string, unknown> | null;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('Atom document root must be <feed>');
  }

  // Only real document roots participate in this check. Processing instructions
  // (e.g. the XML declaration `<?xml ...?>`, surfaced as a `?xml` key) and
  // comments (`#comment`) are not document roots and are ignored here.
  const documentRootKeys = Object.keys(root).filter(
    (key) => !key.startsWith('?') && !key.startsWith('#'),
  );
  if (!documentRootKeys.includes('feed')) {
    throw new Error('Atom document root must be <feed>');
  }
  if (documentRootKeys.length !== 1) {
    throw new Error('Atom document must have exactly one <feed> root element and no other document roots');
  }

  const feed = root.feed as Record<string, unknown>;
  if (typeof feed !== 'object' || feed === null || Array.isArray(feed)) {
    throw new Error('Atom document root must be <feed>');
  }
  if (feed['@_xmlns'] !== ATOM_NS) {
    throw new Error(`Atom document is not in the required Atom namespace (${ATOM_NS})`);
  }

  // Walk the whole Atom tree before extracting so namespace rebinding anywhere
  // in the document (entry, author/name, category, id, ...) is rejected.
  walkAtomElements(feed, localNamespaceContext(feed), '/feed');

  const entries = toArray(feed.entry as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const papers: RawArxivPaper[] = [];
  const seen = new Set<string>();

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error('Atom feed contains an empty or malformed <entry> element');
    }
    const entry = rawEntry as Record<string, unknown>;

    const rawId = asText(entry.id);
    if (typeof rawId === 'string' && /arxiv\.org\/api\/errors/i.test(rawId)) {
      throw new Error(`arXiv API returned an error entry: ${rawId}`);
    }

    const title = asText(entry.title);
    const summary = asText(entry.summary);
    const published = asText(entry.published);
    const updated = asText(entry.updated);

    const required: Array<[string, string | undefined]> = [
      ['id', rawId],
      ['title', title],
      ['summary', summary],
      ['published', published],
      ['updated', updated],
    ];
    for (const [tag, value] of required) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`entry is missing required <${tag}> element`);
      }
    }

    const id = rawId as string;
    const titleText = title as string;
    const summaryText = summary as string;
    const publishedText = published as string;
    const updatedText = updated as string;

    if (!isValidIsoUtcDateTime(publishedText)) {
      throw new Error(`Invalid <published> date: ${publishedText}`);
    }
    if (!isValidIsoUtcDateTime(updatedText)) {
      throw new Error(`Invalid <updated> date: ${updatedText}`);
    }

    const { arxivId, baseId } = parseArxivIdentity(id);

    const authorNodes = toArray(
      entry.author as Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    const authors: string[] = [];
    for (const authorNode of authorNodes) {
      const name = asText(
        authorNode && typeof authorNode === 'object'
          ? (authorNode as Record<string, unknown>).name
          : authorNode,
      );
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`entry has an author with a missing or empty <name>: ${arxivId}`);
      }
      authors.push(name);
    }
    if (authors.length === 0) {
      throw new Error(`entry has no <author> elements: ${arxivId}`);
    }

    const categoryTerms = toArray(
      entry.category as Record<string, unknown> | Record<string, unknown>[] | undefined,
    )
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const term = (c as Record<string, unknown>)['@_term'];
          if (typeof term === 'string') return term;
        }
        return undefined;
      })
      .filter((c): c is string => typeof c === 'string');

    const categories: string[] = [];
    for (const term of categoryTerms) {
      if (term === 'astro-ph' || term.startsWith('astro-ph.')) {
        if (!ALLOWED_ASTRO_PH_CATEGORIES.has(term)) {
          throw new Error(`entry has an unknown astro-ph category: ${term}`);
        }
        categories.push(term);
      }
    }

    if (categories.length === 0) {
      throw new Error(`entry has no astro-ph category: ${arxivId}`);
    }

    if (seen.has(arxivId)) continue;
    seen.add(arxivId);

    papers.push({
      arxiv_id: arxivId,
      base_id: baseId,
      title_original: titleText,
      abstract_original: summaryText,
      authors,
      categories,
      submitted_at: publishedText,
      updated_at: updatedText,
      url: `https://arxiv.org/abs/${arxivId}`,
    });
  }

  return papers;
}

export function parseArxivPageInfo(xml: string): { totalResults:number; startIndex:number; itemsPerPage:number } {
  // Keep API errors, namespace rebinding and malformed Atom distinct from genuine zero results.
  parseArxivAtom(xml);
  const feed = new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false}).parse(xml).feed as Record<string,unknown>;
  const ns = 'http://a9.com/-/spec/opensearch/1.1/';
  const read = (name:string):number => {
    const values = Object.entries(feed).filter(([key]) => !key.startsWith('@') && key.split(':')[1] === name);
    if(values.length !== 1) throw new Error(`Missing or duplicate OpenSearch ${name}`);
    const [key, node] = values[0]!;
    const prefix = key.split(':')[0]!;
    const object = node && typeof node==='object' && !Array.isArray(node) ? node as Record<string,unknown> : null;
    if((object?.[`@_xmlns:${prefix}`] ?? feed[`@_xmlns:${prefix}`]) !== ns) throw new Error('Invalid OpenSearch namespace');
    const value = asText(node);
    if(!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>2147483647) throw new Error(`Invalid OpenSearch ${name}`);
    return Number(value);
  };
  return {totalResults:read('totalResults'),startIndex:read('startIndex'),itemsPerPage:read('itemsPerPage')};
}

function raceWithTimeout<T>(promise: Promise<T>, timeout: Promise<never>): Promise<T> {
  // Mark the losing promise as handled so a late rejection cannot surface as unhandled.
  void promise.catch(() => {});
  return Promise.race([promise, timeout]);
}

export async function collectArxivMetadata(options: {
  fetch?: typeof fetch;
  maxResults?: number;
  timeoutMs?: number;
  maxBytes?: number;
} & ArxivQueryOptions = {}): Promise<CollectionResult> {
  if (options.maxResults !== undefined) assertMaxResults(options.maxResults);
  if (options.maxBytes !== undefined) assertPositiveInteger('maxBytes', options.maxBytes);
  if (options.timeoutMs !== undefined) assertPositiveInteger('timeoutMs', options.timeoutMs);

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  const url = buildArxivQuery(maxResults, options);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readerRef: ReadableStreamDefaultReader<Uint8Array> | undefined;

  // The HTTP status of a non-2xx answer, captured the moment its headers arrive. Once it is KNOWN it
  // can never be lost to whatever reading the failure document does next — a 503 or a 429 whose body
  // hangs is still that status, so the shared hold still sees it.
  let failureStatus: number | undefined;
  // The origin's own failure document, kept as the SAME bounded byte prefix the success path is held
  // to. The bytes are the evidence (stored and hashed), the text is only a readable copy of them.
  const failure = boundedFailureBody(maxBytes);

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const reader = readerRef;
      if (reader) void reader.cancel().catch(() => {});
      if (failureStatus !== undefined) { failure.markIncomplete(); reject(new ArxivHttpError(failureStatus, failure.body(), 'arXiv API')); }
      else reject(new Error(`arXiv request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const readBody = async (response: Response): Promise<string> => {
    const body = response.body;
    if (!body) throw new Error('arXiv API response body is empty');
    const reader = body.getReader();
    readerRef = reader;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            throw new Error(`arXiv response exceeds maxBytes limit of ${maxBytes}`);
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      void reader.cancel().catch(() => {});
      readerRef = undefined;
      throw err;
    }
    readerRef = undefined;

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  };

  try {
    const response = await raceWithTimeout(
      (async () => {
        const res = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
        if (!res.ok) {
          // The real consumer of the export API keeps the origin's own failure document, read ONCE
          // from this response under the shared byte budget — never by re-requesting, and never
          // replacing the status. Without this the API's 500/503/429 body reached collect-job empty,
          // so the "both endpoints keep failure text" claim was true only for the RSS helper.
          failureStatus = res.status;
          await failure.read(res, (live) => { readerRef = live; });
          throw new ArxivHttpError(res.status, failure.body(), 'arXiv API');
        }
        return res;
      })(),
      timeout,
    );

    if (!response.body) throw new Error('arXiv API response body is empty');

    const raw_atom = await raceWithTimeout(readBody(response), timeout);
    const papers = parseArxivAtom(raw_atom);
    return { papers, raw_atom, collected_at_utc: new Date().toISOString() };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    const reader = readerRef;
    if (reader) void reader.cancel().catch(() => {});
  }
}
