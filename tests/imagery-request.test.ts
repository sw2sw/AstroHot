import test from 'node:test';
import assert from 'node:assert/strict';
import { requestImagery } from '../packages/backend/src/imagery/request.ts';

test('missing archive queues only one public date singleton and returns pending', async () => {
  const sent: unknown[] = [];
  const result = await requestImagery('2000-01-01', {
    get: async () => null,
    enqueue: async (...args) => { sent.push(args); return null; },
    enabled: true,
  });
  assert.deepEqual(result, {item:null,status:'pending'});
  assert.deepEqual(sent, [['imagery.apod', {date:'2000-01-01'}, {singletonKey:'nasa-apod:2000-01-01'}]]);
});
test('invalid date is rejected before reads or enqueue',async()=>{
 await assert.rejects(requestImagery('2000-02-30',{get:async()=>{assert.fail('read');},enqueue:async()=>{assert.fail('enqueue');}}));
});
test('ready database row with missing local image queues recovery without doing upstream work',async()=>{
 const item={translationStatus:'ready',mediaStatus:'ready',imageUrl:'/api/imagery/media/'+'f'.repeat(64)} as any;
 const sent:unknown[]=[];
 const result=await requestImagery('2000-01-08',{get:async()=>item,enqueue:async(...args)=>{sent.push(args);return null;},enabled:true});
 assert.equal(result.status,'pending');assert.equal(sent.length,1);
 assert.equal(result.item?.imageUrl,null);
 assert.equal(result.item?.mediaStatus,'pending');
});
test('complete archive bypasses queue even when collection disabled',async()=>{
 const item={translationStatus:'ready',mediaStatus:'not_applicable'} as any;
 assert.deepEqual(await requestImagery('2000-01-01',{get:async()=>item,enqueue:async()=>{assert.fail('enqueue');},enabled:false}),{item,status:'ready'});
});
test('collection disabled never queues a miss or partial archive',async()=>{
 for(const item of [null,{translationStatus:'pending',mediaStatus:'not_applicable'} as any])assert.deepEqual(await requestImagery('2000-01-01',{get:async()=>item,enqueue:async()=>{assert.fail('enqueue');},enabled:false}),{item,status:item?'pending':'unavailable'});
});
