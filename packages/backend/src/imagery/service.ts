import { createHash } from 'node:crypto';
import { sql } from '../db.ts';
import { fetchApod, type ApodMetadata } from './apod.ts';
import { archiveImage } from './media.ts';
import { translateImagery } from './translate.ts';
import { completeReceipt } from '../providers/receipts.ts';
import { validateApodDate } from './date.ts';
import { claimImageryDate, releaseImageryDate } from './claims.ts';
import { getImagery, imageryMediaAvailable, saveImageryMetadata, saveImageryMedia } from './store.ts';

interface Dependencies {
  fetch?: (date:string)=>Promise<ApodMetadata|null>;
  archive?: (url:string)=>Promise<{localPath:string;contentType:string}>;
  translate?: (metadata:ApodMetadata)=>Promise<{titleZh:string;explanationZh:string;receiptId:number}|null>;
}
interface RecordRow {metadata:ApodMetadata;media_status:string;translation_status:string}
async function record(date:string): Promise<RecordRow|undefined> {
  const rows = await sql<RecordRow[]>`SELECT metadata,media_status,translation_status FROM imagery_archive WHERE source='nasa-apod' AND source_date=${date}`;
  return rows[0];
}
const complete = (r:RecordRow) => r.translation_status === 'ready' && ['ready','not_applicable'].includes(r.media_status);
/** Generates a public date archive, never a user profile. Cache reads do not call NASA or AI. */
export async function ensureImagery(date:string,deps:Dependencies = {}) {
  validateApodDate(date);
  let r = await record(date);
  if (r && complete(r) && await imageryMediaAvailable(await getImagery('nasa-apod',date))) return getImagery('nasa-apod',date);
  const token = await claimImageryDate('nasa-apod',date);
  if (!token) return getImagery('nasa-apod',date); // Another worker owns generation; callers can poll the read-only archive.
  try {
    r = await record(date); // Double-check after ownership acquisition.
    if (!r) {
      const metadata = await (deps.fetch ?? fetchApod)(date);
      if (!metadata) return null;
      if (metadata.source !== 'nasa-apod' || metadata.sourceDate !== date) throw new Error('Invalid imagery source record');
      const hash = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
      await saveImageryMetadata(metadata,hash);
      r = await record(date);
    }
    if (!r) throw new Error('Imagery archive unavailable');
    if (r.metadata.mediaType === 'image' && r.media_status === 'ready' && !await imageryMediaAvailable(await getImagery('nasa-apod',date))) {
      await sql`UPDATE imagery_archive SET media_status='pending',local_path=NULL,content_type=NULL,updated_at=now() WHERE source='nasa-apod' AND source_date=${date} AND media_status='ready'`;
      r.media_status = 'pending';
    }
    if (r.metadata.mediaType === 'image' && r.media_status !== 'ready') {
      let media: {localPath:string;contentType:string}|undefined;
      try {if (r.metadata.imageUrl) media = await (deps.archive ?? archiveImage)(r.metadata.imageUrl);} catch { /* Store only a bounded code, never upstream URLs/errors. */ }
      if (media) await saveImageryMedia('nasa-apod',date,media);
      else await sql`UPDATE imagery_archive SET media_status='failed',media_error_code='media_unavailable',updated_at=now() WHERE source='nasa-apod' AND source_date=${date} AND media_status<>'ready'`;
    }
    if (r.translation_status !== 'ready') {
      let translation: Awaited<ReturnType<NonNullable<Dependencies['translate']>>>;
      let failed = false;
      try {translation = await (deps.translate ?? translateImagery)(r.metadata);} catch {failed=true;translation=null;}
      if (translation) {
        if (!translation.titleZh.trim() || !translation.explanationZh.trim()) throw new Error('Invalid imagery translation');
        await sql.begin(async tx => {
          const [receipt] = await tx`SELECT id FROM receipts WHERE id=${translation.receiptId} AND status IN ('received','completed') FOR UPDATE`;
          if (!receipt) throw new Error('Imagery translation receipt unavailable');
          const saved = await tx`UPDATE imagery_archive SET title_zh=${translation.titleZh},explanation_zh=${translation.explanationZh},translation_receipt_id=${translation.receiptId},translation_status='ready',translation_error_code=NULL,updated_at=now() WHERE source='nasa-apod' AND source_date=${date} AND translation_status<>'ready' RETURNING source`;
          if (saved.length) await completeReceipt(tx,translation.receiptId);
        });
      } else if (failed) {
        await sql`UPDATE imagery_archive SET translation_status='failed',translation_error_code='translation_unavailable',updated_at=now() WHERE source='nasa-apod' AND source_date=${date} AND translation_status<>'ready'`;
      }
    }
    return getImagery('nasa-apod',date);
  } finally { await releaseImageryDate('nasa-apod',date,token); }
}
