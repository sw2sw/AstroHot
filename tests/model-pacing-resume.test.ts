import { stub } from './setup.ts';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { chatJson } from '../packages/backend/src/providers/llm.ts';
import { completeReceipt, paidRequest, ReceiptUnknownError, ReceiptBusyError } from '../packages/backend/src/providers/receipts.ts';
import { providerPacing } from '../packages/backend/src/providers/provider-pacing.ts';
import { ModelLimitBusyError } from '../packages/backend/src/providers/model-limit.ts';
import { upsertMaterial } from '../packages/backend/src/content/materials.ts';
import { processArticle, registerContentJobs } from '../packages/backend/src/jobs/content.ts';
import { getBoss, stopBoss, recordRun, QUEUES } from '../packages/backend/src/jobs/queue.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { ingestRawArxivCollection } from '../packages/backend/src/arxiv/raw-store.ts';
import { setTimeout as delay } from 'node:timers/promises';

let answer: (body: string) => Promise<unknown> = async () => ({ ok: true });
const calls: string[] = [];
const provider = await stub(async (_hit, req) => ({ choices: [{ message: { content: JSON.stringify(await answer(req.body)) } }] }));
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'pacing-fixture';
const opts = { model: 'default', purpose: 'pacing-reuse', subject: 'reuse', promptVersion: 'fixture-v1', system: '', user: 'fixture', schema: z.object({ ok: z.boolean() }) };
const reset = async () => {
  answer = async () => ({ ok: true });
  calls.length = 0;
  await sql`TRUNCATE receipts CASCADE`;
  await sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL`;
  await sql`DELETE FROM settings WHERE key LIKE 'provider_pacing:%'`;
};
beforeEach(reset);
after(async () => { await stopBoss(); await provider.close(); await closeDb(); });

for (const status of ['received', 'completed']) {
  test(`${status} chat receipt is reused without taking capacity or moving pacing`, async () => {
    const hits = provider.hits();
    const first = await chatJson(opts);
    if (status === 'completed') await completeReceipt(sql, first.receiptId);
    await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined',acquired_at=now()-interval '10 days' WHERE slot<=4`;
    const key = `provider_pacing:${providerPacing(new URL(provider.url)).name}`;
    await sql`UPDATE settings SET value=jsonb_set(value,'{cooldownUntil}',to_jsonb((extract(epoch FROM clock_timestamp())*1000+60000)::bigint)) WHERE key=${key}`;
    const permits = await sql`SELECT * FROM model_permits ORDER BY slot`;
    const pacing = await sql`SELECT * FROM settings WHERE key=${key}`;
    const attempts = await sql`SELECT * FROM receipt_attempts ORDER BY id`;
    const reused = await chatJson(opts);
    assert.equal(reused.reused, true);
    assert.equal(reused.receiptId, first.receiptId);
    assert.deepEqual(reused.data, { ok: true });
    assert.equal(provider.hits()-hits, 1);
    assert.deepEqual(await sql`SELECT * FROM receipt_attempts ORDER BY id`, attempts);
    assert.deepEqual(await sql`SELECT * FROM model_permits ORDER BY slot`, permits);
    assert.deepEqual(await sql`SELECT * FROM settings WHERE key=${key}`, pacing);
  });
}


