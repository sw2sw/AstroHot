// Topic pages: which articles a topic takes, its chronicle and counts.
// Written before the code, from the ways it can go wrong:
// - a company topic takes an article about another company that only mentions it (several subjects,
//   its name nowhere in the title), or drops one about it whose title names it in English, in another
//   case, next to Chinese text, or only by a product (it is the article's only subject);
// - a Latin name matches inside another word ("Metadata" is not Meta); a headline naming a company
//   that is not a subject of the article gets in;
// - a technical-direction topic stops taking its tags;
// - the chronicle keeps a month's latest events instead of its most important ones, lists one event
//   twice across months, files 00:30 Beijing time on the 1st under the previous month, links an event
//   with a public story page to the article, or counts a withdrawn report's source;
// - a company's chronicle (its milestones) shows a tutorial, somebody else's commentary or another
//   organisation's research (even from an official source), drops the company's model/product launches,
//   or keeps more than three models, two products and one piece of its own news a month;
// - withdrawn or not yet released articles appear in a list, a count or the chronicle;
// - an article or story page names a topic its reports do not belong to;
// - a topic without content has no page, or an unknown slug or a page past the end has one.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage, listTopicSummaries, topicsOfStory } from "@aihot/backend/publication/topics";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-topics-official-${T}`;
const MEDIA = `test-topics-media-${T}`;
const OTHER = `test-topics-other-${T}`;
const ESA_BLOG = `test-topics-esa-blog-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${OTHER}, 'Other media', 'rss', 'T2', 'editorial', false, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, owner_entity_id, next_fetch_at) VALUES
    (${ESA_BLOG}, 'ESA blog', 'rss', 'T1', 'editorial', true, 'esa', '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
interface Report {
  source?: string;
  at: Date;
  title: string;
  originalTitle?: string;
  subjects?: string[];
  tags?: string[];
  score?: number;
  selected?: boolean;
  fact?: number;
  category?: string;
}

/** A published report; `fact` links it to a fact before publishing, as grouping would. */
async function report(r: Report): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: r.source ?? MEDIA, url: `https://example.com/topics-${T}-${n}`, title: r.originalTitle ?? r.title, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: r.at,
  });
  await sql`UPDATE articles SET discovered_at = ${r.at}, timeline_at = ${r.at}, grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', ${r.category ?? "stars-transients"}, ${r.title}, ${`摘要 ${n}`}, ${r.score ?? 80}, ${r.selected ?? true}, ${r.subjects ?? []}, ${[r.category === "observatories-data" ? "数据发布" : r.category === "outreach-images" ? "科普" : "科研成果", ...(r.tags ?? [])]})`;
  if (r.fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${r.fact}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(r.at.getTime() + 60_000) });
  return articleId;
}

async function story(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
  return { id: s!.id, publicId };
}

