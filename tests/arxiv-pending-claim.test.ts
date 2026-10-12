import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql,closeDb } from '../packages/backend/src/db.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { ingestRawArxivCollection,readPendingRawArxivPapers } from '../packages/backend/src/arxiv/raw-store.ts';
test('an already claimed old paper cannot occupy pending LIMIT and starve unclaimed work',async()=>{
 try{
 const entries=[1,2].map(i=>`<entry><id>https://arxiv.org/abs/2610.${String(i).padStart(5,'0')}v1</id><title>Title ${i}</title><summary>Original abstract ${i}</summary><published>2026-10-05T00:00:00Z</published><updated>2026-10-05T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('');
 const raw_atom=`<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
 await ingestRawArxivCollection({raw_atom,papers:parseArxivAtom(raw_atom),collected_at_utc:'2026-10-06T00:00:00Z'});
 const old=(await sql`SELECT * FROM arxiv_raw_papers WHERE arxiv_id='2610.00001v1'`)[0]!;
 await sql`INSERT INTO arxiv_analysis_claims(arxiv_id,metadata_hash,token,claimed_at) VALUES(${old.arxiv_id},${old.metadata_hash},${randomUUID()},clock_timestamp())`;
 const ready=await readPendingRawArxivPapers(1);
 assert.deepEqual(ready.map(p=>p.arxiv_id),['2610.00002v1']);
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims`)[0]!.n,1,'do not expire or delete a possibly live model claim');
 assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
 }finally{await closeDb();}
});
