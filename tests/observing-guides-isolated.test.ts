import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { loadObservingGuides, autoGuidesStart } from '../packages/backend/src/publication/observing-guides.ts';
import Fastify from 'fastify';
import { registerSite } from '../apps/api/src/routes/site.ts';

// Use the runner's migrated per-file database, guarded as throwaway by setup.ts.
// Synthetic fixture data only; no fixed local port or credentials.
import './setup.ts';
globalThis.fetch = async () => { throw new Error('network/source/model access forbidden'); };
const start = '2026-10-16T08:00:00Z';
process.env.OBSERVING_GUIDES_AUTO_START_AT = start;
after(async () => { await closeDb(); });
let ready: Promise<void>;
async function setup() {
  ready ??= (async () => {
    await sql`INSERT INTO sources (id, name, kind, participation_mode) VALUES ('astro','Astronomy Magazine · News','rss','editorial'),('sky','Sky & Telescope · 天文新闻','rss','editorial'),('other','Unapproved source','rss','editorial'),('signal','Astronomy Magazine · News','rss','hot_signal')`;
  })();
  await ready;
  await sql`DELETE FROM publications`;
  await sql`DELETE FROM articles`;
}
async function add(id: string, opts: Record<string, any> = {}) {
  const sky = opts.sky === true;
  const article = {
    id, source_id: sky ? 'sky' : 'astro', identity_key: id, timeline_at: new Date('2026-10-23T05:00:00Z'),
    url: sky ? 'https://skyandtelescope.org/astronomy-news/future-weekly-permalink/' : 'https://www.astronomy.com/the-sky-this-week/synthetic-next-week/',
    title: sky ? "This Week's Sky at a Glance, October 23 – 30" : 'The Sky This Week from October 23 to 30: Mars',
    raw: sky ? { categories: ['Sky at a Glance'] } : {},
    discovered_at: new Date('2026-10-16T08:00:01Z'), backfill: false, ...opts.article,
  };
  await sql`INSERT INTO articles ${sql(article)}`;
  await sql`INSERT INTO publications ${sql({ article_id: id, channel: 'news', url: article.url, discovered_at: article.discovered_at, timeline_at: article.timeline_at, sort_at: article.timeline_at, source_id: sky ? 'sky' : 'astro', title: `具体中文篇名 ${id}：火星与星团`, summary: '现有公开摘要', published_at: new Date('2026-10-23T05:00:00Z'), visibility: 'public', selected: false, visible_after: null, ...opts.publication })}`;
}

test('merged manual/automatic set sorts by trusted publication time; dedup, ties, nulls and cursor pages', async () => {
  await setup();
  await add('manual-old', { article: { title: 'Other observing article' }, publication: { published_at: new Date('2026-10-01T00:00:00Z') } });
  await add('manual-middle', { article: { title: 'Other observing article' }, publication: { published_at: new Date('2026-10-20T00:00:00Z') } });
  await add('manual-new', { publication: { published_at: new Date('2026-10-24T00:00:00Z') } });
  await add('auto-b'); await add('auto-a', { sky: true });
  await add('undated', { publication: { published_at: null } });
  const manual = ['manual-old','manual-middle','manual-new','manual-new'];
  const result = await loadObservingGuides(manual);
  assert.deepEqual(result.guides.map(g => g.id), ['manual-new','auto-a','auto-b','manual-middle','manual-old','undated']);
  assert.equal(result.guides[0]!.title, '具体中文篇名 manual-new：火星与星团');
  assert.equal(result.guides.at(-1)!.publishedAt, null);
  assert.equal(result.guides[1]!.publishedAt, '2026-10-23T05:00:00.000Z');
  assert.equal(result.nextCursor, null);
  for(let i=0;i<65;i++) await add(`page-${String(i).padStart(3,'0')}`);
  const collected: string[] = []; let cursor: string | null = null;
  do { const page = await loadObservingGuides(manual,cursor); assert.ok(page.guides.length<=30); collected.push(...page.guides.map(g=>g.id)); cursor=page.nextCursor; } while(cursor);
  assert.equal(collected.length,71); assert.equal(new Set(collected).size,71);
  assert.equal(collected.at(-1),'undated');
  const first = await loadObservingGuides(manual);
  await assert.rejects(loadObservingGuides(['different-manual'],first.nextCursor), /invalid guides cursor/);
  await assert.rejects(loadObservingGuides(manual,'guides1.bad'), /malformed cursor/);
});

