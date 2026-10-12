import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import './setup.ts';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {claimImageryDate,releaseImageryDate} from '../packages/backend/src/imagery/claims.ts';
after(async()=>{await sql`DELETE FROM imagery_claims WHERE source = 'test-imagery-claims'`;await closeDb();});
test('separate concurrent claims allow only one owner without retaining a pool connection',async()=>{
 const date='2026-10-01'; const claims=await Promise.all([claimImageryDate('test-imagery-claims',date),claimImageryDate('test-imagery-claims',date)]);
 assert.equal(claims.filter(Boolean).length,1);await sql`SELECT 1`;await releaseImageryDate('test-imagery-claims',date,claims.find(Boolean)!);
});
test('wrong token cannot release the active owner',async()=>{
 const date='2026-10-02';const token=await claimImageryDate('test-imagery-claims',date);assert.ok(token);
 await releaseImageryDate('test-imagery-claims',date,'00000000-0000-0000-0000-000000000000');assert.equal(await claimImageryDate('test-imagery-claims',date),null);
 await releaseImageryDate('test-imagery-claims',date,token);const next=await claimImageryDate('test-imagery-claims',date);assert.ok(next);await releaseImageryDate('test-imagery-claims',date,next);
});
test('expired crash lease can be reclaimed and old token cannot release replacement',async()=>{
 const date='2026-10-03';const old=await claimImageryDate('test-imagery-claims',date);assert.ok(old);
 await sql`UPDATE imagery_claims SET expires_at = now() - interval '1 second' WHERE source='test-imagery-claims' AND source_date=${date}`;
 const next=await claimImageryDate('test-imagery-claims',date);assert.ok(next);assert.notEqual(next,old);await releaseImageryDate('test-imagery-claims',date,old);assert.equal(await claimImageryDate('test-imagery-claims',date),null);await releaseImageryDate('test-imagery-claims',date,next);
});
