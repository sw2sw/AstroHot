// Pure production decisions with database/channel I/O forbidden; no setup, credentials or network.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
mock.module('../packages/backend/src/db.ts', { namedExports: { sql: () => { throw new Error('database forbidden'); } } });
mock.module('../packages/backend/src/arxiv/collection-state.ts', { namedExports: {
  ARXIV_COLLECTION_KEY: 'astro-ph', claimCollectionWithin: () => { throw new Error('claim forbidden'); },
} });
const { utcDayAnchor, nextUtcDayAnchor, utcDayKey, resolveDue, ARXIV_COLLECT_ATTEMPTS_PER_DAY, ARXIV_COLLECT_MIN_INTERVAL_MS } =
  await import('../packages/backend/src/arxiv/collection-due.ts');
const d = (s: string) => new Date(s);
const inputs = (now: string, patch = {}) => ({ now: d(now), nextDueAt: null, attempts: 0,
  completedAt: null, recentAdmissionAt: null, todayAttemptAt: null, holdUntil: null, busy: false, ...patch });

test('daily anchor is precisely 05:30 UTC / Beijing 13:30', () => {
  assert.equal(utcDayAnchor(d('2026-10-17T00:00:00Z')).toISOString(), '2026-10-17T05:30:00.000Z');
  assert.equal(resolveDue(inputs('2026-10-17T05:29:59.999Z')).due, false);
  assert.equal(resolveDue(inputs('2026-10-17T05:30:00Z')).due, true);
  assert.equal(nextUtcDayAnchor(d('2026-10-17T05:30:00Z')).toISOString(), '2026-10-18T05:30:00.000Z');
});

test('transition preserves spent attempt and 09:00:19 Beijing admission floor, not 13:30 retry', () => {
  const patch = { attempts: 1, nextDueAt: d('2026-10-16T07:00:19Z'), recentAdmissionAt: d('2026-10-16T01:00:19Z') };
  const original = structuredClone(patch);
  const early = resolveDue(inputs('2026-10-16T05:30:00Z', patch));
  assert.equal(early.due, false);
  assert.equal(early.nextDueAt.toISOString(), '2026-10-16T07:00:19.000Z');
  assert.equal(resolveDue(inputs('2026-10-16T07:00:18.999Z', patch)).due, false);
  assert.equal(resolveDue(inputs('2026-10-16T07:00:19Z', patch)).due, true);
  assert.deepEqual(patch, original, 'pure polling never resets budget or mutates schedule');
});

test('three UTC-day attempts can land at Beijing 13:30, 19:30 and next local 01:30', () => {
  assert.equal(ARXIV_COLLECT_ATTEMPTS_PER_DAY, 3);
  assert.equal(ARXIV_COLLECT_MIN_INTERVAL_MS, 21600000);
  const stamps = ['2026-10-17T05:30:00Z', '2026-10-17T11:30:00Z', '2026-10-17T17:30:00Z'];
  for (const [attempts, stamp] of stamps.entries()) {
    assert.equal(utcDayKey(d(stamp)), '2026-10-17');
    assert.equal(resolveDue(inputs(stamp, { attempts, recentAdmissionAt: attempts ? d(stamps[attempts - 1]!) : null })).due, true);
  }
  const spent = resolveDue(inputs('2026-10-17T23:30:00Z', { attempts: 3, recentAdmissionAt: d(stamps[2]!) }));
  assert.equal(spent.due, false);
  assert.equal(spent.nextDueAt.toISOString(), '2026-10-18T05:30:00.000Z');
});

test('late admissions retain strict six hours including across UTC midnight', () => {
  const patch = { recentAdmissionAt: d('2026-10-17T23:45:22Z'), nextDueAt: d('2026-10-18T01:00:00Z') };
  const early = resolveDue(inputs('2026-10-18T05:30:00Z', patch));
  assert.equal(early.due, false);
  assert.equal(early.nextDueAt.toISOString(), '2026-10-18T05:45:22.000Z');
  assert.equal(resolveDue(inputs('2026-10-18T05:45:21.999Z', patch)).due, false);
  assert.equal(resolveDue(inputs('2026-10-18T05:45:22Z', patch)).due, true);
});

test('holds, busy ownership, completed days and persisted later due all win', () => {
  assert.equal(resolveDue(inputs('2026-10-17T05:30:00Z', { busy: true })).due, false);
  const held = resolveDue(inputs('2026-10-17T05:30:00Z', { holdUntil: d('2099-01-01T00:00:00Z') }));
  assert.equal(held.due, false);
  assert.equal(held.nextDueAt.toISOString(), '2099-01-01T00:00:00.000Z');
  assert.equal(resolveDue(inputs('2026-10-17T05:30:00Z', { completedAt: d('2026-10-17T01:01:00Z') })).due, false);
  assert.equal(resolveDue(inputs('2026-10-17T05:30:00Z', { nextDueAt: d('2026-10-17T12:00:00Z') })).due, false);
});
