// Integration acceptance for the analysis-side error recording (REVIEW-SHEEP-ROUND1 R1/R3):
// an invalid answer links the EXACT receipt the call returned (never "the latest receipt"), a provider
// refusal without a reliable identity links nothing, and a broken record chain degrades into a visible
// gap without disturbing the business result or the remaining papers. Local stub server only — no real
// provider, no real arXiv.
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sql } from '../packages/backend/src/db.ts';
import { ingestRawArxivCollection } from '../packages/backend/src/arxiv/raw-store.ts';
import { parseArxivAtom } from '../packages/backend/src/arxiv/collect.ts';
import { Reply, stub } from './setup.ts';

/**
 * Runs one node program in a REAL child process and collects its output. `spawnSync` is deliberately
 * not used: this environment refuses the synchronous spawn path outright (EBUSY, even for
 * `spawnSync(process.execPath, ['--version'])`) while the asynchronous path works normally.
 */
function runNodeInChild(script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const answer = { title_zh:'宇宙观测研究', summary_zh:'研究宇宙观测数据，结果仍需全文核查。', reason_zh:'摘要提出可核查的观测结果。', verdict:'REVIEW', study_type:'observation', evidence_excerpt_index:1, fulltext_review_question:'全文如何控制系统误差？' };
const collection = (id='2601.00001v1') => {
  const raw_atom=`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${id}</id><title>Original title</title><summary>Original abstract. We measure $4\\%$\nwith uncertainty. Final result.</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry></feed>`;
  return {raw_atom,papers:parseArxivAtom(raw_atom),collected_at_utc:'2026-01-03T12:00:00Z'};
};
const reset=async()=>{
  await sql`TRUNCATE ops_error_events RESTART IDENTITY`;
  await sql`TRUNCATE arxiv_raw_papers, arxiv_raw_batches, arxiv_reports, arxiv_papers CASCADE`;
  await sql`DELETE FROM receipts`;
};

test('a failed screening records the exact receipt, refuses to guess, and degrades visibly',async()=>{
  // What the stub provider answers next; reassigned per scenario.
  let reply:(hit:number)=>unknown=()=>({choices:[{message:{content:JSON.stringify(answer)}}]});
  const api=await import('../packages/backend/src/arxiv/analyze.ts');
  const server=await stub((_hit, req)=>{
    void req;
    return reply(_hit);
  });
  Object.assign(process.env,{LLM_BASE_URL:server.url,LLM_API_KEY:'local-fake',LLM_MODEL:'qwen3.8:27b'});
  try {
    // 1) An invalid answer: the event carries the receipt THIS call used; the attempt stays NULL
    //    because no error carries an attempt id and a received answer may be a replay that reused
    //    an older attempt — "latest attempt of the receipt" would be a guess.
    await reset();
    await ingestRawArxivCollection(collection('2601.00011v1'));
    reply=()=>({choices:[{message:{content:JSON.stringify({...answer,verdict:'PUBLISHED'})}}]});
    const invalid=await api.analyzePendingArxiv({limit:1,model:'default'});
    assert.equal(invalid.failed,1);
    assert.equal(invalid.failures[0]!.code,'analysis_validation_failed');
    assert.equal(invalid.recordingGaps,undefined); // nothing failed on the recording chain
    const [receipt]=await sql<{ id: number }[]>`SELECT id FROM receipts`;
    const [event]=await sql<{ code: string; severity: string; receipt_id: number; receipt_attempt_id: number | null; observation_key: string; target_id: string; details: Record<string,unknown> }[]>`
      SELECT code,severity,receipt_id,receipt_attempt_id,observation_key,target_id,details FROM ops_error_events`;
    assert.equal(event!.code,'analysis_validation_failed');
    assert.equal(event!.severity,'error');
    assert.equal(event!.receipt_id,receipt!.id); // exact identity, not "the latest receipt"
    assert.equal(event!.receipt_attempt_id,null); // honest NULL beats a guessed attempt row
    // The observation key folds in THIS execution's scope and failure kind: two real executions
    // replaying the same receipt are two rows, never one swallowed by UNIQUE.
    assert.match(event!.observation_key,new RegExp(`^arxiv\\.analysis:receipt:${receipt!.id}:(run:\\d+|exec:[0-9a-f-]+):validation$`));
    assert.equal(event!.details.association,'exact_receipt');
    assert.equal(event!.target_id,'2601.00011v1');

    // 2) A provider refusal (503): no exact identity on the error, so the event links NOTHING instead
    //    of guessing a receipt, and the failure is a distinct class, not "transport".
    await reset();
    await ingestRawArxivCollection(collection('2601.00012v1'));
    reply=()=>new Reply(503,{error:'upstream over capacity'});
    const rejected=await api.analyzePendingArxiv({limit:1,model:'default'});
    assert.equal(rejected.failed,1);
    const [refused]=await sql<{ code: string; severity: string; receipt_id: number | null; receipt_attempt_id: number | null; observation_key: string }[]>`
      SELECT code,severity,receipt_id,receipt_attempt_id,observation_key FROM ops_error_events`;
    assert.equal(refused!.code,'analysis_provider_rejected');
    assert.equal(refused!.severity,'error');
    assert.equal(refused!.receipt_id,null); // NULL beats a wrong guess
    assert.equal(refused!.receipt_attempt_id,null);
    // Scoped to THIS execution (run:N via recordRun, exec:UUID for a manual invocation) — never
    // per-day, so two real attempts are two rows.
    assert.match(refused!.observation_key,/^arxiv\.analysis:(run:\d+|exec:[0-9a-f-]+):/);

    // 3) The record chain itself is broken (table dropped): the business result survives, failures are
    //    still counted, the gap is stated in the result — and the next paper still runs.
    await reset();
    await ingestRawArxivCollection(collection('2601.00013v1'));
    await ingestRawArxivCollection(collection('2601.00014v1'));
    // Paper ...13 fails validation; paper ...14 answers validly and must still be analyzed.
    reply=(hit)=>hit%2===0 ? {choices:[{message:{content:JSON.stringify({...answer,verdict:'PUBLISHED'})}}]}
                           : {choices:[{message:{content:JSON.stringify(answer)}}]};
    await sql`DROP TABLE ops_error_events`;
    try {
      const degraded=await api.analyzePendingArxiv({limit:2,model:'default'});
      assert.equal(degraded.analyzed,1); // the healthy paper was still processed
      assert.equal(degraded.failed,1);
      assert.ok(degraded.recordingGaps && degraded.recordingGaps.length>=1,'the gap must be visible in the run result');
      assert.match(degraded.recordingGaps!.join(' '),/event not recorded|association failed/);
    } finally {
      // Restore the exact migration shape so later suites on this database copy behave. Keep this in
      // step with database/migrations: 0064 created the table, 0065 added the durable execution
      // identity (run_key) that survives a job_runs retention cleanup.
      await sql`DROP TABLE IF EXISTS ops_error_events`;
      await sql`CREATE TABLE ops_error_events (
        id                 bigserial PRIMARY KEY,
        occurred_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
        stage              text NOT NULL,
        code               text NOT NULL,
        severity           text NOT NULL DEFAULT 'error' CHECK (severity IN ('error','warning')),
        sanitized_message  text NOT NULL DEFAULT '',
        observation_key    text NOT NULL UNIQUE,
        group_key          text NOT NULL,
        job_run_id         bigint REFERENCES job_runs (id) ON DELETE SET NULL,
        run_key            text,
        target_id          text,
        receipt_id         bigint REFERENCES receipts (id) ON DELETE SET NULL,
        receipt_attempt_id bigint REFERENCES receipt_attempts (id) ON DELETE SET NULL,
        details            jsonb NOT NULL DEFAULT '{}'::jsonb,
        evidence_ref       text,
        evidence_sha256    text,
        evidence_truncated boolean NOT NULL DEFAULT false)`;
      await sql`CREATE INDEX ops_error_events_occurred_idx ON ops_error_events (occurred_at DESC)`;
      await sql`CREATE INDEX ops_error_events_group_idx ON ops_error_events (group_key, occurred_at DESC)`;
      await sql`CREATE INDEX ops_error_events_stage_idx ON ops_error_events (stage, occurred_at DESC)`;
      await sql`CREATE INDEX ops_error_events_run_key_idx ON ops_error_events (run_key, occurred_at DESC)`;
    }
  } finally {
    await server.close();
  }
});

// A request that never left the process is not a network fault. An unknown model name, a missing
// endpoint/key and the global model switch are three DIFFERENT configuration states, each with its
// own reason code — previously all three were recorded as `transport`, which blames a network that
// was never used and hides the operator's actual problem behind a source-outage alarm. Nothing is
// sent, so nothing is billed: no receipt exists, and the event links no receipt at all (an honest
// NULL beats "the latest receipt", which would belong to some other execution).
const childAtom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/2601.00031v1</id><title>Original title</title><summary>Original abstract. We measure $4\\%$
with uncertainty. Final result.</summary><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry></feed>`;

test('a configuration state is its own reason, never a blamed network, and never a guessed receipt', async () => {
  const api = await import('../packages/backend/src/arxiv/analyze.ts');
  const server = await stub(() => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  const saved = {
    LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_API_KEY: process.env.LLM_API_KEY, LLM_MODEL: process.env.LLM_MODEL,
  };
  Object.assign(process.env, { LLM_BASE_URL: server.url, LLM_API_KEY: 'local-fake', LLM_MODEL: 'stub-model' });
  const receipts = async () => (await sql`SELECT count(*)::int n FROM receipts`)[0]!.n;
  const lastEvent = async () => (await sql<{
    code: string; severity: string; receipt_id: number | null; receipt_attempt_id: number | null;
    observation_key: string; run_key: string | null; details: Record<string, unknown>;
  }[]>`SELECT code,severity,receipt_id,receipt_attempt_id,observation_key,run_key,details FROM ops_error_events`)[0]!;
  try {
    // 1) A model name this build does not know. The name is refused before anything else happens.
    await reset();
    await ingestRawArxivCollection(collection('2601.00021v1'));
    const hitsBefore = server.hits();
    const receiptsBefore = await receipts();
    const unknown = await api.analyzePendingArxiv({ limit: 1, model: 'no-such-model' });
    assert.equal(unknown.failed, 1);
    assert.equal(unknown.failures[0]!.code, 'analysis_model_unknown');
    let event = await lastEvent();
    assert.equal(event.code, 'analysis_model_unknown');
    assert.equal(event.severity, 'error');
    assert.equal(event.receipt_id, null);
    assert.equal(event.receipt_attempt_id, null);
    assert.match(event.observation_key, /:model_unknown$/);
    assert.match(event.run_key ?? '', /^(run:\d+|exec:[0-9a-f-]+)$/);
    assert.equal(server.hits(), hitsBefore, 'an unknown model name must not reach any endpoint');
    assert.equal(await receipts(), receiptsBefore, 'no paid identity may be invented for a request never sent');

    // 2) The named model exists but its endpoint/key are missing. Same discipline, different reason.
    await reset();
    await ingestRawArxivCollection(collection('2601.00022v1'));
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    const hitsBefore2 = server.hits();
    const unconfigured = await api.analyzePendingArxiv({ limit: 1, model: 'default' });
    assert.equal(unconfigured.failures[0]!.code, 'analysis_model_not_configured');
    event = await lastEvent();
    assert.equal(event.severity, 'error');
    assert.equal(event.receipt_id, null);
    assert.equal(event.receipt_attempt_id, null);
    assert.match(event.observation_key, /:model_unconfigured$/);
    assert.equal(server.hits(), hitsBefore2, 'a missing endpoint must not be dialled');
    assert.equal(await receipts(), receiptsBefore, 'no paid identity may be invented for a request never sent');

    // 3) The global switch is off. It is read once at process BOOT, so the only honest way to reach
    //    this state is a real child process started with MODEL_CALLS_ENABLED=false — which is exactly
    //    what an operator's deployment does. A business waiting state, so it is a WARNING, not an
    //    alarm, and the stub endpoint is still never dialled. The script is one line with no double
    //    quotes and takes its fixture from the environment: neither survives the Windows command line.
    Object.assign(process.env, { LLM_BASE_URL: server.url, LLM_API_KEY: 'local-fake', LLM_MODEL: 'stub-model' });
    await reset();
    const hitsBefore3 = server.hits();
    const script = [
      "import {closeDb} from './packages/backend/src/db.ts'",
      "import {ingestRawArxivCollection} from './packages/backend/src/arxiv/raw-store.ts'",
      "import {parseArxivAtom} from './packages/backend/src/arxiv/collect.ts'",
      "import {analyzePendingArxiv} from './packages/backend/src/arxiv/analyze.ts'",
      'const a=process.env.PROBE_ATOM',
      "await ingestRawArxivCollection({raw_atom:a,papers:parseArxivAtom(a),collected_at_utc:'2026-01-03T12:00:00Z'})",
      "const r=await analyzePendingArxiv({limit:1,model:'default'})",
      "console.log('RESULT:'+JSON.stringify({failed:r.failed,code:r.failures[0]&&r.failures[0].code,switch:process.env.MODEL_CALLS_ENABLED}))",
      'await closeDb()',
    ].join(';');
    const child = await runNodeInChild(script, { MODEL_CALLS_ENABLED: 'false', PROBE_ATOM: childAtom });
    assert.equal(child.code, 0, `${child.stderr}\n${child.stdout}`);
    const reported = JSON.parse(/RESULT:(\{.*\})/.exec(child.stdout)![1]!) as { failed: number; code: string; switch: string };
    assert.equal(reported.failed, 1);
    // The child really ran with the switch off (a mis-set environment would silently pass otherwise).
    assert.equal(reported.switch, 'false');
    assert.equal(reported.code, 'analysis_model_disabled');
    event = await lastEvent();
    assert.equal(event.code, 'analysis_model_disabled');
    assert.equal(event.severity, 'warning'); // a switch an operator set, not a source outage
    assert.equal(event.receipt_id, null);
    assert.equal(event.receipt_attempt_id, null);
    assert.match(event.observation_key, /:model_disabled$/);
    assert.equal(server.hits(), hitsBefore3, 'a switched-off process must not dial anything');
    assert.equal(await receipts(), 0, 'no paid identity may be invented for a request never sent');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await server.close();
  }
});
