// The arXiv collection must not be retried by pg-boss itself: an internal retry would run seconds
// after a failed attempt, outside the six-hour spacing and outside the durable daily budget. The queue
// policy therefore has to be declared per schedule AND corrected on queues that already exist from an
// earlier deployment (createQueue is a no-op once the queue is there).
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBoss, stopBoss, ensureQueue } from '../packages/backend/src/jobs/queue.ts';
import { closeDb } from '../packages/backend/src/db.ts';

test('the collection queue never retries inside pg-boss, and an existing queue is corrected',async()=>{
 Object.assign(process.env,{COLLECT_ENABLED:'true',ARXIV_NATIVE_COLLECT_ENABLED:'true',MODEL_CALLS_ENABLED:'false'});
 const { SCHEDULES, scheduleQueueOptions } = await import('../apps/worker/src/schedules.ts');
 const entry = SCHEDULES.find((schedule) => schedule.name === 'arxiv.collect');
 assert.ok(entry,'the collection schedule is registered while both flags are on');
 assert.equal(entry.retryLimit,0,'its queue must not retry a failed attempt seconds later');
 assert.equal(scheduleQueueOptions(entry).retryLimit,0);
 assert.equal(scheduleQueueOptions({}).retryLimit,1,'every other cron entry keeps the previous behaviour');

 const boss = await getBoss();
 const queue = 'cron.arxiv.collect';
 // A deployment that created this queue before the change: its settings are already stored.
 await boss.createQueue(queue,{policy:'singleton',retryLimit:1,expireInSeconds:900});
 assert.equal((await boss.getQueue(queue))!.retryLimit,1);
 await ensureQueue(queue,scheduleQueueOptions(entry));
 const corrected = await boss.getQueue(queue);
 assert.equal(corrected!.retryLimit,0,'the existing queue is corrected instead of silently keeping its retry');
 assert.equal(corrected!.expireInSeconds,3600,'the rest of the declared settings are applied too');
});

test.after(async()=>{await stopBoss();await closeDb();});
