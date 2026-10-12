import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRun } from '../packages/backend/src/jobs/queue.ts';
import { sql,closeDb } from '../packages/backend/src/db.ts';
test('arxiv scheduled health cannot report ok when individual papers failed',async()=>{
 try{
 const result={analyzed:1,failed:1,skipped:0,failures:[{arxivId:'2610.00001v1',code:'model_output_invalid'}]};
 await recordRun('arxiv.analyze',async()=>result);
 const row=(await sql`SELECT status,detail,error FROM job_runs WHERE job='arxiv.analyze' ORDER BY id DESC LIMIT 1`)[0]!;
 assert.equal(row.status,'failed');assert.deepEqual(row.detail,result);assert.ok(row.error);
 await recordRun('arxiv.analyze',async()=>({analyzed:1,failed:0,skipped:0,failures:[]}));
 assert.equal((await sql`SELECT status FROM job_runs WHERE job='arxiv.analyze' ORDER BY id DESC LIMIT 1`)[0]!.status,'ok');
 await recordRun('other.mock',async()=>({failed:1}));
 assert.equal((await sql`SELECT status FROM job_runs WHERE job='other.mock' ORDER BY id DESC LIMIT 1`)[0]!.status,'ok','do not reinterpret unrelated task result contracts');
 }finally{await closeDb();}
});
