import './setup.ts';

// This file drives the OPTIONAL API supplement. The ordinary round is RSS-primary and touches the
// export API zero times, so a test that is about the API path has to ask for it explicitly.
process.env.ARXIV_API_SUPPLEMENT_ENABLED='true';
// This file drives the LEGACY ordinary submission-date window. It is a separate, default-off switch
// from the API supplement (RSS-U3): asking for the gap-fill must not bring the window back.
process.env.ARXIV_API_WINDOW_ENABLED='true';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { stub } from './setup.ts';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { collectAndStoreArxiv } from '../packages/backend/src/arxiv/collect-job.ts';
import { analyzePendingArxiv } from '../packages/backend/src/arxiv/analyze.ts';
import { loadArxivFeed } from '../packages/backend/src/publication/arxiv.ts';
// The domain day is the Asia/Shanghai calendar day: arxiv_collection_state.analysis_start_on and the
// daily report's issue_date both use it. A fixture dated from the UTC day is a day BEHIND between
// 16:00Z and 24:00Z (Shanghai has already rolled over), which put every paper before the analysis
// start and made this whole file fail for six hours out of every day. Build the fixture on the same
// calendar the code under test uses.
const domainDay = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const xml=(version=1)=>`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>3</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>100</opensearch:itemsPerPage>${[1,2,3].map(n=>`<entry><id>http://arxiv.org/abs/2601.0000${n}v${version}</id><title>Original title ${n}</title><summary>Original abstract ${n}</summary><published>${domainDay()}T00:00:00Z</published><updated>${domainDay()}T01:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
const collectFixture=(version=1)=>collectAndStoreArxiv({fetch:async url=>new Response(new URL(String(url)).hostname==='rss.arxiv.org'?'<rss version="2.0"><channel><title>astro-ph</title></channel></rss>':xml(version))});
test('AI-free daily snapshot preserves provenance, SELECT publication, revisions and empty-day archive',async()=>{
 let api:any; try {api=await import('../packages/backend/src/arxiv/daily.ts');} catch(e) {assert.fail(`daily composer missing: ${e}`);}
 const server=await stub((_hit,req)=>{const user=JSON.parse(req.body).messages.at(-1).content;const n=Number(/Original abstract (\d)/.exec(user)![1]);return {choices:[{message:{content:JSON.stringify({title_zh:'宇宙研究',summary_zh:'观测摘要，需全文核查。',reason_zh:'有待核查。',verdict:['SELECT','REVIEW','DEFER'][n-1],study_type:'observation',evidence_excerpt_index:0,fulltext_review_question:'如何控制误差？'})}}]};});
 Object.assign(process.env,{LLM_BASE_URL:server.url,LLM_API_KEY:'local-fake',LLM_MODEL:'qwen3.8:27b',COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true'});
 const app=Fastify(); const originalFetch=globalThis.fetch;
 try {
  await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches, arxiv_reports, arxiv_papers CASCADE`;await sql`DELETE FROM receipts`;
  const collect=()=>collectFixture();
  await collect();assert.equal((await analyzePendingArxiv({limit:3,model:'default'})).analyzed,3);
  const before=await sql`SELECT * FROM arxiv_papers ORDER BY base_id`;const raw=await sql`SELECT * FROM arxiv_raw_papers ORDER BY arxiv_id`;const receipts=await sql`SELECT * FROM receipts ORDER BY id`;
  const hits=server.hits();globalThis.fetch=async()=>{throw new Error('composer HTTP forbidden');};
  const first=await api.composeArxivDailyReport();assert.equal(first.status,'imported');assert.equal(first.report.mode,'daily');assert.deepEqual(first.report.counts,{SELECT:1,REVIEW:1,DEFER:1});assert.equal(first.report.paper_count,3);assert.equal(first.report.candidate_pool_count,3);
  assert.deepEqual(first.report.items,before.map(p=>p.paper));assert.deepEqual(first.report.ranked_selected_ids,['2601.00001v1']);assert.match(first.report.coverage,/analyzed|分析/);assert.equal(first.report.input_collected_at_utc,new Date(Math.min(...(await sql`SELECT report FROM arxiv_reports WHERE run_id IN (SELECT run_id FROM arxiv_papers)`).map(r=>Date.parse(r.report.input_collected_at_utc)))).toISOString());
  const again=await api.composeArxivDailyReport({issueDate:first.report.issue_date});assert.equal(again.status,'unchanged');assert.deepEqual(again.report,first.report);
  assert.deepEqual(await sql`SELECT * FROM arxiv_papers ORDER BY base_id`,before);assert.deepEqual(await sql`SELECT * FROM arxiv_raw_papers ORDER BY arxiv_id`,raw);assert.deepEqual(await sql`SELECT * FROM receipts ORDER BY id`,receipts);assert.equal(server.hits(),hits);
  const {registerArxiv}=await import('../apps/api/src/routes/arxiv.ts');registerArxiv(app);
  const feed=await loadArxivFeed({page:1,pageSize:20,category:null});assert.equal(feed.total,1);assert.deepEqual(feed.latestBatch,{paperCount:3,selectedCount:1,outcome:'selected'});assert.equal(feed.items[0]!.verdict,'SELECT');
  const http=await app.inject({url:'/api/arxiv/items'});assert.equal(http.statusCode,200);assert.equal(http.json().items.length,1);
  globalThis.fetch=originalFetch;assert.equal((await collect())!.status,'unchanged');assert.equal((await analyzePendingArxiv({limit:3})).analyzed,0);assert.equal(server.hits(),hits);
  await assert.rejects(api.composeArxivDailyReport({issueDate:'2026-02-30'}),/date|calendar/i);await assert.rejects(api.composeArxivDailyReport({issueDate:'2026-1-01'}),/date|YYYY/i);
  const empty=await api.composeArxivDailyReport({issueDate:'2000-01-01'});assert.equal(empty.report.paper_count,0);assert.equal((await loadArxivFeed({page:1,pageSize:20,category:null})).latestBatch!.outcome,'no_new_papers');assert.equal((await loadArxivFeed({page:1,pageSize:20,category:null})).total,1);
  await collectFixture(2);assert.equal((await analyzePendingArxiv({limit:3,model:'default'})).analyzed,3);
  const revised=await api.composeArxivDailyReport({issueDate:first.report.issue_date});assert.notEqual(revised.runId,first.runId);assert.equal(revised.report.paper_count,3);assert.deepEqual(revised.report.counts,{SELECT:1,REVIEW:1,DEFER:1});assert.equal(revised.report.items[0].arxiv_id,'2601.00001v2');
  assert.equal(first.report.input_sha256,(await import('../packages/backend/src/arxiv/store.ts')).reportDigest(before.map(p=>p.paper)));
  await sql`UPDATE arxiv_papers SET generated_at=(${first.report.issue_date}::date::timestamp AT TIME ZONE 'Asia/Shanghai') - interval '1 second' WHERE base_id='2601.00003'`;
  assert.equal((await api.composeArxivDailyReport({issueDate:first.report.issue_date})).report.paper_count,2);
  await sql`UPDATE arxiv_papers SET paper=jsonb_set(paper,'{verdict}','"INVALID"'::jsonb) WHERE base_id='2601.00002'`;
  await assert.rejects(api.composeArxivDailyReport({issueDate:first.report.issue_date}),/verdict/);
  const reportCount=(await sql`SELECT count(*) AS n FROM arxiv_reports`)[0]!.n;
  await sql`INSERT INTO arxiv_papers(paper_key,base_id,version,generated_at,run_id,paper) SELECT 'arxiv:2602.'||lpad(n::text,5,'0'),'2602.'||lpad(n::text,5,'0'),1,now(),p.run_id,p.paper FROM arxiv_papers p CROSS JOIN generate_series(1,1001) n WHERE p.base_id='2601.00001'`;
  await assert.rejects(api.composeArxivDailyReport({issueDate:first.report.issue_date}),/exceeds|1000|overflow/i);
  assert.equal((await sql`SELECT count(*) AS n FROM arxiv_reports`)[0]!.n,reportCount);
 } finally {globalThis.fetch=originalFetch;await app.close();await server.close();await closeDb();}
});
