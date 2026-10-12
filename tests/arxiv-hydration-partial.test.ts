import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';
import {ingestHydratedArxivBatch} from '../packages/backend/src/arxiv/hydration.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';

const DAYS:Record<number,string>={5:'Mon',6:'Tue',7:'Wed',8:'Thu'};
const atomFor=(papers:{id:string;title?:string;summary?:string}[],start=0)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({id,title,summary})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>${title??`Title ${id}`}</title><summary>${summary??`Abstract ${id}`}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[],day=7)=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>${DAYS[day]}, 0${day} Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const jobOptions=(fetchImpl:typeof fetch,now:string)=>({fetch:fetchImpl,sleep:async()=>{},now:()=>new Date(now)});
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_rss_cache CASCADE`;

test('a partially returned batch stores the returned versions, records the missing one and still completes',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const announced=['2610.04001v1','2610.04002v1','2610.04003v1'];
 const batches:string[][]=[];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced,7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  batches.push(ids);
  return new Response(atomFor(ids.filter(id=>id!=='2610.04002v1').map(id=>({id}))));
 };
 const result=await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z'));
 assert.equal(result!.complete,true,'a partial hydration answer must not fail the job');
 assert.deepEqual(batches,[announced],'the whole candidate set is asked for in one batch');
 assert.equal(result!.hydrationRequested,3);
 assert.equal(result!.hydrationIngested,2);
 assert.equal(result!.hydrationMissing,1);
 assert.equal(result!.hydrationUnexpected,0);
 assert.equal(result!.hydrationFailed,1,'the verifiable failure count is returned');
 const papers=await sql<{arxiv_id:string}[]>`SELECT arxiv_id FROM arxiv_raw_papers ORDER BY arxiv_id`;
 assert.deepEqual(papers.map(p=>p.arxiv_id),['2610.04001v1','2610.04003v1'],'both returned versions are stored');
 const open=await sql<{arxiv_id:string;kind:string;attempts:number;resolved_at:Date|null}[]>`
  SELECT arxiv_id,kind,attempts,resolved_at FROM arxiv_hydration_exceptions`;
 assert.equal(open.length,1,'exactly one exception is recorded');
 assert.equal(open[0]!.arxiv_id,'2610.04002v1');
 assert.equal(open[0]!.kind,'missing');
 assert.equal(open[0]!.attempts,1);
 assert.equal(open[0]!.resolved_at,null);
 assert.ok((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,'the watermark stands for the handled window');
});

test('a rerun re-requests nothing it already has and still processes new announcements',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const first=['2610.04101v1','2610.04102v1','2610.04103v1'];
 const firstBatch:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(first,7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor(ids.filter(id=>id!=='2610.04102v1').map(id=>({id}))));
 };
 const initial=await collectAndStoreArxiv(jobOptions(firstBatch,'2026-10-07T12:00:00Z'));
 assert.equal(initial!.hydrationMissing,1);
 // Same UTC day: the feed comes from the daily cache, and both the stored versions and the open
 // exception are skipped.
 const repeated:string[]=[];
 const second=await collectAndStoreArxiv(jobOptions(async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') throw new Error('a cached same-day feed must not be requested again');
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  repeated.push(...ids);
  return new Response(atomFor(ids.map(id=>({id}))));
 },'2026-10-07T13:00:00Z'));
 assert.equal(second!.rssCacheHit,true);
 assert.deepEqual(repeated,[],'neither the stored versions nor the open exception are re-requested');
 // A new UTC day is a new feed, and a new announcement must still be hydrated promptly.
 const requested:string[][]=[];
 const third=await collectAndStoreArxiv(jobOptions(async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(['2610.04104v1'],8));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  requested.push(ids);
  return new Response(atomFor(ids.map(id=>({id}))));
 },'2026-10-08T12:00:00Z'));
 assert.deepEqual(requested,[['2610.04104v1']],'only the new announcement is asked for');
 assert.equal(third!.hydrationIngested,1);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`)[0]!.n,1,'the old exception is still open');
});

