import { stub } from './setup.ts';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { ingestRawArxivCollection, readPendingRawArxivPapers } from '../packages/backend/src/arxiv/raw-store.ts';
import { analyzePendingArxiv } from '../packages/backend/src/arxiv/analyze.ts';
import { ARXIV_PROMPT_VERSION, noteArxivFailure } from '../packages/backend/src/arxiv/analysis-retry.ts';
import { autoReleaseUnknownReceipts } from '../packages/backend/src/operations/recover.ts';
import { paidRequest, ProviderRejectedError, rejectReceivedResponse } from '../packages/backend/src/providers/receipts.ts';

const provider = await stub(() => ({ choices: [{ message: { content: '{}' } }] }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = 'test-key';
after(async () => { await provider.close(); await closeDb(); });
beforeEach(async () => {
  await sql`TRUNCATE arxiv_raw_batches, arxiv_raw_papers, receipts CASCADE`;
});
async function seed(count = 1) {
  const entries = Array.from({ length: count }, (_, i) => `<entry><id>https://arxiv.org/abs/2610.${String(i + 1).padStart(5, '0')}v1</id><title>Retry fixture ${i}</title><summary>Original abstract ${i}</summary><published>2026-10-06T00:00:00Z</published><updated>2026-10-06T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('');
  const raw_atom = `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
  await ingestRawArxivCollection({ raw_atom, papers: parseArxivAtom(raw_atom), collected_at_utc: '2026-10-06T00:00:00Z' });
  return sql`SELECT * FROM arxiv_raw_papers ORDER BY arxiv_id`;
}
async function state() { return (await sql`SELECT * FROM arxiv_analysis_retry ORDER BY arxiv_id`)[0]!; }

test('exactly three invalid answers cap tracked retries; cooldown prevents immediate repeat', async () => {
  await seed();
  const hits = provider.hits();
  for (let i = 1; i <= 3; i++) {
    const result = await analyzePendingArxiv({ model: 'deepseek-flash', limit: 1 });
    assert.equal(result.failed, 1);
    assert.equal((await state()).validation_failures, i);
    assert.equal((await sql`SELECT count(*)::int n FROM arxiv_analysis_claims`)[0]!.n, 0);
    assert.equal((await analyzePendingArxiv({ model: 'deepseek-flash', limit: 1 })).failed, 0);
    assert.equal(provider.hits() - hits, i);
    await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second'`;
  }
  assert.equal((await state()).blocked_reason, 'validation_limit');
  await analyzePendingArxiv({ model: 'deepseek-flash', limit: 1 });
  assert.equal(provider.hits() - hits, 3);
});

test('cooling and capped rows are excluded before pending LIMIT', async () => {
  const rows = await seed(3);
  await noteArxivFailure(rows[0]!.arxiv_id, rows[0]!.metadata_hash, true, false);
  for (let i = 0; i < 3; i++) await noteArxivFailure(rows[1]!.arxiv_id, rows[1]!.metadata_hash, true, false);
  assert.deepEqual((await readPendingRawArxivPapers(1)).map(p => p.arxiv_id), [rows[2]!.arxiv_id]);
  const cooling = (await sql`SELECT extract(epoch FROM next_attempt_at-clock_timestamp())::float seconds FROM arxiv_analysis_retry ORDER BY arxiv_id`);
  assert.ok(cooling[0]!.seconds > 290 && cooling[0]!.seconds <= 300);
  assert.ok(cooling[1]!.seconds > 1190 && cooling[1]!.seconds <= 1200);
});

test('unknown transport outcome retains claim and is never automatically released', async () => {
  await seed();
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1/v1';
  try {
    const result = await analyzePendingArxiv({ model: 'deepseek-flash', limit: 1 });
    assert.equal(result.failures[0]!.code, 'analysis_receipt_unknown');
    assert.equal((await state()).validation_failures, 0);
    assert.equal((await state()).blocked_reason, 'receipt_uncertain');
    const before = await sql`SELECT * FROM arxiv_analysis_claims`;
    assert.equal(before.length, 1);
    await sql`UPDATE receipts SET updated_at=clock_timestamp()-interval '1 hour'`;
    assert.deepEqual(await autoReleaseUnknownReceipts(), { released: 0, requeued: 0 });
    assert.equal((await sql`SELECT status FROM receipts`)[0]!.status, 'unknown');
    assert.deepEqual(await sql`SELECT * FROM arxiv_analysis_claims`, before);
    assert.equal((await readPendingRawArxivPapers(1)).length, 0);
  } finally { process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`; }
});

test('mixed legacy HTTP refusals and invalid answer block for review without invented counts', async () => {
  const [raw] = await seed();
  const request = { service: 'retry-fixture', purpose: 'arxiv-analysis', subject: raw!.arxiv_id,
    identity: { fixture: true }, requestSummary: { promptVersion: 'arxiv-analysis-v1' },
    attemptTag: `${raw!.base_id}@${raw!.metadata_hash.slice(0, 12)}` };
  for (let i = 0; i < 2; i++) await assert.rejects(paidRequest(request, async () => { throw new ProviderRejectedError('HTTP 503', 503, true); }));
  const answer = await paidRequest(request, async () => ({ response: { invalid: true } }));
  await rejectReceivedResponse(answer.receiptId, 'unusable output: synthetic invalid answer');
  assert.equal((await readPendingRawArxivPapers(1)).length, 0);
  assert.equal((await state()).validation_failures, 0);
  assert.equal((await state()).blocked_reason, 'legacy_retry_review');
  await readPendingRawArxivPapers(1);
  assert.equal((await state()).validation_failures, 0);
});

test('uncertain legacy receipt matches raw id and hash across all prompt versions', async () => {
  const rows = await seed(3);
  for (let i = 0; i < 3; i++) {
    const raw = rows[i]!;
    await assert.rejects(paidRequest({ service: 'retry-fixture', purpose: 'arxiv-analysis', subject: raw.arxiv_id,
      identity: { i }, requestSummary: { promptVersion: i === 2 ? 'different-prompt' : ARXIV_PROMPT_VERSION },
      attemptTag: `${raw.base_id}@${i === 1 ? '000000000000' : raw.metadata_hash.slice(0, 12)}` }, async () => { throw new Error('synthetic lost answer'); }));
  }
  assert.deepEqual((await readPendingRawArxivPapers(3)).map(p => p.arxiv_id), [rows[1]!.arxiv_id]);
  assert.equal((await state()).blocked_reason, 'receipt_uncertain');
});

test('v1 cap, quarantine and cooldown survive protocol v2 without new calls',async()=>{
 assert.equal(ARXIV_PROMPT_VERSION,'arxiv-analysis-v2-evidence-index');
 const raw=await seed(4);
 for(let i=0;i<4;i++) await sql`INSERT INTO arxiv_analysis_retry(arxiv_id,metadata_hash,prompt_version,validation_failures,next_attempt_at,blocked_reason)
 VALUES(${raw[i]!.arxiv_id},${raw[i]!.metadata_hash},'arxiv-analysis-v1',${i===0?3:i===3?2:0},clock_timestamp()+interval '20 minutes',${i===0?'validation_limit':i===1?'receipt_uncertain':i===2?'legacy_retry_review':null})`;
 const before=await sql`SELECT * FROM arxiv_analysis_retry ORDER BY arxiv_id`;
 const hits=provider.hits();
 assert.equal((await readPendingRawArxivPapers(4)).length,0);
 assert.equal((await analyzePendingArxiv({model:'deepseek-flash',limit:4})).failed,0);
 assert.equal(provider.hits(),hits);
 assert.deepEqual(await sql`SELECT * FROM arxiv_analysis_retry ORDER BY arxiv_id`,before);
 await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE arxiv_id=${raw[3]!.arxiv_id}`;
 assert.equal((await analyzePendingArxiv({model:'deepseek-flash',limit:4})).failed,1);
 assert.equal(provider.hits(),hits+1);
 assert.equal((await readPendingRawArxivPapers(4)).length,0);
 const totals=await sql`SELECT sum(validation_failures)::int n FROM arxiv_analysis_retry WHERE arxiv_id=${raw[3]!.arxiv_id}`;
 assert.equal(totals[0]!.n,3);
 await sql`UPDATE arxiv_analysis_retry SET next_attempt_at=clock_timestamp()-interval '1 second'`;
 assert.equal((await readPendingRawArxivPapers(4)).length,0);
});
