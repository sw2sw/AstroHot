import './setup.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { stub } from './setup.ts';
import http from 'node:http';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { modelFetch } from '../packages/backend/src/providers/model-limit.ts';
import * as limiter from '../packages/backend/src/providers/model-limit.ts';
import { providerPacing, tryProviderPermit, paceAfterResponse } from '../packages/backend/src/providers/provider-pacing.ts';
import { paidRequest } from '../packages/backend/src/providers/receipts.ts';

const reset = async () => {
  await sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL`;
  await sql`DELETE FROM settings WHERE key LIKE 'provider_pacing:%'`;
};
after(async () => { await reset(); await closeDb(); });

test('provider matching is exact and rejects overlapping configured origins', () => {
  assert.match(providerPacing(new URL('https://api.agnes-ai.cn.evil.invalid/v1'))!.name, /^origin:/);
  assert.match(providerPacing(new URL('https://api.siliconflow.cn.evil.invalid/v1'))!.name, /^origin:/);
  assert.equal(providerPacing(new URL('https://api.agnes-ai.cn/v1'))?.name, 'agnes');
  process.env.AGNES_BASE_URL = 'http://127.0.0.1:12345/v1';
  process.env.SILICONFLOW_BASE_URL = 'http://127.0.0.1:12345/other';
  try { assert.throws(() => providerPacing(new URL(process.env.AGNES_BASE_URL!)), /ambiguous/); }
  finally { delete process.env.AGNES_BASE_URL; delete process.env.SILICONFLOW_BASE_URL; }
});

test('a loopback origin keeps the conservative default spacing unless the environment lowers it', () => {
  const saved = process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS;
  try {
    delete process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS;
    for (const host of ['http://127.0.0.1:8123/v1', 'http://localhost:8123/v1', 'http://[::1]:8123/v1']) {
      const policy = providerPacing(new URL(host));
      assert.match(policy.name, /^origin:/);
      assert.equal(policy.intervalMs, 10_000, `${host} must not be sped up without an explicit setting`);
    }
    process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS = '0';
    assert.equal(providerPacing(new URL('http://127.0.0.1:8123/v1')).intervalMs, 0);
    process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS = 'not-a-number';
    assert.throws(() => providerPacing(new URL('http://127.0.0.1:8123/v1')), /MODEL_LOOPBACK_ORIGIN_INTERVAL_MS/);
  } finally {
    if (saved === undefined) delete process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS;
    else process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS = saved;
  }
});

test('provider cooldown is isolated while quarantine still holds provider concurrency', async () => {
  await reset();
  const agnes = { name: 'agnes' as const, intervalMs: 1, maxConcurrent: 1 };
  const siliconflow = { name: 'siliconflow' as const, intervalMs: 1, maxConcurrent: 1 };
  const first = await tryProviderPermit(agnes, 'quarantine', 'one');
  assert.ok(first.token);
  await limiter.quarantineModelPermit(first.token);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await tryProviderPermit(agnes, 'another-model', 'two')).token, undefined);
  await paceAfterResponse(agnes, '60');
  const other = await tryProviderPermit(siliconflow, 'embedding', 'three');
  assert.ok(other.token, 'Agnes cooldown must not block SiliconFlow');
  assert.equal((await sql`SELECT token FROM model_permits WHERE token IS NOT NULL`).length, 2);
  await limiter.releaseModelPermit(first.token);
  await limiter.releaseModelPermit(other.token);
  assert.equal((await tryProviderPermit(agnes, 'rerank', 'four')).token, undefined, 'release must not clear cooldown');
});

test('provider and global slot admission is atomic when the normal four slots are held', async () => {
  await reset();
  const tokens = await Promise.all(Array.from({ length: 4 }, (_, i) => limiter.acquireModelPermit('full', String(i))));
  const provider = { name: 'agnes' as const, intervalMs: 10_000, maxConcurrent: 1 };
  assert.equal((await tryProviderPermit(provider, 'blocked', 'one')).token, undefined);
  assert.equal((await sql`SELECT key FROM settings WHERE key='provider_pacing:agnes'`).length, 0);
  await limiter.releaseModelPermit(tokens[0]!);
  const admitted = await tryProviderPermit(provider, 'free', 'two');
  assert.ok(admitted.token);
  await Promise.all([...tokens.slice(1), admitted.token].map(limiter.releaseModelPermit));
});

test('Agnes shares spacing across models, keys and purposes', async () => {
  await reset();
  const times: number[] = [];
  const server = await stub(() => { times.push(Date.now()); return {ok:true}; });
  process.env.AGNES_BASE_URL = server.url;
  process.env.AGNES_REQUESTS_PER_MINUTE = '240';
  try {
    await Promise.all(['news','arxiv','vision'].map((purpose, i) => modelFetch(`${server.url}/v1/chat/completions`, {
      method:'POST',body:JSON.stringify({model:`different-${i}`}),headers:{'x-test-key':`fake-${i}`},
    }, purpose, String(i))));
    assert.equal(server.hits(),3);
    for (let i=1; i<times.length; i++) assert.ok(times[i]! - times[i-1]! >= 220, `requests only ${times[i]! - times[i-1]!}ms apart`);
  } finally { delete process.env.AGNES_BASE_URL; await server.close(); }
});

test('429 cooldown blocks another purpose and retry across the provider', async () => {
  await reset();
  let hits=0;
  const server=http.createServer((req,res)=>{req.resume(); hits++; res.writeHead(429, {'retry-after':'3'});res.end('limited');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.env.SILICONFLOW_BASE_URL=url;
  process.env.SILICONFLOW_REQUESTS_PER_MINUTE='600';
  try {
    const first=await modelFetch(url, {method:'POST',body:'{}'}, 'embedding','one');
    assert.equal(first.res.status,429);
    await assert.rejects(modelFetch(url, {method:'POST',body:'{}'}, 'reranker','two'), /within/);
    assert.equal(hits,1);
    const [row]=await sql<{value:{cooldownUntil:number}}[]>`SELECT value FROM settings WHERE key='provider_pacing:siliconflow'`;
    assert.ok(row!.value.cooldownUntil > Date.now()+1000);
  } finally {delete process.env.SILICONFLOW_BASE_URL;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('pre-receipt admission refuses cooldown without generating receipt attempts', async () => {
  await reset();
  assert.equal(typeof limiter.withModelAdmission, 'function', 'pre-receipt admission API missing');
  const server=await stub(()=>({ok:true}));
  process.env.AGNES_BASE_URL=server.url;
  process.env.AGNES_REQUESTS_PER_MINUTE='6';
  try {
    const invoke=(subject:string)=>limiter.withModelAdmission(server.url, 'pacing-receipt', subject, () => paidRequest({
      service:'llm',purpose:'pacing-receipt',subject,identity:{subject},
    }, async()=>{
      const {text}=await modelFetch(server.url,{method:'POST',body:'{}'},'pacing-receipt',subject);
      return {response:JSON.parse(text)};
    }));
    const tag=String(Date.now());
    await invoke(`first-${tag}`);
    await assert.rejects(invoke(`blocked-${tag}`), /within/);
    const [row]=await sql<{n:number}[]>`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=${`blocked-${tag}`}`;
    assert.equal(row!.n,0);
    assert.equal(server.hits(),1);
    assert.equal((await sql`SELECT token FROM model_permits WHERE token IS NOT NULL`).length,0);
  } finally {delete process.env.AGNES_BASE_URL;await server.close();}
});


test('dispatch timeout is created after provider queue wait', async () => {
  await reset();
  const server=await stub(()=>({ok:true}));
  process.env.AGNES_BASE_URL=server.url;
  process.env.AGNES_REQUESTS_PER_MINUTE='240';
  let createdAt=0;
  try {
    await modelFetch(server.url,{method:'POST',body:'{}'},'signal','first');
    const start=Date.now();
    await modelFetch(server.url, {method:'POST',body:'{}',signal:()=>{createdAt=Date.now();return AbortSignal.timeout(150);}},'signal','second');
    assert.ok(createdAt-start>=220, 'timeout started before queue wait');
    assert.equal(server.hits(),2);
    assert.equal((await sql`SELECT token FROM model_permits WHERE token IS NOT NULL`).length,0);
  } finally {delete process.env.AGNES_BASE_URL;await server.close();}
});


test('bounded admission exposes requeue delay without taking any global slot', async () => {
  await reset();
  const server=await stub(()=>({ok:true}));
  process.env.AGNES_BASE_URL=server.url;
  process.env.AGNES_REQUESTS_PER_MINUTE='6';
  try {
    await modelFetch(server.url,{method:'POST',body:'{}'},'requeue','first');
    const [clock]=await sql<{ms:number}[]>`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms`;
    await sql`UPDATE settings SET value=jsonb_set(value,'{cooldownUntil}',${sql.json(Number(clock!.ms)+60_000)}) WHERE key='provider_pacing:agnes'`;
    await assert.rejects(modelFetch(server.url,{method:'POST',body:'{}'},'requeue','second'), (error:unknown)=>{
      assert.ok(error instanceof limiter.ModelLimitBusyError);
      assert.ok(error.retryAfterSeconds>=58);
      return true;
    });
    assert.equal(server.hits(),1);
    assert.equal((await sql`SELECT token FROM model_permits WHERE token IS NOT NULL`).length,0);
  } finally {delete process.env.AGNES_BASE_URL;await server.close();}
});


test('SiliconFlow embedding then reranker can use the shared 30RPM admission without falling back on ordinary spacing', async () => {
  await reset();
  const server=await stub(()=>({ok:true}));
  process.env.SILICONFLOW_BASE_URL=server.url;
  process.env.SILICONFLOW_REQUESTS_PER_MINUTE='30';
  try {
    const invoke=(purpose:string)=>limiter.withModelAdmission(server.url,purpose,purpose,()=>paidRequest({
      service:'llm',purpose,subject:purpose,identity:{purpose,nonce:Date.now()},
    },async()=>{
      const {text}=await modelFetch(server.url,{method:'POST',body:'{}',signal:()=>AbortSignal.timeout(500)},purpose,purpose);
      return {response:JSON.parse(text)};
    }));
    await invoke('sf-embedding');
    await invoke('sf-rerank');
    assert.equal(server.hits(),2);
    assert.equal((await sql`SELECT token FROM model_permits WHERE token IS NOT NULL`).length,0);
  } finally {delete process.env.SILICONFLOW_BASE_URL;delete process.env.SILICONFLOW_REQUESTS_PER_MINUTE;await server.close();}
});
