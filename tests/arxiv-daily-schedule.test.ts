import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const schedules=(flag:string)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"const {SCHEDULES}=await import('./apps/worker/src/schedules.ts');console.log(JSON.stringify(SCHEDULES.filter(s=>s.name==='arxiv.daily-report').map(s=>({name:s.name,cron:s.cron}))));"],{env:{...process.env,ARXIV_DAILY_REPORT_ENABLED:flag,MODEL_CALLS_ENABLED:'false',COLLECT_ENABLED:'false'},timeout:10000,encoding:'utf8'}));
test('daily aggregation is opt-in but independent of model and collect valves',()=>{
 for(const flag of ['false','','1']) assert.deepEqual(schedules(flag),[]);
 assert.deepEqual(schedules('true'),[{name:'arxiv.daily-report',cron:'7,37 * * * *'}]);
});
