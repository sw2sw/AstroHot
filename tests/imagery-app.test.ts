import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import './setup.ts';
import {buildApp} from '../apps/api/src/app.ts';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {getBoss,stopBoss} from '../packages/backend/src/jobs/queue.ts';
// The status test counts pgboss.job rows, and pg-boss creates that schema on first start.
before(getBoss);
after(async()=>{await stopBoss();await closeDb();});
test('real application exposes persisted imagery archive without invoking generation',async()=>{
 const app=await buildApp();try{const r=await app.inject({url:'/api/imagery/items?limit=2'});assert.equal(r.statusCode,200);assert.ok(Array.isArray(r.json().items));assert.ok(r.json().items.length<=2);const [count]=await sql`SELECT count(*)::int AS n FROM imagery_claims`;assert.equal(count?.n,0);assert.equal((await app.inject({method:'POST',url:'/api/imagery/lookup',payload:{date:'2000-02-30'}})).statusCode,400);assert.equal((await app.inject({url:'/api/imagery/media/.env'})).statusCode,400);}finally{await app.close();}
});
test('read-only status reports missing cached image as pending without enqueuing work',async()=>{
 const date='2010-10-10';const metadata={source:'nasa-apod',sourceDate:date,sourceId:date,titleEn:'Synthetic missing image',explanationEn:'Fixture.',credit:'Fixture',copyright:null,sourceUrl:'https://apod.nasa.gov/apod/ap101010.html',mediaType:'image',imageUrl:'https://assets.science.nasa.gov/fixture.png',mediaUrl:null,altEn:null};
 await sql`INSERT INTO imagery_archive (source,source_date,metadata,content_hash,local_path,content_type,media_status,translation_status) VALUES ('nasa-apod',${date},${sql.json(metadata)},${'0'.repeat(64)},${'0'.repeat(64)},'image/png','ready','ready') ON CONFLICT (source,source_date) DO UPDATE SET local_path=EXCLUDED.local_path,media_status='ready',translation_status='ready'`;
 const app=await buildApp();try{const before=await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name='imagery.apod'`;const r=await app.inject({method:'POST',url:'/api/imagery/status',payload:{date}});assert.equal(r.statusCode,200);assert.equal(r.json().status,'pending');assert.equal(r.json().item.imageUrl,null);assert.deepEqual(await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name='imagery.apod'`,before);}finally{await app.close();await sql`DELETE FROM imagery_archive WHERE source='nasa-apod' AND source_date=${date}`;}
});
