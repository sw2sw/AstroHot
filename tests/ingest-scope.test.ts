// Synthetic inputs only. Exercise the authenticated ingest handler's shared application path.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { ingestItems, IngestError } from "@aihot/backend/ingest/items";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { tag } from "./setup.ts";
import { buildApp } from "../apps/api/src/app.ts";
after(async () => { await stopBoss(); await closeDb(); });

test("manual classification selects AI4S per article without changing the publisher", async () => {
  const sourceId = `manual-scope-${tag()}`;
  const url = `https://example.org/${sourceId}/synthetic-logic-result`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,enabled)
    VALUES(${sourceId},'Synthetic publisher','external','{}'::jsonb,'T2','editorial',true)`;
  assert.deepEqual(await ingestItems({ sourceId, items: [{ title: 'Synthetic logic tool', url,
    contentScope: 'ai4s', scopeReason: 'AI-assisted logic study, no direct astronomy application.' }] }), { ok: true, created: 1 });
  const [a] = await sql`SELECT source_id,content_scope FROM articles WHERE url=${url}`;
  assert.equal(a!.content_scope, 'ai4s');
  assert.equal(a!.source_id, sourceId);
});

test("legacy input stays astronomy, source AI4S default works, and an explicit article choice wins", async () => {
  const id = `manual-default-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,enabled)
    VALUES(${id},'Synthetic mixed publisher','external',${sql.json({contentScope:'ai4s'})},'T2','editorial',true)`;
  await ingestItems({ sourceId:id, items:[{title:'Source-default material',url:`https://example.org/${id}/default`},
    {title:'Ordinary astronomy',url:`https://example.org/${id}/astro`,contentScope:'astro',scopeReason:'Ordinary astronomy report without AI methods.'}] });
  assert.deepEqual((await sql`SELECT content_scope FROM articles WHERE source_id=${id} ORDER BY url`).map(x=>x.content_scope),['astro','ai4s']);
  const legacy=`legacy-${tag()}`;
  await ingestItems({ sourceId:legacy, items:[{title:'Legacy input',url:`https://example.org/${legacy}`}] });
  assert.equal((await sql`SELECT content_scope FROM articles WHERE source_id=${legacy}`)[0]!.content_scope,'astro');
});

test("invalid classification is rejected before any source or material write", async () => {
  for (const classification of [{contentScope:'physics',scopeReason:'Invalid scope'}, {contentScope:'ai4s'}, {contentScope:'ai4s',scopeReason:'   '}]) {
    const id=`invalid-scope-${tag()}`;
    await assert.rejects(ingestItems({sourceId:id,items:[{title:'Synthetic invalid entry',url:`https://example.org/${id}`,...classification}]}),
      (e:unknown)=>e instanceof IngestError && e.status===400);
    assert.equal((await sql`SELECT id FROM sources WHERE id=${id}`).length,0);
  }
});

test("same-link replay is a no-op, and conflicting classification rolls back without revision or paid work", async () => {
  const id=`repeat-scope-${tag()}`,url=`https://example.org/${id}`;
  const item={title:'Synthetic original title',url,contentScope:'ai4s',scopeReason:'A synthetic AI research method.'};
  assert.deepEqual(await ingestItems({sourceId:id,items:[item]}),{ok:true,created:1});
  const [before]=await sql`SELECT id,revision,title,content_scope,processing_queued_at FROM articles WHERE url=${url}`;
  const receiptCount=(await sql`SELECT count(*)::int n FROM receipts`)[0]!.n;
  assert.deepEqual(await ingestItems({sourceId:id,items:[item]}),{ok:true,created:0});
  await assert.rejects(ingestItems({sourceId:id,items:[{...item,title:'Must not overwrite',contentScope:'astro'}]}),
    (e:unknown)=>e instanceof IngestError && e.status===409);
  const [after]=await sql`SELECT id,revision,title,content_scope,processing_queued_at FROM articles WHERE url=${url}`;
  assert.deepEqual(after,before);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n,receiptCount);
  assert.equal((await sql`SELECT participation_mode FROM sources WHERE id=${id}`)[0]!.participation_mode,'isolated');
  const audits=await sql`SELECT actor,reason FROM audit_log WHERE subject=${`content:${before!.id}`} AND action='content.classify'`;
  assert.equal(audits.length,1);
  assert.equal(audits[0]!.actor,'ingest-token');
  assert.equal(audits[0]!.reason,item.scopeReason);
});

test("HTTP manual ingest requires the existing token, validates scope, and preserves cross-list approval boundaries", async () => {
  process.env.INGEST_TOKEN='synthetic-ingest-scope-token-20261116';
  const app=await buildApp();
  try {
    const id=`http-scope-${tag()}`,url=`https://example.org/${id}`;
    const payload={sourceId:id,items:[{title:'Synthetic authenticated AI4S input',url,contentScope:'ai4s',scopeReason:'Synthetic evidence for a research method.'}]};
    const denied=await app.inject({method:'POST',url:'/api/ingest/items',payload});
    assert.equal(denied.statusCode,401);
    assert.equal((await sql`SELECT id FROM sources WHERE id=${id}`).length,0);
    const headers={authorization:`Bearer ${process.env.INGEST_TOKEN}`};
    const invalid=await app.inject({method:'POST',url:'/api/ingest/items',headers,payload:{...payload,items:[{...payload.items[0],contentScope:'invalid'}]}});
    assert.equal(invalid.statusCode,400);
    const ok=await app.inject({method:'POST',url:'/api/ingest/items',headers,payload});
    assert.equal(ok.statusCode,200);assert.deepEqual(ok.json(),{ok:true,created:1});
    const [a]=await sql`SELECT id,content_scope FROM articles WHERE url=${url}`;
    assert.equal(a!.content_scope,'ai4s');
    assert.equal((await sql`SELECT article_id FROM publications WHERE article_id=${a!.id} AND astro_cross_listed`).length,0);
    const conflict=await app.inject({method:'POST',url:'/api/ingest/items',headers,payload:{...payload,items:[{...payload.items[0],contentScope:'astro'}]}});
    assert.equal(conflict.statusCode,409);
  } finally {await app.close();delete process.env.INGEST_TOKEN;}
});
