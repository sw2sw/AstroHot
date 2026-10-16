// Offline contract test: real schedule source, with all module I/O replaced at import boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

test('analysis checks each minute in its own exclusive queue without queue retries', async () => {
  let source = await readFile(new URL('../apps/worker/src/schedules.ts', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ process: { env: { ARXIV_ANALYSIS_ENABLED: 'true', MODEL_CALLS_ENABLED: 'true' } },
    imageryDailyEnabled: () => false, backupConfigured: () => false, FEATURES: {},
    sweepUnprocessed() {}, linkRelatedStories() {}, adaptIntervals() {},
  });
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.schedules = SCHEDULES; globalThis.options = scheduleQueueOptions; globalThis.register = registerSchedules;', context);
  const entry = context.schedules.find((s: { name: string }) => s.name === 'arxiv.analyze');
  assert.equal(entry.cron, '* * * * *');
  assert.equal(entry.queue, 'cron.arxiv.analyze.continuous');
  assert.equal(context.options(entry).policy, 'exclusive');
  assert.equal(context.options(entry).retryLimit, 0);
  assert.equal(context.options({}).policy, 'singleton', 'other queues do not change');
  assert.equal(context.options({}).retryLimit, 1);
  const queues = new Map(), handlers = new Map(), scheduled = new Map(), removed: string[] = [];
  context.ensureQueue = async (name: string, options: unknown) => queues.set(name, options);
  context.recordRun = async (name: string, fn: (id: number) => Promise<unknown>) => { assert.equal(name, 'arxiv.analyze'); return fn(123); };
  context.analyzePendingArxiv = async (options: {limit: number; jobRunId: number}) => {
    assert.equal(options.limit, 20); assert.equal(options.jobRunId, 123); return 'checked';
  };
  await context.register({
    schedule: async (name: string, cron: string) => scheduled.set(name, cron),
    work: async (name: string, _options: unknown, fn: () => Promise<unknown>) => handlers.set(name, fn),
    getSchedules: async () => [{name:'cron.arxiv.analyze',key:'legacy',cron:'*/30 * * * *',timezone:'Asia/Shanghai'},
      {name:entry.queue,key:'current',cron:'* * * * *',timezone:'Asia/Shanghai'}],
    unschedule: async (name: string) => removed.push(name),
  });
  assert.equal(queues.get(entry.queue).policy, 'exclusive');
  assert.equal(scheduled.get(entry.queue), '* * * * *');
  assert.ok(!scheduled.has('cron.arxiv.analyze'));
  assert.deepEqual(removed, ['cron.arxiv.analyze']);
  assert.equal(await handlers.get(entry.queue)(), 'checked');
});