async function fact(storyId: number | null, title: string): Promise<number> {
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${randomUUID()}`}, ${storyId}, ${title}) RETURNING id`;
  return f!.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const page = async (slug: string, p = 1) => {
  const data = await loadTopicPage(slug, p, new Date());
  assert.ok(data, `${slug} page ${p}`);
  return data;
};
/** Every article of a topic, over all its pages. */
async function members(slug: string): Promise<string[]> {
  const first = await page(slug);
  const out = ids(first.items);
  for (let p = 2; p <= first.pageCount; p++) out.push(...ids((await page(slug, p)).items));
  return out;
}

test("a company topic takes the articles about it, not the ones that only mention it", async () => {
  const about = await report({ at: hoursAgo(30), title: `甚大望远镜取得新成果 ${T}`, subjects: ["eso"] });
  const product = await report({ at: hoursAgo(31), title: `ALMA 新观测成果 ${T}`, subjects: ["eso"] });
  const english = await report({ at: hoursAgo(32), title: `新观测成果发布 ${T}`, originalTitle: `ESO publishes new observations ${T}`, subjects: ["eso", "esa"] });
  const subpoena = await report({ at: hoursAgo(33), title: `ESA 公布探测器新结果 ${T}`, subjects: ["esa", "eso", "noirlab"] });
  const lowerCase = await report({ at: hoursAgo(34), title: `esa 公布新的任务结果 ${T}`, subjects: ["esa", "eso"] });
  const pact = await report({ at: hoursAgo(35), title: `多家研究机构签署合作协议 ${T}`, subjects: ["esa", "eso", "bao"] });
  const metadata = await report({ at: hoursAgo(36), title: `NOIRLaboratory 标准发布，ESA 参与 ${T}`, subjects: ["noirlab", "esa"] });
  const adjacent = await report({ at: hoursAgo(37), title: `发布NOIRLab的新成果 ${T}`, subjects: ["noirlab", "esa"] });
  const headline = await report({ at: hoursAgo(38), title: `ESO 被一篇盘点提到 ${T}`, subjects: ["bao"] });
  const agent = await report({ at: hoursAgo(39), title: `系外行星观测成果发布 ${T}`, tags: ["系外行星"] });

  const eso = await members("eso");
  for (const id of [about, product, english]) assert.ok(eso.includes(id), "about ESO");
  for (const id of [subpoena, lowerCase, pact, headline]) assert.ok(!eso.includes(id), "only mentions ESO");
  const esa = await members("esa");
  for (const id of [subpoena, lowerCase, metadata]) assert.ok(esa.includes(id), "about ESA");
  for (const id of [english, pact]) assert.ok(!esa.includes(id), "only mentions ESA");
  const noirlab = await members("noirlab");
  assert.ok(noirlab.includes(adjacent), "NOIRLab next to Chinese text");
  assert.ok(!noirlab.includes(metadata), "NOIRLaboratory is not NOIRLab");
  assert.ok((await members("exoplanets")).includes(agent), "a technical direction takes its tag");

  // The article page names the topics it belongs to.
  const topicsOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    return (JSON.parse(res.body) as { topics: Array<{ slug: string }> }).topics.map((t) => t.slug);
  };
  assert.deepEqual(await topicsOf(about), ["eso", "research-results"]);
  assert.deepEqual(await topicsOf(subpoena), ["esa", "research-results"]);
  assert.deepEqual(await topicsOf(pact), ["research-results"]);
  assert.deepEqual(await topicsOf(agent), ["exoplanets", "research-results"]);
});

