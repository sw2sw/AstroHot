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
import {ingestHydratedArxivBatch,refetchHydrationExceptions} from '../packages/backend/src/arxiv/hydration.ts';
import {ArxivLeaseLostError} from '../packages/backend/src/arxiv/collection-state.ts';
import {findArxivHttpError} from '../packages/backend/src/arxiv/http.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';

const atomFor=(papers:{id:string;title?:string}[],start=0)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({id,title})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>${title??`Title ${id}`}</title><summary>Abstract ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[])=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>Wed, 07 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_collection_day,arxiv_rss_cache CASCADE`;
const switchesOn=()=>Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});

interface ExceptionRow { resolved_at:Date|null; attempts:number; last_error:string; last_attempt_at:Date|null; http_status:number|null }
const exception=async(id:string)=>(await sql<ExceptionRow[]>`
 SELECT resolved_at,attempts,last_error,last_attempt_at,http_status FROM arxiv_hydration_exceptions
 WHERE arxiv_id=${id} AND resolved_at IS NULL ORDER BY id LIMIT 1`)[0]!;

// Seeds exactly one open 'missing' exception for 2610.05002v1.
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

test('a rate limit during recovery persists the shared hold, counts the attempt and closes nothing',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const limited:typeof fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':'10800'}});
 const result=await refetchHydrationExceptions({fetch:limited,sleep:async()=>{}});
 assert.equal(result.status,'skipped','the durable hold takes over the run');
 assert.equal(result.failureReason,'rate_limited');
 assert.equal(result.recordedExceptionCount,1);
 assert.deepEqual(result.unresolvedIds,['2610.05002v1']);
 const held=(await sql<{owner:string|null;lease_until:Date;db_now:Date}[]>`
  SELECT owner,lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(held.owner,null,'the lease is handed over to the ownerless hold');
 const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
 assert.ok(remaining>21590&&remaining<=21600,
  `a three-hour Retry-After is SHORTER than the floor, so the full six hours are held (${remaining}s)`);
 const row=await exception('2610.05002v1');
 assert.equal(row.resolved_at,null,'a rate limit never fakes a resolution');
 assert.equal(row.attempts,2,'the failed attempt is counted');
 assert.equal(row.http_status,429);
 assert.match(row.last_error,/429/);
 assert.ok(row.last_attempt_at,'the attempt moment is recorded');
 // The hold is shared: ordinary collection skips without a request...
 const skipped=await collectAndStoreArxiv({fetch:async()=>{throw new Error('the hold must block ordinary collection');},sleep:async()=>{},now:()=>new Date('2026-10-07T13:00:00Z')});
 assert.equal(skipped!.status,'skipped');
 // ... and so does a later recovery.
 const again=await refetchHydrationExceptions({fetch:async()=>{throw new Error('the hold must block recovery too')}});
 assert.equal(again.status,'skipped');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,2,'a hold stores nothing');
});

test('a timeout or an HTTP 5xx during recovery is counted, bounded and never resolves',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const timedOut=await refetchHydrationExceptions({fetch:async()=>{throw new Error('arXiv request timed out after 90000ms');},sleep:async()=>{}});
 assert.equal(timedOut.status,'failed');
 assert.equal(timedOut.failureReason,'timeout');
 assert.equal(timedOut.recordedExceptionCount,1);
 assert.deepEqual(timedOut.unresolvedIds,['2610.05002v1']);
 let row=await exception('2610.05002v1');
 assert.equal(row.resolved_at,null);
 assert.equal(row.attempts,2);
 assert.match(row.last_error,/timed out/);
 const unavailable=await refetchHydrationExceptions({fetch:async()=>new Response('unavailable',{status:503}),sleep:async()=>{}});
 assert.equal(unavailable.status,'failed');
 assert.equal(unavailable.failureReason,'http_error');
 row=await exception('2610.05002v1');
 assert.equal(row.attempts,3,'a 5xx is an attempt like any other, not a silent no-op');
 assert.equal(row.http_status,503);
 assert.equal(row.resolved_at,null);
 // The attempt cap is what bounds the loop: with three spent attempts nothing is selected any more.
 const capped=await refetchHydrationExceptions({maxAttempts:3,fetch:async()=>{throw new Error('the cap must stop the retry');}});
 assert.equal(capped.status,'idle');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,2,'a failed recovery stores nothing');
});

