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
import {claimCollection,invalidateCollectionWindow,releaseCollection} from '../packages/backend/src/arxiv/collection-state.ts';
test('cursor invalidation preserves fixed bounds across UTC rollover',async()=>{
 try {
 const state=await claimCollection(new Date('2026-10-06T12:00:00Z'));
 assert.ok(!('status' in state));
 await sql`UPDATE arxiv_collection_state SET next_start=20,expected_total=25,seen_ids=ARRAY['2610.00001v1'] WHERE key=${state.key}`;
 await invalidateCollectionWindow(state);
 const reset=(await sql`SELECT * FROM arxiv_collection_state WHERE key=${state.key}`)[0]!;
 assert.equal(reset.next_start,0);assert.equal(reset.expected_total,null);assert.deepEqual(reset.seen_ids,[]);
 assert.equal(reset.window_from,state.window_from);assert.equal(reset.window_through,state.window_through);
 await releaseCollection(state);
 const resumed=await claimCollection(new Date('2026-10-07T12:00:00Z'));
 assert.ok(!('status' in resumed));
 assert.equal(resumed.window_from,'202610060000');assert.equal(resumed.window_through,'202610061200');
 await releaseCollection(resumed);
 // Exercise the collector mismatch path, not only its state helper.
 await sql`UPDATE arxiv_collection_state SET next_start=20,expected_total=25,seen_ids=ARRAY['2610.00001v1']`;
 const {collectAndStoreArxiv}=await import('../packages/backend/src/arxiv/collect-job.ts');
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const requests:URL[]=[];let mismatch=true;
 const fake:typeof fetch=async input=>{
 const u=new URL(String(input));requests.push(u);
 if(u.hostname==='rss.arxiv.org') return new Response('<rss version="2.0"><channel><title>astro-ph</title></channel></rss>');
 return new Response(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${mismatch?26:0}</opensearch:totalResults><opensearch:startIndex>${u.searchParams.get('start')}</opensearch:startIndex><opensearch:itemsPerPage>0</opensearch:itemsPerPage></feed>`);
 };
 const opt={fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-08T12:00:00Z')};
 await assert.rejects(collectAndStoreArxiv(opt),/pagination coverage changed/);
 const invalid=(await sql`SELECT * FROM arxiv_collection_state`)[0]!;
 assert.equal(invalid.window_from,'202610060000');assert.equal(invalid.window_through,'202610061200');
 assert.equal(invalid.next_start,0);assert.equal(invalid.expected_total,null);assert.deepEqual(invalid.seen_ids,[]);
 mismatch=false;assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 const api=requests.filter(u=>u.hostname==='export.arxiv.org');
 assert.deepEqual(api.map(u=>u.searchParams.get('start')),['20','0']);
 assert.ok(api.every(u=>u.searchParams.get('search_query')!.includes('202610060000 TO 202610061200')));
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through.toISOString(),'2026-10-06T12:00:00.000Z');
 } finally {await closeDb();}
});
