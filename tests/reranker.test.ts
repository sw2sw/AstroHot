import { Reply, embeddingsStub, stub, tag } from './setup.ts';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';

let answer: unknown = { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] };
let request: { url: string; body: string };
const provider = await stub((_hit, req) => { request = req; return answer; });
process.env.RERANKER_BASE_URL = `${provider.url}/v1`;
process.env.RERANKER_API_KEY = 'local-fixture-key';
process.env.RERANKER_MODEL = 'fixture-reranker';
after(async () => { const { stopBoss } = await import('@aihot/backend/jobs/queue'); await stopBoss(); await provider.close(); await closeDb(); });

test('reranker uses a paid validated result and replays received/completed receipts without calling upstream', async () => {
  const { rerank } = await import('@aihot/backend/providers/reranker');
  const subject = `article:${tag()}`;
  const before = provider.hits();
  assert.deepEqual(await rerank('query', ['first', 'second'], subject), [1, 0]);
  assert.equal(request!.url, '/v1/rerank');
  assert.deepEqual(JSON.parse(request!.body), { model: 'fixture-reranker', query: 'query', documents: ['first', 'second'], top_n: 2, return_documents: false });
  const [receipt] = await sql`SELECT id,status,completed_at FROM receipts WHERE purpose='rerank' AND subject=${subject}`;
  assert.equal(receipt!.status, 'completed');
  assert.ok(receipt!.completed_at);
  await sql`UPDATE receipts SET status='received', completed_at=NULL WHERE id=${receipt!.id}`;
  assert.deepEqual(await rerank('query', ['first', 'second'], subject), [1, 0]);
  assert.deepEqual(await rerank('query', ['first', 'second'], subject), [1, 0]);
  assert.equal(provider.hits() - before, 1);
});

test('actual recall reranks only the existing shortlist, preserving pinned seeds and cosine scores', async () => {
  const { recallFacts } = await import('@aihot/backend/events/recall');
  const id = tag();
  const source = `rerank-${id}`;
  await sql`INSERT INTO sources (id,name,kind,tier) VALUES (${source},'fixture','rss','T1')`;
  const facts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { upsertMaterial } = await import('@aihot/backend/content/materials');
    const { articleId: article } = await upsertMaterial({ sourceId: source, url: `https://example.org/${id}-${i}`, title: '星系研究发现新恒星', bodyText: 'fixture', bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
    const [story] = await sql`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},'fixture') RETURNING id`;
    const [fact] = await sql`INSERT INTO facts (public_id,story_id,title) VALUES (${`f-${article}`},${story!.id},${`候选${i}`}) RETURNING id`;
    facts.push(Number(fact!.id));
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${article},'primary')`;
  }
  const seed = (await sql`SELECT fa.article_id,fa.fact_id,f.story_id,f.title AS fact_title FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.fact_id=${facts[3]!}`)[0]!;
  const query = `query-${id}`;
  const text = '星系研究发现新恒星';
  const base = await recallFacts(query, text, 0.6, 3, [seed as any]);
  const before = provider.hits();
  answer = { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] };
  const result = await recallFacts(query, text, 0.6, 3, [seed as any], true);
  assert.deepEqual(result.map(r => r.factId), [facts[3], ...base.filter(r => r.factId !== facts[3]).slice(0, 2).reverse().map(r => r.factId)]);
  assert.equal(result.length, 3);
  assert.deepEqual(new Map(result.map(r => [r.factId, r.score])), new Map(base.map(r => [r.factId, r.score])));
  assert.equal(provider.hits() - before, 1);
  assert.equal(JSON.parse(request!.body).documents.length, 2);
});

test('event grouping calls reranker but high relevance never merges an unrelated fact', async () => {
  const { upsertMaterial } = await import('@aihot/backend/content/materials');
  const { publishArticle } = await import('@aihot/backend/publication/publish');
  const { groupArticle } = await import('@aihot/backend/events/group');
  const { stopBoss } = await import('@aihot/backend/jobs/queue');
  const source = `group-rerank-${tag()}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${source},'fixture','rss','T1','editorial','2100-01-01')`;
  const reports: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}/${i}`, title: '星系研究发现新恒星', bodyText: '星系研究发现新恒星。', bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
    reports.push(articleId);
    await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,output) VALUES (${articleId},1,'rule','pass','other','星系研究发现新恒星','星系研究发现新恒星',80,true,${sql.json({ scope: 'single', fact: { title: '星系研究发现新恒星', subject: '星系', action: '发现', object: '恒星' } })})`;
    await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
    await publishArticle(articleId);
    if (i < 2) {
      const [story] = await sql`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},'fixture') RETURNING id`;
      const [fact] = await sql`INSERT INTO facts (public_id,story_id,title) VALUES (${`f-${articleId}`},${story!.id},'星系研究发现新恒星') RETURNING id`;
      await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${articleId},'primary')`;
    }
  }
  const judge = await stub((_hit, req) => {
    const text = JSON.stringify(JSON.parse(req.body).messages);
    const ids = [...text.matchAll(/【候选 (C\d+)】/g)].map(m => m[1]);
    return { choices: [{ message: { content: JSON.stringify({ query: 'fixture', decisions: ids.map(id => ({ id, relation: 'UNRELATED', confidence: 1, note: '' })), selection: { addsValue: true, reason: 'fixture' } }) } }] };
  });
  process.env.DEEPSEEK_BASE_URL = `${judge.url}/v1`;
  process.env.DEEPSEEK_API_KEY = 'local-fixture-key';
  answer = { results: Array.from({ length: 6 }, (_, index) => ({ index, relevance_score: index + 1 })) };
  const before = provider.hits();
  try {
    const result = await groupArticle(reports[2]!);
    assert.equal(result.verdict, 'new-story');
    assert.equal(provider.hits() - before, 1, 'editorial grouping must use optional rerank');
    assert.equal(judge.hits(), 1);
  } finally { await judge.close(); }
});

