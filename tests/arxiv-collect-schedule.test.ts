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
import {ARXIV_COLLECT_ATTEMPTS_PER_DAY,collectScheduledArxiv,isScheduledSkip} from '../packages/backend/src/arxiv/collection-budget.ts';
import {beginDueCollectionAttempt,finishDueCollectionAttempt} from '../packages/backend/src/arxiv/collection-due.ts';
import type {ScheduledCollectionSkip} from '../packages/backend/src/arxiv/collection-budget.ts';

type Tick = Awaited<ReturnType<typeof collectScheduledArxiv>>;
type CollectRun = Exclude<NonNullable<Tick>, { reason: string }>;
const ran=(value:Tick):CollectRun=>{
 assert.ok(value!==undefined&&!isScheduledSkip(value),'expected the tick to run collection');
 return value as CollectRun;
};
const skipped=(value:Tick)=>{
 assert.ok(value!==undefined&&isScheduledSkip(value),'expected the tick to be skipped');
 return value;
};

const atomFor=(papers:{id:string;title?:string}[],start=0)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({id,title})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>${title??`Title ${id}`}</title><summary>Abstract ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[])=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>Wed, 07 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const clean=()=>sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_collection_day,arxiv_collection_schedule,arxiv_rss_cache CASCADE`;
const at=(stamp:string)=>()=>new Date(stamp);
/** Drive the admission at one explicit instant through the test clock seam. */
const begin=(when:Date)=>beginDueCollectionAttempt({clock:()=>when});
/** The admission takes the channel lease in the same transaction, so a direct-call test hands it back. */
const releaseLease=()=>sql`UPDATE arxiv_collection_state SET owner=NULL,lease_until=NULL WHERE key='astro-ph'`;
const forbidden:typeof fetch=async()=>{throw new Error('no arXiv request is allowed here');};
const day=async(key:string)=>(await sql<{attempts:number;last_outcome:string|null;completed_at:Date|null}[]>`
 SELECT attempts,last_outcome,completed_at FROM arxiv_collection_day WHERE day=${key}::date`)[0]!;

// A feed that answers the hydration request for exactly the IDs it was asked about, and an empty window.
const serving=(feed:()=>string,hits?:string[]):typeof fetch=>async input=>{
 const u=new URL(String(input));
 hits?.push(u.href);
 if(u.hostname==='rss.arxiv.org') return new Response(feed());
 const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
 if(ids.length) return new Response(atomFor(ids.map(id=>({id}))));
 return new Response(atomFor([]));
};

test('the first productive attempt of the UTC day closes the day for the remaining ticks',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const hits:string[]=[];
 const fake=serving(()=>rssFor(['2610.07001v1']),hits);
 const first=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 assert.equal(first.status,'imported');
 assert.equal(first.newContentCount,2,'the new announcement and its hydrated version both count as new content');
 const requestCount=hits.length;
 assert.ok(requestCount>0);
 for(const hour of ['07','13']) assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at(`2026-10-07T${hour}:00:00Z`)})).reason,'completed');
 assert.equal(hits.length,requestCount,'a closed day issues no further request');
 const state=await day('2026-10-07');
 assert.equal(state.attempts,1);
 assert.equal(state.last_outcome,'collected');
 assert.ok(state.completed_at,'a productive attempt stops the day');
});

test('attempts that find nothing new exhaust the UTC day budget and never exceed it',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const hits:string[]=[];
 const empty=serving(()=>rssFor([]),hits);
 for(const hour of ['01','07','13']){
  const run=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at(`2026-10-07T${hour}:00:00Z`)}));
  assert.equal(run.newContentCount,0,'an empty feed and an empty window store nothing new');
  assert.equal((await day('2026-10-07')).last_outcome,'empty');
 }
 const state=await day('2026-10-07');
 assert.equal(state.attempts,ARXIV_COLLECT_ATTEMPTS_PER_DAY);
 assert.equal(state.completed_at,null,'an unproductive day stays open until the budget is gone');
 const requestCount=hits.length;
 assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T19:00:00Z')})).reason,'budget');
 assert.equal(hits.length,requestCount,'a spent budget issues no request');
 // The budget is a UTC-day budget: the next UTC day opens a fresh one.
 const nextDay=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-08T01:00:00Z')}));
 assert.equal(nextDay.newContentCount,0);
 assert.equal((await day('2026-10-08')).attempts,1);
});

test('a retry re-reads the cached feed so an announcement published later that day is not missed',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 let rssFetches=0;
 let feed=rssFor([]);
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org'){rssFetches++;return new Response(feed);}
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(ids.length) return new Response(atomFor(ids.map(id=>({id}))));
  return new Response(atomFor([]));
 };
 const first=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 assert.equal(first.newContentCount,0);
 assert.equal(rssFetches,1);
 assert.equal((await day('2026-10-07')).last_outcome,'empty');
 // arXiv publishes again later that day: the cached (empty) feed must not be replayed.
 feed=rssFor(['2610.08101v1']);
 const retry=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T07:00:00Z')}));
 assert.equal(rssFetches,2,'the retry re-reads the official feed instead of replaying the cached one');
 assert.ok(retry.newContentCount>0,'the later announcement is collected');
 assert.equal(retry.hydrationIngested,1);
 const state=await day('2026-10-07');
 assert.equal(state.attempts,2);
 assert.equal(state.last_outcome,'collected');
 assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T13:00:00Z')})).reason,'completed');
 assert.equal(rssFetches,2);
});

test('a failed attempt leaves the day open for the retry and the retry still runs',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const down:typeof fetch=async()=>{throw new Error('feed down');};
 await assert.rejects(collectScheduledArxiv({fetch:down,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 let state=await day('2026-10-07');
 assert.equal(state.attempts,1);
 assert.equal(state.last_outcome,'failed');
 assert.equal(state.completed_at,null,'a failure never closes the day');
 // A few seconds after the failure — a pg-boss internal retry, a re-delivery or a restart — must not
 // run the collection again: the day is open, but only the next due tick may spend an attempt.
 const tooSoon=skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T01:00:06Z')}));
 assert.equal(tooSoon.reason,'not_due','a re-delivery seconds after the failure is refused');
 assert.equal(tooSoon.nextEligibleAt,'2026-10-07T07:00:00.000Z');
 assert.equal((await day('2026-10-07')).attempts,1,'a refused re-delivery spends no attempt');
 const retry=ran(await collectScheduledArxiv({fetch:serving(()=>rssFor(['2610.09001v1'])),sleep:async()=>{},now:at('2026-10-07T07:00:00Z')}));
 assert.ok(retry.newContentCount>0);
 state=await day('2026-10-07');
 assert.equal(state.attempts,2);
 assert.equal(state.last_outcome,'collected');
 assert.ok(state.completed_at);
});

test('a tick blocked by the durable 429 hold does not spend an attempt of the day',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 await sql`TRUNCATE arxiv_collection_state CASCADE`;
 // Any non-expired ownerless hold, whatever put it there — a 429, an operator's manual pause. This test
 // is about the generic gate, not about how long a 429 holds for; that is asserted where the 429 is
 // really raised (arxiv-collection-cooldown / arxiv-hydration-cache-throttle).
 await sql`INSERT INTO arxiv_collection_state(key,owner,lease_until) VALUES('astro-ph',NULL,clock_timestamp()+interval '2 hours')`;
 const blocked=skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 assert.equal(blocked.status,'skipped','the durable hold blocks the run before it touches the network');
 assert.equal(blocked.reason,'rate_limited','a frozen tick is reported as rate limited, not as a run');
 assert.equal((await day('2026-10-07')).attempts,0,'an attempt that never ran is given back');
});

test('a real 429 freezes the rest of the UTC day for the whole six hours',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const limited:typeof fetch=async()=>new Response('rate limited',{status:429});
 // The 01:00 tick really runs and really gets a 429, so that attempt is spent: the hold is established
 // from the moment the 429 was handled, not from a nominal hour.
 await assert.rejects(collectScheduledArxiv({fetch:limited,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}),/HTTP 429/);
 assert.equal((await day('2026-10-07')).attempts,1);
 const held=(await sql<{owner:string|null;lease_until:Date;db_now:Date}[]>`
  SELECT owner,lease_until,clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(held.owner,null,'the lease is handed over to the ownerless hold');
 const remaining=(new Date(held.lease_until).getTime()-new Date(held.db_now).getTime())/1000;
 assert.ok(remaining>21590&&remaining<=21600,`the hold is the full six hours (${remaining}s)`);
 // The day's remaining ticks are refused without a request and without spending an attempt — a queue
 // retry, a pg-boss re-delivery and a restart all land on the same durable row.
 for(const hour of ['07','13']){
  const blocked=skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at(`2026-10-07T${hour}:00:00Z`)}));
  assert.equal(blocked.reason,'rate_limited',`the ${hour}:00 tick is frozen, not run`);
 }
 assert.equal((await day('2026-10-07')).attempts,1,'a frozen tick spends no attempt');
 const after=(await sql<{lease_until:Date}[]>`SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0]!;
 assert.equal(new Date(after.lease_until).getTime(),new Date(held.lease_until).getTime(),'a refused tick never slides the hold');
});

test('one due instant admits once, and the next attempt waits the whole six hours',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const hits:string[]=[];
 const empty=serving(()=>rssFor([]),hits);
 const first=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 assert.equal(first.newContentCount,0);
 assert.equal((await day('2026-10-07')).attempts,1);
 const issued=hits.length;
 assert.ok(issued>0,'the admitted tick really ran');
 // A duplicate delivery, a restart re-delivery and the queue's own retry all land in the same tick.
 const duplicate=skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T01:00:05Z')}));
 assert.equal(duplicate.reason,'not_due','the tick is already spent');
 assert.equal(duplicate.nextEligibleAt,'2026-10-07T07:00:00.000Z','the next eligible moment is the next tick');
 assert.equal(hits.length,issued,'a rejected tick touches no network');
 assert.equal((await day('2026-10-07')).attempts,1,'a rejected tick spends no attempt');
 // Even one second before the interval is up the call is refused, network untouched.
 assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T06:59:59Z')})).reason,'not_due');
 assert.equal(hits.length,issued);
 assert.equal((await day('2026-10-07')).attempts,1);
 // Exactly one interval later the next scheduled tick is admitted.
 const retry=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T07:00:00Z')}));
 assert.equal(retry.newContentCount,0);
 assert.equal((await day('2026-10-07')).attempts,2);
});

test('two concurrent deliveries of one tick cannot both start a collection',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const hits:string[]=[];
 const empty=serving(()=>rssFor([]),hits);
 const results=await Promise.all([
  collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}),
  collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}),
 ]);
 const running=results.filter((value):value is CollectRun=>value!==undefined&&!isScheduledSkip(value));
 const rejected=results.filter((value):value is ScheduledCollectionSkip=>value!==undefined&&isScheduledSkip(value));
 assert.equal(running.length,1,'exactly one delivery is admitted');
 assert.equal(rejected.length,1);
 assert.equal(rejected[0]!.reason,'not_due');
 assert.equal((await day('2026-10-07')).attempts,1,'the tick is spent exactly once');
});

test('a partial hydration round closes the day once it stored what it could',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const announced=['2610.06201v1','2610.06202v1'];
 const requests:string[]=[];
 const hydration:string[][]=[];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  requests.push(u.href);
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(announced));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(ids.length){hydration.push(ids);return new Response(atomFor(ids.filter(id=>id!=='2610.06201v1').map(id=>({id}))));}
  return new Response(atomFor([]));
 };
 // The supplement's own batch size is the knob that splits the gap list (RSS-U3); pageSize stays 1 so
 // the legacy window page below is also one paper wide.
 const first=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T01:00:00Z'),pageSize:1,supplementBatchIds:1}));
 assert.equal(first.partial,true,'the versions that could not be stored are reported, not raised');
 assert.equal(first.complete,false,'a partial round never claims the window was handled');
 assert.equal(first.hydrationIngested,1,'the version that did come back is really counted');
 assert.equal(first.hydrationFailed,1);
 assert.deepEqual(hydration,[['2610.06201v1'],['2610.06202v1']],'both sub-batches are still asked for');
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,null,'the watermark stays conservative');
 const state=await day('2026-10-07');
 assert.equal(state.attempts,1);
 assert.equal(state.last_outcome,'partial');
 assert.ok(state.completed_at,'a handled window closes the day instead of running the whole round again');
 const issued=requests.length;
 for(const hour of ['07','13']) assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at(`2026-10-07T${hour}:00:00Z`)})).reason,'completed');
 assert.equal(requests.length,issued,'a day closed by a partial round issues no further request');
 const open=await sql<{arxiv_id:string;kind:string;attempts:number;resolved_at:Date|null}[]>`
  SELECT arxiv_id,kind,attempts,resolved_at FROM arxiv_hydration_exceptions ORDER BY arxiv_id`;
 assert.deepEqual(open.map(r=>r.arxiv_id),['2610.06201v1'],'the absent version stays recorded as evidence');
 assert.equal(open[0]!.kind,'missing');
 assert.equal(open[0]!.resolved_at,null,'the exception stays open for the explicit recovery entry');
});

test('a round that stored none of its requested versions keeps the day open for the retry budget',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const asked:string[][]=[];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(['2610.06301v1']));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(ids.length) asked.push(ids);
  return new Response(atomFor([]));
 };
 const first=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 assert.equal(first.partial,true);
 assert.equal(first.hydrationIngested,0);
 assert.deepEqual(asked,[['2610.06301v1']]);
 const state=await day('2026-10-07');
 assert.equal(state.last_outcome,'failed','storing nothing looks systemic, so the day is not closed');
 assert.equal(state.completed_at,null);
 assert.equal(state.attempts,1);
 // The retry is a clean run: the open exception is not asked for again, so the round simply finds
 // nothing and the day stays open until its budget is spent.
 const retry=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T07:00:00Z')}));
 assert.equal(retry.partial,false,'a version already recorded as an open exception is never re-requested');
 assert.deepEqual(asked,[['2610.06301v1']],'the retry asks for nothing it already recorded');
 assert.equal((await day('2026-10-07')).attempts,2);
});

test('a tick that ran hours late starts its six hours when it really ran',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const hits:string[]=[];
 const empty=serving(()=>rssFor([]),hits);
 // The morning tick is polled late: the job starts at 08:05 instead of 01:00, so the day's first
 // attempt really runs at 08:05 and owns 14:05 as its earliest retry.
 const late=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T08:05:00Z')}));
 assert.equal(late.newContentCount,0);
 assert.equal((await day('2026-10-07')).attempts,1);
 const issued=hits.length;
 assert.ok(issued>0,'the late tick really ran');
 // 13:00 is only 4 h 55 m after the attempt really ran. A late run is not rounded back to a nominal
 // hour, so the whole six hours are measured on the real admission: no minute is given away.
 const tooSoon=skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T13:00:00Z')}));
 assert.equal(tooSoon.reason,'not_due','the six hours are measured on the admission, not on a nominal hour');
 assert.equal(tooSoon.nextEligibleAt,'2026-10-07T14:05:00.000Z','exactly six hours after the real admission, not one minute less');
 assert.equal(hits.length,issued,'the refused tick touches no network');
 assert.equal((await day('2026-10-07')).attempts,1,'the refused tick spends no attempt');
 // The boundary is the real instant plus the full interval, to the second.
 assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T14:04:59Z')})).reason,'not_due');
 assert.equal(hits.length,issued);
 const next=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T14:05:00Z')}));
 assert.equal(next.newContentCount,0);
 assert.equal((await day('2026-10-07')).attempts,2);
});

test('the six-hour bound is strict: a punctual tick is not given back the time it started late',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const hits:string[]=[];
 const empty=serving(()=>rssFor([]),hits);
 // A job always starts a little after its hour: 400 ms into 01:00 and 100 ms into 07:00. Six whole
 // hours have NOT passed between the two admissions, so the 07:00 tick is refused. The interval may be
 // longer than six hours, never shorter, and the sub-second lateness of a punctual run is not
 // subtracted from it.
 ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T01:00:00.400Z')}));
 const issued=hits.length;
 const tooSoon=skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at('2026-10-07T07:00:00.100Z')}));
 assert.equal(tooSoon.reason,'not_due','the interval is measured on the real instants, with no jitter allowance');
 assert.equal(tooSoon.nextEligibleAt,'2026-10-07T07:00:00.400Z','the earliest admission is the real instant plus the whole interval');
 assert.equal(hits.length,issued,'the refused tick touches no network');
 assert.equal((await day('2026-10-07')).attempts,1,'a refused tick spends no attempt');
 const admitted=ran(await collectScheduledArxiv({fetch:empty,sleep:async()=>{},now:at('2026-10-07T07:00:00.400Z')}));
 assert.equal(admitted.newContentCount,0);
 assert.equal((await day('2026-10-07')).attempts,2,'exactly six hours after the real admission the next tick runs');
});

test('a minute of lateness is lateness: 01:01 owns 07:01, and the bound is strict to the millisecond',async()=>{
 await clean();
 // Driven straight at the admission so the boundary is exact.
 const late=await begin(new Date('2026-10-06T01:01:00Z'));
 assert.equal(late.allowed,true);
 assert.equal(late.nextDueAt,'2026-10-06T07:01:00.000Z','the six hours start when the attempt really ran');
 await releaseLease();
 const refused=await begin(new Date('2026-10-06T07:00:00Z'));
 assert.equal(refused.allowed,false,'one minute past the anchor is already late');
 assert.equal(refused.reason,'not_due');
 assert.equal(refused.nextDueAt,'2026-10-06T07:01:00.000Z');
 assert.equal((await day('2026-10-06')).attempts,1,'a refused tick spends no attempt');
 const aMillisecondEarly=await begin(new Date('2026-10-06T07:00:59.999Z'));
 assert.equal(aMillisecondEarly.allowed,false,'the bound is strict one millisecond short as well');
 assert.equal(aMillisecondEarly.nextDueAt,'2026-10-06T07:01:00.000Z');
 const exactly=await begin(new Date('2026-10-06T07:01:00.000Z'));
 assert.equal(exactly.allowed,true,'exactly six hours passes the time gate');
 assert.equal(exactly.attempt,2);
 await releaseLease();
 const beyond=await begin(new Date('2026-10-06T14:30:00Z'));
 assert.equal(beyond.allowed,true,'a longer interval is never refused by the time gate');
 assert.equal(beyond.attempt,3);
});

test('the durable due instant still spaces a very late attempt across the UTC day boundary',async()=>{
 await clean();
 // Driven straight at the admission rather than through the entry: the spacing rule must not depend on
 // how the day's ticks happen to fall.
 const late=await begin(new Date('2026-10-07T23:30:00Z'));
 assert.equal(late.allowed,true);
 assert.equal(late.nextDueAt,'2026-10-08T05:30:00.000Z');
 const nextDay=await begin(new Date('2026-10-08T01:00:00Z'));
 assert.equal(nextDay.allowed,false,'a very late attempt still spaces the next day first attempt');
 assert.equal(nextDay.reason,'not_due');
 assert.equal(nextDay.nextDueAt,'2026-10-08T05:30:00.000Z','six hours after 23:30 really ran, with no rounding for a late run');
});

test('a partial round closes the day when the independent window stored real papers',async()=>{
 await clean();
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const requests:string[]=[];
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  requests.push(u.href);
  if(u.hostname==='rss.arxiv.org') return new Response(rssFor(['2610.06401v1']));
  const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  // The announced version never comes back, so hydration stores none of what it asked for...
  if(ids.length) return new Response(atomFor([]));
  // ...while the independent API window really does store an ordinary paper.
  return new Response(atomFor([{id:'2610.06501v1'}]));
 };
 const first=ran(await collectScheduledArxiv({fetch:fake,sleep:async()=>{},now:at('2026-10-07T01:00:00Z')}));
 assert.equal(first.partial,true,'the absent version is a structured partial result, not a failed round');
 assert.equal(first.hydrationIngested,0,'no requested version could be stored');
 assert.equal(first.windowIngested,1,'the independent window stored an ordinary paper');
 assert.equal(first.complete,false,'the watermark stays conservative');
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,null);
 const state=await day('2026-10-07');
 assert.equal(state.last_outcome,'partial','the window really stored a paper, so the day is closed');
 assert.ok(state.completed_at);
 const issued=requests.length;
 for(const hour of ['07','13']) assert.equal(skipped(await collectScheduledArxiv({fetch:forbidden,sleep:async()=>{},now:at(`2026-10-07T${hour}:00:00Z`)})).reason,'completed');
 assert.equal(requests.length,issued,'a closed day issues no further request');
 const open=await sql<{arxiv_id:string;kind:string;resolved_at:Date|null}[]>`
  SELECT arxiv_id,kind,resolved_at FROM arxiv_hydration_exceptions ORDER BY arxiv_id`;
 assert.deepEqual(open.map(r=>r.arxiv_id),['2610.06401v1'],'the exception stays recorded and queryable');
 assert.equal(open[0]!.kind,'missing');
 assert.equal(open[0]!.resolved_at,null,'the exception stays open for the explicit recovery entry');
});

test.after(async()=>{await closeDb();});
