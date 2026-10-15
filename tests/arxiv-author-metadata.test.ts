import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { ingestRawArxivCollection, rawMetadataDigest } from '../packages/backend/src/arxiv/raw-store.ts';
import type { RawArxivDatabase } from '../packages/backend/src/arxiv/raw-store.ts';
import { ARXIV_PROMPT_VERSION } from '../packages/backend/src/arxiv/analysis-retry.ts';
import { readPendingRawArxivPapers } from '../packages/backend/src/arxiv/raw-store.ts';
const fixture=(name:string)=>readFileSync(new URL('./fixtures/arxiv-author-metadata/'+name,import.meta.url),'utf8');
const oldXml=fixture('old-entry.atom'), newXml=fixture('official-new.atom');
const old=parseArxivAtom(oldXml)[0]!, next=parseArxivAtom(newXml)[0]!;
const input=(raw_atom:string)=>({raw_atom,papers:parseArxivAtom(raw_atom),collected_at_utc:'2026-10-08T02:50:59Z'});
const hash=(xml:string)=>createHash('sha256').update(xml).digest('hex');
const newEntry=newXml.match(/<entry>[\s\S]*?<\/entry>/)![0];
const added=newEntry.replaceAll('2612.90001','2612.99999');
const batch=(entry:string)=>newXml.replace(newEntry,added+entry).replace('<opensearch:totalResults>1','<opensearch:totalResults>2').replace('<opensearch:itemsPerPage>1','<opensearch:itemsPerPage>2');
test('real saved official authors-only update adopts latest metadata/hash offline',async()=>{
 assert.deepEqual(old,JSON.parse(fixture('old-metadata.json')));
 assert.deepEqual(next,JSON.parse(fixture('new-metadata.json')));
 assert.deepEqual(Object.keys(old).filter(k=>JSON.stringify(old[k as keyof typeof old])!==JSON.stringify(next[k as keyof typeof next])),['authors']);
 const updates:unknown[][]=[]; const retryMigrations:unknown[][]=[];
 const tx=async(strings:TemplateStringsArray,...values:unknown[])=>{
  const q=strings.join('?');
  const claimsActive=false;
  // The per-paper serialization boundary (RSS-U2 F2) is part of the adoption path now: the
  // offline fake harness grants it as the no-op it is offline.
  if(q.includes('pg_advisory_xact_lock'))return [];
  if(q.includes('INSERT INTO arxiv_raw_batches'))return [{content_hash:'offline'}];
  if(q.includes('INSERT INTO arxiv_raw_papers'))return [];
  if(q.includes('SELECT') && q.includes('metadata, metadata_hash, source FROM arxiv_raw_papers'))return [{metadata_hash:rawMetadataDigest(old),metadata:old}];
  // The adoption is one CAS statement now (RSS-U2 F2): the fake emulates the row-level
  // predicate it can see. With no claim it returns the adopted row; with a live claim the
  // real statement's NOT EXISTS refuses, so nothing is recorded as persisted.
  if(q.includes('UPDATE arxiv_raw_papers')){
   if(claimsActive) return []; // the row predicate refuses: nothing is persisted, nothing recorded
   updates.push(values); return [{arxiv_id:old.arxiv_id}];
  }
  if(q.includes('SELECT 1 FROM arxiv_analysis_claims'))return [];
  if(q.includes('UPDATE arxiv_analysis_retry')){retryMigrations.push(values);return [];}
  throw Error('Unexpected SQL: '+q);
 };
 await ingestRawArxivCollection(input(newXml),{begin:fn=>fn(tx as never)});
 assert.equal(updates.length,1,'latest legal authors metadata must be persisted');
 assert.ok(updates[0]!.some(v=>v===rawMetadataDigest(next)));
 assert.ok(updates[0]!.some(v=>typeof v==='string'&&v.startsWith('{')&&rawMetadataDigest(JSON.parse(v))===rawMetadataDigest(next)));
 assert.equal(retryMigrations.length,1,'retry guards migrate to the new hash with counts intact');
 assert.ok(retryMigrations[0]!.includes(rawMetadataDigest(old)));
 assert.ok(retryMigrations[0]!.includes(rawMetadataDigest(next)));
});
test('offline: an active paid-analysis claim defers the authors-only adoption',async()=>{
 const updates:unknown[][]=[];
 const tx=async(strings:TemplateStringsArray,...values:unknown[])=>{
  const q=strings.join('?');
  const claimsActive=true;
  // The per-paper serialization boundary (RSS-U2 F2) is part of the adoption path now: the
  // offline fake harness grants it as the no-op it is offline.
  if(q.includes('pg_advisory_xact_lock'))return [];
  if(q.includes('INSERT INTO arxiv_raw_batches'))return [{content_hash:'offline'}];
  if(q.includes('INSERT INTO arxiv_raw_papers'))return [];
  if(q.includes('SELECT') && q.includes('metadata, metadata_hash, source FROM arxiv_raw_papers'))return [{metadata_hash:rawMetadataDigest(old),metadata:old}];
  // The adoption is one CAS statement now (RSS-U2 F2): the fake emulates the row-level
  // predicate it can see. With no claim it returns the adopted row; with a live claim the
  // real statement's NOT EXISTS refuses, so nothing is recorded as persisted.
  if(q.includes('UPDATE arxiv_raw_papers')){
   if(claimsActive) return []; // the row predicate refuses: nothing is persisted, nothing recorded
   updates.push(values); return [{arxiv_id:old.arxiv_id}];
  }
  if(q.includes('SELECT 1 FROM arxiv_analysis_claims'))return [{'?column?':1}];
  throw Error('Unexpected SQL: '+q);
 };
 const result=await ingestRawArxivCollection(input(newXml),{begin:fn=>fn(tx as never)});
 assert.equal(result.status,'imported');
 assert.deepEqual(result.deferredAuthorUpdates,[old.arxiv_id]);
 assert.equal(updates.length,0,'no metadata/hash update while a paid claim is active');
});
test('isolated PostgreSQL authors-only policy', {skip:!process.env.ARXIV_AUTHOR_TEST_URL},async(t)=>{
 const url=new URL(process.env.ARXIV_AUTHOR_TEST_URL!);
 assert.equal(url.hostname,'127.0.0.1'); assert.match(url.pathname,/^\/arxiv_author_[a-z0-9]+_test$/);
 const sql=postgres(url.toString(),{max:2,onnotice:()=>{}});
 const db:RawArxivDatabase={begin:async fn=>sql.begin(fn) as ReturnType<typeof fn>};
 const snapshot=async()=>({papers:await sql`SELECT * FROM arxiv_raw_papers ORDER BY arxiv_id`,batches:await sql`SELECT * FROM arxiv_raw_batches ORDER BY content_hash`});
 const reset=async()=>{await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches CASCADE`;await ingestRawArxivCollection(input(oldXml),db);await sql`UPDATE arxiv_raw_papers SET analysis_status='analyzed'`;};
 try {
  assert.equal((await sql`SELECT count(*)::int n FROM schema_migrations WHERE name='0062_arxiv_collection_state.sql'`)[0]!.n,1);
  await t.test('latest authors and hash, both exact batches, first fields/status preserved, legal new row, replay idempotent, zero receipts',async()=>{
   await reset(); const before=await snapshot();
   const xml=batch(newEntry), request=input(xml);
   assert.equal((await ingestRawArxivCollection(request,db)).status,'imported');
   const after=await snapshot(), changed=after.papers.find(p=>p.arxiv_id===old.arxiv_id)!;
   assert.deepEqual(changed,{...before.papers[0],metadata:next,metadata_hash:rawMetadataDigest(next)});
   assert.equal(after.papers.length,2);assert.equal(after.batches.length,2);
   assert.deepEqual(after.batches.find(b=>b.content_hash===hash(oldXml)),before.batches[0]);
   assert.equal(after.batches.find(b=>b.content_hash===hash(xml))!.raw_atom,xml);
   assert.equal((await ingestRawArxivCollection({...request,collected_at_utc:'2026-10-09T00:00:00Z'},db)).status,'unchanged');
   assert.deepEqual(await snapshot(),after);
   assert.equal((await ingestRawArxivCollection(input(oldXml),db)).status,'unchanged');
   assert.deepEqual(await snapshot(),after,'archived old Atom replay cannot revert current authors');
   assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
   assert.equal((await sql`SELECT count(*)::int n FROM arxiv_papers`)[0]!.n,0);
   });
   await t.test('active claim defers adoption, completion predicate still matches, later batch adopts, zero receipts',async()=>{
    await reset();
    await sql`UPDATE arxiv_raw_papers SET analysis_status='pending' WHERE arxiv_id=${old.arxiv_id}`;
    await sql`INSERT INTO arxiv_analysis_claims(arxiv_id,metadata_hash,token) VALUES(${old.arxiv_id},${rawMetadataDigest(old)},'in-flight')`;
    const result=await ingestRawArxivCollection(input(batch(newEntry)),db);
    assert.equal(result.status,'imported');
    assert.deepEqual(result.deferredAuthorUpdates,[old.arxiv_id]);
    const stored=[...(await sql`SELECT metadata_hash,analysis_status FROM arxiv_raw_papers WHERE arxiv_id=${old.arxiv_id}`)];
    assert.deepEqual(stored,[{metadata_hash:rawMetadataDigest(old),analysis_status:'pending'}],'claimed row keeps the old hash this batch');
    // The in-flight completion predicate (analyze under the old hash) still matches exactly one row.
    await sql`UPDATE arxiv_raw_papers SET analysis_status='analyzed' WHERE arxiv_id=${old.arxiv_id} AND metadata_hash=${rawMetadataDigest(old)} AND analysis_status='pending'`;
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE arxiv_id=${old.arxiv_id} AND analysis_status='analyzed'`)[0]!.n,1);
    await sql`DELETE FROM arxiv_analysis_claims`;
    const replay=await ingestRawArxivCollection(input(newXml),db);
    assert.equal(replay.status,'imported');
    assert.deepEqual(replay.deferredAuthorUpdates,[]);
    assert.equal((await sql`SELECT metadata_hash FROM arxiv_raw_papers WHERE arxiv_id=${old.arxiv_id}`)[0]!.metadata_hash,rawMetadataDigest(next));
    assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers WHERE arxiv_id=${old.arxiv_id}`)[0]!.analysis_status,'analyzed');
    assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0,'an authors-only correction never pays for a second analysis');
   });
   await t.test('retry cap migrates with the hash and still blocks under the new hash',async()=>{
    await reset();
    await sql`UPDATE arxiv_raw_papers SET analysis_status='pending' WHERE arxiv_id=${old.arxiv_id}`;
    await sql`INSERT INTO arxiv_analysis_retry(arxiv_id,metadata_hash,prompt_version,validation_failures,next_attempt_at,blocked_reason)
      VALUES(${old.arxiv_id},${rawMetadataDigest(old)},${ARXIV_PROMPT_VERSION},3,clock_timestamp()+interval '10 minutes','validation_limit')`;
    const result=await ingestRawArxivCollection(input(newXml),db);
    assert.equal(result.status,'imported');
    assert.deepEqual(result.deferredAuthorUpdates,[]);
    const rows=[...(await sql`SELECT metadata_hash,validation_failures::int AS failures,blocked_reason FROM arxiv_analysis_retry WHERE arxiv_id=${old.arxiv_id}`)];
    assert.deepEqual(rows,[{metadata_hash:rawMetadataDigest(next),failures:3,blocked_reason:'validation_limit'}],'cap/block counts migrate to the new hash');
    const ready=await readPendingRawArxivPapers(20);
    assert.deepEqual(ready.map(p=>p.arxiv_id),[],'migrated validation_limit still blocks: zero extra model calls');
    assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
   });
   await t.test('analyzed paper adopts new authors without touching report, status or first fields',async()=>{
    await reset();
    const before=(await snapshot()).papers.find(p=>p.arxiv_id===old.arxiv_id)!;
    await sql`INSERT INTO arxiv_reports(run_id,content_hash,generated_at,issue_date,report) VALUES('run-authors','ch',${new Date('2026-10-08T03:00:00Z')},'2026-10-08','{}'::jsonb)`;
    await sql`INSERT INTO arxiv_papers(paper_key,base_id,version,generated_at,run_id,paper) VALUES(${old.arxiv_id},${old.base_id},1,${new Date('2026-10-08T03:00:00Z')},'run-authors',${JSON.stringify({publication_status:'candidate_only',peer_review_status:'unverified',analysis_scope:'title_and_abstract_only',title_original:old.title_original,authors:old.authors})}::text::jsonb)`;
    await sql`UPDATE arxiv_raw_papers SET analysis_status='analyzed' WHERE arxiv_id=${old.arxiv_id}`;
    const result=await ingestRawArxivCollection(input(newXml),db);
    assert.equal(result.status,'imported');
    assert.deepEqual(result.deferredAuthorUpdates,[]);
    const row=(await snapshot()).papers.find(p=>p.arxiv_id===old.arxiv_id)!;
    assert.equal(row.analysis_status,'analyzed','authors-only correction never re-runs analysis');
    assert.equal(row.metadata_hash,rawMetadataDigest(next));
    assert.equal(row.first_batch_hash,before.first_batch_hash);
    assert.deepEqual(row.first_collected_at,before.first_collected_at);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_papers WHERE base_id=${old.base_id} AND paper->>'publication_status'='candidate_only' AND paper->'authors'=${JSON.stringify(old.authors)}::text::jsonb`)[0]!.n,1,'persisted analysis result is preserved verbatim');
    assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
   });
  const mutations:[string,(s:string)=>string][]=[
   ['title',s=>s.replace('<title>Synthetic','<title>Changed Synthetic')],
   ['abstract',s=>s.replace('<summary>This','<summary>Changed This')],
   ['category',s=>s.replace('term="astro-ph.GA"','term="astro-ph.CO"')],
   ['submitted date',s=>s.replace('<published>2026-10-06','<published>2026-10-05')],
   ['updated date',s=>s.replace('<updated>2026-10-06','<updated>2026-10-07')],
  ];
  for(const [name,change] of mutations)await t.test(name+' drift atomically rejects batch, preceding addition and preceding authors update',async()=>{
   await reset();
   // An authors-only existing row is visited before a separate conflicting existing row.
   await ingestRawArxivCollection(input(oldXml.replaceAll('2612.90001','2612.88888')),db);
   const before=await snapshot();
   const xml=batch(newEntry+change(newEntry.replaceAll('2612.90001','2612.88888')));
   await assert.rejects(ingestRawArxivCollection(input(xml),db),/raw feed conflict/);
   assert.deepEqual(await snapshot(),before);
  });
  for(const [name,value] of [['url','https://arxiv.org/abs/2612.90001v2'],['base_id','2612.00001'],['arxiv_id','2612.90001v2'],['future_field',{nested:1}]] as const)await t.test('stored '+name+' difference rejects atomically',async()=>{
   await reset();const altered={...old,[name]:value};
   await sql`UPDATE arxiv_raw_papers SET metadata=${JSON.stringify(altered)}::jsonb,metadata_hash=${rawMetadataDigest(altered)}`;
   const before=await snapshot();await assert.rejects(ingestRawArxivCollection(input(batch(newEntry)),db),/raw feed conflict/);assert.deepEqual(await snapshot(),before);
  });
  for(const authors of [undefined,null,[],[''],['   '],[1],'Alice'])await t.test('stored invalid authors '+JSON.stringify(authors)+' reject',async()=>{
   await reset();const altered:Record<string,unknown>={...old,authors};if(authors===undefined)delete altered.authors;
   await sql`UPDATE arxiv_raw_papers SET metadata=${JSON.stringify(altered)}::jsonb,metadata_hash=${rawMetadataDigest(altered)}`;
   const before=await snapshot();await assert.rejects(ingestRawArxivCollection(input(batch(newEntry)),db),/raw feed conflict/);assert.deepEqual(await snapshot(),before);
  });
  await t.test('malformed/missing authors, API errors, invalid calendar, tampered papers remain strict',async()=>{
   await reset();const before=await snapshot();
   for(const xml of [newXml.replace(/<author>[\s\S]*?<\/author>/g,''),newXml.replace('<name>Ada Example</name>','<name/>'),newXml.replace('2026-10-06T09:15:00Z','2026-02-30T09:15:00Z'),'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#bad</id></entry></feed>']){
    await assert.rejects(ingestRawArxivCollection({raw_atom:xml,papers:[],collected_at_utc:'2026-10-08T00:00:00Z'},db));
   }
   for(const authors of [undefined,null,[],[''],[1]]){
    const req=input(newXml);Object.assign(req.papers[0]!,{authors});await assert.rejects(ingestRawArxivCollection(req,db),/mismatch/);
   }
   const req=input(newXml);Object.assign(req.papers[0]!,{future_field:true});await assert.rejects(ingestRawArxivCollection(req,db),/mismatch/);
   assert.deepEqual(await snapshot(),before);assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,0);
  });
 }finally{await sql.end({timeout:0});}
});
