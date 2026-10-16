import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const names=(analysis:string,models:string)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"const {SCHEDULES}=await import('./apps/worker/src/schedules.ts');console.log(JSON.stringify(SCHEDULES.filter(s=>s.name==='arxiv.analyze').map(s=>({name:s.name,cron:s.cron}))));"],{env:{...process.env,ARXIV_ANALYSIS_ENABLED:analysis,MODEL_CALLS_ENABLED:models},timeout:10000,encoding:'utf8'}));
test('arxiv analysis schedule is opt-in and requires both literal true valves',()=>{
 for(const flags of [['false','false'],['true','false'],['false','true'],['1','true'],['true','1']]) assert.deepEqual(names(flags[0]!,flags[1]!),[]);
 assert.deepEqual(names('true','true'),[{name:'arxiv.analyze',cron:'* * * * *'}]);
});