test('an entry that was never requested is recorded and never stored as a paper',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const announced=['2610.04201v1','2610.04202v1'];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced,7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor([...ids,'2610.04999v1'].map(id=>({id}))));
 };
 const result=await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z'));
 assert.equal(result!.complete,true);
 assert.equal(result!.hydrationIngested,2,'only the requested versions are ingested');
 assert.equal(result!.hydrationUnexpected,1);
 assert.equal(result!.hydrationMissing,0);
 assert.equal(result!.hydrationFailed,1);
 const papers=await sql<{arxiv_id:string}[]>`SELECT arxiv_id FROM arxiv_raw_papers ORDER BY arxiv_id`;
 assert.deepEqual(papers.map(p=>p.arxiv_id),['2610.04201v1','2610.04202v1'],'the unrequested entry never pollutes the paper table');
 const open=await sql<{arxiv_id:string;kind:string;returned_ids:string[]}[]>`
  SELECT arxiv_id,kind,returned_ids FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`;
 assert.equal(open.length,1);
 assert.equal(open[0]!.arxiv_id,'2610.04999v1');
 assert.equal(open[0]!.kind,'unexpected');
 assert.deepEqual([...open[0]!.returned_ids].sort(),['2610.04201v1','2610.04202v1','2610.04999v1'],'the whole returned ID list is kept as evidence');
});

test('a same-base different-version answer rejects the whole batch and stores nothing',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(['2610.04500v1'],7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor([{id:'2610.04500v2'}]));
 };
 const error=await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z')).then(()=>undefined,f=>f as Error);
 assert.ok(error,'a wrong version must reject the batch');
 assert.match(error.message,/version mismatch/);
 assert.match(error.message,/requested v1, received v2/,'the error names the version');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,0,'no paper may be stored');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_batches`)[0]!.n,0,'the untrustworthy document must not be archived');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions`)[0]!.n,0);
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,null,'the watermark must not advance');
});

test('a same-version metadata drift rejects the batch and rolls the exception registration back with it',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(['2610.04600v1'],7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor([{id:'2610.04600v1',title:'Original title'}]));
 };
 await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z'));
 const stored=await sql<{title:string}[]>`SELECT metadata->>'title_original' AS title FROM arxiv_raw_papers WHERE arxiv_id='2610.04600v1'`;
 assert.equal(stored[0]!.title,'Original title');
 const batchesBefore=(await sql`SELECT count(*)::int n FROM arxiv_raw_batches`)[0]!.n;
 const drifted=atomFor([{id:'2610.04600v1',title:'Drifted title'}]);
 await assert.rejects(ingestHydratedArxivBatch({
  page:{raw_atom:drifted,papers:parseArxivAtom(drifted),collected_at_utc:'2026-10-08T12:00:00Z'},
  requestedIds:['2610.04600v1','2610.04700v1'],
  acceptedIds:['2610.04600v1'],
  exceptions:[{arxivId:'2610.04700v1',baseId:'2610.04700',version:1,kind:'missing'}],
  meta:{httpStatus:200,headers:{},pagination:{},durationMs:1},
 }),/raw feed conflict/);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_batches`)[0]!.n,batchesBefore,'the drifted document is not archived');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions`)[0]!.n,0,'the exception row rolls back with the batch');
 const after=await sql<{title:string}[]>`SELECT metadata->>'title_original' AS title FROM arxiv_raw_papers WHERE arxiv_id='2610.04600v1'`;
 assert.equal(after[0]!.title,'Original title','the stored version is never overwritten');
});

test('a batch that returns none of the requested versions is reported as a partial round and holds the watermark',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const announced=['2610.04801v1','2610.04802v1'];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced,7));
  return new Response(atomFor([]));
 };
 const result=await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z'));
 assert.equal(result!.partial,true,'ordinary missing versions are reported as a partial round, not raised');
 assert.equal(result!.complete,false,'a partial round never claims the window was handled');
 assert.match(result!.hydrationFailure!,/hydration returned missing/,'the partial result names what stayed behind');
 assert.equal(result!.hydrationFailed,2);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,0);
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,null,'a batch that stored nothing must not advance the watermark');
 const open=await sql<{arxiv_id:string;kind:string;attempts:number}[]>`
  SELECT arxiv_id,kind,attempts FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL ORDER BY arxiv_id`;
 assert.deepEqual(open.map(r=>r.arxiv_id),announced);
 assert.ok(open.every(r=>r.kind==='missing'));
 assert.ok(open.every(r=>r.attempts===1));
});

