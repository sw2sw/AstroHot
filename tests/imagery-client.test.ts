import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupImagery} from '../apps/web/app/features/imagery/client.ts';
test('birthday client sends only POST body and no-store without credentials or date in URL',async()=>{let url='';let init:RequestInit|undefined;const f:typeof fetch=async(u,i)=>{url=String(u);init=i;return new Response(JSON.stringify({item:null,status:'unavailable'}));};assert.deepEqual(await lookupImagery('2000-01-01',f),{item:null,status:'unavailable'});assert.equal(url,'/api/imagery/lookup');assert.equal(init?.method,'POST');assert.equal(init?.cache,'no-store');assert.equal(init?.body,'{"date":"2000-01-01"}');});
test('birthday client reports generic failure instead of echoing upstream body',async()=>{const f:typeof fetch=async()=>new Response('private birthday and token',{status:503});await assert.rejects(lookupImagery('2000-01-01',f),/^Error: 暂时无法查询天文影像$/);});
test('birthday waits using only private read-only POST status then returns ready',async()=>{
 let now=0;const urls:string[]=[];
 const f:typeof fetch=async(u,i)=>{urls.push(String(u));assert.equal(i?.body,'{"date":"2000-01-01"}');assert.equal(i?.cache,'no-store');return new Response(JSON.stringify({item:null,status:urls.length===3?'ready':'pending'}));};
 const result=await lookupImagery('2000-01-01',f,{now:()=>now,sleep:async(ms)=>{now+=ms;}});
 assert.equal(result.status,'ready');assert.deepEqual(urls,['/api/imagery/lookup','/api/imagery/status','/api/imagery/status']);assert.equal(now,6000);
});
test('polling deadline preserves last pending item with models disabled',async()=>{
 let now=0,hits=0;const item={titleEn:'cached'};
 const f:typeof fetch=async()=>{hits++;return new Response(JSON.stringify({item:hits===1?item:null,status:'pending'}));};
 const result=await lookupImagery('2000-01-01',f,{now:()=>now,sleep:async(ms)=>{now+=ms;}});
 assert.equal(result.status,'pending');assert.deepEqual(result.item,item);assert.ok(now<=100000);assert.ok(hits<=34);
});
