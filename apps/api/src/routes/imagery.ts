import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

interface Dependencies {
  list:(options?:{limit?:number;before?:string})=>Promise<unknown[]>;
  lookup:(date:string)=>Promise<{item:any|null;status:string}>;
  status:(date:string)=>Promise<any|null>;
  media:(key:string)=>Promise<{body:Buffer;contentType:string}>;
}
function calendarDate(value:unknown): value is string {
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===value;
}
export function registerImagery(app:FastifyInstance,deps:Dependencies,opts:{enabled?:boolean}={}) {
  const enabled=opts.enabled ?? false;
  const requests=new Map<string,{start:number;count:number}>();
  const noStore=(reply:any)=>reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
  app.get('/api/imagery/items',async(req,reply)=>{
    if(!enabled) return noStore(reply).code(404).send({error:'not_found'});
    const q=req.query as Record<string,unknown>;
    const limit=q.limit===undefined ? 20 : Number(q.limit);
    if(!Number.isInteger(limit) || limit<1 || limit>50 || (q.before!==undefined && !calendarDate(q.before))) return noStore(reply).code(400).send({error:'invalid_request'});
    try{return reply.header('Cache-Control','public, max-age=60').send({items:await deps.list({limit,before:q.before as string|undefined})});}
    catch{return noStore(reply).code(503).send({error:'temporarily_unavailable'});}
  });
  for (const path of ['lookup','status'] as const) app.post(`/api/imagery/${path}`,{bodyLimit:1024,onRequest:async(_req,reply)=>{noStore(reply);}},async(req,reply)=>{
    noStore(reply);
    if(!enabled)return reply.code(404).send({error:'not_found'});
    const b=req.body;
    const date=b && typeof b==='object' && !Array.isArray(b) ? (b as Record<string,unknown>).date : undefined;
    if(!calendarDate(date) || date<'1995-06-16' || date>new Date().toISOString().slice(0,10) || Object.keys(b as object).length!==1) return reply.code(400).send({error:'invalid_date'});
    if(path==='status') {
      try {
        const item=await deps.status(date);
        const status=item && item.translationStatus==='ready' && ['ready','not_applicable'].includes(item.mediaStatus) ? 'ready':'pending';
        return reply.send({item,status});
      } catch {return reply.code(503).send({error:'temporarily_unavailable'});}
    }
    const now=Date.now();
    for(const [key,v] of requests)if(now-v.start>=3_600_000)requests.delete(key);
    let bucket=requests.get(req.ip);
    if(!bucket){if(requests.size>=5000)return reply.code(429).header('Retry-After','3600').send({error:'rate_limited'});bucket={start:now,count:0};requests.set(req.ip,bucket);}
    if(bucket.count>=10)return reply.code(429).header('Retry-After',String(Math.max(1,Math.ceil((bucket.start+3_600_000-now)/1000)))).send({error:'rate_limited'});
    bucket.count++;
    try{
      return reply.send(await deps.lookup(date));
    }catch{return reply.code(503).send({error:'temporarily_unavailable'});}
  });
  app.get('/api/imagery/media/:key',async(req,reply)=>{
    if(!enabled)return noStore(reply).code(404).send({error:'not_found'});
    const {key}=req.params as {key:string};
    if(!/^[a-f0-9]{64}$/.test(key))return noStore(reply).code(400).send({error:'invalid_media_key'});
    try{
      const media=await deps.media(key);
      if(!['image/jpeg','image/png','image/gif','image/webp','image/avif'].includes(media.contentType))throw Error('Unsupported media');
      const etag='"'+createHash('sha256').update(media.contentType).update(media.body).digest('hex')+'"';
      reply.header('Cache-Control','public, max-age=31536000, immutable').header('ETag',etag).header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").type(media.contentType);
      const condition=req.headers['if-none-match'];
      if(typeof condition==='string' && condition.split(',').some(v=>v.trim()==='*' || v.trim().replace(/^W\//,'')===etag))return reply.code(304).send();
      return reply.send(media.body);
    }catch(error){return noStore(reply).code((error as NodeJS.ErrnoException).code==='ENOENT'?404:503).send({error:(error as NodeJS.ErrnoException).code==='ENOENT'?'not_found':'temporarily_unavailable'});}
  });
}
