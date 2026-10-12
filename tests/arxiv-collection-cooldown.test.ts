import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { collectAndStoreArxiv } from '../packages/backend/src/arxiv/collect-job.ts';
import { findArxivHttpError } from '../packages/backend/src/arxiv/http.ts';

const rss='<rss version="2.0"><channel><title>astro-ph</title></channel></rss>';
const atom='<feed xmlns="http://www.w3.org/2005/Atom" xmlns:os="http://a9.com/-/spec/opensearch/1.1/"><os:totalResults>0</os:totalResults><os:startIndex>0</os:startIndex><os:itemsPerPage>100</os:itemsPerPage></feed>';
const now=()=>new Date();
const row=async()=> (await sql`SELECT *,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;

/**
 * Runs one snippet in a genuinely NEW node process. `spawnSync` is refused by the test sandbox
 * (EBUSY), which silently left the "the hold survives a restart" claim unverified, so the child is
 * spawned asynchronously and awaited here instead.
 */
function runChild(source: string, timeoutMs = 30000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timed out')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

for (const stage of ['rss','metadata','hydration'] as const) {
  test(`${stage} HTTP429 persists a six-hour admission hold across retries and process restart without AI`,async()=>{
    process.env.COLLECT_ENABLED='true'; process.env.ARXIV_NATIVE_COLLECT_ENABLED='true';
    await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches,arxiv_raw_papers,arxiv_raw_batches CASCADE`;
    if(stage==='hydration' || stage==='rss') {
      const {ingestArxivAnnouncements}=await import('../packages/backend/src/arxiv/announcements.ts');
      const day=new Date().toUTCString().replace('GMT','+0000');
      await ingestArxivAnnouncements(`<rss version="2.0" xmlns:a="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title><item><guid>oai:arXiv.org:2610.99999v1</guid><link>https://arxiv.org/abs/2610.99999</link><category>astro-ph.CO</category><a:announce_type>new</a:announce_type><pubDate>${day}</pubDate></item></channel></rss>`,now().toISOString());
    }
    const receiptsBefore=(await sql`SELECT count(*)::int n FROM receipts`)[0]!.n;
    const hits:string[]=[];
    const limited:typeof fetch=async input=>{
      const url=new URL(String(input)); hits.push(url.href);
      if ((stage==='rss' && url.hostname==='rss.arxiv.org') || (stage==='metadata' && url.hostname==='export.arxiv.org') || (stage==='hydration' && url.searchParams.has('id_list'))) return new Response('rate limited',{status:429});
      return new Response(url.hostname==='rss.arxiv.org'?rss:atom);
    };
    await assert.rejects(collectAndStoreArxiv({fetch:limited,now,sleep:async()=>{}}),/HTTP 429/);
    assert.equal(hits.length,stage==='rss'?1:2,'429 aborts all remaining requests');
    const held=await row();
    assert.equal(held.owner,null);
    const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
    assert.ok(remaining>21590 && remaining<=21600,`durable hold ${remaining}s`);
    assert.equal(held.completed_through,null);
    const heldCursor={from:held.window_from,through:held.window_through,start:held.next_start,total:held.expected_total,seen:held.seen_ids};
    const forbidden:typeof fetch=async()=>{throw new Error('network forbidden during cooldown');};
    for(let i=0;i<3;i++) {
      const skipped=await collectAndStoreArxiv({fetch:forbidden,now});
      assert.equal(skipped!.status,'skipped');
      assert.equal(skipped!.complete,false);
    }
    // The restart is a REAL second process: the durable hold has to survive a boot with no in-memory
    // state at all. It is spawned asynchronously — a synchronous child is refused by the test
    // sandbox, which would leave this claim unverified rather than failing it.
    const child = await runChild(
      `import {collectAndStoreArxiv} from './packages/backend/src/arxiv/collect-job.ts'; import {closeDb} from './packages/backend/src/db.ts'; try { const r=await collectAndStoreArxiv({fetch:async()=>{throw Error('child network forbidden')}}); if(r.status!=='skipped') throw Error('not skipped'); console.log('restart persisted skip'); } finally {await closeDb();}`,
    );
    assert.equal(child.code, 0, child.stderr); assert.match(child.stdout, /restart persisted skip/);
    const after=await row();
    assert.equal(new Date(after.lease_until).getTime(),new Date(held.lease_until).getTime(),'skips never slide the hold');
    assert.deepEqual({from:after.window_from,through:after.window_through,start:after.next_start,total:after.expected_total,seen:after.seen_ids},heldCursor);
    if(stage==='hydration' || stage==='rss') await sql`TRUNCATE arxiv_announcements,arxiv_announcement_batches CASCADE`;
    // The first attempt already cached this UTC day's feed; drop it so the resumed run really issues
    // both the RSS and the metadata request.
    await sql`DELETE FROM arxiv_rss_cache`;
    await sql`UPDATE arxiv_collection_state SET lease_until=clock_timestamp()-interval '1 second' WHERE key='astro-ph'`;
    const resumed:string[]=[];
    const good:typeof fetch=async input=>{const url=new URL(String(input));resumed.push(url.href);return new Response(url.hostname==='rss.arxiv.org'?rss:atom);};
    const result=await collectAndStoreArxiv({fetch:good,now,sleep:async()=>{}});
    assert.equal(result!.complete,true); assert.equal(resumed.length,2);
    const completed=await row();assert.equal(completed.owner,null); assert.equal(completed.lease_until,null); assert.ok(completed.completed_through);
    assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,receiptsBefore);
  });
}

