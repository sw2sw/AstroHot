// Astronomy topic milestones: institution ownership, completed discoveries, data and mission news,
// first-clause event labels, deduplication, curated boundaries, direction filters and monthly limits.
// Pure selection tests replay the astronomy industry rules without database or model calls.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTopic, TOPICS } from "@aihot/backend/publication/topics";
import { selectTopicChronicle, selectTopicHighlights, type ChronicleReport } from "@aihot/backend/publication/topic-chronicle";

const NOW = new Date("2026-09-30T20:00:00+08:00");
const window = { now: NOW };
const ALL = TOPICS.map((t) => t.slug);
const topic = (slug: string) => {
  const t = findTopic(slug);
  assert.ok(t, slug);
  return t;
};

let n = 0;
/** A selected report, on 10 September unless `day` says otherwise. */
function report(title: string, o: Partial<ChronicleReport> & { day?: number } = {}): ChronicleReport {
  n += 1;
  const at = new Date(`2026-09-${String(o.day ?? 10).padStart(2, "0")}T12:00:00+08:00`);
  return {
    id: `r${n}`, title, originalTitle: null, category: "galaxies-cosmology", tags: ["天体发现"], score: 85, topicSlugs: ALL,
    timelineAt: at, publishedAt: at, factPublishedAt: null, firstParty: false, owner: null, factId: null, factSubject: null,
    factAction: null, factOccurredAt: null, storyPublicId: null, sourceCount: 1, scope: "single", ...o,
  };
}
const product = (title: string, o: Partial<ChronicleReport> & { day?: number } = {}) => report(title, { category: "observatories-data", tags: ["数据发布"], ...o });
const news = (title: string, o: Partial<ChronicleReport> & { day?: number } = {}) => report(title, { category: "solar-space-weather", tags: ["任务进展"], ...o });
const events = (slug: string, reports: ChronicleReport[]) => selectTopicChronicle(topic(slug), reports, window).flatMap((m) => m.events);
const titles = (slug: string, reports: ChronicleReport[]) => events(slug, reports).map((e) => e.title);

test("an institution month keeps two discoveries, two data releases, one mission by score", () => {
  const reports = [
    report("ESO 发现遥远星系", { score: 90, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }),
    report("ESO 确认星系团", { score: 85, day: 20, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }),
    report("ESO 发现暗弱星系", { score: 80, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }),
    product("ESO 发布巡天目录", { score: 85, tags: ["数据发布", "entity:eso"] }),
    product("ESO 公开光谱数据", { score: 80, day: 18, tags: ["数据发布", "entity:eso"] }),
    product("ESO 发布测光数据", { score: 76, tags: ["数据发布", "entity:eso"] }),
    news("ESO 宣布观测任务完成", { score: 98, day: 25, tags: ["任务进展", "entity:eso"] }),
    news("ESO 公布太阳监测任务进展", { score: 97, tags: ["任务进展", "entity:eso"] }),
  ];
  const picked = events("eso", reports);
  const of = (kind: string) => picked.filter((e) => e.kind === kind).map((e) => e.title).sort();
  assert.deepEqual(of("discovery"), ["ESO 发现遥远星系", "ESO 确认星系团"].sort());
  assert.deepEqual(of("data"), ["ESO 发布巡天目录", "ESO 公开光谱数据"].sort());
  assert.deepEqual(of("mission"), ["ESO 宣布观测任务完成"]);
  assert.equal(picked.length, 5);
  assert.deepEqual(picked.map((e) => e.at), [...picked].sort((a, b) => b.at.localeCompare(a.at)).map((e) => e.at), "newest first within the month");
});

