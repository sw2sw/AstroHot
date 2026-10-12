import './setup.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { paidRequest } from '../packages/backend/src/providers/receipts.ts';
import { spawn } from 'node:child_process';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { providerPacing, tryProviderPermit } from '../packages/backend/src/providers/provider-pacing.ts';
import { acquireModelPermit, releaseModelPermit, quarantineModelPermit, MODEL_PERMIT_LIMIT, modelFetch, withModelAdmission, ModelLimitBusyError } from '../packages/backend/src/providers/model-limit.ts';
const reset = async () => {
  await sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL`;
  await sql`DELETE FROM settings WHERE key LIKE 'provider_pacing:%'`;
};
after(async () => { await reset(); await closeDb(); });
test('unknown origins share conservative protection across model paths', () => {
  const one = providerPacing(new URL('https://chatapi.weixin.qq.com/openai/v1'));
  assert.ok(one, 'unconfigured model origin must be protected');
  assert.equal(one.name, providerPacing(new URL('https://chatapi.weixin.qq.com/other/model'))?.name);
  assert.notEqual(one.name, providerPacing(new URL('https://another.invalid/v1'))?.name);
  assert.equal(one.maxConcurrent, 2);
  assert.equal(one.intervalMs, 10000);
  assert.throws(() => providerPacing(new URL('https://user:secret@example.invalid')), /userinfo/);
});
test('all provider URLs reject userinfo and generic concurrency is configurable only within soft4', () => {
  for (const url of ['https://user:secret@api.agnes-ai.cn/v1', 'https://user@api.siliconflow.cn/v1', 'ftp://api.agnes-ai.cn/v1']) {
    assert.throws(() => providerPacing(new URL(url)), /http|userinfo/);
  }
  try {
    for (const value of ['1', '2', '3', '4']) {
      process.env.MODEL_ORIGIN_MAX_CONCURRENT = value;
      assert.equal(providerPacing(new URL('https://config.invalid/v1')).maxConcurrent, Number(value));
    }
    for (const value of ['0', '5', '6', '1.5', '1e0', ' 1', '-1']) {
      process.env.MODEL_ORIGIN_MAX_CONCURRENT = value;
      assert.throws(() => providerPacing(new URL('https://config.invalid/v1')), /positive integer|at most/);
    }
  } finally { delete process.env.MODEL_ORIGIN_MAX_CONCURRENT; }
});
test('invalid named base configuration fails closed even for the official hostname', () => {
  try {
    for (const value of ['not a URL', 'ftp://api.agnes-ai.cn', 'https://user:secret@api.agnes-ai.cn']) {
      process.env.AGNES_BASE_URL = value;
      assert.throws(() => providerPacing(new URL('https://api.agnes-ai.cn/v1')), /http|userinfo/);
    }
  } finally { delete process.env.AGNES_BASE_URL; }
});
test('legacy global admission leaves two physical slots spare', async () => {
  await reset();
  const outcomes = await Promise.allSettled(Array.from({length:12}, (_, i) => acquireModelPermit('news', String(i), {waitMs:0})));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal((await sql`SELECT * FROM model_permits`).length, MODEL_PERMIT_LIMIT);
});
test('quarantine in physical slots five and six counts against normal soft cap', async () => {
  await reset();
  await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined' WHERE slot IN (5,6)`;
  const outcomes = await Promise.allSettled(Array.from({length:8}, (_, i) => acquireModelPermit('arxiv', String(i), {waitMs:0})));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal((await sql`SELECT * FROM model_permits WHERE token IS NOT NULL`).length, 4);
  assert.equal((await sql`SELECT * FROM model_permits WHERE state='quarantined'`).length, 2);
});

const worker = (origin: string) => new Promise<string[]>((resolve,reject) => {
  const child = spawn(process.execPath, ['tests/fixtures/model-headroom-client.ts', origin], {env:{...process.env,DATABASE_POOL_MAX:'1'},stdio:['ignore','pipe','pipe']});
  let out='', err='';
  child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>err+=d);
  child.on('error',reject); child.on('exit',code=>code===0?resolve(JSON.parse(out.trim())):reject(Error(err+out)));
});
test('two real workers share per-origin two and cross-origin four pools', async () => {
  await reset();
  const same = await Promise.all([worker('https://shared.invalid/v1'),worker('https://shared.invalid/another-model')]);
  assert.equal(same.flat().length,2);
  await reset();
  const different = await Promise.all([worker('https://one.invalid/v1'),worker('https://two.invalid/v1'),worker('https://three.invalid/v1')]);
  assert.equal(different.flat().length,4);
  assert.equal((await sql`SELECT * FROM model_permits WHERE token IS NOT NULL`).length,4);
});
test('named provider invalid concurrency and numeric formats fail closed', () => {
  for (const value of ['6','5','0','-1','1.5','1e0',' 1','']) {
    process.env.AGNES_MAX_CONCURRENT=value;
    if(value==='') continue; // Existing empty env retains default.
    assert.throws(()=>providerPacing(new URL('https://api.agnes-ai.cn')), /positive integer|concurrent|exceed|limit/i);
  }
  delete process.env.AGNES_MAX_CONCURRENT;
});

