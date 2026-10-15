import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import './setup.ts';
import {requestImagery} from '../packages/backend/src/imagery/request.ts';
import {getBoss,stopBoss,QUEUES} from '../packages/backend/src/jobs/queue.ts';
import {sql,closeDb} from '../packages/backend/src/db.ts';
after(async()=>{await stopBoss();await closeDb();});
test('concurrent reader misses persist one public singleton without generation',async()=>{
 await getBoss(); // pg-boss creates the pgboss schema on first start; this test reads it.
 // The shared acceptance database can contain this fixture's completed jobs from an earlier run.
 await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.imageryApod} AND singleton_key='nasa-apod:2000-01-01'`;
 await sql`DELETE FROM imagery_archive WHERE source='nasa-apod' AND source_date='2000-01-01'`;
 await Promise.all(Array.from({length:8},()=>requestImagery('2000-01-01',{enabled:true})));
 const jobs=await sql`SELECT data,singleton_key,state FROM pgboss.job WHERE name=${QUEUES.imageryApod} AND singleton_key='nasa-apod:2000-01-01'`;
 assert.equal(jobs.length,1);assert.deepEqual(jobs[0]?.data,{date:'2000-01-01'});assert.equal(jobs[0]?.singleton_key,'nasa-apod:2000-01-01');
 assert.equal((await sql`SELECT * FROM imagery_archive WHERE source_date='2000-01-01'`).length,0);
 const boss=await getBoss();const [job]=await boss.fetch<{date:string}>(QUEUES.imageryApod);
 assert.ok(job);assert.equal(await boss.send(QUEUES.imageryApod,{date:'2000-01-01'},{singletonKey:'nasa-apod:2000-01-01'}),null);
 await boss.complete(QUEUES.imageryApod,job.id);
});
