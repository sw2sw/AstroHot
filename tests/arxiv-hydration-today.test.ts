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
import {ingestArxivAnnouncements} from '../packages/backend/src/arxiv/announcements.ts';
import {ingestRawArxivCollection} from '../packages/backend/src/arxiv/raw-store.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';
const atom=(ids:string[])=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>${ids.length}</opensearch:itemsPerPage>${ids.map(id=>`<entry><id>https://arxiv.org/abs/${id}</id><title>T ${id}</title><summary>A</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rss=(ids:string[],day=7)=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>${day===5?'Mon':day===6?'Tue':'Wed'}, 0${day} Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
test('newly observed historical or future RSS cannot backfill raw; today new may have old submission',async()=>{
 try {
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const requested:string[]=[];
 const feed=rss(['2610.03001v1'],5).replace('</channel>',rss(['2610.03002v1']).split('<title>astro-ph</title>')[1]!.split('</channel>')[0]+'<item><guid>oai:arXiv.org:2610.03003v1</guid><link>https://arxiv.org/abs/2610.03003</link><pubDate>Thu, 08 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item></channel>');
 const fake:typeof fetch=async input=>{
 const u=new URL(String(input));if(u.hostname==='rss.arxiv.org') return new Response(feed);
 const ids=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);requested.push(...ids);return new Response(atom(ids));
 };
 const opt={fetch:fake,sleep:async()=>{},now:()=>new Date('2026-10-07T12:00:00Z')};
 assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 assert.deepEqual(requested,['2610.03002v1']);
 requested.length=0;
 assert.equal((await collectAndStoreArxiv(opt))!.complete,true);
 assert.deepEqual(requested,[],'stale feed evidence must not become a retryable history backfill');
 const raw=(await sql`SELECT metadata FROM arxiv_raw_papers`)[0]!;
 assert.equal(raw.metadata.submitted_at,'2026-10-01T00:00:00Z','today new announcement legitimately has an old submission');
 // The successful feed of this UTC day is served from the daily cache, so drop it to make this run
 // really fetch the malformed feed.
 await sql`DELETE FROM arxiv_rss_cache`;
 await assert.rejects(collectAndStoreArxiv({...opt,fetch:async()=>new Response(feed.replace('Mon, 05 Oct 2026','Mon, 32 Oct 2026'))}),/announcement feed failed/);
 assert.equal((await sql`SELECT completed_through FROM arxiv_collection_state`)[0]!.completed_through.toISOString(),'2026-10-07T12:00:00.000Z');
 } finally {await closeDb();}
});
