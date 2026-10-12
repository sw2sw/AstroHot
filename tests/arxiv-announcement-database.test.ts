import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql,closeDb } from '../packages/backend/src/db.ts';
import { importArxivReport } from '../packages/backend/src/arxiv/store.ts';
import { loadArxivFeed } from '../packages/backend/src/publication/arxiv.ts';
import { ingestArxivAnnouncements } from '../packages/backend/src/arxiv/announcements.ts';
const original=JSON.parse(readFileSync(new URL('fixtures/arxiv-pilot.json',import.meta.url),'utf8'));
function rss(id:string,type:string,date='Tue, 06 Oct 2026 00:00:00 -0400'){
 return `<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph updates</title><item><guid isPermaLink="false">oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><category>astro-ph.GA</category><pubDate>${date}</pubDate><arxiv:announce_type>${type}</arxiv:announce_type></item></channel></rss>`;
}
test('actual PostgreSQL announcement evidence enriches only public read DTO, globally sorts pages and never rewrites history',async()=>{
 try{
 const selected=original.items.filter((p:{verdict:string})=>p.verdict==='SELECT').slice(0,3).map((p:Record<string,unknown>,i:number)=>({...p,categories:['astro-ph.GA'],submitted_at:`2026-10-0${i===0?1:5-i}T12:00:00Z`,updated_at:'2026-10-05T12:00:00Z'}));
 const report={...original,run_id:'announcement-pg-regression',items:selected,paper_count:3,candidate_pool_count:3,counts:{SELECT:3,REVIEW:0,DEFER:0},ranked_selected_ids:selected.map((p:{arxiv_id:string})=>p.arxiv_id)};
 await importArxivReport(report);
 const before=await sql`SELECT * FROM arxiv_papers ORDER BY base_id`;
 const reports=await sql`SELECT * FROM arxiv_reports ORDER BY run_id`;
 const xml=rss(selected[0].arxiv_id,'new');
 const first=await ingestArxivAnnouncements(xml,'2026-10-06T12:00:00Z');assert.equal(first.status,'imported');
 const duplicate=await ingestArxivAnnouncements(xml,'2026-10-07T12:00:00Z');assert.equal(duplicate.status,'unchanged');
 await ingestArxivAnnouncements(rss(selected[1].arxiv_id,'cross','Wed, 07 Oct 2026 00:00:00 -0400'),'2026-10-07T12:00:00Z');
 await ingestArxivAnnouncements(rss(selected[2].arxiv_id,'replace','Thu, 08 Oct 2026 00:00:00 -0400'),'2026-10-08T12:00:00Z');
 const pages=await Promise.all([1,2,3].map(page=>loadArxivFeed({page,pageSize:1,category:null})));
 assert.equal(pages[0]!.total,3);assert.equal(pages[0]!.items[0]!.arxiv_id,selected[0].arxiv_id);
 assert.equal(pages[0]!.items[0]!.announced_on,'2026-10-06');
 assert.equal(pages[1]!.items[0]!.arxiv_id,selected[1].arxiv_id);assert.equal(pages[1]!.items[0]!.announced_on,undefined);
 assert.equal(pages[2]!.items[0]!.announced_on,undefined);
 assert.equal((await loadArxivFeed({page:1,pageSize:20,category:'astro-ph.CO'})).total,0);
 assert.equal((await loadArxivFeed({page:1,pageSize:20,category:'astro-ph.GA'})).total,3);
 assert.deepEqual(await sql`SELECT * FROM arxiv_papers ORDER BY base_id`,before);
 assert.deepEqual(await sql`SELECT * FROM arxiv_reports ORDER BY run_id`,reports);
 assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
 await assert.rejects(ingestArxivAnnouncements(rss(selected[0].arxiv_id,'new','Wed, 07 Oct 2026 00:00:00 -0400'),'2026-10-07T12:00:00Z'),/conflict|different|contradict/i);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_announcement_batches`)[0]!.n,3);
 }finally{await closeDb();}
});
