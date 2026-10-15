import './setup.ts';

// This file drives the OPTIONAL API supplement. The ordinary round is RSS-primary and touches the
// export API zero times, so a test that is about the API path has to ask for it explicitly.
process.env.ARXIV_API_SUPPLEMENT_ENABLED='true';
// This file drives the LEGACY ordinary submission-date window. It is a separate, default-off switch
// from the API supplement (RSS-U3): asking for the gap-fill must not bring the window back.
process.env.ARXIV_API_WINDOW_ENABLED='true';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';

const emptyRss='<rss version="2.0"><channel><title>astro-ph</title></channel></rss>';
const emptyWindow=`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>0</opensearch:itemsPerPage></feed>`;
const page=(start:number,total=2)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>1</opensearch:itemsPerPage><entry><id>https://arxiv.org/abs/2610.9000${start}v1</id><title>Page ${start}</title><summary>Abstract ${start}</summary><published>2026-10-07T00:00:00Z</published><updated>2026-10-07T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry></feed>`;
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_rss_cache CASCADE`;
const options=(fetchImpl:typeof fetch,now:string,sleep?:(ms:number)=>Promise<void>)=>({fetch:fetchImpl,sleep:sleep??(async()=>{}),now:()=>new Date(now)});

test('the RSS feed is fetched once per channel and UTC day and a failed feed is never cached',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 let rssFetches=0;
 const good:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org'){rssFetches++;return new Response(emptyRss);}
  return new Response(emptyWindow);
 };
 const first=await collectAndStoreArxiv(options(good,'2026-10-07T01:00:00Z'));
 assert.equal(first!.complete,true);
 assert.equal(rssFetches,1);
 assert.equal(first!.rssCacheHit,false);
 const sameDay=await collectAndStoreArxiv(options(good,'2026-10-07T09:00:00Z'));
 assert.equal(sameDay!.rssCacheHit,true);
 assert.equal(rssFetches,1,'a same-day rerun reuses the successfully ingested feed');
 const cached=await sql<{channel:string;day:string}[]>`SELECT channel,cache_day::text AS day FROM arxiv_rss_cache`;
 assert.deepEqual(cached.map(r=>[r.channel,r.day]),[['astro-ph','2026-10-07']],'the cache records the channel and the UTC collection day');
 const nextDay=await collectAndStoreArxiv(options(good,'2026-10-08T01:00:00Z'));
 assert.equal(rssFetches,2,'a new UTC day is a new cache key and refetches');
 const failing:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') throw new Error('feed down');
  return new Response(emptyWindow);
 };
 await assert.rejects(collectAndStoreArxiv(options(failing,'2026-10-09T01:00:00Z')),/announcement feed failed/);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_rss_cache WHERE cache_day='2026-10-09'`)[0]!.n,0,'a failed response must never be cached as a success');
 const retried=await collectAndStoreArxiv(options(good,'2026-10-09T02:00:00Z'));
 assert.equal(retried!.rssCacheHit,false);
 assert.equal(rssFetches,3,'the failed day is fetched again instead of replaying a cached failure');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_rss_cache WHERE cache_day='2026-10-09'`)[0]!.n,1);
});

test('RSS and metadata requests share one serialized channel at least three seconds apart',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const sleeps:number[]=[];
 const order:string[]=[];
 let inFlight=0;
 let maxInFlight=0;
 const fake:typeof fetch=async input=>{
  inFlight+=1;maxInFlight=Math.max(maxInFlight,inFlight);
  try{
   const u=new URL(String(input));
   if(u.hostname==='rss.arxiv.org'){order.push('rss');return new Response(emptyRss);}
   order.push(`api:${u.searchParams.get('start')}`);
   return new Response(page(Number(u.searchParams.get('start'))));
  }finally{inFlight-=1;}
 };
 const result=await collectAndStoreArxiv(options(fake,'2026-10-07T12:00:00Z',async ms=>{sleeps.push(ms);}));
 assert.equal(result!.complete,true);
 assert.deepEqual(order,['rss','api:0','api:1'],'both endpoints are served by the same channel');
 assert.deepEqual(sleeps,[3000,3000],'three seconds between RSS and the first metadata request, and between metadata pages');
 assert.equal(maxInFlight,1,'the channel never runs two arXiv requests at once');
});

test('a valid Retry-After only extends the durable 429 hold while invalid or shorter values keep the six-hour floor',async()=>{
 const holdSeconds=async()=>{
  const row=(await sql<{lease_until:Date;db_now:Date}[]>`
   SELECT lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  return (new Date(row.lease_until).getTime()-new Date(row.db_now).getTime())/1000;
 };
 const limited=(retryAfter?:string):typeof fetch=>async()=>
  new Response('rate limited',{status:429,headers:retryAfter===undefined?{}:{'retry-after':retryAfter}});
 for(const [label,header,floor,ceiling] of [
  ['an absent header',undefined,21590,21600],
  ['an invalid value','banana',21590,21600],
  ['a past HTTP-date',new Date('2026-10-07T00:00:00Z').toUTCString(),21590,21600],
  ['a shorter window','60',21590,21600],
  ['exactly the floor','21600',21590,21600],
  ['a longer window','72000',71900,72000],
  ['a future HTTP-date',new Date('2026-10-07T20:00:00Z').toUTCString(),28700,28800],
 ] as const){
  await sql`TRUNCATE arxiv_collection_state CASCADE`;
  await assert.rejects(collectAndStoreArxiv(options(limited(header),'2026-10-07T12:00:00Z')),/HTTP 429/);
  const held=await holdSeconds();
  assert.ok(held>floor&&held<=ceiling,`${label}: durable hold was ${held}s`);
 }
});

test('a valid Retry-After longer than a day is honoured in full: the collector has no ceiling of its own',async()=>{
 // Round 6 capped a valid header at 24 hours. That ceiling was never approved, and it meant the
 // collector resumed ahead of a deadline the source really set, so it is gone: whatever a valid
 // Retry-After asks for is what the row holds, however long that is. Only a MISSING, non-integer or
 // non-positive value collapses back to the six-hour floor.
 for(const [label,header,seconds] of [
  ['a day and an hour','90000',90000],
  ['a week','604800',604800],
 ] as const){
  await sql`TRUNCATE arxiv_collection_state CASCADE`;
  const fake:typeof fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':header}});
  await assert.rejects(collectAndStoreArxiv(options(fake,'2026-10-07T12:00:00Z')),/HTTP 429/);
  const row=(await sql<{lease_until:Date;db_now:Date}[]>`
   SELECT lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  const held=(new Date(row.lease_until).getTime()-new Date(row.db_now).getTime())/1000;
  assert.ok(held>seconds-10&&held<=seconds,`${label}: the hold is the source's own deadline, not a ceiling (${held}s)`);
 }
});

test.after(async()=>{await closeDb();});