test("what is not a completed discovery stays out, however high its score", () => {
  const out = [
    "ESO 即将发现系外行星", "ESO 将于下周确认系外行星", "ESO 计划确认系外行星",
    "传闻 ESO 有望发现系外行星", "ESO 科普讲座：发现系外行星的方法",
    "ESO announces the discovery of a distant exoplanet today",
  ];
  const reports = out.map((title, i) => report(title, { score: 99, day: 1 + i, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }));
  reports.push(report("ESO 发现系外行星并确认遥远星系：本周成果汇总", { score: 99, day: 20, scope: "composite", factSubject: "ESO", tags: ["天体发现", "entity:eso"] }));
  assert.deepEqual(titles("eso", reports), []);
  assert.deepEqual(titles("research-results", reports), [], "nor on the research-results timeline");
  const discovery = report("ESO 发现系外行星，计划后续观测", { score: 99, day: 25, factSubject: "ESO", tags: ["天体发现", "entity:eso"] });
  assert.deepEqual(titles("eso", [...reports, discovery]), [discovery.title], "a completed discovery may include a follow-up plan");
  assert.deepEqual(titles("research-results", [...reports, discovery]), [discovery.title]);
});

test("an institution's discovery published on another institution's platform stays its own", () => {
  const release = report("ESO 发现系外行星，成果由 ESA 平台发布", { factSubject: "ESO", tags: ["天体发现", "entity:esa"], owner: "esa" });
  assert.deepEqual(titles("esa", [release]), []);
  assert.deepEqual(titles("eso", [release]), [release.title]);
  assert.deepEqual(titles("research-results", [release]), [release.title]);
});

test("an institution's discovery names the institution first, or the institution is the fact's subject", () => {
  const discovery = report("ESO 发现系外行星，ESA 将参与后续观测");
  assert.deepEqual(titles("eso", [discovery]), [discovery.title]);
  assert.deepEqual(titles("esa", [discovery]), [], "ESA is only named after ESO");
  const community = report("业余天文团队发现系外行星", { owner: "esa", tags: ["天体发现", "entity:esa"] });
  assert.deepEqual(titles("esa", [community]), [], "announced on its platform, not its discovery");
  const joint = report("ESO 与 ESA 联合发现系外行星", { factSubject: "ESO、ESA" });
  assert.deepEqual(titles("eso", [joint]), [joint.title]);
  assert.deepEqual(titles("esa", [joint]), [joint.title], "both subjects");
});

test("institution mission news is its own: its subject, or the only institution it is about", () => {
  const probe = news("ESA 公布任务进展，ESO 将参与后续观测", { score: 90, factSubject: "ESA", tags: ["任务进展", "entity:eso"] });
  const report2 = news("观测任务进展报告涉及 ESO 与 ESA", { score: 90, tags: ["任务进展", "entity:eso", "entity:esa"] });
  const joint = news("ESO 与 ESA 宣布联合观测任务完成", { score: 90, factSubject: "ESO、ESA", tags: ["任务进展", "entity:eso", "entity:esa"] });
  assert.deepEqual(titles("eso", [probe, report2]), [], "a mention cannot override a known external subject");
  assert.deepEqual(titles("esa", [probe]), [probe.title]);
  assert.deepEqual(titles("esa", [report2]), [], "multiple institution tags are ambiguous");
  const unknown = news("外部团队公布 ESO 观测任务进展", { factSubject: "外部团队", tags: ["任务进展", "entity:eso"] });
  assert.deepEqual(titles("eso", [unknown]), [unknown.title], "an unknown subject retains the single institution tag fallback");
  assert.deepEqual(titles("esa", [joint]), [joint.title]);
  assert.deepEqual(titles("eso", [joint]), [joint.title], "both known subjects");
  assert.deepEqual(events("eso", [joint]).map((e) => e.kind), ["mission"]);
});

test("one discovery's reports within a week are one milestone: the earliest date, the strongest Chinese headline", () => {
  const reports = [
    report("ESO发现系外行星A，初步结果", { day: 11, score: 77, sourceCount: 3, factSubject: "ESO", storyPublicId: "s-1" }),
    report("ESO发现系外行星A，确认参数", { day: 12, score: 90, factId: 1, factSubject: "ESO", storyPublicId: "s-1" }),
    report("ESO discovers Planet-A", { day: 13, score: 99, factId: 2, factSubject: "ESO", originalTitle: "ESO discovers Planet-A", storyPublicId: "s-1" }),
    report("ESO发现系外行星A，后续观测", { day: 14, score: 80, factSubject: "ESO", storyPublicId: "s-1" }),
  ];
  const picked = events("eso", reports);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.title, "ESO发现系外行星A，确认参数", "a Chinese headline before a higher score");
  assert.equal(picked[0]!.at.slice(0, 10), "2026-09-11");
  assert.equal(picked[0]!.kind, "discovery");
});

