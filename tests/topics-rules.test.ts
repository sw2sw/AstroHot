// Milestone failures to guard before implementing the new deterministic rules:
// - a useful tutorial, opinion or trend list is presented as a historical milestone;
// - a stronger later report moves an event's date, or an explicit occurrence loses to collection time;
// - cached titles survive a score/tag/subject correction, while the selected list should stay readable.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage } from "@aihot/backend/publication/topics";
import { overrideFields } from "@aihot/backend/admin/content";

const T = tag();
const SOURCE = `test-topic-rules-${T}`;
const now = new Date();
const at = new Date(now.getTime() - 6 * 3600_000);
let serial = 0;
let cached: string;
let cachedFact: number;
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,owner_entity_id,next_fetch_at)
    VALUES (${SOURCE},'Official','rss','T1','editorial','eso','2100-01-01')`;
  cachedFact = await fact(null, "eso");
  cached = await report({ company: "eso", title: "ESO 新的天体成果", factId: cachedFact, score: 90 });
  await loadTopicPage("eso", 1); // Warm once; all corrections below happen before expiry.
});
after(async () => { await stopBoss(); await closeDb(); });

async function fact(storyId: number | null, subject: string, occurred: Date | null = null, action = "发布"): Promise<number> {
  const [f] = await sql<{id: number}[]>`INSERT INTO facts (public_id,story_id,title,subject,action,object,occurred_at)
    VALUES (${`f-${randomUUID()}`},${storyId},'天体发现',${subject},${action},'测试天体',${occurred}) RETURNING id`;
  return f!.id;
}
async function story() {
  const id = randomUUID();
  const [s] = await sql<{id: number}[]>`INSERT INTO stories (public_id,title,first_report_at,latest_at) VALUES (${id},'新天体',${at},${at}) RETURNING id`;
  return { id: s!.id, publicId: id };
}
async function report(o: {company?: string; title: string; category?: string; tags?: string[]; score?: number; factId?: number; published?: Date; timeline?: Date}) {
  const published = o.published ?? at;
  const timeline = o.timeline ?? published;
  const {articleId} = await upsertMaterial({sourceId: SOURCE,url:`https://example.com/topic-rules-${T}-${++serial}`,title:o.title,
    publishedAt:published,bodyText:'Supported report',bodyHtml:'<p>Supported report</p>',bodyStatus:'ok',via:'fetch'});
  await sql`UPDATE articles SET discovered_at=${timeline},timeline_at=${timeline},grouped_at=now() WHERE id=${articleId}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,subjects,tags)
    VALUES (${articleId},1,'rule','pass',${o.category ?? 'galaxies-cosmology'},${o.title},'新的消息',${o.score ?? 90},true,
    ${o.company ? [o.company] : []},${o.tags ?? ['天体发现']})`;
  if (o.factId) await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${o.factId},${articleId},'report')`;
  await publishArticle(articleId,{releasedAt:new Date(timeline.getTime()+60000)});
  return articleId;
}
const page = async (slug: string) => {const p=await loadTopicPage(slug,1,new Date()); assert.ok(p); return p;};

test("astronomy directions keep selected explanatory reading without manufacturing milestones or SEO highlights", async () => {
  for (const [slug, direction] of [['exoplanets','系外行星'],['black-holes','黑洞'],['cosmology','宇宙学']]) {
    const id=await report({title:`${direction} 基础概念解读`,category:'galaxies-cosmology',tags:['科普',direction!],score:99});
    const p=await page(slug!);
    assert.deepEqual(p.chronicle,[],slug);
    assert.deepEqual(p.highlights,[],`${slug}: search snippets use the same milestone rules`);
    assert.ok(p.items.some(r=>r.id===id));
  }
});

// A release can include a migration guide or benchmark result; those suffixes do not change its main action.
test("launches keep their milestones when the headline also mentions supporting guides or benchmarks", async () => {
  const launch = await report({company:'esa',title:'ESA 发布 系外行星A，附观测方法与迁移指南',score:87});
  const model = await report({company:'noirlab',title:'NOIRLab 发现系外行星B，观测参数精度登顶',score:79});
  const product = await report({company:'noirlab',title:'NOIRLab 公开巡天目录（附视频教程）',category:'observatories-data',tags:['数据发布'],score:76});
  const tutorial = await report({company:'esa',title:'ESA 观测使用指南：如何处理数据',category:'planets-solar-system',tags:['科普'],score:99});
  const view = await fact(null,'esa',null,'opinion');
  const opinion = await report({company:'esa',title:'ESA 研究员谈未来观测',factId:view,category:'planets-solar-system',tags:['科研成果'],score:99});
  const esa=await page('esa');
  assert.deepEqual(esa.milestones.map(m=>m.href),[`/items/${launch}`]);
  assert.ok(esa.items.some(r=>r.id===tutorial)&&esa.items.some(r=>r.id===opinion));
  const noirlab=await page('noirlab');
  assert.deepEqual(new Set(noirlab.milestones.map(m=>m.href)),new Set([model,product].map(id=>`/items/${id}`)));
});

test("event dates use an explicit occurrence, otherwise the earliest publication, and do not move with the stronger report", async () => {
  const month=beijingDate(now).slice(0,7);
  const boundary=new Date(`${month}-01T00:00:00+08:00`);
  const earlier=new Date(boundary.getTime()-40*86400000);
  const later=new Date(boundary.getTime()-2*86400000);
  const occurred=new Date(earlier.getTime()-86400000);
  for(const [company,useOccurrence,sameFact] of [['bao',true,false],['pmo',false,false],['shao',false,true]] as const) {
    const event=await story();
    const original=await fact(event.id,company,useOccurrence?occurred:null);
    const follow=sameFact ? original : await fact(event.id,company);
    const old=await report({company,title:`${company} 发现天体`,published:earlier,timeline:new Date(earlier.getTime()+3600000),factId:original,score:69});
    const stronger=await report({company,title:`${company} 新天体的正式公告`,published:later,factId:follow,score:95});
    const p=await page(company);
    const entries=p.milestones.filter(m=>m.href===`/story/${event.publicId}`);
    assert.equal(entries.length,1);
    assert.equal(entries[0]!.date,beijingDate(useOccurrence?occurred:earlier));
    assert.ok(p.items.some(r=>r.id===stronger));
    if (sameFact) assert.ok(!p.items.some(r=>r.id===old),'the old fact representative no longer holds a selected seat');
    else assert.ok(p.items.some(r=>r.id===old));
  }
});

test("cached milestone eligibility follows current score, launch tag and fact subject corrections", async () => {
  assert.ok((await loadTopicPage('eso',1))?.milestones.length);
  await sql`UPDATE analyses SET score=1 WHERE article_id=${cached}`;
  await publishArticle(cached,{releasedAt:at});
  assert.deepEqual((await loadTopicPage('eso',1))?.milestones,[],'score changes apply without waiting for cached counts');
  await sql`UPDATE analyses SET score=90 WHERE article_id=${cached}`;
  await overrideFields(cached,{fields:{tags:['科研成果','entity:eso']},version:0,reason:'实际是研究解读'},'topic-rules');
  assert.deepEqual((await loadTopicPage('eso',1))?.milestones,[],'the current launch tag is checked');
  await overrideFields(cached,{fields:{tags:['天体发现','entity:eso']},version:1,reason:'恢复已核实发布'},'topic-rules');
  await sql`UPDATE facts SET subject='ESA' WHERE id=${cachedFact}`;
  assert.deepEqual((await loadTopicPage('eso',1))?.milestones,[],'a known different action subject cannot remain a ESO milestone');
  assert.ok((await loadTopicPage('eso',1))?.items.some(r=>r.id===cached),'chronicle rules do not remove the selected report');
});
