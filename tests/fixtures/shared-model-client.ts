import '../../tests/setup.ts';
import { chatJson } from '../../packages/backend/src/providers/llm.ts';
import { closeDb } from '../../packages/backend/src/db.ts';
import { z } from 'zod';
import { ModelLimitBusyError } from '../../packages/backend/src/providers/model-limit.ts';
// A smaller normal cap makes some concurrent jobs retryable busy. Requeue only unsent
// admissions; unknown paid outcomes must never be retried by this fixture.
async function invoke(i: number) {
 const deadline = Date.now() + 8000;
 for (;;) {
  try {
   return await chatJson({model:'default',purpose:process.argv[2]!,subject:`${process.argv[2]}-${process.argv[3]}-${i}`,promptVersion:'limiter-independent-v1',system:'',user:`${process.argv[2]}-${process.argv[3]}-${i}`,schema:z.object({ok:z.boolean()})});
  } catch (error) {
   if (!(error instanceof ModelLimitBusyError) || Date.now() >= deadline) throw error;
   await new Promise(resolve => setTimeout(resolve, error.retryAfterSeconds * 1000));
  }
 }
}
try {
 const results = await Promise.all(Array.from({length:6},(_,i)=>invoke(i)));
 console.log(JSON.stringify({done:results.length,reused:results.filter(r=>r.reused).length}));
} finally { await closeDb(); }
