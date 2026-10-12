import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { ingestRawArxivCollection } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { stub, gate } from './setup.ts';

const answer = { title_zh:'宇宙观测研究', summary_zh:'研究宇宙观测数据，结果仍需全文核查。', reason_zh:'摘要提出可核查的观测结果。', verdict:'REVIEW', study_type:'observation', evidence_excerpt_index:1, fulltext_review_question:'全文如何控制系统误差？' };
const collection = (id='2601.00001v1') => {
 const raw_atom=`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${id}</id><title>Original title</title><summary>Original abstract. We measure $4\\%$\nwith uncertainty. Final result.</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry></feed>`;
 return {raw_atom,papers:parseArxivAtom(raw_atom),collected_at_utc:'2026-01-03T12:00:00Z'};
};
const reset=async()=>{await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches, arxiv_reports, arxiv_papers CASCADE`;await sql`DELETE FROM receipts`;};

test('actual pending raw to paid local AI to validated separate report, exact revision and dedupe',async()=>{
 let api:any;
 try { api=await import('../packages/backend/src/arxiv/analyze.ts'); } catch(error) { assert.fail(`analysis implementation missing: ${error}`); }
 assert.equal(typeof api.analyzePendingArxiv,'function');
 let response:any=answer;
 let wait:any=null;let entered:any=null;
 const server=await stub(async(_hit, req)=>{const body=JSON.parse(req.body);assert.match(body.messages[0].content,/title_zh/);assert.match(body.messages[0].content,/study_type/);if(body.messages[1].content.startsWith('{')){const input=JSON.parse(body.messages[1].content);assert.equal(input.evidence_excerpts[1].text,' We measure $4\\%$\nwith uncertainty.');}entered?.open();if(wait)await wait.promise;return {choices:[{message:{content:JSON.stringify(response)}}]};});
 Object.assign(process.env,{LLM_BASE_URL:server.url,LLM_API_KEY:'local-fake',LLM_MODEL:'qwen3.8:27b'});
 try {
  await reset();await ingestRawArxivCollection(collection());
  const result=await api.analyzePendingArxiv({limit:1,model:'default'});
  assert.equal(result.analyzed,1);
  const [paper]=await sql`SELECT paper FROM arxiv_papers`;
  assert.equal(paper!.paper.evidence_abstract_quote,' We measure $4\\%$\nwith uncertainty.');assert.equal(Object.hasOwn(paper!.paper,'evidence_excerpt_index'),false);
  assert.equal(paper!.paper.title_zh,answer.title_zh);assert.equal(paper!.paper.publication_status,'candidate_only');
  assert.equal(paper!.paper.analysis_scope,'title_and_abstract_only');assert.equal(paper!.paper.verdict,'REVIEW');
  assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers`)[0]!.analysis_status,'analyzed');
  assert.equal((await sql`SELECT count(*) AS n FROM arxiv_reports`)[0]!.n,1);
  assert.equal((await sql`SELECT status,purpose FROM receipts`)[0]!.status,'completed');
  assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,0);assert.equal(server.hits(),1);

  await reset();await ingestRawArxivCollection(collection('2601.00002v1'));
  response={...answer,verdict:'PUBLISHED'};
  const invalid=await api.analyzePendingArxiv({limit:1,model:'default'});
  assert.equal(invalid.failed,1);
  assert.deepEqual(invalid.failures,[{arxivId:'2601.00002v1',code:'analysis_validation_failed'}]);
  assert.equal((await sql`SELECT count(*) AS n FROM arxiv_papers`)[0]!.n,0);
  assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers`)[0]!.analysis_status,'pending');
  response=answer;
  assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,0,'invalid answers must cool down before retry');
  await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second'`;
  assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,1);

  await reset();await ingestRawArxivCollection(collection('2601.00003v1'));
  response={...answer,evidence_abstract_quote:'Invented evidence'};
  await api.analyzePendingArxiv({limit:1,model:'default'});
  assert.equal((await sql`SELECT count(*) AS n FROM arxiv_papers`)[0]!.n,0);
  response=answer;
  assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,0,'invalid answers must cool down before retry');
  await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second'`;
  assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,1);

  await reset();await ingestRawArxivCollection(collection('2601.00004v1'));
  wait=gate();entered=gate();const work=api.analyzePendingArxiv({limit:1,model:'default'});await entered.promise;
  const hits=server.hits();assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,0);assert.equal(server.hits(),hits);
  await ingestRawArxivCollection(collection('2601.00004v2'));wait.open();await work;wait=null;entered=null;
  assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers WHERE version=2`)[0]!.analysis_status,'pending');
  assert.equal((await api.analyzePendingArxiv({limit:1,model:'default'})).analyzed,1);
  assert.equal((await sql`SELECT version FROM arxiv_papers`)[0]!.version,2);
  console.log(JSON.stringify({actualLibraryAnalysis:true,separateReportPersisted:true,dedupe:true,invalidRetriable:true,evidenceGrounded:true,concurrentDedupe:true,versionAdvanceSafe:true,localHttpCalls:server.hits()}));
 } finally {await server.close();await closeDb();}
});
