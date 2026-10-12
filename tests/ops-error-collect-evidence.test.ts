// Offline acceptance for the export-API failure document (REVIEW-SHEEP-ROUND3 C6). The claim that a
// failed response is kept is proven through the path the collection job really runs —
// collectArxivMetadata -> collectAndStoreArxiv -> recordOpsError — and not through the byte collector
// on its own, because it was the collector alone being exercised that let a bodyText:"" slip past the
// review: the helper worked, the consumer threw an empty string. Local fake fetch only: no real
// source is contacted and no paid model is involved.
import './setup.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { config } from '../packages/backend/src/config.ts';
import { collectAndStoreArxiv } from '../packages/backend/src/arxiv/collect-job.ts';

// Every other invariant-test file ends on `after(closeDb)`; this one did not, so its postgres pool
// (idle_timeout 600s) was the only thing left on the loop and the file took up to ten minutes to
// exit — a run could neither be re-measured nor be told apart from a hang. Closing the pool is the
// same teardown the rest of the suite uses and changes nothing about what the tests assert.
after(closeDb);

const rss = '<rss version="2.0"><channel><title>astro-ph</title></channel></rss>';
// What the origin itself answers on a 503: the document an operator has to be able to read offline.
const FAILURE_BODY = '{"error":"service unavailable","retry_after":120}';
const evidenceDir = path.join(config.dataDir, 'ops', 'error-evidence');

test('the export API failure document reaches the record through the real collector', async () => {
  process.env.COLLECT_ENABLED = 'true';
  process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
  await sql`TRUNCATE ops_error_events RESTART IDENTITY`;
  await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches,arxiv_raw_papers,arxiv_raw_batches CASCADE`;
  await sql`DELETE FROM arxiv_rss_cache`;

  const urls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.href);
    if (url.hostname === 'rss.arxiv.org') return new Response(rss);
    // The metadata endpoint's own failure document. Read ONCE by the consumer: a re-request would
    // both fire a second request and lose the answer that explained the first one.
    return new Response(FAILURE_BODY, { status: 503, headers: { 'content-type': 'application/json' } });
  };

  await assert.rejects(
    collectAndStoreArxiv({ fetch: fake, now: () => new Date(), sleep: async () => {} }),
    /HTTP 503/,
  );
  // Both official endpoints were contacted exactly once each: the failure body came from the answer
  // that already existed, never from a second request made to go and fetch it.
  assert.equal(urls.length, 2, `requests: ${urls.join(', ')}`);
  assert.equal(urls.filter((u) => u.includes('export.arxiv.org')).length, 1);

  const [row] = await sql<{
    code: string; severity: string; evidence_ref: string | null; evidence_sha256: string | null;
    evidence_truncated: boolean; details: Record<string, unknown>; run_key: string | null;
  }[]>`
    SELECT code,severity,evidence_ref,evidence_sha256,evidence_truncated,details,run_key
    FROM ops_error_events WHERE code = 'source_http_failed'`;
  assert.ok(row, 'the export-API failure must produce a source_http_failed event');
  assert.equal(row!.severity, 'error');
  assert.equal(row!.evidence_truncated, false);
  // This is the case the review caught: the consumer used to throw bodyText "" and nothing was kept.
  assert.ok(row!.evidence_sha256, 'the failure bytes must be hashed, not dropped');
  assert.ok(row!.evidence_ref, 'the failure bytes must be written offline and referenced');

  const stored = await readFile(path.join(evidenceDir, `${row!.evidence_sha256}.txt`));
  assert.equal(stored.toString('utf8'), FAILURE_BODY); // the origin's own document, byte for byte
  assert.equal(row!.evidence_sha256, createHash('sha256').update(Buffer.from(FAILURE_BODY, 'utf8')).digest('hex'));

  // The record says which endpoint really answered, and how much of it was kept — an export-API 503 is
  // never dressed up as an RSS failure, and a byte budget that cut the document is stated as such.
  assert.equal(row!.details.httpStatus, 503);
  assert.equal(row!.details.endpoint, 'export.arxiv.org/api/query');
  assert.equal(row!.details.failedBodyBytes, Buffer.byteLength(FAILURE_BODY));
  assert.equal(row!.details.failedBodyTruncated, false);
  // A real execution carries a durable identity, so a later job_runs cleanup cannot make this one
  // observation look like two.
  assert.match(row!.run_key ?? '', /^(run:\d+|exec:[0-9a-f-]+)$/);
});

// A body that could not be READ at all is a different fact from a complete empty body, and the
// difference has to survive the real collection entry points (ROUND4 D8). Neither case invents an
// empty evidence file, and neither makes a second request.
type EvidenceRow = {
  code: string; severity: string; evidence_ref: string | null; evidence_truncated: boolean;
  details: Record<string, unknown>;
};

test('a 503 whose failure body cannot be read keeps the status and says the body is unknown', async () => {
  process.env.COLLECT_ENABLED = 'true';
  process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
  await sql`TRUNCATE ops_error_events RESTART IDENTITY`;
  await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches,arxiv_raw_papers,arxiv_raw_batches CASCADE`;
  await sql`DELETE FROM arxiv_rss_cache`;

  // The first read REJECTS: not one byte of the origin's document ever arrives.
  const brokenBody = () => new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('socket hang up')); } });
  const urls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.href);
    if (url.hostname === 'rss.arxiv.org') return new Response(rss);
    return new Response(brokenBody(), { status: 503, headers: { 'content-type': 'application/json' } });
  };

  await assert.rejects(
    collectAndStoreArxiv({ fetch: fake, now: () => new Date(), sleep: async () => {} }),
    /HTTP 503/,
  );
  assert.equal(urls.filter((u) => u.includes('export.arxiv.org')).length, 1, 'no second request to chase the body');

  const [row] = await sql<EvidenceRow[]>`
    SELECT code,severity,evidence_ref,evidence_truncated,details
    FROM ops_error_events WHERE code = 'source_http_failed'`;
  assert.ok(row, 'an unreadable 503 body must still produce the event');
  assert.equal(row!.evidence_ref, null, 'no empty file may be invented for a body that never arrived');
  assert.equal(row!.evidence_truncated, true, 'a rejected read is INCOMPLETE, never a complete empty body');
  assert.equal(row!.details.httpStatus, 503); // the status survives whatever the read did
  assert.equal(row!.details.failedBodyBytes, 0);
  assert.equal(row!.details.failedBodyTruncated, true);
  assert.equal(row!.details.bodyUnavailable, true);
});

