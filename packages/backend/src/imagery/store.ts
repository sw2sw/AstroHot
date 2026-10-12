import type { ImageryItem, ImageryRightsLink } from "../../../contracts/src/imagery.ts";
import { sql } from "../db.ts";
import { readArchivedImage } from './media.ts';

/** Local-only validation shared by readers and recovery workers; never fetches upstream. */
export async function imageryMediaAvailable(item: ImageryItem | null): Promise<boolean> {
  if (!item) return false;
  if (item.mediaStatus === 'not_applicable') return true;
  if (item.mediaStatus !== 'ready' || !item.imageUrl) return false;
  const match = /^\/api\/imagery\/media\/([a-f0-9]{64})$/.exec(item.imageUrl);
  if (!match) return false;
  try { await readArchivedImage(match[1]!); return true; }
  catch { return false; }
}

/** Public metadata captured from an upstream imagery provider, before translation and local media land. */
export interface ImageryMetadata {
  source: "nasa-apod";
  sourceDate: string;
  sourceId: string;
  titleEn: string;
  explanationEn: string;
  credit: string;
  copyright: string | null;
  rawCreditHtml?: string | null;
  rawCopyrightHtml?: string | null;
  creditLinks?: ImageryRightsLink[];
  copyrightLinks?: ImageryRightsLink[];
  sourceUrl: string;
  mediaType: "image" | "video" | "iframe";
  imageUrl: string | null;
  mediaUrl: string | null;
  altEn: string | null;
}

const SOURCE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const LOCAL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** True ISO calendar date (year >= 1), checked by explicit day counts so Date never rolls over. */
export function isValidImageryDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = month === 2 && leap ? 29 : MONTH_DAYS[month - 1];
  if (maxDay === undefined) return false;
  return day >= 1 && day <= maxDay;
}

export function isValidImagerySource(value: unknown): value is string {
  return typeof value === "string" && SOURCE_RE.test(value);
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === "string";

// Every whitelisted field must pass its check; extra keys are dropped so private extras never reach the database.
const METADATA_CHECKS: ReadonlyArray<readonly [keyof ImageryMetadata, (value: unknown) => boolean]> = [
  ["source", (value) => value === "nasa-apod"],
  ["sourceDate", isValidImageryDate],
  ["sourceId", isText],
  ["titleEn", isText],
  ["explanationEn", isText],
  ["credit", isText],
  ["copyright", isTextOrNull],
  ["sourceUrl", isText],
  ["mediaType", (value) => value === "image" || value === "video" || value === "iframe"],
  ["imageUrl", isTextOrNull],
  ["mediaUrl", isTextOrNull],
  ["altEn", isTextOrNull],
];

function safeRightsLinks(value: unknown): ImageryRightsLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link: unknown) => {
    if (!link || typeof link !== 'object') return [];
    const {label,url} = link as Record<string,unknown>;
    if (typeof label !== 'string' || !label.trim() || typeof url !== 'string') return [];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return [];
      return [{label,url}];
    } catch { return []; }
  });
}

function checkedMetadata(value: unknown): ImageryMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, check] of METADATA_CHECKS) {
    if (!check(record[key])) return null;
    out[key] = record[key];
  }
  // Optional additions keep existing archived rows readable; raw markup stays in JSON only.
  for (const key of ['rawCreditHtml', 'rawCopyrightHtml'] as const) {
    if (record[key] !== undefined) {
      if (!isTextOrNull(record[key])) return null;
      out[key] = record[key];
    }
  }
  for (const key of ['creditLinks', 'copyrightLinks'] as const) {
    if (record[key] !== undefined) {
      if (!Array.isArray(record[key])) return null;
      out[key] = safeRightsLinks(record[key]);
    }
  }
  return out as unknown as ImageryMetadata;
}

export async function saveImageryMetadata(metadata: ImageryMetadata, contentHash: string): Promise<void> {
  const clean = checkedMetadata(metadata);
  if (!clean || !HASH_RE.test(contentHash)) throw new Error("invalid imagery metadata or content hash");
  // Media download only applies to images; video/iframe embeds need no local pipeline.
  const mediaStatus = clean.mediaType === "image" ? "pending" : "not_applicable";
  await sql`
    INSERT INTO imagery_archive (source, source_date, metadata, content_hash, media_status)
    VALUES (${clean.source}, ${clean.sourceDate}, ${JSON.stringify(clean)}::text::jsonb, ${contentHash}, ${mediaStatus})
    ON CONFLICT (source, source_date) DO NOTHING
  `;
}

