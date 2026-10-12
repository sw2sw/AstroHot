import './setup.ts';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import { sql,closeDb } from '../packages/backend/src/db.ts';
import {chatJson} from '../packages/backend/src/providers/llm.ts';
import {acquireModelPermit,releaseModelPermit} from '../packages/backend/src/providers/model-limit.ts';
import {ProviderRejectedError,ReceiptUnknownError} from '../packages/backend/src/providers/receipts.ts';
import {z} from 'zod';
const count=async()=>Number((await sql`SELECT count(*) AS n FROM model_permits WHERE token IS NOT NULL`)[0]!.n);
const reset=()=>sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL`;
after(async()=>{await reset();await closeDb();});
test('independent: two real processes share four normal permits, poolmax1, receipt reuse and safe busy',async()=>{
 await reset(); let active=0,max=0,hits=0;
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{hits++;active++;max=Math.max(max,active);setTimeout(()=>{active--;res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));},160);});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as {port:number}).port;
 const env={...process.env,SILICONFLOW_BASE_URL:`http://127.0.0.1:${port}`,SILICONFLOW_REQUESTS_PER_MINUTE:'60000',SILICONFLOW_MAX_CONCURRENT:'4',DATABASE_POOL_MAX:'1',LLM_BASE_URL:`http://127.0.0.1:${port}`,LLM_API_KEY:'local-fake',LLM_MODEL:'qwen3.8:27b',MODEL_CALLS_ENABLED:'true'};
 const run=(purpose:string,tag:string)=>new Promise<{done:number,reused:number}>((resolve,reject)=>{
  const child=spawn(process.execPath,['tests/fixtures/shared-model-client.ts',purpose,tag],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('child timeout'));},10000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error(err+out));else resolve(JSON.parse(out.trim()));});
 });
 const tag=String(Date.now());
 try {
  const results=await Promise.all([run('news',tag),run('arxiv-analysis',tag)]);
  assert.equal(results.reduce((a,b)=>a+b.done,0),12);assert.equal(hits,12);assert.equal(max,4);assert.equal(await count(),0);
  const reuse=await Promise.all([run('news',tag),run('arxiv-analysis',tag)]);
  assert.equal(reuse.reduce((a,b)=>a+b.reused,0),12);assert.equal(hits,12);assert.equal(await count(),0);
  Object.assign(process.env,env);
  const held=await Promise.all(Array.from({length:4},(_,i)=>acquireModelPermit('test',String(i))));
  const user=`busy-${tag}`;
  await assert.rejects(chatJson({model:'default',purpose:'independent-busy',subject:user,promptVersion:'v1',system:'',user,schema:z.object({ok:z.boolean()})}),ProviderRejectedError);
  assert.equal(hits,12);assert.equal((await sql`SELECT status FROM receipts WHERE subject=${user}`).length,0);
  await Promise.all(held.map(releaseModelPermit));
  const timeout=`timeout-${tag}`;
  await assert.rejects(chatJson({model:'default',purpose:'independent-timeout',subject:timeout,promptVersion:'v1',system:'',user:timeout,schema:z.object({ok:z.boolean()}),timeoutMs:50}),ReceiptUnknownError);
  assert.equal(await count(),1);assert.equal((await sql`SELECT state FROM model_permits WHERE token IS NOT NULL`)[0]!.state,'quarantined');
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${timeout}`)[0]!.status,'unknown');
  console.log(JSON.stringify({processes:2,calls:12,reused:12,maxUpstreamConcurrent:max,poolMaxPerChild:1,busyNoSend:true,timeoutQuarantined:true}));
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await reset();}
});
