import { stub } from './setup.ts';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { ingestRawArxivCollection } from '../packages/backend/src/arxiv/raw-store.ts';
import { analyzePendingArxiv } from '../packages/backend/src/arxiv/analyze.ts';
import { ARXIV_PROMPT_VERSION } from '../packages/backend/src/arxiv/analysis-retry.ts';

const fields = { title_zh:'宇宙观测研究', summary_zh:'研究结果仍需全文核查。', verdict:'REVIEW', study_type:'observation', evidence_excerpt_index:1, fulltext_review_question:'全文如何控制系统误差？' };
const reason = '  摘要提出可核查的观测结果。\n';
let response: Record<string, unknown> = {};
const provider = await stub((_hit, req) => {
 const body = JSON.parse(req.body);
 assert.match(body.messages[0].content, /reason_zh/);
 assert.equal(JSON.parse(body.messages[1].content).evidence_excerpts[1].text, ' We measure $4\\%$\nwith uncertainty.');
 return { choices:[{message:{content:JSON.stringify(response)}}] };
});
Object.assign(process.env, { LLM_BASE_URL:provider.url, LLM_API_KEY:'local-fake', LLM_MODEL:'qwen3.8:27b' });
after(async () => { await provider.close(); await closeDb(); });
beforeEach(async () => {
 // Each fixture starts a fresh isolated admission clock; within-case cooldown/dedupe remains real.
 await sql`DELETE FROM settings WHERE key LIKE 'provider_pacing:%'`;
 await sql`TRUNCATE arxiv_raw_batches, arxiv_raw_papers, arxiv_reports, arxiv_papers, receipts CASCADE`;
 const now = new Date().toISOString();
 const raw_atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2610.00001v1</id><title>Original title</title><summary>Context sentence. We measure $4\\%$\nwith uncertainty. Final result.</summary><published>${now}</published><updated>${now}</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry></feed>`;
 await ingestRawArxivCollection({raw_atom, papers:parseArxivAtom(raw_atom), collected_at_utc:now});
});

const rejected: Array<[string, Record<string, unknown>]> = [
 ['both equal', {reason, reason_zh:reason}],
 ['both conflicting', {reason, reason_zh:'不同理由'}],
 ['canonical null with alias', {reason, reason_zh:null}],
 ['canonical blank with alias', {reason, reason_zh:''}],
 ['null alias', {reason:null}],
 ['blank alias', {reason:''}],
 ['whitespace alias', {reason:' \n\t'}],
 ['English alias', {reason:'English only'}],
 ['numeric alias', {reason:42}],
 ['array alias', {reason:['中文']}],
 ['object alias', {reason:{text:'中文'}}],
 ['boolean alias', {reason:true}],
 ['oversized alias', {reason:'中'.repeat(4001)}],
 ['missing reason', {}],
 ['unrelated unknown field', {reason, explanation:'中文'}],
 ['freeform evidence quote', {reason, evidence_abstract_quote:'We measure 4% with uncertainty.'}],
 ['bad evidence index', {reason, evidence_excerpt_index:'1'}],
 ['null canonical', {reason_zh:null}],
 ['blank canonical', {reason_zh:' '}],
];
for (const [name, extra] of rejected) test(`rejects ${name} without changing raw response`, async () => {
 response = {...fields, ...extra};
 const original = JSON.stringify(response);
 const hits = provider.hits();
 const result = await analyzePendingArxiv({limit:1});
 assert.equal(result.analyzed, 0);
 assert.equal(result.failed, 1);
 assert.equal(result.failures[0]!.code, 'analysis_validation_failed');
 assert.equal((await sql`SELECT count(*)::int n FROM arxiv_papers`)[0]!.n, 0);
 const [receipt] = await sql`SELECT status,response FROM receipts`;
 assert.equal(receipt!.status, 'failed');
 assert.equal(receipt!.response.choices[0].message.content, original);
 assert.equal((await sql`SELECT validation_failures FROM arxiv_analysis_retry`)[0]!.validation_failures, 1);
 assert.equal((await analyzePendingArxiv({limit:1})).failed, 0);
 assert.equal(provider.hits(), hits + 1, 'cooldown must not dispatch another request');
});

test('canonical reason remains accepted and preserved', async () => {
 response = {...fields, reason_zh:reason};
 const original = JSON.stringify(response);
 assert.equal((await analyzePendingArxiv({limit:1})).analyzed, 1);
 assert.equal((await sql`SELECT paper FROM arxiv_papers`)[0]!.paper.reason_zh, reason);
 assert.equal((await sql`SELECT response FROM receipts`)[0]!.response.choices[0].message.content, original);
});

test('reason alias alone is accepted without rewriting original receipt or evidence', async () => {
 response = {...fields, reason};
 const original = JSON.stringify(response);
 const result = await analyzePendingArxiv({limit:1});
 assert.equal(result.analyzed, 1, JSON.stringify(result));
 assert.equal(result.failed, 0);
 const [paper] = await sql`SELECT paper FROM arxiv_papers`;
 assert.equal(paper!.paper.reason_zh, reason);
 assert.equal(Object.hasOwn(paper!.paper, 'reason'), false);
 assert.equal(paper!.paper.evidence_abstract_quote, ' We measure $4\\%$\nwith uncertainty.');
 const [receipt] = await sql`SELECT status,response,request FROM receipts`;
 assert.equal(receipt!.status, 'completed');
 assert.equal(receipt!.response.choices[0].message.content, original);
 assert.deepEqual(JSON.parse(receipt!.response.choices[0].message.content), {...fields, reason});
 assert.equal(receipt!.request.promptVersion, ARXIV_PROMPT_VERSION);
 assert.equal(ARXIV_PROMPT_VERSION, 'arxiv-analysis-v2-evidence-index');
 const hits = provider.hits();
 assert.equal((await analyzePendingArxiv({limit:1})).analyzed, 0);
 assert.equal(provider.hits(), hits);
});
