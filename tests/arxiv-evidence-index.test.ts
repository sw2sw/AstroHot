import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { z } from 'zod';
const source=readFileSync(new URL('../packages/backend/src/arxiv/analyze.ts',import.meta.url),'utf8');
// Exercise the same production schema offline without importing model/DB modules.
const start=source.includes('function evidenceExcerpts(')?source.indexOf('function evidenceExcerpts('):source.indexOf('function hanText(');
const code=source.slice(start,source.indexOf('type ModelAnswer'));
const {answerSchema,evidenceExcerpts}=new Function('z','HAN',stripTypeScriptTypes(code)+';return {answerSchema,evidenceExcerpts:typeof evidenceExcerpts==="function"?evidenceExcerpts:undefined};')(z,/\p{Script=Han}/u);
const answer={title_zh:'中文研究',summary_zh:'摘要结果',reason_zh:'证据需要核查',verdict:'REVIEW',study_type:'mixed',fulltext_review_question:'如何控制误差？'};
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/arxiv-real-invalid-quotes.json',import.meta.url),'utf8'));
test('indexed evidence selects a non-first exact LaTeX/newline excerpt',()=>{
 const abstract='Context sentence. We measure $4\\%$\nwith uncertainty. Final result.';
 const parsed=answerSchema(abstract).parse({...answer,evidence_excerpt_index:1});
 assert.equal(parsed.evidence_abstract_quote,' We measure $4\\%$\nwith uncertainty.');
 assert.equal(Object.hasOwn(parsed,'evidence_excerpt_index'),false);
 assert.ok(abstract.includes(parsed.evidence_abstract_quote));
});
test('all 11 saved rewritten quotes fail closed; model indices copy real original evidence',()=>{
 assert.equal(fixtures.length,11);
 for(const row of fixtures){
  const original=JSON.parse(row.content);
  assert.equal(answerSchema(row.abstract_original).safeParse(original).success,false,row.subject);
  const excerpts=evidenceExcerpts(row.abstract_original);
  assert.ok(excerpts.length>1,row.subject);
  const {evidence_abstract_quote:ignored,...fields}=original;
  for(let index=0;index<excerpts.length;index++){
   const parsed=answerSchema(row.abstract_original).parse({...fields,evidence_excerpt_index:index});
   assert.equal(parsed.evidence_abstract_quote,excerpts[index]);
   assert.ok(row.abstract_original.includes(parsed.evidence_abstract_quote));
  }
 }
});
test('bad index types, out-of-range indices, freeform quotes and empty evidence are rejected',()=>{
 for(const index of [undefined,-1,1,0.5,'0',null,true,Infinity]) assert.equal(answerSchema('Evidence.').safeParse({...answer,evidence_excerpt_index:index}).success,false);
 assert.equal(answerSchema('Evidence.').safeParse({...answer,evidence_excerpt_index:0,evidence_abstract_quote:'Evidence.'}).success,false);
 for(const text of ['', ' \n\t']) assert.equal(answerSchema(text).safeParse({...answer,evidence_excerpt_index:0}).success,false);
 for(const bad of [{title_zh:'English only'},{summary_zh:'中'.repeat(6001)},{reason_zh:'中'.repeat(4001)},{fulltext_review_question:'中'.repeat(4001)},{verdict:'PUBLISHED'},{study_type:'invented'},{fulltext:'伪造全文'}])
  assert.equal(answerSchema('Evidence.').safeParse({...answer,evidence_excerpt_index:0,...bad}).success,false);
 const chunks=evidenceExcerpts('x'.repeat(24001));
 assert.ok(chunks.every((x:string)=>x.length<=12000&&x.trim().length>0));
 assert.equal(chunks.join(''),'x'.repeat(24001));
});
