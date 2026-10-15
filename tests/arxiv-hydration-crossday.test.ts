import './setup.ts';

// This file drives the OPTIONAL API supplement. The ordinary round is RSS-primary and touches the
// export API zero times, so a test that is about the API path has to ask for it explicitly.
process.env.ARXIV_API_SUPPLEMENT_ENABLED='true';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql, closeDb} from '../packages/backend/src/db.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';
import {refetchHydrationExceptions} from '../packages/backend/src/arxiv/hydration.ts';

// The source date/UTC observation pair is taken from the saved official feed audit:
// 2026-10-06 00:00 -0400 first observed 2026-10-07 02:35:03 UTC.
const feed='<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title><item><guid>oai:arXiv.org:2610.03101v1</guid><link>https://arxiv.org/abs/2610.03101</link><pubDate>Tue, 06 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item></channel></rss>';
const emptyFeed='<rss version="2.0"><channel><title>astro-ph</title></channel></rss>';
const atom=(ids:string[])=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${ids.length}</opensearch:itemsPerPage>${ids.map(id=>`<entry><id>https://arxiv.org/abs/${id}</id><title>Cross-day first release</title><summary>Original scientific evidence.</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;

test('a missing version is recorded as an exception, never auto-retried and recovered only by the explicit entry',async()=>{
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const requests:string[][]=[];
 let currentFeed=feed;
 let failHydration=true;
 const fake:typeof fetch=async input=>{
  const url=new URL(String(input));
  if(url.hostname==='rss.arxiv.org') return new Response(currentFeed);
  const ids=(url.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(ids.length){requests.push(ids);return new Response(atom(failHydration?[]:ids));}
  assert.match(url.searchParams.get('search_query')??'',/202610070000/,'the frozen window keeps its fixed start');
  return new Response(atom([]));
 };
 try {
  const partial=await collectAndStoreArxiv({fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T02:35:03Z')});
  assert.equal(partial!.partial,true,'the version that came back missing is reported, not raised');
  assert.equal(partial!.complete,false,'a round that stored nothing never claims the window was handled');
  assert.match(partial!.hydrationFailure!,/hydration returned missing/);
  assert.deepEqual(requests,[['2610.03101v1']]);
  const first=(await sql`SELECT first_batch_hash FROM arxiv_announcements WHERE arxiv_id='2610.03101v1'`)[0]!.first_batch_hash;
  assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through,null,'a batch that stored nothing must hold the watermark');
  const open=await sql<{arxiv_id:string;kind:string;attempts:number}[]>`
   SELECT arxiv_id,kind,attempts FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`;
  assert.equal(open.length,1,'the absent version is recorded instead of being dropped');
  assert.equal(open[0]!.arxiv_id,'2610.03101v1');
  assert.equal(open[0]!.kind,'missing');
  assert.equal(open[0]!.attempts,1);
  // The next UTC day must not ask again for a version that is already known to be absent.
  failHydration=false;currentFeed=emptyFeed;requests.length=0;
  const result=await collectAndStoreArxiv({fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-08T02:35:03Z')});
  assert.equal(result!.complete,true);
  assert.deepEqual(requests,[],'ordinary collection never re-requests an unresolved exception');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,0);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`)[0]!.n,1);
  // The separate, explicitly triggered entry is what recovers it.
  const recovered=await refetchHydrationExceptions({sleep:async()=>{},fetch:async input=>{
   const ids=(new URL(String(input)).searchParams.get('id_list')??'').split(',').filter(Boolean);
   return new Response(atom(ids));
  }});
  assert.deepEqual(recovered.resolvedIds,['2610.03101v1']);
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,1,'the recovered version is stored');
  assert.equal((await sql`SELECT first_batch_hash FROM arxiv_announcements WHERE arxiv_id='2610.03101v1'`)[0]!.first_batch_hash,first,'the first announcement evidence is unchanged');
  assert.equal((await sql`SELECT count(*)::int n FROM arxiv_hydration_exceptions WHERE resolved_at IS NULL`)[0]!.n,0,'only a successful refetch resolves it');
  assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0,'collection must never call paid model');
 } finally {await closeDb();}
});
