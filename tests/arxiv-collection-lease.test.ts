// The owner lease is what makes collection and the recovery entry mutually exclusive, and a request
// that outlives one lease term would silently break that. These tests hold the lease to its promise:
// it is renewed before every request, it stays alive while a request is in flight, and a lease that was
// taken over fails closed instead of committing an answer it no longer owns.
import './setup.ts';

// This file drives the OPTIONAL API supplement. The ordinary round is RSS-primary and touches the
// export API zero times, so a test that is about the API path has to ask for it explicitly.
process.env.ARXIV_API_SUPPLEMENT_ENABLED='true';
// This file drives the LEGACY ordinary submission-date window. It is a separate, default-off switch
// from the API supplement (RSS-U3): asking for the gap-fill must not bring the window back.
process.env.ARXIV_API_WINDOW_ENABLED='true';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {ArxivLeaseLostError,ArxivLeaseUnconfirmedError,claimCollectionLease,confirmCollectionLease,ownerGuardedDatabase,withLeaseHeartbeat} from '../packages/backend/src/arxiv/collection-state.ts';
import type {CollectionLease} from '../packages/backend/src/arxiv/collection-state.ts';
import {createArxivChannel} from '../packages/backend/src/arxiv/channel.ts';
import {RSS_CHANNEL,writeArxivRssCache} from '../packages/backend/src/arxiv/hydration.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';

const DAYS:Record<number,string>={7:'Wed',8:'Thu'};
const atomFor=(papers:{id:string}[],start=0)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({id})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>Title ${id}</title><summary>Abstract ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[],day=7)=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>${DAYS[day]}, 0${day} Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_rss_cache CASCADE`;
const leaseUntil=async():Promise<Date|null>=>{
 const row=(await sql<{lease_until:Date|null}[]>`SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0];
 return row?.lease_until ? new Date(row.lease_until) : null;
};

