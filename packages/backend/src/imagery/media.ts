import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.ts';
import { guardedFetch } from '../lib/http-fetch.ts';

const MAX_BYTES = 15 * 1024 * 1024;
const MIME: Record<string,string> = {jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif'};
const pending = new Map<string,Promise<{localPath:string;contentType:string}>>();
type Options = {directory?:string;fetchImpl?:typeof guardedFetch};
const directoryFor = (opts: Options) => path.resolve(opts.directory ?? path.join(config.dataDir,'imagery'));
function checkUrl(value: string): void {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || !['apod.nasa.gov','science.nasa.gov','assets.science.nasa.gov'].includes(u.hostname)) throw new Error('Unsupported imagery URL');
}
async function contentType(body: Buffer): Promise<string> {
  if (body.length > MAX_BYTES || !body.length) throw new Error('Invalid imagery size');
  const meta = await sharp(body,{limitInputPixels:100_000_000}).metadata();
  const type = meta.format ? MIME[meta.format] : undefined;
  if (!type || !meta.width || !meta.height) throw new Error('Unsupported imagery content');
  return type;
}
export async function readArchivedImage(key: string, opts: Options = {}): Promise<{body:Buffer;contentType:string}> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid imagery key');
  const body = await readFile(path.join(directoryFor(opts),key));
  return {body,contentType:await contentType(body)};
}
export async function archiveImage(url: string, opts: Options = {}): Promise<{localPath:string;contentType:string}> {
  checkUrl(url);
  const directory = directoryFor(opts);
  const key = createHash('sha256').update(url).digest('hex');
  const target = path.join(directory,key);
  const existing = pending.get(target); if (existing) return existing;
  const work = (async () => {
    try {
      const cached = await readArchivedImage(key,opts);
      return {localPath:key,contentType:cached.contentType};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const response = await (opts.fetchImpl ?? guardedFetch)(url,{timeoutMs:20_000,maxBytes:MAX_BYTES,redirectPolicy:'same-origin'});
    if (response.status !== 200) throw new Error('Imagery upstream unavailable');
    const type = await contentType(response.body);
    await mkdir(directory,{recursive:true});
    const temporary = path.join(directory,`${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary,response.body,{flag:'wx',mode:0o600});
      await rename(temporary,target);
    } finally { await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;}); }
    return {localPath:key,contentType:type};
  })();
  pending.set(target,work);
  try {return await work;} finally {if (pending.get(target) === work) pending.delete(target);}
}