const MEDIA_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

// Marks locally-landed media ready; refuses unsafe file keys, never overwrites already-ready media,
// and only touches rows whose metadata is an image (video/iframe embeds need no local pipeline).
export async function saveImageryMedia(
  source: string,
  date: string,
  media: { localPath: string; contentType: string },
): Promise<void> {
  const { localPath, contentType } = media;
  const validPath =
    typeof localPath === "string" &&
    localPath.length <= 200 &&
    !localPath.includes("..") &&
    LOCAL_PATH_RE.test(localPath);
  if (!isValidImagerySource(source) || !isValidImageryDate(date) || !validPath || !MEDIA_CONTENT_TYPES.has(contentType)) {
    throw new Error("invalid imagery media");
  }
  const rows = await sql<{ media_type: ImageryMetadata["mediaType"]; media_status: ImageryItem["mediaStatus"] }[]>`
    SELECT metadata->>'mediaType' AS media_type, media_status
    FROM imagery_archive
    WHERE source = ${source} AND source_date = ${date}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("imagery row not found");
  if (row.media_type !== "image") throw new Error("local media not applicable for non-image imagery");
  if (row.media_status === "ready") return;
  await sql`
    UPDATE imagery_archive
    SET local_path = ${localPath}, content_type = ${contentType}, media_status = 'ready', media_error_code = NULL, updated_at = now()
    WHERE source = ${source} AND source_date = ${date}
      AND media_status <> 'ready' AND metadata->>'mediaType' = 'image'
  `;
}

interface ImageryArchiveRow {
  source: string;
  source_date: string;
  metadata: ImageryMetadata;
  title_zh: string | null;
  explanation_zh: string | null;
  translation_status: ImageryItem["translationStatus"];
  media_status: ImageryItem["mediaStatus"];
  local_path: string | null;
}

// Readers only ever get locally-served media: the upstream imageUrl is never exposed.
function publicImageUrl(row: ImageryArchiveRow): string | null {
  if (row.media_status !== "ready" || row.local_path === null) return null;
  if (row.local_path.includes("..") || !LOCAL_PATH_RE.test(row.local_path)) return null;
  return `/api/imagery/media/${row.local_path}`;
}

function toItem(row: ImageryArchiveRow): ImageryItem {
  const metadata = row.metadata;
  return {
    source: row.source,
    sourceDate: row.source_date,
    titleEn: metadata.titleEn,
    titleZh: row.title_zh,
    explanationEn: metadata.explanationEn,
    explanationZh: row.explanation_zh,
    credit: metadata.credit,
    copyright: metadata.copyright,
    ...(metadata.creditLinks !== undefined ? {creditLinks:safeRightsLinks(metadata.creditLinks)} : {}),
    ...(metadata.copyrightLinks !== undefined ? {copyrightLinks:safeRightsLinks(metadata.copyrightLinks)} : {}),
    sourceUrl: metadata.sourceUrl,
    mediaType: metadata.mediaType,
    imageUrl: publicImageUrl(row),
    mediaUrl: metadata.mediaType === "image" ? null : metadata.mediaUrl,
    altEn: metadata.altEn,
    translationStatus: row.translation_status,
    mediaStatus: row.media_status,
  };
}

export async function listImagery(options: {limit?:number;before?:string} = {}): Promise<ImageryItem[]> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (options.before !== undefined && !isValidImageryDate(options.before))) throw new Error('invalid imagery pagination');
  const rows = options.before === undefined
    ? await sql<ImageryArchiveRow[]>`SELECT source,source_date::text AS source_date,metadata,title_zh,explanation_zh,translation_status,media_status,local_path FROM imagery_archive ORDER BY source_date DESC,source LIMIT ${limit}`
    : await sql<ImageryArchiveRow[]>`SELECT source,source_date::text AS source_date,metadata,title_zh,explanation_zh,translation_status,media_status,local_path FROM imagery_archive WHERE source_date < ${options.before} ORDER BY source_date DESC,source LIMIT ${limit}`;
  return rows.map(toItem);
}

export async function getImagery(source: string, date: string): Promise<ImageryItem | null> {
  if (!isValidImagerySource(source) || !isValidImageryDate(date)) return null;
  const rows = await sql<ImageryArchiveRow[]>`
    SELECT source, source_date::text AS source_date, metadata, title_zh, explanation_zh,
           translation_status, media_status, local_path
    FROM imagery_archive
    WHERE source = ${source} AND source_date = ${date}
  `;
  const row = rows[0];
  return row === undefined ? null : toItem(row);
}