test('a version mismatch during recovery is rejected, counted and kept as offline evidence',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const mismatched:typeof fetch=async input=>{
  const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
  return new Response(atomFor(ids.map(id=>({id:`${id.replace(/v\d+$/,'')}v2`}))));
 };
 const result=await refetchHydrationExceptions({fetch:mismatched,sleep:async()=>{}});
 assert.equal(result.status,'failed');
 assert.equal(result.failureReason,'version_mismatch');
 assert.match(result.message!,/requested v1, received v2/);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,2,'the untrustworthy batch stores nothing');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_batches`)[0]!.n,2,'and archives no new batch');
 const row=await exception('2610.05002v1');
 assert.equal(row.resolved_at,null);
 assert.equal(row.attempts,2);
 assert.match(row.last_error,/version mismatch/);
 const rejection=(await sql<{kind:string;arxiv_ids:string[];detail:string;findings:{requestedVersion:number;receivedVersion:number}[];http_status:number;raw_response_excerpt:string}[]>`
  SELECT kind,arxiv_ids,detail,findings,http_status,raw_response_excerpt FROM arxiv_hydration_rejections`)[0]!;
 assert.equal(rejection.kind,'version_mismatch');
 assert.deepEqual(rejection.arxiv_ids,['2610.05002v1']);
 assert.match(rejection.detail,/requested v1, received v2/);
 assert.deepEqual(rejection.findings.map(f=>[f.requestedVersion,f.receivedVersion]),[[1,2]],'the versions are queryable, not only readable');
 assert.equal(rejection.http_status,200);
 assert.ok(rejection.raw_response_excerpt.includes('2610.05002v2'),'the rejected document stays readable offline');
});

test('a same-version content conflict during recovery is rolled back, counted and recorded as evidence',async()=>{
 await clean();
 switchesOn();
 const stored=atomFor([{id:'2610.06001v1',title:'Stored title'}]);
 await ingestHydratedArxivBatch({
  page:{raw_atom:stored,papers:parseArxivAtom(stored),collected_at_utc:'2026-10-07T10:00:00Z'},
  requestedIds:['2610.06001v1'],acceptedIds:['2610.06001v1'],exceptions:[],
  meta:{httpStatus:200,headers:{},pagination:{},durationMs:1},
 });
 await sql`INSERT INTO arxiv_hydration_exceptions(arxiv_id,base_id,version,kind) VALUES('2610.06001v1','2610.06001',1,'missing')`;
 const drifted=atomFor([{id:'2610.06001v1',title:'Drifted title'}]);
 const result=await refetchHydrationExceptions({fetch:async()=>new Response(drifted),sleep:async()=>{}});
 assert.equal(result.status,'failed');
 assert.equal(result.failureReason,'content_conflict');
 assert.equal((await sql`SELECT metadata->>'title_original' AS title FROM arxiv_raw_papers WHERE arxiv_id='2610.06001v1'`)[0]!.title,'Stored title','the stored version is never overwritten');
 const rejection=(await sql<{kind:string;detail:string}[]>`SELECT kind,detail FROM arxiv_hydration_rejections`)[0]!;
 assert.equal(rejection.kind,'content_conflict');
 assert.match(rejection.detail,/raw feed conflict/);
 const row=await exception('2610.06001v1');
 assert.equal(row.resolved_at,null);
 assert.equal(row.attempts,2,'the rolled-back attempt is still counted so the retry stays bounded');
});

test('a lease lost while the refetch is in flight is neither an upstream failure nor a spent retry',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 assert.equal(before.attempts,1,'the missing version starts with one recorded attempt');
 const thief='00000000-0000-4000-8000-000000000006';
 let dispatched=false;
 let cancelledReason:unknown;
 let entered:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const fake:typeof fetch=async(_input,init)=>{
  dispatched=true;
  entered();
  const signal=init?.signal;
  assert.ok(signal,'the transport is given the run signal');
  await new Promise<void>(resolve=>{
   if(signal!.aborted) return resolve();
   signal!.addEventListener('abort',()=>{cancelledReason=signal!.reason;resolve();},{once:true});
  });
  throw new Error('the refetch was cancelled by the takeover');
 };
 // The transport deadline is deliberately short so a cancellation coming from the deadline rather than
 // from the lease cannot pass as a lease cancellation.
 const run=refetchHydrationExceptions({fetch:fake,sleep:async()=>{},minIntervalMs:0,leaseHeartbeatMs:20,timeoutMs:3000});
 await Promise.race([started,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('the refetch never reached the network')),5000))]);
 // The channel changes hands while the request is still open: the renewal is refused, so the run is
 // cancelled, and what it observed belongs to nobody. The new owner will re-request this version.
 await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
 const result=await run;
 assert.equal(dispatched,true,'the request really was dispatched before the takeover');
 assert.ok(cancelledReason instanceof ArxivLeaseLostError,
  `the in-flight request was cancelled by the lease it belonged to (${String(cancelledReason)})`);
 assert.equal(result.status,'failed');
 assert.equal(result.failureReason,'lease_lost','a takeover is reported as itself, not as a transport failure');
 assert.equal(result.recordedExceptionCount,0,'a cancelled refetch spends no retry');
 assert.deepEqual(result.unresolvedIds,['2610.05002v1'],'the version stays retryable for whoever owns the channel now');
 const after=await exception('2610.05002v1');
 assert.equal(after.attempts,1,'the shared retry budget is untouched');
 assert.equal(after.last_error,before.last_error,'nor does a stale owner rewrite why the exception is carried');
 assert.equal(after.resolved_at,null);
});

test('a Retry-After longer than six hours lengthens the shared hold during recovery too',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const limited:typeof fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':'28800'}});
 const result=await refetchHydrationExceptions({fetch:limited,sleep:async()=>{}});
 assert.equal(result.status,'skipped','the durable hold takes over the run');
 const held=(await sql<{owner:string|null;lease_until:Date;db_now:Date}[]>`
  SELECT owner,lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(held.owner,null);
 const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
 assert.ok(remaining>28790&&remaining<=28800,`eight hours of Retry-After are honoured, not trimmed to six (${remaining}s)`);
});