test('RSS and each metadata request independently default to 90 seconds',async t=>{
  process.env.COLLECT_ENABLED='true';process.env.ARXIV_NATIVE_COLLECT_ENABLED='true';
  await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches CASCADE`;
  const durations:number[]=[];
  const native=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',((fn: Parameters<typeof setTimeout>[0],ms?:number,...args:unknown[])=>{
    durations.push(ms!);return native(fn,ms,...args);
  }) as typeof setTimeout);
  const fake:typeof fetch=async input=>new Response(new URL(String(input)).hostname==='rss.arxiv.org'?rss:atom);
  assert.equal((await collectAndStoreArxiv({fetch:fake,sleep:async()=>{}}))!.complete,true);
  // Exactly the two bounded, fail-closed timers of the lease control plane sit below 90 s (the dispatch
  // guard's 5 s and the renewal's 30 s), so the transport deadline is asserted by value rather than by a
  // range: a range would quietly absorb them.
  assert.deepEqual(durations.filter(ms=>ms===90000),[90000,90000]);
});
test('non-429 failure does not persist a cooldown',async()=>{
  await sql`TRUNCATE arxiv_collection_state CASCADE`;
  const fake:typeof fetch=async()=>new Response('unavailable',{status:503});
  await assert.rejects(collectAndStoreArxiv({fetch:fake,sleep:async()=>{}}),/HTTP 503/);
  const state=await row(); assert.equal(state.owner,null);assert.equal(state.lease_until,null);
});
test('mid-pagination HTTP429 retains a nonzero cursor and resumes exact bounds',async()=>{
  await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches,arxiv_raw_papers,arxiv_raw_batches CASCADE`;
  const receiptsBefore=(await sql`SELECT count(*)::int n FROM receipts`)[0]!.n;
  const page=(start:number)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:os="http://a9.com/-/spec/opensearch/1.1/"><os:totalResults>2</os:totalResults><os:startIndex>${start}</os:startIndex><os:itemsPerPage>1</os:itemsPerPage><entry><id>https://arxiv.org/abs/2610.9000${start}v1</id><title>Synthetic ${start}</title><summary>Synthetic abstract</summary><published>${now().toISOString()}</published><updated>${now().toISOString()}</updated><author><name>Synthetic</name></author><category term="astro-ph.CO"/></entry></feed>`;
  const hits:string[]=[];
  const fake:typeof fetch=async input=>{
    const url=new URL(String(input));hits.push(url.href);
    return url.hostname==='rss.arxiv.org'?new Response(rss):Number(url.searchParams.get('start'))===0?new Response(page(0)):new Response('',{status:429});
  };
  await assert.rejects(collectAndStoreArxiv({fetch:fake,pageSize:1,sleep:async()=>{}}),/HTTP 429/);
  assert.equal(hits.length,3);
  const held=await row();assert.equal(held.next_start,1);assert.equal(held.expected_total,2);assert.deepEqual(held.seen_ids,['2610.90000v1']);
  const skipped=await collectAndStoreArxiv({fetch:async()=>{throw Error('forbidden')},pageSize:1});assert.equal(skipped!.status,'skipped');
  // Drop the cached feed of this UTC day so the resumed run issues the RSS request its assertion expects.
  await sql`DELETE FROM arxiv_rss_cache`;
  await sql`UPDATE arxiv_collection_state SET lease_until=clock_timestamp()-interval '1 second' WHERE key='astro-ph'`;
  const resumed:string[]=[];
  const good:typeof fetch=async input=>{const url=new URL(String(input));resumed.push(url.href);return new Response(url.hostname==='rss.arxiv.org'?rss:page(Number(url.searchParams.get('start'))));};
  assert.equal((await collectAndStoreArxiv({fetch:good,pageSize:1,sleep:async()=>{}}))!.complete,true);
  const api=new URL(resumed[1]!);assert.equal(api.searchParams.get('start'),'1');assert.ok(api.searchParams.get('search_query')!.includes(`${held.window_from} TO ${held.window_through}`));
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,2);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,receiptsBefore);
});
test('a 429 whose durable request watermark cannot be written keeps both facts and still freezes the channel',async()=>{
 await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches CASCADE`;
 // The database refuses ONLY the request watermark — a pure `last_request_at` update — which is exactly
 // the cleanup step that used to replace the request error on its way out of the finally block. The
 // lease itself is untouched, so the 429 still reaches the hold branch.
 await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_watermark() RETURNS trigger AS $$
  BEGIN
   IF NEW.last_request_at IS DISTINCT FROM OLD.last_request_at
    THEN RAISE EXCEPTION 'watermark refused by the harness'; END IF;
   RETURN NEW;
  END $$ LANGUAGE plpgsql`;
 await sql`DROP TRIGGER IF EXISTS arxiv_test_block_watermark ON arxiv_collection_state`;
 await sql`CREATE TRIGGER arxiv_test_block_watermark BEFORE UPDATE ON arxiv_collection_state
  FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_watermark()`;
 try {
  const limited:typeof fetch=async input=>new URL(String(input)).hostname==='rss.arxiv.org'
   ? new Response('rate limited',{status:429}) : new Response(atom);
  let rejection:unknown;
  try {
   await collectAndStoreArxiv({fetch:limited,sleep:async()=>{}});
   assert.fail('the run must not report success');
  } catch(error) { rejection=error; }
  // Both facts are still there: the 429 the request really got, and the watermark that could not be
  // written. Neither replaced the other, so nothing was hidden by the cleanup failure.
  assert.ok(rejection instanceof AggregateError,'the two failures are reported together');
  assert.ok(findArxivHttpError(rejection,429),'the 429 survives the wrapping and can still be classified');
  assert.match(String((rejection as AggregateError).errors[1]),/watermark refused by the harness/);
  // And the 429 control semantics were not lost: the shared six-hour hold really was established.
  const held=(await sql<{owner:string|null;lease_until:Date;db_now:Date}[]>`
   SELECT owner,lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  assert.equal(held.owner,null,'the hold was written even though the watermark was not');
  const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
  assert.ok(remaining>21590&&remaining<=21600,`the full six-hour floor (${remaining}s)`);
  // The run stopped, and the next entry is refused without touching the network.
  const blocked=await collectAndStoreArxiv({fetch:async()=>{throw new Error('the hold must block the next run');}});
  assert.equal(blocked!.status,'skipped');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_watermark ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_watermark()`;
 }
});

test('a 429 whose hold cannot be persisted at all reports both failures and never pretends there is no pause',async()=>{
 const {claimCollection}=await import('../packages/backend/src/arxiv/collection-state.ts');
 await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches CASCADE`;
 // Every handover to an ownerless hold is refused — the owner-conditioned write AND the conservative
 // fallback — so the pause really cannot be made durable.
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
  const limited:typeof fetch=async input=>new URL(String(input)).hostname==='rss.arxiv.org'
   ? new Response('rate limited',{status:429}) : new Response(atom);
  let rejection:unknown;
  try {
   await collectAndStoreArxiv({fetch:limited,sleep:async()=>{}});
   assert.fail('the run must not report success');
  } catch(error) { rejection=error; }
  // Fail closed, and on BOTH counts: the 429 that really happened stays visible, and so does the failure
  // to persist the pause it demanded.
  assert.ok(findArxivHttpError(rejection,429),'the real 429 is still part of the report');
  assert.match(String(rejection),/durable cooldown commit failed/,'the persistence failure is reported explicitly');
  // The one thing this run cannot do is MAKE the pause durable, so the report says who has to: leaving
  // it at "commit failed" would let an operator read the run as self-healing. The required action is
  // part of the failure, and both entries share the same wording for it.
  assert.match(String(rejection),/Set a durable pause as an operator before collection resumes/,
   'the operator action the failed hold demands is stated, not implied');
  // The one state the run was NOT entitled to assume is "no pause was needed": the lease must therefore
  // be left in place rather than released, so the next entry is refused instead of admitted.
  const state=(await sql<{owner:string|null;lease_until:Date|null}[]>`
   SELECT owner,lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
  assert.ok(state.owner,'the lease is left owned instead of being cleared into "no hold"');
  assert.ok(state.lease_until,'and its term is left in place');
  await assert.rejects(claimCollection(now()),/busy/,'the next entry is refused rather than told the channel is free');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_hold ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_hold()`;
 }
});

test('a hold never shortens an existing longer pause, and the conservative fallback neither steals nor clears it',async()=>{
 const {claimCollectionLease,deferRateLimitedCollection,holdCollectionConservatively,releaseCollection}=
  await import('../packages/backend/src/arxiv/collection-state.ts');
 await sql`TRUNCATE arxiv_collection_state CASCADE`;
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as {key:string;owner:string};
 // An operator's manual pause, longer than the 429 floor, is already in the term.
 await sql`UPDATE arxiv_collection_state SET lease_until=clock_timestamp()+interval '30 hours' WHERE key='astro-ph'`;
 const manual=(await sql<{lease_until:Date}[]>`SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 await deferRateLimitedCollection(lease,60);
 const afterLimit=(await sql<{owner:string|null;lease_until:Date}[]>`
  SELECT owner,lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(afterLimit.owner,null,'the lease is handed to the ownerless hold');
 assert.equal(new Date(afterLimit.lease_until).getTime(),new Date(manual.lease_until).getTime(),
  'a shorter Retry-After never shortens a longer pause that was already in place');
 assert.equal(await holdCollectionConservatively(lease),true,'the conservative fallback extends the existing pause');
 const afterConservative=(await sql<{lease_until:Date}[]>`
  SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(new Date(afterConservative.lease_until).getTime(),new Date(manual.lease_until).getTime(),
  'the conservative floor only ever extends, never shortens');
 // And it never steals a successor's lease.
 const successor=await claimCollectionLease();
 assert.equal((successor as {status?:string}).status,'skipped','the active pause still keeps everybody out');
 await sql`UPDATE arxiv_collection_state SET lease_until=clock_timestamp()-interval '1 second' WHERE key='astro-ph'`;
 const fresh=await claimCollectionLease();
 assert.ok(!('status' in fresh),'once the pause expires the channel is admitted again');
 assert.equal(await holdCollectionConservatively(lease as {key:string;owner:string}),false,
  'the old owner cannot clear or take over the successor it no longer is');
 await releaseCollection(fresh as {key:string;owner:string});
 assert.equal((await sql<{owner:string|null}[]>`SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!.owner,null,
  'the successor can still release its own lease');
});

test('cooldown CAS and ordinary release cannot corrupt a successor or clear a hold',async()=>{
  const {claimCollection,deferRateLimitedCollection,releaseCollection}=await import('../packages/backend/src/arxiv/collection-state.ts');
  await sql`TRUNCATE arxiv_collection_state CASCADE`;
  const first=await claimCollection(now());assert.ok(!('status' in first));
  await assert.rejects(claimCollection(now()),/busy/);
  await sql`UPDATE arxiv_collection_state SET lease_until=clock_timestamp()-interval '1 second' WHERE key='astro-ph'`;
  const successor=await claimCollection(now());assert.ok(!('status' in successor));
  await assert.rejects(deferRateLimitedCollection(first),/lease lost/);
  await releaseCollection(first);assert.equal((await row()).owner,successor.owner);
  await deferRateLimitedCollection(successor);const held=await row();
  await releaseCollection(successor);assert.equal(new Date((await row()).lease_until).getTime(),new Date(held.lease_until).getTime());
});
test('the conservative fallback carries the source deadline, so a refused primary hold cannot quietly truncate a long Retry-After',async()=>{
 const {claimCollectionLease,deferRateLimitedCollection,holdCollectionConservatively}=
  await import('../packages/backend/src/arxiv/collection-state.ts');
 await sql`TRUNCATE arxiv_collection_state CASCADE`;
 const admission=await claimCollectionLease();
 assert.ok(!('status' in admission),'a fresh channel is admitted');
 const lease=admission as {key:string;owner:string};
 // The owner-conditioned write can no longer match — the row is ownerless — so ONLY the conservative
 // fallback can run. That is exactly the situation the fallback exists for, and the deadline it writes
 // has to be the one the source asked for, not the six-hour floor it would otherwise fall back to.
 await sql`UPDATE arxiv_collection_state SET owner=NULL,lease_until=clock_timestamp()-interval '1 second' WHERE key='astro-ph'`;
 await assert.rejects(deferRateLimitedCollection(lease,72000),/lease lost/,
  'the primary hold is refused, as a taken-over lease would be');
 assert.equal(await holdCollectionConservatively(lease,72000),true,'the fallback commits the hold');
 const held=(await sql<{lease_until:Date;db_now:Date}[]>`
  SELECT lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
 assert.ok(remaining>71900&&remaining<=72000,
  `the fallback keeps the source's own twenty-hour deadline instead of the six-hour floor (${remaining}s)`);
});

test('a release that fails after the run already reported an error keeps both facts instead of replacing the request failure',async()=>{
 // The release is the last cleanup step of a run. An exception thrown from a `finally` block WINS over
 // the one already in flight, so a release that failed after a real 503 would have erased the 503 — and
 // every caller branching on the request's status would have read "database error" instead. The trigger
 // refuses exactly the release shape: owner cleared AND the term cleared with it.
 await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches CASCADE`;
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
  const fake:typeof fetch=async input=>new URL(String(input)).hostname==='rss.arxiv.org'
   ? new Response(rss) : new Response('unavailable',{status:503});
  let rejection:unknown;
  try {
   await collectAndStoreArxiv({fetch:fake,sleep:async()=>{}});
   assert.fail('the run must not report success');
  } catch(error) { rejection=error; }
  assert.ok(rejection instanceof AggregateError,'the request failure and the cleanup failure are reported together');
  assert.ok(findArxivHttpError(rejection,503),'the 503 the run really got is still the failure a caller reads');
  assert.match(String((rejection as AggregateError).errors[1]),/release refused by the harness/,
   'and the release failure is kept as its own fact rather than being dropped');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_release ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_release()`;
 }
});

test('a release that fails after a successful round is reported with the round instead of being swallowed',async()=>{
 // The failure-path half of this was already covered: a release that fails after a real 429 keeps both
 // facts. The success path is the other half, and round 7 found it returning a plain "complete" while
 // the lease had never been handed back — the cleanup error was stored and then discarded, because a
 // `return` from inside the try skips the line that was supposed to re-throw it.
 await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches,arxiv_raw_papers,arxiv_raw_batches CASCADE`;
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
  const fake:typeof fetch=async input=>new Response(new URL(String(input)).hostname==='rss.arxiv.org'?rss:atom);
  const result=await collectAndStoreArxiv({fetch:fake,now,sleep:async()=>{}});
  assert.ok(result,'the round still resolves: a failed cleanup must not replace the round it belongs to');
  assert.equal(result!.complete,true,'and it keeps the outcome it actually earned');
  const cleanup=(result as {cleanupFailure?:string}).cleanupFailure;
  assert.ok(cleanup!==undefined,'the cleanup that did not happen is stated rather than dropped');
  assert.match(cleanup!,/release refused by the harness/,'and it is the real failure, not a placeholder');
  const state=await row();
  assert.ok(state.owner,'the release really was refused, so this is the case under test');
 } finally {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_release ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_release()`;
 }
});

test.after(async()=>{await closeDb();});