test('new chat identity cannot reserve a receipt or paid attempt while normal capacity is full', async () => {
  const hits = provider.hits();
  await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined' WHERE slot<=4`;
  const permits = await sql`SELECT * FROM model_permits ORDER BY slot`;
  await assert.rejects(chatJson({ ...opts, subject: 'new', user: 'new-identity' }), ModelLimitBusyError);
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT * FROM receipts`).length, 0);
  assert.equal((await sql`SELECT * FROM receipt_attempts`).length, 0);
  assert.deepEqual(await sql`SELECT * FROM model_permits ORDER BY slot`, permits);
});

// Replay the production scheduled handlers with disposable due-times. This is not a cron timing test.
process.env.ARXIV_ANALYSIS_ENABLED = 'true';
async function scheduled(name: string) {
  const { SCHEDULES } = await import('../apps/worker/src/schedules.ts');
  const task = SCHEDULES.find(s => s.name === name)!;
  assert.ok(task);
  return recordRun(task.name, task.run);
}
async function waitFor(check: () => Promise<boolean>) {
  const until = Date.now() + 90_000;
  while (!(await check())) {
    assert.ok(Date.now() < until, 'scheduled retry did not settle');
    await delay(50);
  }
}

test('news sweep resumes partially paid stages after capacity retry without buying them twice', async () => {
  for (const name of ['PREFILTER_MODEL', 'SCORE_MODEL', 'STRUCTURE_MODEL', 'UNDERSTAND_MODEL', 'SUMMARIZE_MODEL']) process.env[name] = 'default';
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES('pacing-news','Pacing','rss','T1','editorial')`;
  const { articleId } = await upsertMaterial({ sourceId: 'pacing-news', url: 'https://example.invalid/pacing',
    title: 'Planet atmosphere measurement', bodyText: 'The team measured a planet atmosphere and published the spectrum with uncertainties. '.repeat(10),
    bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
  answer = async body => {
    const messages = JSON.parse(body).messages;
    const system = String(messages[0]?.content ?? '');
    const step = system.includes('宽召回的天文相关性预筛') ? 'prefilter'
      : system.includes('事件注意力评分器') ? 'score'
      : system.includes('资料结构化助手') ? 'structure' : 'understand';
    calls.push(step);
    if (step === 'prefilter') {
      // Simulate unrelated stuck upstream work appearing after this paid stage finishes.
      await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined',purpose='fixture-held' WHERE token IS NULL AND slot<=5`;
      return { label: 'PASS', reason: 'fixture' };
    }
    if (step === 'score') return { attentionScore: 80 };
    if (step === 'structure') return { scope: 'single', category: 'planets-solar-system', tags: [], subjects: [], fact: null };
    return { itemType: 'research_result', authorRole: 'principal', tags: [], editorialJudgment: '提供了新的观测证据', titleZh: '行星大气观测结果', summaryZh: '研究团队公布了行星大气光谱与测量误差。' };
  };
  const hits = provider.hits();
  assert.equal((await processArticle(articleId)).state, 'waiting');
  const [waiting] = await sql`SELECT processing_attempts,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.equal(waiting!.processing_attempts, 0);
  assert.ok(waiting!.processing_retry_at > new Date());
  assert.equal(provider.hits()-hits, 1);
  assert.equal((await sql`SELECT * FROM receipts`).length, 1);
  assert.equal((await sql`SELECT * FROM receipt_attempts`).length, 1);
  const [saved] = await sql`SELECT id,status FROM receipts`;
  assert.equal(saved!.status, 'received');
  await sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL WHERE purpose='fixture-held'`;
  await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second',created_at=now()-interval '10 minutes' WHERE id=${articleId}`;
  await registerContentJobs(await getBoss());
  for (let tick = 0; tick < 6; tick++) {
    await scheduled('content.sweep');
    await waitFor(async () => !(await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articleId} AND state<'completed'`).length);
    const [state] = await sql`SELECT processing_state,processing_attempts,processing_retry_at FROM articles WHERE id=${articleId}`;
    assert.equal(state!.processing_attempts, 0);
    if (state!.processing_state === 'analyzed') break;
    assert.equal(state!.processing_state, 'new');
    assert.ok(state!.processing_retry_at);
    // Model pacing is untouched: only advance the disposable article's scheduled due-time.
    await sql`UPDATE articles SET processing_retry_at=now()-interval '1 second' WHERE id=${articleId}`;
  }
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${articleId}`)[0]!.processing_state, 'analyzed');
  assert.equal(calls.filter(s => s === 'prefilter').length, 1);
  assert.equal(calls.filter(s => s === 'structure').length, 1);
  assert.equal(calls.filter(s => s === 'score').length, 2);
  assert.equal(calls.filter(s => s === 'understand').length, 1);
  assert.equal(provider.hits()-hits, 5);
  assert.equal((await sql`SELECT * FROM receipt_attempts`).length, 5);
  assert.ok((await sql`SELECT status FROM receipts WHERE id=${saved!.id}`)[0]!.status === 'completed');
  const [done] = await sql`SELECT processing_attempts,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.equal(done!.processing_attempts, 0);
  assert.equal(done!.processing_retry_at, null);
  assert.equal((await sql`SELECT * FROM analyses WHERE article_id=${articleId}`).length, 1);
  assert.equal((await sql`SELECT status FROM job_runs WHERE job='content.sweep' ORDER BY id DESC LIMIT 1`)[0]!.status, 'ok');
  await waitFor(async () => !(await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articleId} AND state<'completed'`).length);
});

