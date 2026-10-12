import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { sql, closeDb } from '../packages/backend/src/db.ts';
const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>100</opensearch:itemsPerPage><entry><id>http://arxiv.org/abs/2601.00001v1</id><title>Original title</title><summary>Original abstract</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry></feed>`;
test('native job guards, exact raw persistence, dedupe and failed feed are AI-free', async () => {
 const api = await import('../packages/backend/src/arxiv/collect-job.ts');
 const originalFetch = globalThis.fetch;
 let forbidden = 0;
 globalThis.fetch = async () => { forbidden++; throw new Error('No model or external HTTP permitted'); };
 try {
  await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches, arxiv_reports, arxiv_papers CASCADE`;
  await sql`DELETE FROM receipts`;
  let fetches = 0;
  const emptyRss='<rss version="2.0"><channel><title>astro-ph</title></channel></rss>';
  const fake: typeof fetch = async (url) => { fetches++; const parsed=new URL(String(url)); if(parsed.hostname==='rss.arxiv.org') return new Response(emptyRss); assert.equal(parsed.searchParams.get('max_results'), '100'); return new Response(xml); };
  const realDb = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://127.0.0.1:1/disabled_test';
  for (const [collect,native] of [[undefined,undefined],['false','true'],['true','false'],['1','true'],['true','1'],['TRUE','true'],['true','TRUE']]) {
   if (collect === undefined) delete process.env.COLLECT_ENABLED; else process.env.COLLECT_ENABLED = collect;
   if (native === undefined) delete process.env.ARXIV_NATIVE_COLLECT_ENABLED; else process.env.ARXIV_NATIVE_COLLECT_ENABLED = native;
   await api.collectAndStoreArxiv({fetch:fake});
  }
  process.env.DATABASE_URL = realDb;
  assert.equal(fetches,0); assert.equal(forbidden,0);
  process.env.COLLECT_ENABLED = 'true'; process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
  const first = await api.collectAndStoreArxiv({fetch:fake});
  assert.equal(first!.status,'imported');
  const batches = await sql`SELECT * FROM arxiv_raw_batches`;
  const papers = await sql`SELECT * FROM arxiv_raw_papers`;
  assert.equal(batches.length,1); assert.equal(batches[0]!.raw_atom,xml);
  assert.deepEqual(papers[0]!.metadata,parseArxivAtom(xml)[0]);
  assert.equal(papers[0]!.analysis_status,'pending');
  await sql`UPDATE arxiv_raw_papers SET analysis_status='analyzed'`;
  const snapshot = await sql`SELECT * FROM arxiv_raw_papers`;
  assert.equal((await api.collectAndStoreArxiv({fetch:fake}))!.status,'unchanged');
  assert.deepEqual(await sql`SELECT * FROM arxiv_raw_papers`,snapshot);
  assert.deepEqual(await sql`SELECT * FROM arxiv_raw_batches`,batches);
  await assert.rejects(api.collectAndStoreArxiv({fetch:async()=>new Response('unavailable',{status:503})}));
  await assert.rejects(api.collectAndStoreArxiv({fetch:async()=>new Response('<feed>')}));
  assert.deepEqual(await sql`SELECT * FROM arxiv_raw_batches`,batches);
  for (const table of ['arxiv_reports','arxiv_papers','receipts']) assert.equal((await sql`SELECT count(*)::int AS n FROM ${sql(table)}`)[0]!.n,0);
  assert.equal(forbidden,0);
 } finally { globalThis.fetch=originalFetch; await closeDb(); }
});
test('disabled guards cannot load or reach a database in a fresh process', () => {
 const code = `const {collectAndStoreArxiv}=await import('./packages/backend/src/arxiv/collect-job.ts'); let calls=0; for(const [c,n] of [['',''],['false','true'],['true','false'],['1','true'],['true','1'],['TRUE','true'],['true','TRUE']]) {process.env.COLLECT_ENABLED=c;process.env.ARXIV_NATIVE_COLLECT_ENABLED=n;await collectAndStoreArxiv({fetch:async()=>{calls++;throw new Error('fetch forbidden')}});} console.log(calls);`;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DATABASE_URL:'postgres://postgres@127.0.0.1:1/disabled_test'},timeout:5000,encoding:'utf8'}).trim(),'0');
});
test('native schedule requires both literal true flags and offsets analysis', () => {
 const schedules=(collect:string,native:string)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"const {SCHEDULES}=await import('./apps/worker/src/schedules.ts'); console.log(JSON.stringify(SCHEDULES.filter(s=>s.name==='arxiv.collect').map(s=>({name:s.name,cron:s.cron,tz:s.tz,retryLimit:s.retryLimit}))));"],{env:{...process.env,COLLECT_ENABLED:collect,ARXIV_NATIVE_COLLECT_ENABLED:native,MODEL_CALLS_ENABLED:'false'},timeout:10000,encoding:'utf8'}));
 for(const [c,n] of [['false','true'],['true','false'],['1','true'],['true','1'],['',''],['TRUE','true']]) assert.deepEqual(schedules(c!,n!),[]);
 // One first attempt at 01:00 UTC and two retries six hours apart, evaluated in UTC because the
 // daily attempt budget is a UTC-day budget, and no pg-boss retry of its own: an internal retry would
 // run seconds after a failure, outside the spacing and outside the budget.
 assert.deepEqual(schedules('true','true'),[{name:'arxiv.collect',cron:'0 1,7,13 * * *',tz:'UTC',retryLimit:0}]);
});