test('a renewal the database cannot answer is an unconfirmed control-plane failure, never an upstream one',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 // A PURE renewal — owner unchanged, only the term extended — is refused by the database. That is not a
 // confirmed takeover: the row may well still be ours and the database simply unable to answer. But the
 // run cannot show it holds the channel, so it stops, and it stops as a control-plane failure: nothing it
 // saw may be counted against the shared retry budget, whichever way the task happened to end.
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_renewal() RETURNS trigger AS $$
  BEGIN
   IF NEW.owner IS NOT DISTINCT FROM OLD.owner AND NEW.lease_until IS DISTINCT FROM OLD.lease_until
    THEN RAISE EXCEPTION 'renewal refused by the harness'; END IF;
   RETURN NEW;
  END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_renewal ON arxiv_collection_state`;
 await sql`CREATE TRIGGER arxiv_test_block_renewal BEFORE UPDATE ON arxiv_collection_state
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_renewal()`;
 try {
  const result=await refetchHydrationExceptions({
   fetch:async()=>{throw new Error('no request may be dispatched on an unconfirmed lease');},
  });
  assert.equal(result.status,'failed');
  assert.equal(result.failureReason,'lease_unconfirmed','a database that cannot answer is not a confirmed takeover');
  assert.equal(result.recordedExceptionCount,0,'a control-plane failure never spends a retry');
  assert.deepEqual(result.unresolvedIds,['2610.05002v1']);
  const after=await exception('2610.05002v1');
  assert.equal(after.attempts,before.attempts,'the shared budget is untouched');
  assert.equal(after.last_error,before.last_error,'and the reason the exception carries is untouched');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_rejections`)[0]!.n,0,
   'nothing was dispatched, so there is no upstream failure to record');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_renewal ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_renewal()`;
 }
 // The control plane is healthy again: the same entry classifies an upstream failure as one.
 const recovered=await refetchHydrationExceptions({
  fetch:async()=>{throw new Error('arXiv request timed out after 90000ms');},sleep:async()=>{},
 });
 assert.equal(recovered.failureReason,'timeout','with a working renewal the upstream failure is classified as itself');
 assert.equal((await exception('2610.05002v1')).attempts,before.attempts+1);
});

test('an upstream failure observed just before a takeover still keeps its own evidence',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 const thief='00000000-0000-4000-8000-000000000010';
 // The request really is dispatched and really fails upstream, and the channel changes hands inside that
 // same request — after the answer, before this run can record what it saw. The shared retry budget must
 // stay untouched, because the answer belongs to whoever holds the lease now... but the failure this run
 // really observed is evidence, and it must not disappear just because the budget write was refused.
 const fake:typeof fetch=async()=>{
  await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
  throw new Error('arXiv request timed out after 90000ms');
 };
 const result=await refetchHydrationExceptions({fetch:fake,sleep:async()=>{},minIntervalMs:0});
 assert.equal(result.status,'failed');
 assert.equal(result.failureReason,'lease_lost','the budget write is refused as the takeover it was');
 assert.equal(result.recordedExceptionCount,0);
 const after=await exception('2610.05002v1');
 assert.equal(after.attempts,before.attempts,'the budget the new owner needs is not spent');
 assert.equal(after.last_error,before.last_error);
 const rejection=(await sql<{kind:string;detail:string;duration_ms:number}[]>`
  SELECT kind,detail,duration_ms FROM arxiv_hydration_rejections ORDER BY id DESC LIMIT 1`)[0]!;
 assert.equal(rejection.kind,'transport','the failure this run really saw is kept as its own evidence');
 assert.match(rejection.detail,/timed out/);
 assert.ok(rejection.duration_ms>=0,'and it carries the timing of the request that produced it');
});

test('a takeover after the answer refuses the budget write instead of counting a stale attempt',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 // The answer is a version mismatch — a real failure this run would normally count and record. The
 // channel changes hands inside the request, after the answer is already on its way back, so the
 // heartbeat never observes it: only the ownership check inside the budget write itself can refuse it.
 const thief='00000000-0000-4000-8000-000000000008';
 const mismatched:typeof fetch=async input=>{
  const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
  await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
  return new Response(atomFor(ids.map(id=>({id:`${id.replace(/v\d+$/,'')}v2`}))));
 };
 const result=await refetchHydrationExceptions({fetch:mismatched,sleep:async()=>{},minIntervalMs:0});
 assert.equal(result.status,'failed');
 assert.equal(result.failureReason,'lease_lost','the stale answer is refused as a takeover, not counted as a version mismatch');
 assert.equal(result.recordedExceptionCount,0);
 const after=await exception('2610.05002v1');
 assert.equal(after.attempts,before.attempts,'the shared retry budget is not moved by a run that no longer owns the channel');
 assert.equal(after.last_error,before.last_error,'nor is the reason an exception is carrying');
 // The rejection itself is append-only diagnostics that no scheduling decision reads, so keeping it
 // costs nothing — and it is exactly the offline evidence an operator needs to review the batch.
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_rejections`)[0]!.n,1);
});

