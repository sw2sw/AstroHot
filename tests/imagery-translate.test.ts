import test from 'node:test';
import assert from 'node:assert/strict';
import { translateImagery } from '../packages/backend/src/imagery/translate.ts';
const metadata={source:'nasa-apod',sourceDate:'2026-10-01',titleEn:'A star cluster',explanationEn:'A cluster of stars. Distance: 100 light-years.'};
test('imagery translation uses stable subject and preserves source text in input',async()=>{
 let sent:any; const result=await translateImagery(metadata,{model:'default',enabled:true,chatImpl:async(options:any)=>{sent=options;return {data:{titleZh:'一个星团',explanationZh:'一群恒星。距离为100光年。'},receiptId:12};}});
 assert.deepEqual(result,{titleZh:'一个星团',explanationZh:'一群恒星。距离为100光年。',receiptId:12});
 assert.equal(sent.model,'default');assert.equal(sent.purpose,'imagery_translate');assert.match(sent.subject,/^imagery:nasa-apod:2026-10-01@[a-f0-9]{64}$/);assert.match(sent.user,/100 light-years/);assert.match(sent.system,/翻译/);
});
test('disabled translation never invokes model',async()=>{let calls=0;const r=await translateImagery(metadata,{model:'default',enabled:false,chatImpl:async()=>{calls++;throw Error('no');}});assert.equal(r,null);assert.equal(calls,0);});
test('blank output is rejected rather than archived as complete',async()=>{await assert.rejects(translateImagery(metadata,{model:'default',enabled:true,chatImpl:async()=>({data:{titleZh:' ',explanationZh:''},receiptId:1})}));});
test('same source content produces same translation request key',async()=>{const subjects:string[]=[];const fn=async(o:any)=>{subjects.push(o.subject);return {data:{titleZh:'标题',explanationZh:'解说'},receiptId:1};};await translateImagery(metadata,{model:'default',enabled:true,chatImpl:fn});await translateImagery({...metadata},{model:'default',enabled:true,chatImpl:fn});assert.equal(subjects[0],subjects[1]);});