test("the chronicle keeps each month's most important events, once each, in Beijing months", async () => {
  // The 1st of last month, 00:30 in Beijing (16:30 UTC the day before).
  const today = beijingDate(Date.now());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const firstOfLastMonth = new Date(`${lastMonth}-01T00:30:00+08:00`);
  const at = (minutes: number) => new Date(firstOfLastMonth.getTime() + minutes * 60_000);

  const launch = await story(`系外行星 V9 发布 ${T}`);
  const launchFact = await fact(launch.id, "公布 V9 观测成果");
  const official = await report({ source: OFFICIAL, at: at(0), title: `系外行星 V9 发布 ${T}`, tags: ["系外行星"], score: 95, fact: launchFact });
  await report({ source: OTHER, at: at(5), title: `媒体：系外行星 V9 上线 ${T}`, tags: ["系外行星"], score: 70, fact: launchFact });
  const gone = await report({ source: MEDIA, at: at(6), title: `撤回的报道：系外行星 V9 ${T}`, tags: ["系外行星"], score: 70, fact: launchFact });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${gone}`;
  // A second development of the same story the same month.
  const followFact = await fact(launch.id, "V9 后续观测");
  await report({ at: at(600), title: `系外行星 V9 后续观测成果公布 ${T}`, tags: ["系外行星"], score: 60, fact: followFact });
  const minor: string[] = [];
  // Five more eligible research results of lower importance; the
  // latest one is the least important.
  for (let i = 0; i < 5; i++) minor.push(await report({ at: at(1000 + i * 60), title: `系外行星小进展 ${i} ${T}`, tags: ["系外行星"], score: 85 - i, category: "planets-solar-system" }));

  const data = await page("exoplanets");
  const month = data.chronicle.find((c) => c.month === lastMonth);
  assert.ok(month, "the 1st at 00:30 Beijing time belongs to its own month");
  const listed = month.events.map((e) => e.id);
  assert.equal(month.events.length, 5, "five events a month");
  assert.equal(listed.filter((id) => id === official).length, 1, "the story once, by its most important report");
  assert.ok(!listed.includes(minor[4]!), "the least important event drops out, though it is the latest");
  const lead = month.events.find((e) => e.id === official)!;
  assert.equal(lead.href, `/story/${launch.publicId}`, "an event with a public story links to it");
  assert.ok(month.events.find((e) => e.id === minor[0])!.href.startsWith("/items/"), "an event without a story links to the article");
  assert.deepEqual(listed, [...month.events].sort((a, b) => b.at.localeCompare(a.at)).map((e) => e.id), "newest first within a month");
  assert.equal(month.events.find((e) => e.id === minor[0])?.kind, "research", "a direction keeps substantial research");
  assert.deepEqual(await topicsOfStory(launch.id), [{ slug: "exoplanets", name: "系外行星" }, { slug: "research-results", name: "科研成果" }], "the story page names the topic of its reports");
});

test("an institution's band keeps discoveries and data releases, not commentary or research", async () => {
  const today = beijingDate(Date.now());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const at = (day: number) => new Date(`${lastMonth}-${String(day).padStart(2, "0")}T12:00:00+08:00`);
  const esa = { subjects: ["esa"] };
  const discovery = await report({ ...esa, at: at(3), title: `ESA 发现新系外行星 ${T}`, category: "galaxies-cosmology", tags: ["天体发现"], score: 90 });
  const dataRelease = await report({ ...esa, at: at(5), title: `ESA 发布巡天目录 ${T}`, category: "observatories-data", score: 85 });
  const news = await report({ ...esa, at: at(7), title: `ESA 完成新办公楼建设 ${T}`, category: "galaxies-cosmology", score: 80 });
  const research = await report({ ...esa, source: ESA_BLOG, at: at(9), title: `ESA 发布自研行星观测方法论文 ${T}`, category: "planets-solar-system", score: 95 });
  const tutorial = await report({ ...esa, source: ESA_BLOG, at: at(11), title: `ESA 观测技巧指南 ${T}`, category: "galaxies-cosmology", score: 99 });
  const commentary = await report({ ...esa, at: at(13), title: `评论：ESA 的科学路线之争 ${T}`, category: "galaxies-cosmology", score: 98 });
  const othersResearch = await report({ ...esa, source: OFFICIAL, at: at(15), title: `另一家机构研究 ESA 观测数据的论文 ${T}`, category: "planets-solar-system", score: 97 });

  const data = await page("esa");
  assert.deepEqual(data.chronicle, [], "a company has its band instead of the monthly rail");
  const month = data.milestones.filter((ms) => ms.date.startsWith(lastMonth));
  const listed = month.map((ms) => ms.href);
  for (const id of [tutorial, commentary, othersResearch, research]) assert.ok(!listed.includes(`/items/${id}`), "no tutorials, nor others' commentary or research");
  assert.deepEqual([...listed].sort(), [discovery, dataRelease].map((id) => `/items/${id}`).sort(), "discoveries and data releases; ordinary institutional news does not fill an empty slot");
  assert.ok(!listed.includes(`/items/${news}`));
  assert.deepEqual(month.map((ms) => ms.kind), ["discovery", "data"], "oldest first, each with its kind");
  assert.deepEqual(month.map((ms) => ms.major), [false, false], "nothing picked up automatically is set in bold");
  assert.equal((await page("exoplanets")).milestones.length, 0, "a direction has its rail, not a band");
});

test("a cross-month event keeps its first date while all selected progress stays readable", async () => {
  const current = beijingDate(Date.now()).slice(0, 7);
  const after = new Date(new Date(`${current}-01T00:00:00+08:00`).getTime() - 3600_000);
  const representativeMonth = beijingDate(after).slice(0, 7);
  const before = new Date(new Date(`${representativeMonth}-01T00:00:00+08:00`).getTime() - 3600_000);
  const launch = await story(`ESO 数据发布 ${T}`);
  const originalFact = await fact(launch.id, "正式发布");
  const followFact = await fact(launch.id, "后续报道");
  const independent = await story(`ESO 独立进展 ${T}`);
  const independentFact = await fact(independent.id, "另一件事");
  const common = { subjects: ["eso"], category: "observatories-data", tags: ["数据发布"] };
  const earlier = await report({ ...common, at: before, title: `ESO 发布巡天目录 ${T}`, score: 80, fact: originalFact });
  const representative = await report({ ...common, at: after, title: `ESO 数据发布详细报道 ${T}`, score: 95, fact: followFact });
  const other = await report({ ...common, at: after, title: `ESO 另一项独立数据进展 ${T}`, score: 80, fact: independentFact });

  for (const slug of ["eso", "data-releases"]) {
    const data = await page(slug);
    const entries = data.topic.group === "company"
      ? data.milestones.map((m) => ({ href: m.href, title: m.headline, month: m.date.slice(0, 7) }))
      : data.chronicle.flatMap((m) => m.events.map((e) => ({ href: e.href, title: e.title, month: m.month })));
    const kept = entries.filter((e) => e.href === `/story/${launch.publicId}`);
    assert.deepEqual(kept, [{ href: `/story/${launch.publicId}`, title: `ESO 数据发布详细报道 ${T}`, month: beijingDate(before).slice(0, 7) }], `${slug}: one event, the earliest qualifying publication`);
    assert.ok(entries.some((e) => e.href === `/story/${independent.publicId}`), "a different event remains independent");
    const selected = await members(slug);
    for (const id of [earlier, representative, other]) assert.ok(selected.includes(id), "selected progress is not removed by chronicle deduplication");
  }
});

test("withdrawn articles stay out of lists, counts and the chronicle band", async () => {
  const kept = await report({ at: hoursAgo(5), title: `紫金山天文台 发现新系外行星 ${T}`, subjects: ["pmo"], category: "galaxies-cosmology", tags: ["天体发现"] });
  const withdrawn = await report({ at: hoursAgo(4), title: `紫金山天文台 发现的撤回消息 ${T}`, subjects: ["pmo"], category: "galaxies-cosmology", tags: ["天体发现"] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;

  const data = await page("pmo");
  assert.deepEqual(ids(data.items), [kept]);
  assert.equal(data.topic.total, 1);
  assert.deepEqual(data.milestones.map((m) => m.href), [`/items/${kept}`], "the chronicle band");
  const summary = (await listTopicSummaries()).topics.find((t) => t.slug === "pmo")!;
  assert.equal(summary.latest?.title, `紫金山天文台 发现新系外行星 ${T}`, "the index shows the newest public article");
});

test("every topic has a page; unknown topics and pages past the end have none", async () => {
  const empty = await page("shao");
  assert.equal(empty.topic.indexable, false, "a topic without content is not indexed");
  assert.deepEqual(empty.items, []);
  assert.equal(await loadTopicPage("not-a-topic", 1, new Date()), null);
  assert.equal(await loadTopicPage("shao", 2, new Date()), null);
  const index = await app.inject({ method: "GET", url: "/api/site/topics" });
  const body = JSON.parse(index.body) as { groups: Array<{ key: string }>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.groups.map((g) => g.key), ["company", "field", "genre"]);
  assert.equal(body.topics.length, 15);
});