test('invalid count/index/score answers are failed received results, not unknown outcomes', async () => {
  const { rerank } = await import('@aihot/backend/providers/reranker');
  for (const invalid of [null, {}, { results: [] },
    { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 2 }] },
    { results: [{ index: 0, relevance_score: 1 }, { index: 2, relevance_score: 2 }] },
    { results: [{ index: 0.5, relevance_score: 1 }, { index: 1, relevance_score: 2 }] },
    { results: [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 2 }] },
    { results: [{ index: 0, relevance_score: 'NaN' }, { index: 1, relevance_score: 2 }] }]) {
    const subject = `article:${tag()}`;
    answer = invalid;
    await assert.rejects(rerank('query', ['a', 'b'], subject), /Unusable rerank/);
    const [row] = await sql`SELECT status,response FROM receipts WHERE subject=${subject}`;
    assert.equal(row!.status, 'failed');
    assert.deepEqual(row!.response, invalid);
  }
});

test('bounded texts, stable equal-score ordering and candidate cap', async () => {
  const { rerank } = await import('@aihot/backend/providers/reranker');
  answer = { results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.8 }] };
  assert.deepEqual(await rerank('q'.repeat(4000), ['a'.repeat(4000), 'b'.repeat(4000)], `article:${tag()}`), [0, 1]);
  assert.equal(JSON.parse(request!.body).query.length, 2000);
  assert.deepEqual(JSON.parse(request!.body).documents.map((s: string) => s.length), [2000, 2000]);
  const before = provider.hits();
  await assert.rejects(rerank('q', Array(21).fill('a'), 'too-large'), /2–20/);
  assert.equal(provider.hits(), before);
});

test('stored embedding recall feeds a bounded rerank without reembedding cached reports', async () => {
  const { recallFacts } = await import('@aihot/backend/events/recall');
  const embedding = await embeddingsStub();
  const query = `embedding-${tag()}`;
  const text = '星系研究发现新恒星';
  answer = { results: [{ index: 2, relevance_score: 3 }, { index: 1, relevance_score: 2 }, { index: 0, relevance_score: 1 }] };
  try {
    const base = await recallFacts(query, text, 0.6, 3);
    const hits = embedding.hits();
    assert.ok(hits > 0);
    const ranked = await recallFacts(query, text, 0.6, 3, [], true);
    assert.deepEqual(ranked, [...base].reverse());
    assert.equal(embedding.hits(), hits);
    const [receipt] = await sql`SELECT status FROM receipts WHERE purpose='rerank' AND subject=${`article:${query}`}`;
    assert.equal(receipt!.status, 'completed');
  } finally { await embedding.close(); delete process.env.DASHSCOPE_API_KEY; delete process.env.DASHSCOPE_BASE_URL; }
});

test('recall failure keeps cheap order and an unknown outcome cannot create a new paid retry', async () => {
  const { recallFacts } = await import('@aihot/backend/events/recall');
  const query = `unknown-${tag()}`;
  const text = '星系研究发现新恒星';
  const base = await recallFacts(query, text, 0.6, 3);
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(provider.url)) { attempts++; throw new DOMException('fixture timeout after sending', 'TimeoutError'); }
    return original(input, init);
  };
  try {
    assert.deepEqual(await recallFacts(query, text, 0.6, 3, [], true), base);
    assert.deepEqual(await recallFacts(query, text, 0.6, 3, [], true), base);
  } finally { globalThis.fetch = original; }
  assert.equal(attempts, 1);
  const [receipt] = await sql`SELECT id,status,attempts FROM receipts WHERE subject=${`article:${query}`} AND purpose='rerank'`;
  assert.equal(receipt!.status, 'unknown');
  assert.equal(receipt!.attempts, 1);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=${receipt!.id}`).length, 1);
  answer = new Reply(503, { error: 'fixture failure' });
  assert.deepEqual(await recallFacts(`http-${tag()}`, text, 0.6, 3, [], true), base);
  answer = { results: [] };
  assert.deepEqual(await recallFacts(`invalid-${tag()}`, text, 0.6, 3, [], true), base);
});

test('missing configuration or disabled model valve bypasses optional ordering', async () => {
  const { rerankerAvailable } = await import('@aihot/backend/providers/reranker');
  const { config } = await import('@aihot/backend/config');
  const { recallFacts } = await import('@aihot/backend/events/recall');
  const key = process.env.RERANKER_API_KEY;
  const before = provider.hits();
  delete process.env.RERANKER_API_KEY;
  try {
    assert.equal(rerankerAvailable(), false);
    const base = await recallFacts('disabled-query', '星系研究发现新恒星', 0.6, 3);
    assert.deepEqual(await recallFacts('disabled-query', '星系研究发现新恒星', 0.6, 3, [], true), base);
  } finally { process.env.RERANKER_API_KEY = key; }
  config.modelCallsEnabled = false;
  try { assert.equal(rerankerAvailable(), false); } finally { config.modelCallsEnabled = true; }
  assert.equal(provider.hits(), before);
});