test("curated months cannot suppress an event's automatic milestone after the curated boundary", () => {
  const august = new Date("2026-08-20T12:00:00+08:00");
  const older = report("ESO发现系外行星A，初步结果", { factSubject: "ESO", storyPublicId: "s-curated", score: 95, timelineAt: august, publishedAt: august });
  const newer = report("ESO发现系外行星A，确认参数", { factSubject: "ESO", storyPublicId: "s-curated", score: 80 });
  const picked = selectTopicChronicle(topic("eso"), [older, newer], { now: NOW, through: "2026-08" }).flatMap((m) => m.events);
  assert.deepEqual(picked.map((e) => [e.title, e.at.slice(0, 10)]), [[newer.title, "2026-09-10"]], "automatic selection starts after the curated month, before event deduplication");
});

test("discovery reports with the same event label merge within a week, but different catalogs stay apart", () => {
  const discovery = report("ESO 发现系外行星A，测得轨道参数", { id: "dedup-discovery-1", day: 3, score: 88, factSubject: "ESO", tags: ["天体发现", "entity:eso"] });
  const followUp = report("ESO 发现系外行星A，后续观测确认质量", { id: "dedup-discovery-2", day: 4, score: 81, factSubject: "ESO", tags: ["天体发现", "entity:eso"] });
  assert.notEqual(discovery.id, followUp.id);
  for (const r of [discovery, followUp]) {
    assert.equal(r.factId, null);
    assert.equal(r.storyPublicId, null);
  }
  for (const reports of [[discovery, followUp], [followUp, discovery]]) {
    const picked = events("research-results", reports);
    assert.equal(picked.length, 1, "either input order merges identical first-clause labels without shared fact or story");
    assert.equal(picked[0]!.title, discovery.title, "the strongest headline is kept");
    assert.equal(picked[0]!.label, "ESO 发现系外行星A");
    assert.equal(picked[0]!.at.slice(0, 10), "2026-09-03", "the earliest report dates the event");
    assert.equal(picked[0]!.kind, "discovery");
  }
  const catalogs = [
    product("ESO 发布南天巡天目录，覆盖百万天体", { day: 3, tags: ["数据发布", "entity:eso"] }),
    product("ESO 发布银河光谱目录，新增高分辨率光谱", { day: 4, tags: ["数据发布", "entity:eso"] }),
  ];
  assert.equal(events("data-releases", catalogs).length, 2, "different catalog names are not the same event");
});

test("distinct discoveries and data releases stay apart: targets, versions, comparisons, weeks apart", () => {
  const pairs: Array<[string, string, ChronicleReport[]]> = [
    ["research-results", "different discovery targets", [report("ESO 发现系外行星A", { day: 3, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }), report("ESO 发现系外行星B", { day: 4, factSubject: "ESO", tags: ["天体发现", "entity:eso"] })]],
    ["data-releases", "different dataset releases", [product("ESO 发布南天巡天目录", { day: 3, tags: ["数据发布", "entity:eso"] }), product("ESO 发布银河光谱目录", { day: 4, tags: ["数据发布", "entity:eso"] })]],
    ["data-releases", "different dataset versions", [product("ESO 发布南天巡天目录 DR1", { day: 3, tags: ["数据发布", "entity:eso"] }), product("ESO 发布南天巡天目录 DR2", { day: 4, tags: ["数据发布", "entity:eso"] })]],
    ["research-results", "a discovery compared with another event", [report("ESO 发现系外行星A", { day: 5, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }), report("ESO 发现系外行星B，与系外行星A相比轨道更短", { day: 6, factSubject: "ESO", tags: ["天体发现", "entity:eso"] })]],
    ["data-releases", "a dataset compared with another release", [product("ESO 发布南天巡天目录 DR1", { day: 5, tags: ["数据发布", "entity:eso"] }), product("ESO 发布南天巡天目录 DR2，相比 DR1 增加百万天体", { day: 6, tags: ["数据发布", "entity:eso"] })]],
    ["research-results", "identical discovery labels more than a week apart", [report("ESO 发现系外行星A，初步结果", { day: 2, factSubject: "ESO", tags: ["天体发现", "entity:eso"] }), report("ESO 发现系外行星A，后续结果", { day: 20, factSubject: "ESO", tags: ["天体发现", "entity:eso"] })]],
  ];
  for (const [slug, why, reports] of pairs) assert.equal(events(slug, reports).length, 2, why);
});