test('a 429 whose body never arrives keeps the shared hold and marks the body incomplete', async () => {
  process.env.COLLECT_ENABLED = 'true';
  process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
  await sql`TRUNCATE ops_error_events RESTART IDENTITY`;
  await sql`TRUNCATE arxiv_collection_state,arxiv_announcements,arxiv_announcement_batches,arxiv_raw_papers,arxiv_raw_batches CASCADE`;
  await sql`DELETE FROM arxiv_rss_cache`;

  // The body hangs with a zero prefix until the request timeout cuts it: still a 429, still a hold.
  const stuck = () => new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } });
  const urls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.href);
    if (url.hostname === 'rss.arxiv.org') return new Response(rss);
    return new Response(stuck(), { status: 429, headers: { 'retry-after': '60' } });
  };

  // The hold has to be the FULL six hours from the moment this 429 was handled — "longer than an
  // hour" says nothing about six. The database clock is read before the run, so the assertion below
  // is a real six-hour floor and not a tolerance.
  const [t0] = await sql<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
  await assert.rejects(
    collectAndStoreArxiv({ fetch: fake, timeoutMs: 80, now: () => new Date(), sleep: async () => {} }),
    /429/,
  );
  assert.equal(urls.filter((u) => u.includes('export.arxiv.org')).length, 1);

  const [row] = await sql<EvidenceRow[]>`
    SELECT code,severity,evidence_ref,evidence_truncated,details
    FROM ops_error_events WHERE code = 'rate_limited'`;
  assert.ok(row, 'the 429 must be recorded even though its body hung');
  assert.equal(row!.severity, 'warning'); // a shared business condition, not a system fault
  assert.equal(row!.evidence_ref, null);
  assert.equal(row!.evidence_truncated, true, 'a timeout with no prefix is incomplete evidence');
  assert.equal(row!.details.httpStatus, 429); // the status is never lost to its own body
  assert.equal(row!.details.failedBodyBytes, 0);
  assert.equal(row!.details.failedBodyTruncated, true);
  assert.equal(row!.details.bodyUnavailable, true);
  assert.equal(row!.details.holdConfirmed, true, 'the durable pause is written from the status alone');
  const [state] = await sql<{ owner: string | null; lease_until: Date | null; db_now: Date }[]>`
    SELECT owner, lease_until, clock_timestamp() AS db_now FROM arxiv_collection_state WHERE key = 'astro-ph'`;
  assert.ok(state?.lease_until, 'the shared hold really exists in the database');
  assert.equal(state!.owner, null, 'and it is ownerless, so it binds every process, not just this one');
  const floor = new Date(new Date(t0!.t).getTime() + 6 * 3_600_000);
  const remaining = (new Date(state!.lease_until!).getTime() - new Date(state!.db_now).getTime()) / 1000;
  assert.ok(new Date(state!.lease_until!) >= floor,
    `the full six hours measured from the moment the 429 was handled (${remaining}s left, floor ${floor.toISOString()})`);
  // The durable pause really refuses the next entry — in a NEW call, and without touching the network.
  const blocked = await collectAndStoreArxiv({ fetch: async () => { throw new Error('the hold must block the next run'); } });
  assert.equal(blocked!.status, 'skipped');
});