test('a 429 that travels with a takeover is not allowed to disappear, and no successor lease is stolen',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 const thief='00000000-0000-4000-8000-000000000011';
 // The request really is answered with a 429, and the channel changes hands while that answer is still
 // in flight — so the heartbeat sees the takeover first and the run ends as a CONTROL-PLANE failure
 // that carries the 429 as its cause. Round 6 returned that failure directly, which threw the 429 away.
 // A 429 is a fact about arXiv, not about this run's lease: the hold must still be attempted, and when
 // somebody else owns the row it may not be taken over — but the missing pause must be reported, not
 // silently folded into the takeover.
 const limited:typeof fetch=async()=>{
  await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
  await new Promise(resolve=>setTimeout(resolve,200));
  return new Response('rate limited',{status:429,headers:{'retry-after':'60'}});
 };
 let rejection:unknown;
 try {
  await refetchHydrationExceptions({fetch:limited,sleep:async()=>{},minIntervalMs:0,leaseHeartbeatMs:20});
  assert.fail('the run must not report a clean result');
 } catch(error) { rejection=error; }
 assert.ok(findArxivHttpError(rejection,429),'the real 429 survives the takeover it travelled with');
 assert.match(String(rejection),/cooldown could not be committed/,
  'and the pause it demanded is reported as a fact of its own rather than dropped');
 const held=(await sql<{owner:string|null}[]>`
  SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(held.owner,thief,'the successor keeps its lease: the old owner never takes it over');
 const after=await exception('2610.05002v1');
 assert.equal(after.attempts,before.attempts,'and it never spends the budget the new owner needs');
});

test('a 429 still freezes the channel when the failure evidence itself cannot be written',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 // The rejection table refuses every insert. That table is append-only diagnostics and gates nothing,
 // so a database that cannot store it must not be able to stop the 429 from becoming the shared hold —
 // which is exactly the order round 6 got wrong: the diagnostic ran first, and its failure aborted the
 // catch before the hold was ever attempted.
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_rejection() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'rejection evidence refused by the harness'; END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_rejection ON arxiv_hydration_rejections`;
 await sql`CREATE TRIGGER arxiv_test_block_rejection BEFORE INSERT ON arxiv_hydration_rejections
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_rejection()`;
 try {
  const limited:typeof fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':'7200'}});
  const result=await refetchHydrationExceptions({fetch:limited,sleep:async()=>{}});
  assert.equal(result.status,'skipped','the 429 is still handled as the shared hold it is');
  assert.equal(result.failureReason,'rate_limited');
  assert.equal(result.recordedExceptionCount,1,'the attempt is still counted, so the retry stays bounded');
  const held=(await sql<{owner:string|null;lease_until:Date;db_now:Date}[]>`
   SELECT owner,lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  assert.equal(held.owner,null,'the durable hold was written even though the evidence could not be');
  const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
  assert.ok(remaining>21590&&remaining<=21600,`the full six-hour floor (${remaining}s)`);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_rejections`)[0]!.n,0,
   'and the evidence really did not get written, so the case above is the one under test');
  const blocked=await collectAndStoreArxiv({fetch:async()=>{throw new Error('the hold must block the next run');}});
  assert.equal(blocked!.status,'skipped','the hold really took the channel over');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_rejection ON arxiv_hydration_rejections`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_rejection()`;
 }
});

