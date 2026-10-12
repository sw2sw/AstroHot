import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';
import {refetchHydrationExceptions} from '../packages/backend/src/arxiv/hydration.ts';
import {claimCollectionLease,releaseCollection} from '../packages/backend/src/arxiv/collection-state.ts';

const atomFor=(papers:{id:string;title?:string}[],start=0)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({id,title})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>${title??`Title ${id}`}</title><summary>Abstract ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[])=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>Wed, 07 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_collection_day,arxiv_rss_cache CASCADE`;
const answersRequested:typeof fetch=async input=>{
 const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
 return new Response(atomFor(ids.map(id=>({id}))));
};
const switchesOn=()=>Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});

// Seeds exactly one open 'missing' exception with a real collection round.
const seedMissing=async()=>{
 const announced=['2610.05001v1','2610.05002v1','2610.05003v1'];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(!ids.length) return new Response(atomFor([]));
  return new Response(atomFor(ids.filter(id=>id!=='2610.05002v1').map(id=>({id}))));
 };
 const result=await collectAndStoreArxiv({fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T12:00:00Z')});
 assert.equal(result!.hydrationMissing,1);
};

test('two concurrent refetches cannot overlap: the second reports busy without touching the network',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 let releaseGate!:()=>void;
 const gate=new Promise<void>(resolve=>{releaseGate=resolve;});
 let entered!:()=>void;
 const enteredAt=new Promise<void>(resolve=>{entered=resolve;});
 const first=refetchHydrationExceptions({
  sleep:async()=>{},
  now:()=>new Date(),
  fetch:async input=>{
   entered();
   await gate; // hold the first request open so the second refetch really is concurrent
   const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
   return new Response(atomFor(ids.map(id=>({id}))));
  },
 });
 await enteredAt;
 let secondTouched=false;
 const second=await refetchHydrationExceptions({fetch:async()=>{secondTouched=true;throw new Error('the second refetch must not reach the network');}});
 assert.equal(second.status,'busy','a concurrent refetch shares the collection gate');
 assert.equal(secondTouched,false);
 assert.deepEqual(second.requestedIds,[]);
 assert.ok(second.nextEligibleAt,'a busy gate reports when the owner lease expires');
 releaseGate();
 const done=await first;
 assert.equal(done.status,'refetched');
 assert.deepEqual(done.resolvedIds,['2610.05002v1']);
 assert.equal((await sql`SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!.owner,null,'the refetch releases the shared lease');
});

test('a refetch never runs next to a live collection lease',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const lease=await claimCollectionLease();
 assert.ok(!('status' in lease),'the test takes the same lease ordinary collection takes');
 let touched=false;
 const busy=await refetchHydrationExceptions({fetch:async()=>{touched=true;throw new Error('must not reach the network');}});
 assert.equal(busy.status,'busy');
 assert.equal(touched,false);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`)[0]!.n,1);
 await releaseCollection(lease as {key:string;owner:string});
 const recovered=await refetchHydrationExceptions({sleep:async()=>{},fetch:answersRequested});
 assert.equal(recovered.status,'refetched','the lock is only held for the duration of the run');
});

test('a fresh refetch waits out the durable request gap left by an earlier run',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 // A run that just finished a request: the durable watermark is now, and this process has no memory
 // of it. The recovery entry must space itself from that moment, not from its own start.
 await sql`UPDATE arxiv_collection_state SET last_request_at=clock_timestamp() WHERE key='astro-ph'`;
 const slept:number[]=[];
 const result=await refetchHydrationExceptions({sleep:async ms=>{slept.push(ms);},now:()=>new Date(),fetch:answersRequested});
 assert.equal(result.status,'refetched');
 assert.ok(slept.some(ms=>ms>1000&&ms<=3000),`a cross-process gap of about three seconds was waited: ${JSON.stringify(slept)}`);
 const watermark=await sql<{last_request_at:Date|null}[]>`SELECT last_request_at FROM arxiv_collection_state WHERE key='astro-ph'`;
 assert.ok(watermark[0]!.last_request_at,'the request moment is recorded for whoever asks next');
});

test('the recovery entry obeys the collection switches',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 process.env.COLLECT_ENABLED='false';
 let touched=false;
 const disabled=await refetchHydrationExceptions({fetch:async()=>{touched=true;throw new Error('must not reach the network');}});
 assert.equal(disabled.status,'disabled','the explicit entry honours the same valves as the scheduled job');
 assert.equal(touched,false);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`)[0]!.n,1,'nothing is closed while collection is off');
});

test.after(async()=>{await closeDb();});
