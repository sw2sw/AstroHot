import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArxivQuery } from '../packages/backend/src/arxiv/collect.ts';
test('six-category submitted-date window can request later pages rather than forever newest20',()=>{
 const q=new URL(buildArxivQuery(100,{start:100,submittedFrom:'202610040000',submittedThrough:'202610062359'}));
 assert.equal(q.searchParams.get('start'),'100');assert.equal(q.searchParams.get('max_results'),'100');
 for(const c of ['CO','EP','GA','HE','IM','SR']) assert.ok(q.searchParams.get('search_query')!.includes('cat:astro-ph.'+c));
 assert.ok(q.searchParams.get('search_query')!.includes('submittedDate:[202610040000 TO 202610062359]'));
});
test('query ID hydration validates exact version tokens before lookup',()=>{
 const q=new URL(buildArxivQuery(100,{idList:['2610.03738v1','2610.04048v2']}));
 assert.equal(q.searchParams.get('id_list'),'2610.03738v1,2610.04048v2');assert.equal(q.searchParams.has('search_query'),false);
 for(const id of ['2610.03738v0','2610.03738v01','oops','2610.03738v1,other']) assert.throws(()=>buildArxivQuery(100,{idList:[id]}));
});
