import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { ensureQueue, getBoss, recordRun, stopBoss } from '../packages/backend/src/jobs/queue.ts';
import { ingestRawArxivCollection } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { gate, stub } from './setup.ts';

async function until(check: () => Promise<boolean>, seconds = 80) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await check())) { assert.ok(Date.now() < deadline, 'bounded wait expired'); await delay(100); }
}

test('real cron drops ticks across a minute-long batch, drains 20/20/5 and idle calls no model', { timeout: 190_000 }, async () => {
  Object.assign(process.env, { ARXIV_ANALYSIS_ENABLED: 'true', MODEL_CALLS_ENABLED: 'true', COLLECT_ENABLED: 'false' });
  const { SCHEDULES, scheduleQueueOptions } = await import('../apps/worker/src/schedules.ts');
  const entry = SCHEDULES.find(s => s.name === 'arxiv.analyze')!;
  const queue = entry.queue!;
  const entered = gate(), release = gate();
  let occupied = 0, maxOccupied = 0, callbacks = 0, maxCallbacks = 0;
  const results: number[] = [];
  const provider = await stub(async hit => {
    occupied++; maxOccupied = Math.max(maxOccupied, occupied);
    const [slots] = await sql`SELECT count(*)::int n FROM model_permits WHERE token IS NOT NULL`;
    assert.ok(slots!.n <= 4, 'six physical slots retain two-slot headroom');
    if (hit === 1) { entered.open(); await release.promise; }
    occupied--;
    return { choices: [{ message: { content: JSON.stringify({ title_zh:'宇宙研究', summary_zh:'假数据验证，不是真实论文。', reason_zh:'摘要观测结果有待核验。', verdict:'REVIEW', study_type:'observation', evidence_excerpt_index:0, fulltext_review_question:'误差如何控制？' }) } }] };
  });
  Object.assign(process.env, { LLM_BASE_URL: provider.url, LLM_API_KEY: 'synthetic-only', LLM_MODEL: 'synthetic-model' });
  const boss = await getBoss();
  try {
    const raw_atom = `<feed xmlns="http://www.w3.org/2005/Atom">${Array.from({length:45},(_,i)=>`<entry><id>https://arxiv.org/abs/2610.${String(80000+i).padStart(5,'0')}v1</id><title>Synthetic fixture ${i}</title><summary>Original abstract ${i}.</summary><published>2026-10-16T00:00:00Z</published><updated>2026-10-16T00:00:00Z</updated><author><name>Synthetic</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
    await ingestRawArxivCollection({raw_atom,papers:parseArxivAtom(raw_atom),collected_at_utc:'2026-10-16T00:00:00Z'});
    await ensureQueue(queue, scheduleQueueOptions(entry));
    assert.equal((await boss.getQueue(queue))!.policy, 'exclusive');
    assert.equal((await boss.getQueue(queue))!.retryLimit, 0);
    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => {
      callbacks++; maxCallbacks = Math.max(maxCallbacks, callbacks);
      try { const out = await recordRun(entry.name, entry.run) as { analyzed: number }; results.push(out.analyzed); return out; }
      finally { callbacks--; }
    });
    await boss.schedule(queue, entry.cron, {}, {tz:'Asia/Shanghai',missed:'skip'});
    assert.ok(await boss.send(queue, {})); // deterministic first tick; subsequent tick is the real clock cron.
    await entered.promise;
    const refused = await Promise.all(Array.from({length:80},()=>boss.send(queue,{})));
    assert.ok(refused.every(id=>id===null), 'active batch must not accumulate queued minute ticks');
    await delay(65_000); // crosses at least one real cron minute while the model response stays in flight.
    const [during] = await sql`SELECT count(*)::int n, count(*) FILTER (WHERE state='active')::int active FROM pgboss.job WHERE name=${queue} AND state <= 'active'`;
    assert.equal(during!.n,1); assert.equal(during!.active,1);
    release.open();
    await until(async()=>results.length>=2, 85); // real following minute starts the second batch.
    assert.deepEqual(results,[20,20]);
    await until(async()=>callbacks===0);
    await until(async()=> (await boss.send(queue,{})) !== null);
    await until(async()=>results.length>=3);
    assert.deepEqual(results,[20,20,5]);
    await until(async()=> (await boss.send(queue,{})) !== null);
    await until(async()=>results.length>=4);
    assert.deepEqual(results,[20,20,5,0]); assert.equal(provider.hits(),45);
    assert.equal(maxCallbacks,1); assert.equal(maxOccupied,1);
    const [saved]=await sql`SELECT count(*)::int n FROM arxiv_raw_papers WHERE analysis_status='analyzed'`;
    const [receipts]=await sql`SELECT count(*)::int n FROM receipts WHERE status='completed' AND purpose='arxiv-analysis'`;
    assert.equal(saved!.n,45); assert.equal(receipts!.n,45);
    console.log(JSON.stringify({batches:results,fakeModelHits:provider.hits(),maxCallbacks,maxOccupied,activeAndQueuedDuringHeldMinute:during!.n,naturalCronContinuation:true}));
  } finally {
    release.open(); await boss.unschedule(queue); await stopBoss(); await provider.close(); await closeDb();
  }
});