test("a direction's chronicle takes what names the direction, not everything carrying its tag", () => {
  const general = report("ESO公布观测结果", { tags: ["发现", "系外行星"] });
  const discovery = report("ESO发现系外行星A", { tags: ["发现", "系外行星"] });
  const research = report("系外行星大气测量揭示分子成分", { category: "planets-solar-system", tags: ["研究", "系外行星"] });
  const probe = news("探测器公布太阳监测任务进展", { score: 90, tags: ["任务进展", "系外行星"] });
  assert.deepEqual(new Set(titles("exoplanets", [general, discovery, research, probe])), new Set([discovery.title, research.title]));
  assert.deepEqual(events("exoplanets", [research]).map((e) => e.kind), ["research"]);
});

test("the data-release timeline and a direction each keep five releases of a busy month", () => {
  const releases = Array.from({ length: 9 }, (_, i) => product(`ESO 发布系外行星观测目录 DR${i + 1}`, { day: 1 + i * 3, score: 90 - i, tags: ["数据发布", "系外行星"] }));
  for (const slug of ["data-releases", "exoplanets"]) {
    const picked = events(slug, releases);
    assert.equal(picked.length, 5);
    assert.equal(new Set(picked.map((e) => e.label)).size, 5, "distinct release labels do not merge");
    assert.deepEqual(new Set(picked.map((e) => e.title)), new Set(releases.slice(0, 5).map((r) => r.title)), "the five highest scores stay");
    assert.ok(!picked.some((e) => e.title === releases[8]!.title), "the least important one drops out");
  }
});

test("an institution's highlights lead with its discoveries, then its data and missions", () => {
  const reports = [
    news("ESO 宣布观测任务完成", { score: 99, tags: ["任务进展", "entity:eso"], day: 25, firstParty: true, owner: "eso", factSubject: "ESO" }),
    product("ESO 发布南天巡天目录", { score: 90, tags: ["数据发布", "entity:eso"], day: 26, firstParty: true, owner: "eso", factSubject: "ESO" }),
    report("ESO发现系外行星A", { score: 80, tags: ["发现", "entity:eso"], day: 27, firstParty: true, owner: "eso", factSubject: "ESO" }),
  ];
  assert.deepEqual(selectTopicHighlights(topic("eso"), reports, window).map((e) => e.kind), ["discovery", "data", "mission"]);
});