test('an exception locates the complete raw response offline and marks a truncated excerpt',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const announced=['2610.04301v1','2610.04302v1','2610.04303v1'];
 const long='A'.repeat(3000);
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced,7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor(ids.filter(id=>id!=='2610.04302v1').map(id=>({id,summary:long}))),
   {headers:{'content-type':'application/atom+xml','x-secret-token':'must-not-be-stored','date':'Wed, 07 Oct 2026 12:00:00 GMT'}});
 };
 await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z'));
 const rows=await sql<{arxiv_id:string;kind:string;http_status:number;response_headers:Record<string,string>;
  pagination:{returnedCount:number;requestedCount:number};duration_ms:number;raw_response_excerpt:string;
  raw_response_truncated:boolean;request_ids:string[];returned_ids:string[];raw_atom:string}[]>`
  SELECT e.arxiv_id,e.kind,e.http_status,e.response_headers,e.pagination,e.duration_ms,e.raw_response_excerpt,
         e.raw_response_truncated,e.request_ids,e.returned_ids,b.raw_atom
  FROM arxiv_hydration_exceptions e JOIN arxiv_raw_batches b ON b.content_hash=e.raw_batch_hash
  WHERE e.resolved_at IS NULL`;
 assert.equal(rows.length,1);
 const row=rows[0]!;
 assert.equal(row.arxiv_id,'2610.04302v1');
 assert.equal(row.http_status,200);
 assert.equal(row.raw_response_truncated,true,'the inline excerpt is marked as truncated');
 assert.equal(row.raw_response_excerpt.length,4000);
 assert.ok(row.raw_atom.length>4000);
 assert.ok(row.raw_atom.includes('2610.04301v1')&&row.raw_atom.includes('2610.04303v1'),'the complete response stays locatable by batch hash');
 assert.deepEqual([...row.request_ids].sort(),[...announced].sort());
 assert.deepEqual([...row.returned_ids].sort(),['2610.04301v1','2610.04303v1']);
 assert.equal(row.pagination.requestedCount,3);
 assert.equal(row.pagination.returnedCount,2);
 assert.ok(row.duration_ms>=0);
 assert.equal(row.response_headers['content-type'],'application/atom+xml');
 assert.equal(row.response_headers['x-secret-token'],undefined,'only allow-listed headers are stored');
 assert.equal(Object.keys(row.response_headers).some(k=>/auth|cookie|token|secret/i.test(k)),false,'no credential-bearing header is recorded');
});

test('a zero-hit sub-batch is recorded, does not stop the next sub-batch or the window, and reports a partial round',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const announced=['2610.04901v1','2610.04902v1'];
 const hydration:string[][]=[];
 const window:string[]=[];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced,7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(ids.length){hydration.push(ids);return new Response(atomFor(ids.filter(id=>id!=='2610.04901v1').map(id=>({id}))));}
  window.push(u.href);
  return new Response(atomFor([]));
 };
 const result=await collectAndStoreArxiv({...jobOptions(fake,'2026-10-07T12:00:00Z'),pageSize:1});
 assert.equal(result!.partial,true,'a sub-batch that stored nothing is reported as a partial round, not a failed one');
 assert.equal(result!.complete,false,'a partial round never claims the window was handled');
 assert.equal(result!.hydrationIngested,1,'the healthy version is still counted');
 assert.equal(result!.hydrationFailed,1);
 assert.match(result!.hydrationFailure!,/hydration returned missing/);
 assert.deepEqual(hydration,[['2610.04901v1'],['2610.04902v1']],'the healthy sub-batch is still asked for');
 assert.equal(window.length,1,'the ordinary window page still runs');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id='2610.04902v1'`)[0]!.n,1,'the healthy version is still stored');
 const open=await sql<{arxiv_id:string}[]>`SELECT arxiv_id FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`;
 assert.deepEqual(open.map(r=>r.arxiv_id),['2610.04901v1'],'only the absent version is recorded');
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,null,'a round that stored nothing for a requested version holds the watermark');
});

test.after(async()=>{await closeDb();});
