import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {claimCollection,releaseCollection} from '../packages/backend/src/arxiv/collection-state.ts';
import {readPendingRawArxivPapers,ingestRawArxivCollection} from '../packages/backend/src/arxiv/raw-store.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';
import {ingestArxivAnnouncements} from '../packages/backend/src/arxiv/announcements.ts';

test('start today; old pending cannot consume LIMIT; today first release can have an old submission',async()=>{
 try{
 const state=await claimCollection(new Date('2026-10-06T12:00:00Z'));
 assert.ok(!('status' in state));
 assert.equal(state.window_from,'202610060000');
 await releaseCollection(state);
 await sql`UPDATE arxiv_collection_state SET analysis_start_on='2026-10-06'`;
 const xml=`<feed xmlns="http://www.w3.org/2005/Atom">${[1,2,3].map(i=>`<entry><id>https://arxiv.org/abs/2610.0000${i}v1</id><title>Title ${i}</title><summary>Abstract ${i}</summary><published>${i===3?'2026-10-06':'2026-10-04'}T12:00:00Z</published><updated>2026-10-06T12:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
 await ingestRawArxivCollection({raw_atom:xml,papers:parseArxivAtom(xml),collected_at_utc:'2026-10-06T12:00:00Z'});
 const rss=`<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom"><channel><title>astro-ph</title><item><guid>oai:arXiv.org:2610.00002v1</guid><link>https://arxiv.org/abs/2610.00002</link><pubDate>Tue, 06 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>new</arxiv:announce_type></item></channel></rss>`;
 await ingestArxivAnnouncements(rss,'2026-10-06T12:00:00Z');
 assert.deepEqual((await readPendingRawArxivPapers(1)).map(p=>p.arxiv_id),['2610.00002v1']);
 assert.deepEqual((await readPendingRawArxivPapers(100)).map(p=>p.arxiv_id),['2610.00002v1','2610.00003v1']);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers`)[0]!.n,3,'preserve old raw, never delete or rewrite history');
 await sql`UPDATE arxiv_collection_state SET window_from=NULL,window_through=NULL,completed_through='2026-09-01'`;
 const later=await claimCollection(new Date('2026-10-07T12:00:00Z'));
 assert.ok(!('status' in later));
 assert.equal(later.window_from,'202610070000','even a long outage starts at today UTC, never yesterday');
 await releaseCollection(later);
 }finally{await closeDb();}
});