test("astronomy milestone labels keep the first clause and strip only applicable institution prefixes", () => {
  const cases: Array<[string, string, string, string, Partial<ChronicleReport>?]> = [
    ["eso", "ESO发现系外行星A，公布观测参数", "发现系外行星A", "discovery", { factSubject: "ESO" }],
    ["eso", "ESO发现1,000颗系外行星，公布统计结果", "发现1,000颗系外行星", "discovery", { factSubject: "ESO" }],
    ["eso", "ESO确认系外行星A；公布轨道参数", "确认系外行星A", "discovery", { factSubject: "ESO" }],
    ["eso", "ESO发现系外行星A。后续观测完成", "发现系外行星A", "discovery", { factSubject: "ESO" }],
    ["eso", "ESO发现系外行星A,公布观测参数", "发现系外行星A", "discovery", { factSubject: "ESO" }],
    ["esa", "欧空局：确认系外行星B，公布观测参数", "确认系外行星B", "discovery", { factSubject: "ESA" }],
    ["bao", "中国科学院国家天文台发现系外行星C，公布观测参数", "发现系外行星C", "discovery", { factSubject: "国家天文台" }],
    ["exoplanets", "ESO发现系外行星A，公布观测参数", "ESO发现系外行星A", "discovery"],
    ["research-results", "ESO发现系外行星A，公布观测参数", "ESO发现系外行星A", "discovery"],
    ["eso", "ESO发布南天巡天目录，覆盖百万天体", "ESO发布南天巡天目录", "data", { category: "observatories-data", tags: ["数据发布", "entity:eso"] }],
    ["data-releases", "ESO发布南天巡天目录：百万天体测光数据，开放下载", "ESO发布南天巡天目录：百万天体测光数据", "data", { category: "observatories-data", tags: ["数据发布"] }],
    ["eso", "ESO：公开南天巡天目录，开放下载", "公开南天巡天目录", "data", { category: "observatories-data", tags: ["数据发布"], factSubject: "ESO" }],
    ["esa", "ESA公布太阳探测任务进展：完成近距离观测，公开图像", "公布太阳探测任务进展：完成近距离观测", "mission", { category: "solar-space-weather", tags: ["任务进展", "entity:esa"] }],
    ["bao", "国家天文台公布观测任务进展，公开观测日志", "公布观测任务进展", "mission", { category: "solar-space-weather", tags: ["任务进展"], factSubject: "国家天文台" }],
    ["exoplanets", "系外行星大气：光谱测量揭示分子成分，公布研究结果", "系外行星大气：光谱测量揭示分子成分", "research", { category: "planets-solar-system", tags: ["研究", "系外行星"] }],
    ["research-results", "系外行星大气：光谱测量揭示分子成分；公布研究结果", "系外行星大气：光谱测量揭示分子成分", "research", { category: "planets-solar-system", tags: ["研究"] }],
  ];
  for (const [slug, title, expected, kind, o] of cases) {
    const picked = events(slug, [report(title, o)]);
    assert.equal(picked.length, 1, `${slug}: ${title}`);
    assert.equal(picked[0]!.label, expected, `${slug}: ${title}`);
    assert.equal(picked[0]!.kind, kind, `${slug}: ${title}`);
    assert.equal(picked[0]!.title, title, "the full headline is retained independently of its event label");
  }
});

test("versionless dataset reports merge by identical first-clause labels within a week, but distinct versions stay apart", () => {
  const first = product("ESO发布南天巡天目录，覆盖百万天体", { id: "versionless-catalog-1", day: 10, score: 80 });
  const followUp = product("ESO发布南天巡天目录，开放测光数据下载", { id: "versionless-catalog-2", day: 17, score: 90 });
  assert.notEqual(first.id, followUp.id);
  for (const r of [first, followUp]) {
    assert.equal(r.factId, null);
    assert.equal(r.storyPublicId, null);
  }
  for (const reports of [[first, followUp], [followUp, first]]) {
    const picked = events("data-releases", reports);
    assert.equal(picked.length, 1, "identical first clauses merge without a shared fact or story, in either input order");
    assert.equal(picked[0]!.label, "ESO发布南天巡天目录");
    assert.equal(picked[0]!.title, followUp.title, "the strongest headline is retained");
    assert.equal(picked[0]!.at.slice(0, 10), "2026-09-10", "the earliest report dates the merged event");
    assert.equal(picked[0]!.kind, "data");
  }
  const versions = [
    product("ESO发布南天巡天目录 DR1，开放下载", { day: 10 }),
    product("ESO发布南天巡天目录 DR2，新增百万天体", { day: 11 }),
  ];
  const distinct = events("data-releases", versions);
  assert.equal(distinct.length, 2, "different dataset versions remain distinct releases");
  assert.deepEqual(distinct.map((e) => e.label).sort(), ["ESO发布南天巡天目录 DR1", "ESO发布南天巡天目录 DR2"]);
  assert.deepEqual(distinct.map((e) => e.kind), ["data", "data"]);
});