test('a 429 that arrives just as the channel changes hands reports both facts instead of folding them into one',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 const thief='00000000-0000-4000-8000-000000000012';
 // The answer is a 429 and the channel changes hands inside that same request — after the dispatch
 // guard let it through, and before this run can act on what it saw. So the failure is an ordinary
 // UPSTREAM one (the heartbeat never got a chance to observe the takeover) and it is the ownership
 // check INSIDE the budget write that refuses it. Round 6 returned that refusal directly, which meant
 // the hold the 429 demanded was never even attempted, and the missing pause disappeared into a plain
 // "lease lost" report. The pause is a fact about arXiv, so both facts have to survive.
 const limited:typeof fetch=async()=>{
  await sql`UPDATE arxiv_collection_state SET owner=${thief}::uuid WHERE key='astro-ph'`;
  return new Response('rate limited',{status:429,headers:{'retry-after':'60'}});
 };
 let rejection:unknown;
 try {
  await refetchHydrationExceptions({fetch:limited,sleep:async()=>{},minIntervalMs:0});
  assert.fail('the run must not report a clean result');
 } catch(error) { rejection=error; }
 assert.ok(rejection instanceof AggregateError,'both facts are reported together');
 assert.ok(findArxivHttpError(rejection,429),'the real 429 is one of them');
 assert.match(String(rejection),/cooldown could not be committed/,'and the pause it demanded is the other');
 const held=(await sql<{owner:string|null}[]>`
  SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(held.owner,thief,'the successor keeps its lease: the hold never takes it over');
 const after=await exception('2610.05002v1');
 assert.equal(after.attempts,before.attempts,'and the budget the new owner needs is not spent');
});

test('a hold that fails while the budget write succeeds is a failure, not a clean skip',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 const before=await exception('2610.05002v1');
 // Both hold writes are refused — the owner-conditioned one AND the conservative fallback, which would
 // also have to clear the owner — so the pause really cannot be made durable. The BUDGET write lives in
 // another table and is left alone. That is exactly the shape round 7 found: the attempt IS counted, so
 // the run walked past every failure branch and reached the plain-429 exit, where it returned
 // "skipped" and handed back a `nextEligibleAt` read from a row that held nothing but the plain lease.
 // A skip is what an operator reads as "a durable pause is in force"; there was none.
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_hold() RETURNS trigger AS $$
  BEGIN
   IF OLD.owner IS NOT NULL AND NEW.owner IS NULL
    THEN RAISE EXCEPTION 'hold refused by the harness'; END IF;
   RETURN NEW;
  END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
 await sql`CREATE TRIGGER arxiv_test_block_hold BEFORE UPDATE ON arxiv_collection_state
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_hold()`;
 try {
  const limited:typeof fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':'60'}});
  let rejection:unknown;
  try {
   const result=await refetchHydrationExceptions({fetch:limited,sleep:async()=>{}});
   assert.fail(`the run must not report the pause as established, but returned ${JSON.stringify(result)}`);
  } catch(error) { rejection=error; }
  assert.ok(findArxivHttpError(rejection,429),'the real 429 is still what a caller reads');
  assert.match(String(rejection),/cooldown could not be committed/,
   'the pause that was never established is reported instead of implied');
  assert.match(String(rejection),/Set a durable pause as an operator before collection resumes/,
   'and the operator action it demands is stated, not left to be inferred');
  // The case under test really is "budget written, hold not": the attempt moved, so the run was NOT
  // sent down the budget-refusal branch that would have reported the takeover instead.
  const after=await exception('2610.05002v1');
  assert.equal(after.attempts,before.attempts+1,
   'the attempt was counted, which is what used to send this run to the clean-skip exit');
  // And the row proves the pause was never written: it still carries the plain lease, not six hours.
  const held=(await sql<{owner:string|null;lease_until:Date;db_now:Date}[]>`
   SELECT owner,lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  assert.ok(held.owner,'the lease is kept rather than released when the pause could not be persisted');
  const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
  assert.ok(remaining<1000,`the durable hold really was NOT written (${remaining}s left, not six hours)`);
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_hold()`;
 }
});

test('a 429 whose hold AND budget both fail keeps both facts and the operator duty',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 // Two independent writes fail in the same run. Round 7 kept only the budget failure here, so the
 // record an operator would read was missing the half that says no pause was persisted — the very fact
 // the six-hour rule depends on.
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_hold() RETURNS trigger AS $$
  BEGIN
   IF OLD.owner IS NOT NULL AND NEW.owner IS NULL
    THEN RAISE EXCEPTION 'hold refused by the harness'; END IF;
   RETURN NEW;
  END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
 await sql`CREATE TRIGGER arxiv_test_block_hold BEFORE UPDATE ON arxiv_collection_state
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_hold()`;
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_budget() RETURNS trigger AS $$
  BEGIN
   IF NEW.attempts > OLD.attempts
    THEN RAISE EXCEPTION 'budget refused by the harness'; END IF;
   RETURN NEW;
  END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_budget ON arxiv_hydration_exceptions`;
 await sql`CREATE TRIGGER arxiv_test_block_budget BEFORE UPDATE ON arxiv_hydration_exceptions
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_budget()`;
 try {
  const limited:typeof fetch=async()=>new Response('rate limited',{status:429,headers:{'retry-after':'60'}});
  let rejection:unknown;
  try {
   const result=await refetchHydrationExceptions({fetch:limited,sleep:async()=>{}});
   assert.fail(`the run must not report success, but returned ${JSON.stringify(result)}`);
  } catch(error) { rejection=error; }
  assert.ok(rejection instanceof AggregateError,'both failures are reported together');
  assert.ok(findArxivHttpError(rejection,429),'the real 429 is one of them');
  assert.match(String(rejection),/recovery budget could not be written/,'the budget failure is reported');
  assert.match(String(rejection),/cooldown could not be committed/,
   'and so is the hold that failed beside it, instead of being dropped for the budget alone');
  assert.match(String(rejection),/Set a durable pause as an operator before collection resumes/,
   'with the operator duty attached to the pair');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_budget ON arxiv_hydration_exceptions`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_budget()`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_hold()`;
 }
});

test('a release that fails after a successful refetch is reported with the refetch, not swallowed',async()=>{
 await clean();
 switchesOn();
 await seedMissing();
 // The recovery entry used to end with `releaseCollection(lease).catch(() => {})`: the run kept its
 // result, but a cleanup that never happened left no trace at all, and the recovery script prints only
 // that result — so a caller saw a clean "refetched" with the channel still held by a lease that had
 // not been handed back.
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_release() RETURNS trigger AS $$
  BEGIN
   IF OLD.owner IS NOT NULL AND NEW.owner IS NULL AND NEW.lease_until IS NULL
    THEN RAISE EXCEPTION 'release refused by the harness'; END IF;
   RETURN NEW;
  END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_release ON arxiv_collection_state`;
 await sql`CREATE TRIGGER arxiv_test_block_release BEFORE UPDATE ON arxiv_collection_state
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_release()`;
 try {
  const recovered=await refetchHydrationExceptions({sleep:async()=>{},fetch:async input=>{
   const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
   return new Response(atomFor(ids.map(id=>({id}))));
  }});
  assert.equal(recovered.status,'refetched','the refetch still reports its own outcome');
  assert.equal(recovered.resolvedExceptionCount,1,'and the version it really stored is still counted');
  const cleanup=(recovered as {cleanupFailure?:string}).cleanupFailure;
  assert.ok(cleanup!==undefined,'the cleanup that did not happen is stated rather than dropped');
  assert.match(cleanup!,/release refused by the harness/,'and it is the real failure, not a placeholder');
  const held=(await sql<{owner:string|null}[]>`
   SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  assert.ok(held.owner,'the release really was refused, so this is the case under test');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_release ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_release()`;
 }
});

test.after(async()=>{await closeDb();});
