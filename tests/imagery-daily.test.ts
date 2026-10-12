import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runImageryDaily } from '../packages/backend/src/imagery/daily.ts';

test('daily worker refuses every non-literal or missing safety valve', async () => {
  for (const key of ['IMAGERY_ENABLED', 'IMAGERY_DAILY_ENABLED', 'COLLECT_ENABLED']) {
    for (const value of [undefined, '', 'false', '1', 'TRUE']) {
      let calls = 0;
      const result = await runImageryDaily({
        env: { ...enabled, [key]: value },
        ensureImpl: async () => { calls++; return {}; },
      });
      assert.deepEqual(result, { skipped: true }, `${key}=${value}`);
      assert.equal(calls, 0);
    }
  }
});

test('scheduler registers one hourly catch-up job only with all three literal flags', () => {
  const code = `
    const keys = ['IMAGERY_ENABLED', 'IMAGERY_DAILY_ENABLED', 'COLLECT_ENABLED'];
    const cases = [{}];
    for (const key of keys) for (const value of ['', 'false', '1', 'TRUE'])
      cases.push({ IMAGERY_ENABLED: 'true', IMAGERY_DAILY_ENABLED: 'true', COLLECT_ENABLED: 'true', [key]: value });
    cases.push({ IMAGERY_ENABLED: 'true', IMAGERY_DAILY_ENABLED: 'true', COLLECT_ENABLED: 'true' });
    const results = [];
    for (const [i, env] of cases.entries()) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, env);
      const { SCHEDULES } = await import('./apps/worker/src/schedules.ts?imagery-case=' + i);
      results.push(SCHEDULES.filter(s => s.name === 'imagery.daily').map(({ name, cron, missed }) => ({ name, cron, missed })));
    }
    const { SCHEDULES } = await import('./apps/worker/src/schedules.ts?imagery-wiring');
    process.env.COLLECT_ENABLED = 'false';
    const skipped = await SCHEDULES.find(s => s.name === 'imagery.daily').run();
    console.log(JSON.stringify({ results, skipped }));
  `;
  const { results, skipped } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, AIHOT_CREDENTIALS_DIR: '', ARXIV_REPORT_URL: '',
      DATABASE_URL: 'postgres://127.0.0.1:1/imagery_daily_test', MODEL_CALLS_ENABLED: 'false',
      DB_BACKUP_STORE_SECRET_ID: '', DB_BACKUP_STORE_SECRET_KEY: '', DB_BACKUP_STORE_BUCKET: '', DB_BACKUP_STORE_REGION: '' },
    timeout: 20000, encoding: 'utf8',
  }));
  assert.deepEqual(skipped, { skipped: true });
  assert.equal(results.length, 14);
  for (const result of results.slice(0, -1)) assert.deepEqual(result, []);
  assert.deepEqual(results.at(-1), [{ name: 'imagery.daily', cron: '23 * * * *', missed: 'once' }]);
});

test('unavailable APOD is retried on the next invocation without backfilling', async () => {
  const dates: string[] = [];
  const options = {
    env: enabled, now: new Date('2026-10-05T00:00:00Z'),
    ensureImpl: async (date: string) => { dates.push(date); return dates.length === 1 ? null : {}; },
  };
  assert.deepEqual(await runImageryDaily(options), { date: '2026-10-05', available: false });
  assert.deepEqual(await runImageryDaily(options), { date: '2026-10-05', available: true });
  assert.deepEqual(dates, ['2026-10-05', '2026-10-05']);
});

test('UTC rollover advances one date and does not fill skipped days', async () => {
  const dates: string[] = [];
  const ensureImpl = async (date: string) => { dates.push(date); return {}; };
  for (const now of ['2026-10-05T23:59:59Z', '2026-10-06T00:00:00Z', '2026-10-09T12:00:00Z'])
    await runImageryDaily({ env: enabled, now: new Date(now), ensureImpl });
  assert.deepEqual(dates, ['2026-10-05', '2026-10-06', '2026-10-09']);
});

test('service errors propagate to queue bookkeeping and permit the next hourly attempt', async () => {
  let calls = 0;
  const error = new Error('synthetic failure');
  const options = {
    env: enabled, now: new Date('2026-10-05T12:00:00Z'),
    ensureImpl: async () => { if (++calls === 1) throw error; return {}; },
  };
  await assert.rejects(runImageryDaily(options), value => value === error);
  assert.deepEqual(await runImageryDaily(options), { date: '2026-10-05', available: true });
  assert.equal(calls, 2);
});

test('invalid clock fails before calling the service', async () => {
  let calls = 0;
  await assert.rejects(runImageryDaily({ env: enabled, now: new Date(NaN),
    ensureImpl: async () => { calls++; return {}; },
  }), RangeError);
  assert.equal(calls, 0);
});

const enabled = { IMAGERY_ENABLED: 'true', IMAGERY_DAILY_ENABLED: 'true', COLLECT_ENABLED: 'true' };

test('daily worker requests only the current UTC date', async () => {
  const dates: string[] = [];
  const result = await runImageryDaily({
    env: enabled,
    now: new Date('2026-10-05T00:30:00+08:00'),
    ensureImpl: async date => { dates.push(date); return { sourceDate: date }; },
  });
  assert.deepEqual(dates, ['2026-10-04']);
  assert.deepEqual(result, { date: '2026-10-04', available: true });
});
