import test from 'node:test';
import assert from 'node:assert/strict';
async function http(){const m=await import('../packages/backend/src/arxiv/http.ts').catch(()=>null);assert.equal(typeof m?.fetchArxivXml,'function','bounded official-source fetch must exist');return m!.fetchArxivXml;}
test('official metadata requests bound chunked bodies and HTTP errors',async()=>{
 const get=await http();const url='https://rss.arxiv.org/rss/astro-ph';
 assert.equal(await get(url,{fetch:async()=>new Response('ok'),maxBytes:2}),'ok');
 await assert.rejects(get(url,{fetch:async()=>new Response('oversized'),maxBytes:2}),/maxBytes|exceed|limit/i);
 await assert.rejects(get(url,{fetch:async()=>new Response('down',{status:503})}),/503/);
 await assert.rejects(get('https://localhost/rss/astro-ph',{fetch:async()=>new Response('no')}));
});
test('timeout covers headers and streamed body without any business provider',async()=>{
 const get=await http();const url='https://rss.arxiv.org/rss/astro-ph';
 await assert.rejects(get(url,{timeoutMs:15,fetch:async()=>new Promise(()=>{})}),/timed out|timeout/i);
 let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<rss>'));},cancel(){cancelled=true;}});
 await assert.rejects(get(url,{timeoutMs:15,fetch:async()=>new Response(body)}),/timed out|timeout/i);assert.equal(cancelled,true);
});

// --- ROUND3 (B1/B2): a known HTTP status can never be lost to its own body, and failure
// --- evidence is the response's real prefix under the byte budget — never padded bytes.
test('a 429 keeps its identity when its body hangs, dies, or is cancelled',async()=>{
 const m=await import('../packages/backend/src/arxiv/http.ts');
 const get=m.fetchArxivXml;const url='https://rss.arxiv.org/rss/astro-ph';
 // A 429 whose body never finishes: the timeout must reject with the 429 ITSELF (the shared hold
 // branches on this), carrying whatever prefix arrived, not a plain timeout error.
 const hanging=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('429-body-prefix'));}});
 const hungErr=await get(url,{timeoutMs:30,fetch:async()=>new Response(hanging,{status:429})}).then(()=>null,(e)=>e);
 assert.ok(hungErr instanceof m.ArxivHttpError,`expected ArxivHttpError, got ${hungErr}`);
 assert.equal(hungErr!.status,429);
 assert.equal(hungErr!.bodyText,'429-body-prefix');
 assert.equal(hungErr!.bodyTruncated,true);
 // A 429 whose body read REJECTS mid-stream: the prefix survives and is marked incomplete, and the
 // status still wins — a body failure never replaces the HTTP status.
 let pulls=0;
 const dying=new ReadableStream({
   pull(c){pulls++;if(pulls===1)c.enqueue(new TextEncoder().encode('partial-'));else throw new Error('socket died');},
 });
 const deadErr=await get(url,{timeoutMs:5000,fetch:async()=>new Response(dying,{status:429})}).then(()=>null,(e)=>e);
 assert.ok(deadErr instanceof m.ArxivHttpError);
 assert.equal(deadErr!.status,429);
 assert.equal(deadErr!.bodyText,'partial-');
 assert.equal(deadErr!.bodyTruncated,true);
 // A fully-read 429 body travels complete (not flagged truncated).
 const fullErr=await get(url,{timeoutMs:5000,fetch:async()=>new Response('gone',{status:429})}).then(()=>null,(e)=>e);
 assert.ok(fullErr instanceof m.ArxivHttpError);
 assert.equal(fullErr!.status,429);
 assert.equal(fullErr!.bodyText,'gone');
 assert.equal(fullErr!.bodyTruncated,false);
});

test('failure evidence stays within the byte budget and equals the real response prefix',async()=>{
 const m=await import('../packages/backend/src/arxiv/http.ts');
 const get=m.fetchArxivXml;const url='https://export.arxiv.org/api/query';
 // First chunk alone exceeds the budget: exactly maxBytes of the REAL prefix is kept — no
 // zero-padding, no over-budget allocation, truncated stated.
 const big=new TextEncoder().encode('0123456789ABCDEF'); // 16 bytes, budget 8
 const first=await get(url,{maxBytes:8,fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(big);}}),{status:503})}).then(()=>null,(e)=>e);
 assert.ok(first instanceof m.ArxivHttpError);
 assert.equal(first!.status,503);
 assert.equal(first!.bodyText,'01234567');
 assert.equal(first!.bodyTruncated,true);
 // The budget boundary falls INSIDE a later chunk: the kept bytes are the exact response prefix.
 const chunks=['aaaaaa','bbbbbbbb','cc']; // 6+8+2 = 16 bytes, budget 10 -> 6+4 kept
 const stream=new ReadableStream({start(c){for(const part of chunks)c.enqueue(new TextEncoder().encode(part));}});
 const second=await get(url,{maxBytes:10,fetch:async()=>new Response(stream,{status:503})}).then(()=>null,(e)=>e);
 assert.ok(second instanceof m.ArxivHttpError);
 assert.equal(second!.bodyText,'aaaaaabbbb');
 assert.equal(second!.bodyTruncated,true);
 // An empty failure body is empty evidence, not padded bytes.
 const third=await get(url,{maxBytes:8,fetch:async()=>new Response('',{status:503})}).then(()=>null,(e)=>e);
 assert.ok(third instanceof m.ArxivHttpError);
 assert.equal(third!.bodyText,'');
 assert.equal(third!.bodyTruncated,false);
});
