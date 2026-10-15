import './setup.ts';

// This file drives the OPTIONAL API supplement. The ordinary round is RSS-primary and touches the
// export API zero times, so a test that is about the API path has to ask for it explicitly.
process.env.ARXIV_API_SUPPLEMENT_ENABLED='true';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';
import {ingestHydratedArxivBatch,refetchHydrationExceptions} from '../packages/backend/src/arxiv/hydration.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';

const atomFor=(papers:{id:string;title?:string}[],start=0)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({id,title})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>${title??`Title ${id}`}</title><summary>Abstract ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[])=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>Wed, 07 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const jobOptions=(fetchImpl:typeof fetch,now:string)=>({fetch:fetchImpl,sleep:async()=>{},now:()=>new Date(now)});
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_rss_cache CASCADE`;

// Seeds exactly one open 'missing' exception: three versions are asked for and two come back.
const seedMissing=async()=>{
 const announced=['2610.05001v1','2610.05002v1','2610.05003v1'];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor(ids.filter(id=>id!=='2610.05002v1').map(id=>({id}))));
 };
 const result=await collectAndStoreArxiv(jobOptions(fake,'2026-10-07T12:00:00Z'));
 assert.equal(result!.hydrationMissing,1);
 return result!;
};

test('explicit recovery stores the version, resolves the exception and then has no work left',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 await seedMissing();
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`)[0]!.n,1);
 const recovered=await refetchHydrationExceptions({
  sleep:async()=>{},
  fetch:async input=>{
   const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
   return new Response(atomFor(ids.map(id=>({id}))));
  },
 });
 assert.equal(recovered.status,'refetched');
 assert.deepEqual(recovered.requestedIds,['2610.05002v1']);
 assert.deepEqual(recovered.resolvedIds,['2610.05002v1']);
 assert.deepEqual(recovered.unresolvedIds,[]);
 assert.equal(recovered.resolvedExceptionCount,1);
 const row=await sql<{resolved_at:Date|null;attempts:number}[]>`
  SELECT resolved_at,attempts FROM arxiv_hydration_exceptions WHERE arxiv_id='2610.05002v1'`;
 assert.ok(row[0]!.resolved_at,'a successful refetch resolves the exception');
 assert.equal(row[0]!.attempts,1,'a successful refetch is not another failed observation');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id='2610.05002v1'`)[0]!.n,1,'the recovered version is stored');
 const idle=await refetchHydrationExceptions({fetch:async()=>{throw new Error('nothing left to recover');}});
 assert.equal(idle.status,'idle');
 assert.deepEqual(idle.requestedIds,[]);
});

test('a failed recovery keeps the exception open, counts the attempt and stops at the attempt cap',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 await seedMissing();
 const empty:typeof fetch=async()=>new Response(atomFor([]));
 const first=await refetchHydrationExceptions({fetch:empty,sleep:async()=>{}});
 assert.equal(first.status,'refetched');
 assert.deepEqual(first.resolvedIds,[]);
 assert.deepEqual(first.unresolvedIds,['2610.05002v1']);
 let row=(await sql<{resolved_at:Date|null;attempts:number}[]>`
  SELECT resolved_at,attempts FROM arxiv_hydration_exceptions WHERE arxiv_id='2610.05002v1'`)[0]!;
 assert.equal(row.resolved_at,null,'a failed refetch never fakes a resolution');
 assert.equal(row.attempts,2,'the attempt is counted on the existing row');
 await refetchHydrationExceptions({fetch:empty,sleep:async()=>{}});
 row=(await sql<{resolved_at:Date|null;attempts:number}[]>`
  SELECT resolved_at,attempts FROM arxiv_hydration_exceptions WHERE arxiv_id='2610.05002v1'`)[0]!;
 assert.equal(row.attempts,3);
 assert.equal(row.resolved_at,null);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions`)[0]!.n,1,'observations update one row instead of inserting duplicates');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,2,'a failed recovery stores nothing');
 const capped=await refetchHydrationExceptions({maxAttempts:3,fetch:async()=>{throw new Error('the attempt cap must stop the retry');}});
 assert.equal(capped.status,'idle','a capped exception is no longer selected, so retries are bounded');
});

test('recovery does not probe arXiv while the durable 429 hold is active',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 await seedMissing();
 await sql`UPDATE arxiv_collection_state SET owner=NULL,lease_until=clock_timestamp()+interval '2 hours' WHERE key='astro-ph'`;
 const skipped=await refetchHydrationExceptions({fetch:async()=>{throw new Error('the durable hold must not be bypassed');}});
 assert.equal(skipped.status,'skipped');
 assert.ok(skipped.nextEligibleAt,'the hold reports when recovery becomes eligible again');
 assert.deepEqual(skipped.requestedIds,[]);
 assert.equal((await sql`SELECT resolved_at FROM arxiv_hydration_exceptions WHERE arxiv_id='2610.05002v1'`)[0]!.resolved_at,null);
});

test('a database failure while recording an exception rolls the whole batch back',async()=>{
 await clean();
 const page=atomFor([{id:'2610.05101v1'},{id:'2610.05102v1'}]);
 await assert.rejects(ingestHydratedArxivBatch({
  page:{raw_atom:page,papers:parseArxivAtom(page),collected_at_utc:'2026-10-07T12:00:00Z'},
  requestedIds:['2610.05101v1','2610.05102v1'],
  acceptedIds:['2610.05101v1'],
  // version 0 violates the exception table's CHECK, so the write fails after the paper insert.
  exceptions:[{arxivId:'2610.05102v1',baseId:'2610.05102',version:0,kind:'missing'}],
  meta:{httpStatus:200,headers:{},pagination:{},durationMs:1},
 }),/check|violates|constraint/i);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,0,'the accepted version is rolled back');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_batches`)[0]!.n,0,'no batch evidence survives the rollback');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions`)[0]!.n,0);
});

test.after(async()=>{await closeDb();});
