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
const rss='<rss version="2.0"><channel><title>astro-ph</title></channel></rss>';
function atom(start:number,size:number,total:number){const entries=Array.from({length:Math.max(0,Math.min(size,total-start))},(_,j)=>`<entry><id>https://arxiv.org/abs/2610.${String(start+j+1).padStart(5,'0')}v1</id><title>Title ${start+j}</title><summary>Abstract ${start+j}</summary><published>2026-10-06T00:00:00Z</published><updated>2026-10-06T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('');return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${size}</opensearch:itemsPerPage>${entries}</feed>`;}
test('bounded budget resumes offset, does not advance early; next tick imports next daily paper without duplicates',async()=>{
 try{
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 let total=25;const requests:URL[]=[];
 const fake:typeof fetch=async input=>{const u=new URL(String(input));requests.push(u);return new Response(u.hostname==='rss.arxiv.org'?rss:atom(Number(u.searchParams.get('start')),Number(u.searchParams.get('max_results')),total));};
 const opt={fetch:fake,pageSize:20,maxPages:1,sleep:async()=>{},now:()=>new Date('2026-10-06T12:00:00Z')};
 await assert.rejects(collectAndStoreArxiv(opt),/bounded page budget/);
 const s=(await sql`SELECT * FROM arxiv_collection_state`)[0]!;
 assert.equal(s.next_start,20);assert.equal(s.completed_through,null);assert.equal(s.owner,null);
 assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 assert.deepEqual(requests.filter(u=>u.hostname==='export.arxiv.org').map(u=>u.searchParams.get('start')),['0','20']);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,25);
 total=26;opt.now=()=>new Date('2026-10-07T12:00:00Z');opt.maxPages=2;
 assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,26);
 assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
 const state=(await sql`SELECT * FROM arxiv_collection_state`)[0]!;
 assert.equal(state.next_start,0);assert.equal(state.window_from,null);assert.equal(state.completed_through.toISOString(),'2026-10-07T12:00:00.000Z');
 }finally{await closeDb();}
});