test('generic 429 cooldown crosses models before receipts or timeout creation', async () => {
  await reset();
  const original=globalThis.fetch;
  let hits=0, factories=0;
  globalThis.fetch=async()=>{hits++;return new Response('limited',{status:429,headers:{'retry-after':'60'}});};
  try {
    const url='https://cooldown.invalid/v1';
    const result=await modelFetch(url,{method:'POST',body:'{}',signal:()=>{factories++;return AbortSignal.timeout(100);}},'model-one','first');
    assert.equal(result.res.status,429);
    await assert.rejects(withModelAdmission('https://cooldown.invalid/another-model','model-two','blocked-generic',()=>paidRequest({service:'llm',purpose:'model-two',subject:'blocked-generic',identity:{test:true}},async()=>{
      const {text}=await modelFetch('https://cooldown.invalid/another-model',{method:'POST',body:'{}',signal:()=>{factories++;return AbortSignal.timeout(100);}},'model-two','blocked-generic');
      return {response:text};
    })),(error:unknown)=>{assert.ok(error instanceof ModelLimitBusyError);assert.ok(error.retryAfterSeconds>=48);return true;});
    assert.equal(hits,1); assert.equal(factories,1);
    assert.equal((await sql`SELECT * FROM receipts WHERE subject='blocked-generic'`).length,0);
    assert.equal((await sql`SELECT * FROM model_permits WHERE token IS NOT NULL`).length,0);
  } finally {globalThis.fetch=original;}
});

test('generic quarantined tokens block same origin without expiry', async () => {
  await reset();
  const provider=providerPacing(new URL('https://quarantine.invalid/v1'))!;
  provider.intervalMs=0;
  const first=await tryProviderPermit(provider,'news-model','one');
  const second=await tryProviderPermit(provider,'arxiv-model','two');
  assert.ok(first.token);assert.ok(second.token);
  await quarantineModelPermit(first.token);await quarantineModelPermit(second.token);
  await sql`UPDATE model_permits SET acquired_at=now()-interval '10 days' WHERE token IS NOT NULL`;
  assert.equal((await tryProviderPermit(provider,'third-model','three')).token,undefined);
  assert.equal((await sql`SELECT * FROM model_permits WHERE state='quarantined'`).length,2);
});
test('mixed named, generic and legacy concurrent admission shares one global soft4', async () => {
  await reset();
  const policies = ['https://api.agnes-ai.cn', 'https://api.siliconflow.cn', 'https://mixed.invalid'].map(url => ({ ...providerPacing(new URL(url)), intervalMs: 0, maxConcurrent: 4 }));
  await Promise.all(Array.from({ length: 24 }, async (_, i) => {
    if (i % 4 === 3) {
      try { await acquireModelPermit('mixed', String(i), { waitMs: 0 }); }
      catch (error) { assert.ok(error instanceof ModelLimitBusyError); }
    } else await tryProviderPermit(policies[i % 4]!, 'mixed', String(i));
  }));
  assert.equal((await sql`SELECT * FROM model_permits WHERE token IS NOT NULL`).length, 4);
});
test('generic normal ten-second spacing starts timeout only at send and later work resumes', async () => {
  await reset();
  const original = globalThis.fetch;
  const times: number[] = [];
  let created = 0;
  globalThis.fetch = async () => { times.push(Date.now()); return new Response('{}'); };
  const url = 'https://cadence.invalid/v1';
  try {
    await modelFetch(url, { method: 'POST', body: '{}' }, 'cadence', 'first');
    const start = Date.now();
    await withModelAdmission('https://cadence.invalid/other-model', 'cadence', 'later', async () => {
      return modelFetch('https://cadence.invalid/other-model', { method: 'POST', body: '{}', signal: () => {
        created = Date.now(); return AbortSignal.timeout(100);
      } }, 'cadence', 'later');
    });
    assert.ok(created - start >= 9900);
    assert.ok(times[1]! - times[0]! >= 9900);
    assert.equal(times.length, 2);
    assert.equal((await sql`SELECT * FROM model_permits WHERE token IS NOT NULL`).length, 0);
  } finally { globalThis.fetch = original; }
});
test('full generic admission creates no receipt attempt or request timeout', async () => {
  await reset();
  await Promise.all(Array.from({ length: 4 }, (_, i) => acquireModelPermit('full', String(i), { waitMs: 0 })));
  const original = globalThis.fetch;
  let hits = 0, factories = 0;
  globalThis.fetch = async () => { hits++; return new Response('{}'); };
  try {
    await assert.rejects(withModelAdmission('https://full.invalid/v1', 'full-generic', 'full-generic', () => paidRequest({
      service: 'llm', purpose: 'full-generic', subject: 'full-generic', identity: {},
    }, async () => {
      const { text } = await modelFetch('https://full.invalid/v1', { method: 'POST', body: '{}', signal: () => {
        factories++; return AbortSignal.timeout(100);
      } }, 'full-generic', 'full-generic');
      return { response: text };
    })), (error: unknown) => {
      assert.ok(error instanceof ModelLimitBusyError); assert.equal(error.retryable, true); assert.ok(error.retryAfterSeconds >= 1); return true;
    });
    assert.equal(hits, 0); assert.equal(factories, 0);
    assert.equal((await sql`SELECT * FROM receipts WHERE subject='full-generic'`).length, 0);
  } finally { globalThis.fetch = original; }
});
test('six preexisting quarantined rows remain untouched and reject normal claims', async () => {
  await reset();
  await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined',acquired_at=now()-interval '10 days'`;
  await assert.rejects(acquireModelPermit('another-model','blocked',{waitMs:0}),ModelLimitBusyError);
  assert.equal((await sql`SELECT * FROM model_permits WHERE state='quarantined' AND token IS NOT NULL`).length,6);
});
