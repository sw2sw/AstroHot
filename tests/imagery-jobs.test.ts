import test from 'node:test';
import assert from 'node:assert/strict';
import type { PgBoss } from 'pg-boss';
import { registerImageryJobs } from '../packages/backend/src/jobs/imagery.ts';
import { imageryJobsEnabled } from '../packages/backend/src/imagery/request.ts';
test('worker flags are literal and independent of model flag',()=>{
  assert.equal(imageryJobsEnabled({IMAGERY_ENABLED:'true',COLLECT_ENABLED:'true',MODEL_CALLS_ENABLED:'false'}),true);
  for(const env of [{IMAGERY_ENABLED:'true'},{COLLECT_ENABLED:'true'},{IMAGERY_ENABLED:'1',COLLECT_ENABLED:'true'}])assert.equal(imageryJobsEnabled(env),false);
});
test('worker registers concurrency one and runs generation only in handler',async()=>{
  const dates:string[]=[];
  await registerImageryJobs({} as PgBoss, {
    work: async (_boss,name,options,handler)=>{assert.equal(name,'imagery.apod');assert.equal(options.localConcurrency,1);assert.deepEqual(dates,[]);await handler({date:'2000-01-01'});},
    ensure:async(date)=>{dates.push(date);return null;},
  });
  assert.deepEqual(dates,['2000-01-01']);
});
