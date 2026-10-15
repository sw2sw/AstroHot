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
const atomFor=(ids:{id:string}[],start=0,published='2026-10-01T00:00:00Z')=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${ids.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${Math.min(100,ids.length-start)}</opensearch:itemsPerPage>${ids.slice(start).map(({id})=>`<entry><id>https://arxiv.org/abs/${id}</id><title>T ${id}</title><summary>Abstract ${id}</summary><published>${published}</published><updated>${published}</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const rssFor=(ids:string[])=>`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title>${ids.map(id=>`<item><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><pubDate>Tue, 06 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item>`).join('')}</channel></rss>`;
test('announcements missing raw versions hydrate from persisted evidence even after the feed rolled over',async()=>{
 try{
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches, arxiv_announcements, arxiv_announcement_batches CASCADE`;
 const rss='https://rss.arxiv.org/rss/astro-ph';let day=0;let failToday=false;
 const fake:typeof fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='rss.arxiv.org') {
   day++;
   if(day===1) return new Response(rssFor(['2610.01001v1','2610.01002v1']));
   if(failToday) throw new Error('feed down');
   return new Response(rssFor(['2610.01003v1']));
  }
  const requested=(u.searchParams.get('id_list')??'').split(',').filter(Boolean);
  if(requested.length) return new Response(atomFor(requested.map(id=>({id}))));
  return new Response(atomFor([{id:'2610.01003v1'}],Number(u.searchParams.get('start')),'2026-10-06T03:00:00Z'));
 };
 const opt={fetch:fake,pageSize:20,maxPages:2,sleep:async()=>{},now:()=>new Date('2026-10-06T12:00:00Z')};
 const first=await collectAndStoreArxiv(opt);
 assert.equal(first!.rssPaperCount,2);
 assert.equal(first!.complete,true);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,3,'2 announced + 1 today-window paper');
 // Yesterday's failed hydration: one announced paper has evidence but no raw row.
 await sql`DELETE FROM arxiv_raw_papers WHERE arxiv_id='2610.01002v1'`;
 await sql`UPDATE arxiv_collection_state SET completed_through='2026-10-06T00:00:00Z',window_from=NULL,window_through=NULL,next_start=0,seen_ids='{}'`;
 // The first run cached this UTC day's feed; drop it so the second run really asks for the broken one.
 await sql`DELETE FROM arxiv_rss_cache`;
 failToday=true;
 await assert.rejects(collectAndStoreArxiv(opt),/announcement feed failed/,'a dead feed must fail the job, never fake success');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id='2610.01002v1'`)[0]!.n,1,'persisted evidence hydrated the missing version before the feed error was raised');
 assert.equal((await sql`SELECT completed_through::text FROM arxiv_collection_state`)[0]!.completed_through,'2026-10-06 00:00:00+00','watermark never advances while the announcement feed is failing');
 }finally{await closeDb();}
});