test('arxiv scheduled capacity cooldown and received-answer recovery progress without duplicate paid calls', async () => {
  await sql`TRUNCATE arxiv_raw_batches,arxiv_raw_papers CASCADE`;
  const raw_atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2610.90001v1</id><title>Pacing observation</title><summary>We measured the original spectrum.</summary><published>2026-10-07T00:00:00Z</published><updated>2026-10-07T00:00:00Z</updated><author><name>Fixture</name></author><category term="astro-ph.CO"/></entry></feed>';
  await ingestRawArxivCollection({ raw_atom, papers: parseArxivAtom(raw_atom), collected_at_utc: '2026-10-07T00:00:00Z' });
  answer = async () => ({ title_zh: '观测结果', summary_zh: '测得原始光谱。', reason_zh: '需要全文核查。', verdict: 'REVIEW', study_type: 'observation', evidence_excerpt_index: 0, fulltext_review_question: '如何处理测量误差？' });
  const hits = provider.hits();
  await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined',purpose='fixture-arxiv' WHERE slot<=4`;
  await scheduled('arxiv.analyze');
  assert.equal(provider.hits(), hits);
  assert.equal((await sql`SELECT * FROM receipts`).length, 0);
  const [retry] = await sql`SELECT * FROM arxiv_analysis_retry`;
  assert.equal(retry!.validation_failures, 0);
  assert.equal(retry!.blocked_reason, null);
  assert.ok(retry!.next_attempt_at > new Date());
  assert.equal((await sql`SELECT * FROM arxiv_analysis_claims`).length, 0);
  await scheduled('arxiv.analyze');
  assert.equal(provider.hits(), hits);
  assert.deepEqual((await sql`SELECT * FROM arxiv_analysis_retry`)[0], retry);
  await sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL WHERE purpose='fixture-arxiv'`;
  await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second'`;
  // Fail the business commit after a real saved local HTTP answer. Never invent receipt IDs.
  await sql.unsafe("CREATE FUNCTION pacing_fail_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'fixture business rollback'; END IF; RETURN NEW; END $$");
  await sql.unsafe('CREATE TRIGGER pacing_fail_complete BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION pacing_fail_complete()');
  try { await scheduled('arxiv.analyze'); }
  finally {
    await sql.unsafe('DROP TRIGGER pacing_fail_complete ON receipts');
    await sql.unsafe('DROP FUNCTION pacing_fail_complete()');
  }
  assert.equal(provider.hits()-hits, 1);
  const [receipt] = await sql`SELECT * FROM receipts`;
  assert.equal(receipt!.status, 'received');
  assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers`)[0]!.analysis_status, 'pending');
  assert.equal((await sql`SELECT * FROM arxiv_analysis_claims`).length, 0);
  await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined',acquired_at=now()-interval '10 days' WHERE slot<=4`;
  const permits = await sql`SELECT * FROM model_permits ORDER BY slot`;
  const pacing = await sql`SELECT * FROM settings WHERE key LIKE 'provider_pacing:%' ORDER BY key`;
  await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second'`;
  await scheduled('arxiv.analyze');
  assert.equal(provider.hits()-hits, 1);
  assert.equal((await sql`SELECT * FROM receipt_attempts`).length, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, 'completed');
  assert.equal((await sql`SELECT analysis_status FROM arxiv_raw_papers`)[0]!.analysis_status, 'analyzed');
  assert.equal((await sql`SELECT validation_failures FROM arxiv_analysis_retry`)[0]!.validation_failures, 0);
  assert.deepEqual(await sql`SELECT * FROM model_permits ORDER BY slot`, permits);
  assert.deepEqual(await sql`SELECT * FROM settings WHERE key LIKE 'provider_pacing:%' ORDER BY key`, pacing);
  assert.equal((await sql`SELECT status FROM job_runs WHERE job='arxiv.analyze' ORDER BY id DESC LIMIT 1`)[0]!.status, 'ok');
});


for (const status of ['pending', 'unknown']) {
  test(`${status} receipt keeps its original lock even with full capacity`, async () => {
    const first = await chatJson(opts);
    await sql`UPDATE receipts SET status=${status},updated_at=now() WHERE id=${first.receiptId}`;
    await sql`UPDATE model_permits SET token=gen_random_uuid(),state='quarantined' WHERE slot<=4`;
    const attempts = await sql`SELECT * FROM receipt_attempts ORDER BY id`;
    const permits = await sql`SELECT * FROM model_permits ORDER BY slot`;
    const hits = provider.hits();
    await assert.rejects(chatJson(opts), status === 'pending' ? ReceiptBusyError : ReceiptUnknownError);
    assert.equal(provider.hits(), hits);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${first.receiptId}`)[0]!.status, status);
    assert.deepEqual(await sql`SELECT * FROM receipt_attempts ORDER BY id`, attempts);
    assert.deepEqual(await sql`SELECT * FROM model_permits ORDER BY slot`, permits);
  });
}

test('receipt state is rechecked after admission without holding its transaction open', async () => {
  const request = { service: 'llm', purpose: 'admission-race', subject: 'race', identity: { fixture: 'race' } };
  let paid = 0;
  const call = async () => { paid++; return { response: { ok: true } }; };
  let winner = 0;
  const result = await paidRequest(request, call, async reserve => {
    // Another worker finishes while this worker waits. A held budget lock would deadlock here.
    winner = (await paidRequest(request, call)).receiptId;
    return reserve();
  });
  assert.equal(result.reused, true);
  assert.equal(result.receiptId, winner);
  assert.equal(paid, 1);
  assert.equal((await sql`SELECT * FROM receipt_attempts`).length, 1);
});
