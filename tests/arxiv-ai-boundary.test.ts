import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {ingestRawArxivCollection} from '../packages/backend/src/arxiv/raw-store.ts';
import {parseArxivAtom} from '../packages/backend/src/arxiv/collect.ts';
import Fastify from 'fastify';
import {registerArxiv} from '../apps/api/src/routes/arxiv.ts';
test('independent two-process news plus actual raw arxiv analysis share four normal slots with poolmax1',async()=>{
 await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches, arxiv_reports, arxiv_papers CASCADE`;
 await sql`DELETE FROM receipts`;
 let active=0,peak=0,hits=0;
 const answer={title_zh:'宇宙观测研究',summary_zh:'摘要描述宇宙观测。',reason_zh:'需要全文核查。',verdict:'REVIEW',study_type:'observation',evidence_excerpt_index:0,fulltext_review_question:'如何控制系统误差？'};
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{hits++;active++;peak=Math.max(peak,active);const arxiv=JSON.parse(body).messages.some((m:any)=>m.content.includes('evidence_excerpt_index'));setTimeout(()=>{active--;res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(arxiv?{...answer,verdict:body.includes('2601.00020v1')?'SELECT':'REVIEW'}:{ok:true})}}]}));},300);});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as {port:number}).port;
 const raw_atom=`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${Array.from({length:6},(_,i)=>`<entry><id>http://arxiv.org/abs/2601.${String(i+20).padStart(5,'0')}v1</id><title>Original title</title><summary>Original abstract</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
 await ingestRawArxivCollection({raw_atom,papers:parseArxivAtom(raw_atom),collected_at_utc:'2026-01-03T12:00:00Z'});
 // Local fake named origin uses fast spacing so this checks shared soft-cap concurrency,
 // while model-headroom/provider-pacing suites independently check conservative default pacing.
 const env={...process.env,DATABASE_POOL_MAX:'1',LLM_BASE_URL:`http://127.0.0.1:${port}`,AGNES_BASE_URL:`http://127.0.0.1:${port}`,AGNES_REQUESTS_PER_MINUTE:'60000',AGNES_MAX_CONCURRENT:'4',LLM_API_KEY:'local-fake',LLM_MODEL:'qwen3.8:27b',MODEL_CALLS_ENABLED:'true',ARXIV_ANALYSIS_ENABLED:'true'};
 const run=(mode:string)=>new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,['tests/fixtures/arxiv-ai-client.ts',mode,'boundary'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('child timeout'));},15000);p.on('exit',code=>{clearTimeout(timer);code?reject(Error(err+out)):resolve(JSON.parse(out.trim()));});p.on('error',reject);});
 try {
  const [news,arxiv]=await Promise.all([run('news'),run('arxiv')]);
  assert.equal(news.done,5);assert.equal(arxiv.analyzed,6);assert.equal(arxiv.failed,0);assert.equal(hits,11);assert.equal(peak,4);
  assert.equal((await sql`SELECT count(*) AS n FROM arxiv_papers`)[0]!.n,6);
  assert.equal((await sql`SELECT count(*) AS n FROM arxiv_raw_papers WHERE analysis_status='analyzed'`)[0]!.n,6);
  assert.equal((await sql`SELECT count(*) AS n FROM model_permits WHERE token IS NOT NULL`)[0]!.n,0);
  const app=Fastify();registerArxiv(app);
  try {
   const before=hits;
   const response=await app.inject({method:'GET',url:'/api/arxiv/items'});
   assert.equal(response.statusCode,200);const feed=response.json();
   assert.equal(feed.total,1);assert.equal(feed.items.length,1);
   assert.equal(feed.items[0].arxiv_id,'2601.00020v1');assert.equal(feed.items[0].verdict,'SELECT');
   assert.equal(feed.items[0].publication_status,'candidate_only');assert.match(feed.note,/未阅读全文/);
   assert.equal(hits,before,'public read must not trigger model calls');
  } finally {await app.close();}
  assert.equal((await sql`SELECT count(*) AS n FROM receipts WHERE purpose='arxiv-analysis' AND status='completed'`)[0]!.n,6);
  const replay=await run('news');assert.equal(replay.reused,5);assert.equal((await run('arxiv')).analyzed,0);assert.equal(hits,11);
  console.log(JSON.stringify({processes:2,poolMaxPerChild:1,actualArxivAnalyzed:6,newsCalls:5,httpCalls:11,peakConcurrent:peak,newsReceiptReplay:5,arxivDedupeNoHttp:true}));
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await closeDb();}
});
