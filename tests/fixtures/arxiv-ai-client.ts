import '../../tests/setup.ts';
import {closeDb} from '../../packages/backend/src/db.ts';
import {SCHEDULES} from '../../apps/worker/src/schedules.ts';
import {chatJson} from '../../packages/backend/src/providers/llm.ts';
import {z} from 'zod';
try {
 if(process.argv[2]==='arxiv') {
  const schedule=SCHEDULES.find(s=>s.name==='arxiv.analyze');
  if(!schedule) throw new Error('opt-in analysis schedule missing');
  console.log(JSON.stringify(await schedule.run()));
 }
 else {const results=await Promise.all(Array.from({length:5},(_,i)=>chatJson({model:'default',purpose:'news',subject:`news-real-${process.argv[3]}-${i}`,promptVersion:'news-real-v1',system:'',user:`news-${i}`,schema:z.object({ok:z.boolean()})})));console.log(JSON.stringify({done:results.length,reused:results.filter(r=>r.reused).length}));}
} finally {await closeDb();}
