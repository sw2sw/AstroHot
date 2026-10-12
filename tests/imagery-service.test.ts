import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const runId=randomUUID();
import './setup.ts';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {ensureImagery} from '../packages/backend/src/imagery/service.ts';
const metadata=(date:string)=>({source:'nasa-apod' as const,sourceDate:date,sourceId:date,titleEn:'Fixture',explanationEn:'Synthetic text.',credit:'Fixture',copyright:null,sourceUrl:'https://apod.nasa.gov/apod/ap000101.html',mediaType:'image' as const,imageUrl:'https://assets.science.nasa.gov/a.png',mediaUrl:null,altEn:null});
import {paidRequest} from '../packages/backend/src/providers/receipts.ts';
async function receipt(date:string) { return (await paidRequest({service:'synthetic-imagery',purpose:'imagery_translate',identity:{date,runId}},async()=>({response:{titleZh:'图',explanationZh:'说明'}}))).receiptId; }
test('translation commits completed receipt and archive provenance',async()=>{
 const date='2000-01-05';const receiptId=await receipt(date);
 await ensureImagery(date,{fetch:async()=>({...metadata(date),mediaType:'video',imageUrl:null}),translate:async()=>({titleZh:'图',explanationZh:'说明',receiptId})});
 const [r]=await sql`SELECT status,completed_at FROM receipts WHERE id=${receiptId}`;
 assert.equal(r.status,'completed');assert.ok(r.completed_at);
 const [a]=await sql`SELECT translation_receipt_id FROM imagery_archive WHERE source_date=${date}`;
 assert.equal(a.translation_receipt_id,receiptId);
});
test('completion failure rolls back Chinese and replays the received response without another paid call',async()=>{
 const date='2000-01-06';let calls=0;
 const translate=async()=>{const result=await paidRequest({service:'synthetic-imagery',purpose:'imagery_translate',identity:{date,runId}},async()=>{calls++;return {response:{titleZh:'图',explanationZh:'说明'}};});return {...result.response as {titleZh:string;explanationZh:string},receiptId:result.receiptId};};
 const deps={fetch:async()=>({...metadata(date),mediaType:'video' as const,imageUrl:null}),translate};
 await sql.unsafe(`CREATE FUNCTION fail_imagery_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'synthetic commit failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe('CREATE TRIGGER fail_imagery_completion BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_imagery_completion()');
 try {
  await assert.rejects(ensureImagery(date,deps),/synthetic commit failure/);
  const [a]=await sql`SELECT title_zh,translation_status,translation_receipt_id FROM imagery_archive WHERE source_date=${date}`;
  assert.deepEqual(a,{title_zh:null,translation_status:'pending',translation_receipt_id:null});
  const [r]=await sql`SELECT status FROM receipts WHERE service='synthetic-imagery' ORDER BY id DESC LIMIT 1`;assert.equal(r.status,'received');
 } finally {await sql.unsafe('DROP TRIGGER fail_imagery_completion ON receipts');await sql.unsafe('DROP FUNCTION fail_imagery_completion()');}
 assert.equal((await ensureImagery(date,deps))?.translationStatus,'ready');assert.equal(calls,1);
});
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {config} from '../packages/backend/src/config.ts';
async function archived(letter:string) {const localPath=letter.repeat(64);await mkdir(path.join(config.dataDir,'imagery'),{recursive:true});await writeFile(path.join(config.dataDir,'imagery',localPath),await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer());return {localPath,contentType:'image/png'};}
test('missing ready image is recovered without refetching metadata or translating again',async()=>{
 const date='2000-01-07';let downloads=0;
 const deps={fetch:async()=>metadata(date),archive:async()=>{downloads++;return archived('e');},translate:async()=>({titleZh:'图',explanationZh:'说明',receiptId:await receipt(date)})};
 await ensureImagery(date,deps);await unlink(path.join(config.dataDir,'imagery','e'.repeat(64)));
 const recovered=await ensureImagery(date,{...deps,fetch:async()=>assert.fail('metadata refetch'),translate:async()=>assert.fail('translation repeat')});
 assert.equal(recovered?.mediaStatus,'ready');assert.equal(downloads,2);
 assert.ok(await import('node:fs/promises').then(fs=>fs.stat(path.join(config.dataDir,'imagery','e'.repeat(64)))));
});
import {requestImagery} from '../packages/backend/src/imagery/request.ts';
test('reader validates existing bytes without enqueue and queues a missing image without archive mutation',async()=>{
 const date='2000-01-08';const deps={fetch:async()=>metadata(date),archive:async()=>archived('f'),translate:async()=>({titleZh:'图',explanationZh:'说明',receiptId:await receipt(date)})};
 const original=await ensureImagery(date,deps);
 assert.deepEqual(await requestImagery(date,{enabled:true,enqueue:async()=>assert.fail('complete image queued')}),{item:original,status:'ready'});
 await unlink(path.join(config.dataDir,'imagery','f'.repeat(64)));
 const [beforeRead]=await sql`SELECT * FROM imagery_archive WHERE source_date=${date}`;
 let queued=0;const pending=await requestImagery(date,{enabled:true,enqueue:async()=>{queued++;return null;}});
 assert.equal(queued,1);assert.equal(pending.status,'pending');assert.equal(pending.item?.imageUrl,null);
 const [afterRead]=await sql`SELECT * FROM imagery_archive WHERE source_date=${date}`;assert.deepEqual(afterRead,beforeRead);
 assert.equal((await requestImagery(date,{enabled:false,enqueue:async()=>assert.fail('disabled queue')})).status,'pending');
});
test('missing ready image download failure remains retryable and preserves paid translation',async()=>{
 const date='2000-01-09';await ensureImagery(date,{fetch:async()=>metadata(date),archive:async()=>archived('a'),translate:async()=>({titleZh:'图',explanationZh:'说明',receiptId:await receipt(date)})});
 await unlink(path.join(config.dataDir,'imagery','a'.repeat(64)));
 const deps={fetch:async()=>assert.fail('metadata refetch'),translate:async()=>assert.fail('translation repeat'),archive:async()=>{throw Error('private upstream error');}};
 const failed=await ensureImagery(date,deps);assert.equal(failed?.mediaStatus,'failed');assert.equal(failed?.imageUrl,null);assert.equal(failed?.translationStatus,'ready');
 const [row]=await sql`SELECT media_error_code,translation_receipt_id FROM imagery_archive WHERE source_date=${date}`;assert.equal(row.media_error_code,'media_unavailable');assert.ok(row.translation_receipt_id);
 const [r]=await sql`SELECT status FROM receipts WHERE id=${row.translation_receipt_id}`;assert.equal(r.status,'completed');
 assert.equal((await ensureImagery(date,{...deps,archive:async()=>archived('a')}))?.mediaStatus,'ready');
});
before(async()=>{await sql`TRUNCATE imagery_archive,imagery_claims`;});
after(closeDb);
test('image retry preserves translation and clears bounded failure code',async()=>{let downloads=0,translations=0;const deps={fetch:async(d:string)=>metadata(d),archive:async()=>{downloads++;if(downloads===1)throw Error('upstream failed');return archived('d');},translate:async()=>{translations++;return {titleZh:'图',explanationZh:'说明',receiptId:await receipt('2000-01-04')};}};assert.equal((await ensureImagery('2000-01-04',deps))?.mediaStatus,'failed');assert.equal((await ensureImagery('2000-01-04',deps))?.mediaStatus,'ready');assert.deepEqual([downloads,translations],[2,1]);const [r]=await sql`SELECT media_error_code FROM imagery_archive WHERE source_date='2000-01-04'`;assert.equal(r?.media_error_code,null);});
test('first lookup archives all stages and repeated lookup invokes no upstream or AI',async()=>{let fetches=0,downloads=0,translations=0;const deps={fetch:async(d:string)=>{fetches++;return metadata(d);},archive:async()=>{downloads++;return archived('a');},translate:async()=>{translations++;return {titleZh:'图',explanationZh:'说明',receiptId:await receipt('2000-01-01')};}};const first=await ensureImagery('2000-01-01',deps);assert.equal(first?.translationStatus,'ready');assert.equal(first?.mediaStatus,'ready');assert.deepEqual(await ensureImagery('2000-01-01',deps),first);assert.deepEqual([fetches,downloads,translations],[1,1,1]);});
test('failed translation retries only translation and preserves completed image and metadata',async()=>{let fetches=0,downloads=0,translations=0;const deps={fetch:async(d:string)=>{fetches++;return metadata(d);},archive:async()=>{downloads++;return archived('b');},translate:async()=>{translations++;if(translations===1)throw Error('private upstream detail');return {titleZh:'图',explanationZh:'说明',receiptId:await receipt('2000-01-02')};}};assert.equal((await ensureImagery('2000-01-02',deps))?.translationStatus,'failed');assert.equal((await ensureImagery('2000-01-02',deps))?.translationStatus,'ready');assert.deepEqual([fetches,downloads,translations],[1,1,2]);const [row]=await sql`SELECT translation_error_code FROM imagery_archive WHERE source_date='2000-01-02'`;assert.equal(row?.translation_error_code,null);});
test('concurrent same-date queries have one owner and no duplicate expensive stages',async()=>{let downloads=0,translations=0;const deps={fetch:async(d:string)=>{await new Promise(r=>setTimeout(r,30));return metadata(d);},archive:async()=>{downloads++;return archived('c');},translate:async()=>{translations++;return {titleZh:'图',explanationZh:'说明',receiptId:await receipt('2000-01-03')};}};await Promise.all([ensureImagery('2000-01-03',deps),ensureImagery('2000-01-03',deps)]);assert.deepEqual([downloads,translations],[1,1]);assert.equal((await ensureImagery('2000-01-03',deps))?.translationStatus,'ready');});