test('strict sources, domains, original series identity and persisted categories; no history/backfill/hidden leaks', async () => {
  await setup();
  await add('good-astro'); await add('good-sky', {sky:true});
  await add('wrong-domain', {article:{url:'https://astronomyXcom/the-sky-this-week/fake/'}});
  await add('evil-subdomain', {article:{url:'https://astronomy.com.evil.test/the-sky-this-week/fake/'}});
  await add('generic-observing', {sky:true,article:{title:'How to observe Mars'}});
  await add('sky-no-category', {sky:true,article:{raw:{categories:['Stargazing and Observing']}}});
  await add('wrong-source', {publication:{source_id:'other'}});
  await add('signal-source', {publication:{source_id:'signal'}});
  await add('hidden', {publication:{visibility:'withdrawn'}});
  await add('embargo', {publication:{selected:true,visible_after:new Date('2100-01-01')}});
  await add('old', {article:{discovered_at:new Date('2026-10-15')}});
  await add('backfill', {article:{backfill:true}});
  assert.deepEqual((await loadObservingGuides([])).guides.map(g=>g.id), ['good-astro','good-sky']);
  delete process.env.OBSERVING_GUIDES_AUTO_START_AT;
  assert.equal((await loadObservingGuides([])).guides.length,0);
  assert.equal((await loadObservingGuides(['old'])).guides[0]!.id,'old','old manual entries survive');
  process.env.OBSERVING_GUIDES_AUTO_START_AT=start;
  assert.throws(()=>autoGuidesStart('bad'), /invalid/);
  assert.equal(autoGuidesStart(start)!.toISOString(),'2026-10-16T08:00:00.000Z');
});

test('pagination preserves database timestamp precision and continues across null-date pages', async () => {
  await setup();
  for(let i=1;i<=35;i++) {
    const id=`micro-${String(i).padStart(3,'0')}`;
    await add(id);
    // An explicit text cast avoids postgres.js coercing the fixture to millisecond JS Dates.
    await sql`UPDATE publications SET published_at=${`2026-10-23T05:00:00.${String(i).padStart(6,'0')}Z`}::text::timestamptz WHERE article_id=${id}`;
  }
  for(let i=1;i<=35;i++) await add(`null-${String(i).padStart(3,'0')}`, {publication:{published_at:null}});
  let cursor: string | null=null; const ids: string[]=[];
  do { const page=await loadObservingGuides([],cursor); ids.push(...page.guides.map(g=>g.id));cursor=page.nextCursor; } while(cursor);
  assert.equal(ids.length,70); assert.equal(new Set(ids).size,70);
  assert.equal(ids[0],'micro-035');assert.equal(ids.at(-1),'null-035');
});

test('stored RSS source notes and case-varying S&T column categories match without widening source identity', async () => {
  await setup();
  await sql`UPDATE sources SET name='Astronomy Magazine · News（RSS · 科学刊物，含观测指南）' WHERE id='astro'`;
  await sql`UPDATE sources SET name='Sky & Telescope · 天文新闻（RSS · 科学刊物，含观测指南）' WHERE id='sky'`;
  try {
    await add('stored-astro');
    await add('stored-sky', {sky:true, article:{
      url:'https://skyandtelescope.org/astronomy-news/observing-news/this-weeks-sky-at-a-glance-october-9-18/',
      title:"This Week's Sky at a Glance, October 9 – 18",
      raw:{categories:['Astronomy & Observing News','Celestial News & Events','Observing',"This Week's Sky At a Glance","This week's sky at a glance"]},
    }});
    await add('sky-case', {sky:true,article:{raw:{categories:["THIS WEEK'S SKY AT A GLANCE"]}}});
    await add('sky-generic', {sky:true,article:{raw:{categories:['Observing']}}});
    await add('sky-wrong-type', {sky:true,article:{raw:{categories:{"Sky at a Glance":true}}}});
    await add('sky-missing', {sky:true,article:{raw:{}}});
    await sql`UPDATE sources SET name='Sky & Telescope · 天文新闻 Extra（RSS）' WHERE id='other'`;
    await add('wrong-source-note', {sky:true,publication:{source_id:'other'}});
    assert.deepEqual((await loadObservingGuides([])).guides.map(g=>g.id), ['sky-case','stored-astro','stored-sky']);
    assert.equal((await loadObservingGuides([])).guides.find(g=>g.id==='stored-astro')!.sourceName,'Astronomy Magazine · News');
  } finally {
    await sql`UPDATE sources SET name='Astronomy Magazine · News' WHERE id='astro'`;
    await sql`UPDATE sources SET name='Sky & Telescope · 天文新闻' WHERE id='sky'`;
  }
});

test('real site API handler returns bounded DTO, ETag and invalid-cursor 400 without body redistribution', async () => {
  await setup(); await add('public-sky', { sky: true });
  const app=Fastify(); registerSite(app);
  try {
    const r=await app.inject({method:'GET',url:'/api/site/observing-guides'});
    assert.equal(r.statusCode,200);
    const body=r.json(); assert.equal(body.guides[0].id,'public-sky');
    assert.deepEqual(Object.keys(body.guides[0]).sort(),['id','publishedAt','sourceName','summary','title']);
    assert.ok(r.headers.etag); assert.match(String(r.headers['cache-control']),/max-age=60/);
    assert.equal((await app.inject({method:'GET',url:'/api/site/observing-guides?cursor=broken'})).statusCode,400);
    assert.equal((await app.inject({method:'GET',url:'/api/site/observing-guides?ids=bad%3Fid'})).statusCode,400);
  } finally { await app.close(); }
});