test('the lease heartbeat renews while a task runs and fails closed when the lease is taken over',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
 const before=await leaseUntil();
 const value=await withLeaseHeartbeat(lease,async()=>{
  for(let i=0;i<8;i++) await delay(15);
  return 'answered';
 },{intervalMs:20});
 const after=await leaseUntil();
 assert.equal(value,'answered');
 assert.ok(before&&after&&after.getTime()>before.getTime(),'the term was extended while the call was still running');
 let takeoverAborted=false;
 await assert.rejects(withLeaseHeartbeat(lease,async(signal)=>{
  await delay(30);
  await sql`UPDATE arxiv_collection_state SET owner=${'00000000-0000-4000-8000-000000000001'}::uuid WHERE key='astro-ph'`;
  // The next heartbeat is refused, which aborts this signal: a run that lost its channel must not keep
  // its own request alive on a connection it no longer owns.
  await new Promise<void>(resolve=>{
   if(signal.aborted) return resolve();
   signal.addEventListener('abort',()=>{takeoverAborted=true;resolve();},{once:true});
  });
  return 'stale';
 },{intervalMs:20}),/lease lost/,'an answer produced under a lease that was taken over is refused, not committed');
 assert.ok(takeoverAborted,'the refused renewal aborted the signal the request was given');
 assert.equal((await sql<{owner:string|null}[]>`SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!.owner,'00000000-0000-4000-8000-000000000001','the taking owner keeps the lease');
});

test('one slow request renews the lease while it is still in flight',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const asked:string[]=[];
 const duringRss:(Date|null)[]=[];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org'){
   duringRss.push(await leaseUntil());
   await delay(200);
   duringRss.push(await leaseUntil());
   return new Response(rssFor(['2610.08001v1'],7));
  }
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  asked.push(...ids);
  return new Response(ids.length?atomFor(ids.map(id=>({id}))):atomFor([]));
 };
 const result=await collectAndStoreArxiv({fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T12:00:00Z'),leaseHeartbeatMs:20});
 assert.equal(result!.complete,true,'the round still finishes');
 assert.deepEqual(asked,['2610.08001v1'],'the stored version is hydrated');
 assert.ok(duringRss[0]&&duringRss[1],'the request observed a live lease at both ends of its own answer');
 assert.ok(duringRss[1]!.getTime()>duringRss[0]!.getTime(),'the lease was renewed while the same request was still in flight');
});

test('a competing entry is refused at every request a running round makes',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const competitors:string[]=[];
 const fake:typeof fetch=async input=>{
  const admission=await claimCollectionLease();
  competitors.push('status' in admission?admission.status:'admitted');
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(['2610.08101v1'],7));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  return new Response(ids.length?atomFor(ids.map(id=>({id}))):atomFor([]));
 };
 await collectAndStoreArxiv({fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T12:00:00Z')});
 assert.ok(competitors.length>=3,'rss, the hydration sub-batch and the window page each made a request');
 assert.deepEqual(competitors,competitors.map(()=>'busy'),'the lease was held, and alive, at every request of the round');
});

test('every request the arXiv collection makes is wrapped in the lease heartbeat',()=>{
 for(const file of ['packages/backend/src/arxiv/collect-job.ts','packages/backend/src/arxiv/hydration.ts']){
  const text=readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
  const requests=[...text.matchAll(/channel\.run\(/g)].length;
  const guarded=[...text.matchAll(/withLeaseHeartbeat\(/g)].length;
  assert.ok(requests>0,`${file} makes a request`);
  assert.equal(guarded,requests,`${file}: every channel.run( must be wrapped in withLeaseHeartbeat( so the lease is renewed before it and kept alive while it runs`);
 }
});

const until=async(check:()=>Promise<boolean>,timeoutMs:number,what:string)=>{
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(await check()) return;
  await delay(15);
 }
 throw new Error(`timed out waiting for ${what}`);
};
// A renewal that is waiting on the state row's lock is visible in pg_stat_activity, which is what makes
// "the renewal is still in flight" an observation instead of a guess.
const blockedRenewals=async():Promise<number>=>Number((await sql<{n:string}[]>`
 SELECT count(*) AS n FROM pg_stat_activity
 WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE arxiv_collection_state%'`)[0]!.n);

test('a renewal still in flight when the request finishes is awaited before the result is trusted',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
  const thief='00000000-0000-4000-8000-000000000002';
  // Holding the state row makes the heartbeat's renewals queue behind us, so one of them is guaranteed
  // to be unpaid at the moment the request finishes — the boundary this test is about.
  const first=await sql.reserve();
  const second=await sql.reserve();
  let releaseTask:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{releaseTask=resolve;});
  let call:Promise<unknown>=Promise.resolve();
  try{
   await first`BEGIN`;
   await first`SELECT 1 FROM arxiv_collection_state WHERE key='astro-ph' FOR UPDATE`;
   call=withLeaseHeartbeat(lease,async()=>{await gate;return 'answered';},{intervalMs:500});
   await delay(120);
   // The initial renewal runs, the heartbeat arms and the request starts; the next tick is a full
   // interval away, so taking the channel over now is what the renewal is still waiting on later.
   await first`COMMIT`;
   await second`BEGIN`;
   await second`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
   await until(async()=>await blockedRenewals()>0,5000,'a heartbeat renewal to block behind the row lock');
   // The request is finished, but the renewal it started has not been paid yet.
   releaseTask();
   const outcome=await Promise.race([
    call.then(()=>'resolved' as const,()=>'rejected' as const),
    delay(250).then(()=>'pending' as const),
   ]);
   assert.equal(outcome,'pending','the result must not be handed back while its own renewal is still unpaid');
   await second`COMMIT`;
   await assert.rejects(call,/lease lost/,'the renewal that finally failed is what the caller sees');
  }finally{
   try{await first`ROLLBACK`;}catch{}
   try{await second`ROLLBACK`;}catch{}
   first.release();second.release();
  }
});

test('a batch written after the lease was taken over is refused and rolled back',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
 const held='a'.repeat(64);
 const refused='b'.repeat(64);
 const written=await ownerGuardedDatabase(lease).begin(async tx=>{
  await tx`INSERT INTO arxiv_announcement_batches(content_hash,raw_rss,collected_at,paper_count)
   VALUES(${held},'<rss/>',clock_timestamp(),0)`;
  return 'written';
 });
 assert.equal(written,'written','the holder writes normally while it owns the channel');
 const thief='00000000-0000-4000-8000-000000000003';
 await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
 await assert.rejects(ownerGuardedDatabase(lease).begin(async tx=>{
  await tx`INSERT INTO arxiv_announcement_batches(content_hash,raw_rss,collected_at,paper_count)
   VALUES(${refused},'<rss/>',clock_timestamp(),0)`;
 }),/lease lost/,'a run that no longer owns the channel cannot commit a batch');
 const stored=await sql<{content_hash:string}[]>`
  SELECT content_hash FROM arxiv_announcement_batches WHERE content_hash IN (${held},${refused}) ORDER BY content_hash`;
 assert.deepEqual(stored.map(row=>row.content_hash),[held],'nothing from the taken-over run was committed');
});

test('every batch the collection writes passes the lease owner guard',()=>{
 const job=readFileSync(new URL('../packages/backend/src/arxiv/collect-job.ts',import.meta.url),'utf8');
 assert.equal([...job.matchAll(/ownerGuardedDatabase\(state\)/g)].length,3,'announcements, the hydration sub-batch and the window page are all guarded');
 for(const fragment of [
  'const evidence=await stateApi.ownerGuardedDatabase(state).begin(async tx=>{',
  'ingestRawArxivCollection(page,stateApi.ownerGuardedDatabase(state))',
  '},stateApi.ownerGuardedDatabase(state));',
 ]){
  assert.ok(job.includes(fragment),`collect-job.ts no longer writes a batch this way: ${fragment}`);
 }
 // The feed cache is load-bearing — it is what makes a later run of the same day skip the RSS request —
 // so it commits in the same guarded transaction as the batch it points at, through the ambient
 // transaction, and never on a connection of its own.
 assert.equal([...job.matchAll(/writeArxivRssCache\(/g)].length,1,'the feed cache is written in exactly one place');
 assert.ok(job.includes('const ambient=stateApi.ambientTransaction(tx);')&&job.includes('},ambient);'),
  'the feed cache must join the guarded announcement transaction instead of committing on its own');
 const recovery=readFileSync(new URL('../packages/backend/src/arxiv/hydration.ts',import.meta.url),'utf8');
 assert.ok(recovery.includes('}, stateApi.ownerGuardedDatabase(lease));'),'the explicit recovery entry guards its batch too');
 // The recovery budget is shared state: it is only moved while the lease is still ours, so a stale
 // owner can neither spend a retry nor overwrite why an exception is being carried.
 assert.equal([...recovery.matchAll(/recordHydrationAttemptFailure\(failure, stateApi\.ownerGuardedDatabase\(lease\)\)/g)].length,1,
  'the recovery attempt counter is written under the owner guard');
 assert.equal([...recovery.matchAll(/recordAttempt\(/g)].length,3,'every recovery budget write goes through the guarded helper');
});

test('the channel refuses to dispatch a queued request once its run is cancelled while it waits',async()=>{
 let network=0;
 let waiters=0;
 let release:()=>void=()=>{};
 const sleeping=new Promise<void>(resolve=>{release=resolve;});
 // The spacing wait a request must sit through is exactly where a run can lose its channel without
 // noticing, so the signal is re-checked with nothing left between it and the dispatch.
 const channel=createArxivChannel({
  fetch:async()=>{network++;return new Response('<feed/>');},
  minIntervalMs:5000,
  sleep:async()=>{waiters++;await sleeping;},
 });
 assert.equal(await channel.run(new AbortController().signal,async fetchImpl=>{
  await fetchImpl('https://export.arxiv.org/api/query?start=0');
  return 'first';
 }),'first');
 assert.equal(network,1,'the live run reached the transport');
 const cancelled=new AbortController();
 const queued=channel.run(cancelled.signal,async fetchImpl=>{
  await fetchImpl('https://export.arxiv.org/api/query?start=1');
  return 'second';
 });
 queued.catch(()=>{});
 await until(async()=>waiters>0,5000,'the second run to reach the spacing wait');
 cancelled.abort(new ArxivLeaseLostError());
 release();
 await assert.rejects(queued,/lease lost/,'a run cancelled during its wait never reaches the network');
 assert.equal(network,1,'the spacing wait did not end in a dispatch for the cancelled run');
});

test('a lease lost while a request is in flight cancels it and stops every later dispatch',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const thief='00000000-0000-4000-8000-000000000004';
 const dispatched:string[]=[];
 let abortedReason:unknown;
 let entered:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const fake:typeof fetch=async(input,init)=>{
  const u=new URL(String(input));
  dispatched.push(u.hostname);
  entered();
  const signal=init?.signal;
  assert.ok(signal,'every transport call is given the run signal');
  // Held open until the run abandons its channel. The transport deadline is deliberately short so a
  // cancellation that comes from the deadline instead of the lease cannot pass as a lease cancellation.
  await new Promise<void>(resolve=>{
   if(signal!.aborted) return resolve();
   signal!.addEventListener('abort',()=>{abortedReason=signal!.reason;resolve();},{once:true});
  });
  throw new Error('the request was cancelled');
 };
 const run=collectAndStoreArxiv({fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T12:00:00Z'),leaseHeartbeatMs:20,timeoutMs:3000});
 run.catch(()=>{});
 await Promise.race([started,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('the round never reached the network')),5000))]);
 await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
 await assert.rejects(run,/lease lost/,'the takeover is what the caller sees, not an announcement-feed failure');
 assert.ok(abortedReason instanceof ArxivLeaseLostError,
  `the in-flight request was cancelled by the lease it belonged to, not by the transport's own deadline (${String(abortedReason)})`);
 assert.deepEqual(dispatched,['rss.arxiv.org'],'no further request was dispatched once the lease was lost');
 assert.equal((await sql<{owner:string|null}[]>`SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!.owner,thief,'the taking owner keeps the lease');
});

test('the RSS cache is written under the same ownership check as the feed it points at',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
 const cacheDay='2026-10-07';
 const hashA='c'.repeat(64);
 const entry=(itemCount:number)=>({channel:RSS_CHANNEL,cacheDay,contentHash:hashA,itemCount,fetchedAt:new Date(),
  httpStatus:200,headers:{},durationMs:5});
 await sql`INSERT INTO arxiv_announcement_batches(content_hash,raw_rss,collected_at,paper_count)
  VALUES(${hashA},'<rss/>',clock_timestamp(),1)`;
 await writeArxivRssCache(entry(1),ownerGuardedDatabase(lease));
 const stored=async()=>(await sql<{content_hash:string;item_count:number}[]>`
  SELECT content_hash,item_count FROM arxiv_rss_cache WHERE channel=${RSS_CHANNEL} AND cache_day=${cacheDay}::date`)[0];
 assert.deepEqual(await stored(),{content_hash:hashA,item_count:1},'the owner stamps the cache with the feed it stored');
 // The takeover lands while the old owner is still finishing the round. The cache pointer is what
 // makes a later run of the same day skip the RSS request, so the stale owner must not be able to
 // overwrite it with the feed it read before handing over.
 await sql`UPDATE arxiv_collection_state SET owner=${'00000000-0000-4000-8000-000000000005'}::uuid WHERE key='astro-ph'`;
 await assert.rejects(writeArxivRssCache(entry(9),ownerGuardedDatabase(lease)),/lease lost/,
  'a taken-over run cannot overwrite the feed pointer');
 assert.deepEqual(await stored(),{content_hash:hashA,item_count:1},'the cache still points at the feed the owner stored');
});

test('a lease that is already gone before a request never dispatches it',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
 // The channel changes hands after the run claimed it and before its first renewal.
 await sql`UPDATE arxiv_collection_state SET owner=${'00000000-0000-4000-8000-000000000007'}::uuid WHERE key='astro-ph'`;
 let dispatched=false;
 await assert.rejects(withLeaseHeartbeat(lease,async()=>{dispatched=true;return 'never';}),/lease lost/,'the refused initial renewal fails the run');
 assert.equal(dispatched,false,'nothing is dispatched on a channel that has already changed hands');
});

test('a takeover during the wait is refused at dispatch although nobody aborted and no heartbeat fired',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
 const thief='00000000-0000-4000-8000-000000000009';
 let dispatched=0;
 let waits=0;
 let release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const signals:AbortSignal[]=[];
 const channel=createArxivChannel({
  fetch:async()=>{dispatched+=1;return new Response('<feed/>');},
  minIntervalMs:60000,
  // The next request has to sit in the spacing wait, which is held open by hand: that is exactly the
  // window in which a run can lose its channel without anything telling it.
  sleep:async()=>{waits+=1;await gate;},
  guard:(signal)=>{signal.throwIfAborted();return confirmCollectionLease(lease,{context:'before the request was dispatched'});},
 });
 const runRequest=(start:number)=>withLeaseHeartbeat(lease,(signal)=>{
  signals.push(signal);
  return channel.run(signal,async fetchImpl=>{
   await fetchImpl(`https://export.arxiv.org/api/query?start=${start}`);
   return start;
  });
 },{intervalMs:60000,renewalTimeoutMs:60000,leaseSeconds:600});
 assert.equal(await runRequest(0),0);
 assert.equal(dispatched,1,'the first request really reached the transport');
 const run=runRequest(1);
 run.catch(()=>{});
 await until(async()=>waits>0,5000,'the second run to reach the spacing wait');
 // The channel changes hands while the run waits. Nothing tells the run: the heartbeat interval is far
 // away, it has no renewal outstanding, and nobody aborts the signal. The only thing that can still stop
 // the request is asking the durable row itself at the dispatch boundary — which is why a cancellation
 // signal, however well threaded, is not the same guarantee as a lease that is re-validated.
 await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
 release();
 await assert.rejects(run,/lease lost/,'the dispatch boundary asks the row, not only the local signal');
 assert.equal(dispatched,1,'the request was never sent on a channel that had already changed hands');
 assert.equal(signals[1]!.aborted,false,'nothing aborted the run: the dispatch boundary refused it on its own');
 assert.equal((await sql<{owner:string|null}[]>`SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!.owner,thief,
  'the taking owner keeps the lease');
});

test('a renewal that never answers fails the run closed instead of holding it open',async()=>{
 await clean();
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as CollectionLease;
 // Another connection takes the state row AFTER the initial renewal has been paid, so what this
 // exercises is a renewal that hangs — not a run that never managed to start.
 const holder=await sql.reserve();
 let taskAborted=false;
 let reason:unknown;
 try {
  await assert.rejects(withLeaseHeartbeat(lease,async signal=>{
   await holder`BEGIN`;
   await holder`SELECT 1 FROM arxiv_collection_state WHERE key='astro-ph' FOR UPDATE`;
   await new Promise<void>(resolve=>{
    if(signal.aborted) return resolve();
    signal.addEventListener('abort',()=>{taskAborted=true;reason=signal.reason;resolve();},{once:true});
   });
   return 'unreachable';
  },{intervalMs:200,renewalTimeoutMs:150,leaseSeconds:600}),/could not be confirmed/,
   'a lease nobody can confirm is not one a run may keep working under');
 } finally {
  try{await holder`ROLLBACK`;}catch{}
  holder.release();
 }
 assert.equal(taskAborted,true,'the renewal that never answered aborted the run it belonged to');
 assert.ok(reason instanceof ArxivLeaseUnconfirmedError,
  `and it is reported as unconfirmed rather than as a confirmed takeover (${String(reason)})`);
});

test.after(async()=>{await closeDb();});