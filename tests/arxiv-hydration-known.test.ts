import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {collectAndStoreArxiv} from '../packages/backend/src/arxiv/collect-job.ts';
import {ingestArxivAnnouncements} from '../packages/backend/src/arxiv/announcements.ts';
import {ingestRawArxivCollection} from '../packages/backend/src/arxiv/raw-store.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';
const atom=(ids:string[])=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${ids.length}</opensearch:itemsPerPage>${ids.map(id=>`<entry><id>https://arxiv.org/abs/${id}</id><title>T ${id}</title><summary>A</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rss=(ids:string[],day=7)=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>${day===6?'Tue':'Wed'}, 0${day} Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
test('nonempty RSS retries durable missing versions but never hydrates known raw versions',async()=>{
 try {
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 await ingestArxivAnnouncements(rss(['2610.02001v1'],6),'2026-10-06T12:00:00Z');
 const known=atom(['2610.02002v1']);
 await ingestRawArxivCollection({raw_atom:known,papers:parseArxivAtom(known),collected_at_utc:'2026-10-07T01:00:00Z'});
 const before=await sql`SELECT * FROM arxiv_raw_papers WHERE arxiv_id='2610.02002v1'`;
 const requested:string[]=[];
 const fake:typeof fetch=async input=>{
 const u=new URL(String(input));
 if(u.hostname==='rss.arxiv.org') return new Response(rss(['2610.02002v1','2610.02003v1']));
 const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);requested.push(...ids);
 return new Response(atom(ids));
 };
 const opt={fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T12:00:00Z')};
 assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 assert.deepEqual(requested.sort(),['2610.02001v1','2610.02003v1']);
 assert.deepEqual(await sql`SELECT * FROM arxiv_raw_papers WHERE arxiv_id='2610.02002v1'`,before);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,3);
 requested.length=0;
 assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 assert.deepEqual(requested,[],'fully known feed sends no hydration requests');
 assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
 } finally {await closeDb();}
});
