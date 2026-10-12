import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql,closeDb } from '../packages/backend/src/db.ts';
import { collectAndStoreArxiv } from '../packages/backend/src/arxiv/collect-job.ts';
const emptyRss='<rss version="2.0"><channel><title>astro-ph updates</title></channel></rss>';
function atom(start:number,size:number,total=25){
 const entries=Array.from({length:Math.max(0,Math.min(size,total-start))},(_,j)=>{const i=start+j+1;return `<entry><id>https://arxiv.org/abs/2610.${String(i).padStart(5,'0')}v1</id><title>Title ${i}</title><summary>Original abstract ${i}</summary><published>2026-10-04T12:00:00Z</published><updated>2026-10-04T12:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`;}).join('');
 return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${size}</opensearch:itemsPerPage>${entries}</feed>`;
}
test('native collector persists every paper after newest20 with authoritative totals and no AI',async()=>{
 try{
 process.env.COLLECT_ENABLED='true';process.env.ARXIV_NATIVE_COLLECT_ENABLED='true';
 const requests:string[]=[];const fake:typeof fetch=async input=>{const url=new URL(String(input));requests.push(url.href);return new Response(url.hostname==='rss.arxiv.org'?emptyRss:atom(Number(url.searchParams.get('start')),Number(url.searchParams.get('max_results'))));};
 const result=await collectAndStoreArxiv({fetch:fake,pageSize:20,sleep:async()=>{},now:()=>new Date('2026-10-06T12:00:00Z')});
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,25);
 assert.equal(result!.complete,true);assert.equal(result!.paperCount,25);
 assert.deepEqual(requests.filter(x=>x.includes('/api/query')).map(x=>new URL(x).searchParams.get('start')),['0','20']);
 assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
 }finally{await closeDb();}
});
export { atom,emptyRss };
