import { gate, stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { modelFetch } from '../packages/backend/src/providers/model-limit.ts';
import { shutdownSignal } from '../packages/backend/src/lib/shutdown.ts';

// Real loopback transport and disposable permits; shutdown is last because it is process-wide.
test('sent calls retain caller cancellation and timeout but drain shutdown without quarantine', async () => {
  const subject = `sent-drain:${tag()}`;
  let asked = gate();
  let answer = gate();
  const provider = await stub(async () => { asked.open(); await answer.promise; return { paid: true }; });
  const init = { method: 'POST', body: '{}' };
  const fetchHeld = (signal?: AbortSignal | (() => AbortSignal)) => {
    const pending = modelFetch(provider.url, { ...init, signal }, 'drain_test', subject);
    // Observe rejection immediately, even while waiting for the loopback request.
    pending.catch(() => {});
    return pending;
  };
  try {
    for (const timeout of [false, true]) {
      asked = gate(); answer = gate();
      const controller = new AbortController();
      const pending = fetchHeld(timeout ? () => AbortSignal.timeout(150) : controller.signal);
      await asked.promise;
      if (!timeout) controller.abort(new Error('explicit caller cancellation'));
      await assert.rejects(pending, timeout ? { name: 'TimeoutError' } : /explicit caller cancellation/);
      assert.equal((await sql`SELECT count(*)::int AS n FROM model_permits WHERE subject=${subject} AND state='quarantined'`)[0]!.n, 1);
      answer.open();
      // Synthetic test only: release the exact proven-finished fixture token, never real permits.
      await sql`UPDATE model_permits SET token=NULL,state='active',purpose=NULL,subject=NULL,acquired_at=NULL WHERE subject=${subject}`;
    }
    asked = gate(); answer = gate();
    const draining = fetchHeld(); // Missing caller signal must still have a bounded default deadline.
    await asked.promise;
    shutdownSignal.abort();
    answer.open();
    assert.deepEqual(JSON.parse((await draining).text), { paid: true });
    assert.equal((await sql`SELECT count(*)::int AS n FROM model_permits WHERE subject=${subject}`)[0]!.n, 0, 'a returned answer releases, never quarantines');
    const hits = provider.hits();
    await assert.rejects(fetchHeld(() => AbortSignal.timeout(1000)), /aborted/);
    assert.equal(provider.hits(), hits, 'shutdown refuses later dispatch');
  } finally {
    answer.open(); await provider.close(); await closeDb();
  }
});
