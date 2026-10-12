// 科学刊物的天文资讯：只有可靠公开摘要／片段时写「摘要导读」（journal-summary-intro）。
// 三个源（RDF、RSS 2.0，外加一个抓不动的源）走同一条通用通路，回答验收矩阵里的第一批条目：
//   A1 只有官方摘要 → 生成导读、把摘要输入记进判定、不声称已读全文；
//   A2 公开片段／订阅墙 → 片段或摘要导读＋实际访问提示，只读一次，不陷入抽取重试；
//   A3 只有标题 → 不写实质内容，也不假通过分析；
//   A4 真正公开全文 → 原有正文流程不退化，也不显示错误的收费提示；
//   A5 泛科学非天文 → 不进入天文动态（连材料都不落库）；
//   A6 新闻与论文摘要分型（contentKind，由 URL 与 feed 类别判定，不凭刊物声誉）；
//   A7 重复采集与重复处理 → 无重复文章、无重复模型请求；
//   A9 一源抓不动 → 其余源照常，失败源单独有界退避；
//   A10 日精度与历史条目 → 不编时刻、不冒充今天的新发现；
//   A11 普通摘要导读 → 进公共 pool、非精选、无推送；
//   A12 读者浏览详情 → 不再调用模型、不再抓原网站；
//   A14 没有全文／图片授权 → 不展示全文与图片；
//   A15 候选来源只进配置，一律不启用生产。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { accessFromPage, accessFromStatus, contentKindOf, datePrecisionOf, textRoleLabel } from "@aihot/backend/content/coverage";
import { ExtractTransientError, extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle, queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { loadPool } from "@aihot/backend/publication/pool";
import { readerNote } from "@aihot/backend/publication/rules";
import type { AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { renderContext } from "@aihot/backend/editorial/writing";
import { collectSource } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag();
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// ---------------------------------------------------------------- upstream: three journal feeds + their pages
type Page = { status: number; type?: string; body: string };
const pages = new Map<string, Page>();
const feeds = new Map<string, Page>();
const feedRequests: string[] = [];

const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  const page = feeds.get(path) ?? pages.get(path);
  if (feeds.has(path)) feedRequests.push(path);
  const send = page ?? { status: 404, body: "<html><body>not found</body></html>" };
  res.writeHead(send.status, { "content-type": send.type ?? "text/html" });
  res.end(send.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

const articleText = (topic: string) =>
  `<p>${topic}。${"This report describes the observation and its instrument in plain words. ".repeat(6)}</p>`;

/** A metered paywall: the page renders a fragment and states its limit, as Science's does. */
pages.set(`/article/paywall-${T}`, {
  status: 200,
  body: `<html><body><h1>Space telescope reopens the far-infrared</h1>${articleText("天文台重新打开远红外窗口")}<p>Subscribe to continue reading this article.</p></body></html>`,
});
/** The same wall, stated the other way round: it names subscribers before it offers a sign-in. */
pages.set(`/article/paywall-nodesc-${T}`, {
  status: 200,
  body: `<html><body><h1>Asteroid spins like a fairground ride</h1>${articleText("两颗小行星自转快到像游乐设施")}<p>Already a subscriber? Log in to continue.</p></body></html>`,
});
/** A page that refuses with no stated reason (Sky & Telescope answers 403 to non-browser clients). */
pages.set(`/article/refused-${T}`, { status: 403, body: "<html><body>Forbidden</body></html>" });
pages.set(`/article/refused-nodesc-${T}`, { status: 403, body: "<html><body>Forbidden</body></html>" });
pages.set(`/article/dayprecision-${T}`, { status: 403, body: "<html><body>Forbidden</body></html>" });
pages.set(`/article/blockme-${T}`, { status: 403, body: "<html><body>Forbidden</body></html>" });
/** An outage, not a wall: a temporary failure must never be filed as "needs a subscription". */
pages.set(`/article/flaky-${T}`, { status: 503, type: "text/plain", body: "origin is unwell" });
/**
 * A page that really is openly readable, with no wall and no marker: the only way an article may be
 * recorded as read in full is that the bounded page read brought the text back (A4).
 */
pages.set(`/article/opensite-${T}`, {
  status: 200,
  body: `<html><body><h1>Observatory publishes an openly readable release</h1>${articleText("开放获取的观测报告")}</body></html>`,
});

const rdfFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="${base}/feed-science-${T}.xml"><title>Science Space</title><link>https://www.science.org/</link></channel>
  <item rdf:about="${base}/article/paywall-${T}"><title>Space telescope reopens the far-infrared</title><link>${base}/article/paywall-${T}</link><dc:date>2026-10-08T02:00:00Z</dc:date><description>NASA's new far-infrared telescope will reopen a window astronomers have not had since Herschel.</description></item>
  <item rdf:about="${base}/article/paywall-nodesc-${T}"><title>Asteroid spins like a fairground ride</title><link>${base}/article/paywall-nodesc-${T}</link><dc:date>2026-10-09T17:00:00Z</dc:date></item>
  <item rdf:about="${base}/article/refused-nodesc-${T}"><title>Mars sample mission slips again</title><link>${base}/article/refused-nodesc-${T}</link><dc:date>2026-10-09</dc:date></item>
  <item rdf:about="${base}/article/dayprecision-${T}"><title>Solar wind switchbacks traced to the corona</title><link>${base}/article/dayprecision-${T}</link><dc:date>2026-10-08</dc:date><description>A study links magnetic switchbacks in the solar wind to their coronal source region.</description></item>
  <item rdf:about="${base}/article/blockme-${T}"><title>BLOCKME earthquake strikes Panama, damage expected</title><link>${base}/article/blockme-${T}</link><dc:date>2026-10-09T20:45:00Z</dc:date><description>A major earthquake struck Panama; injuries are expected across the region.</description></item>
  <item rdf:about="${base}/article/opensite-${T}"><title>Observatory publishes an openly readable release</title><link>${base}/article/opensite-${T}</link><dc:date>2026-10-09T21:00:00Z</dc:date><description>The observatory's own short summary of the release.</description></item>
</rdf:RDF>`;
feeds.set(`/feed-science-${T}.xml`, { status: 200, type: "application/xml", body: rdfFeed });

const rssFeed = (title: string, items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${escape(title)}</title>${items.join("")}</channel></rss>`;
feeds.set(`/feed-sky-${T}.xml`, {
  status: 200,
  type: "application/rss+xml; charset=UTF-8",
  body: rssFeed("Sky & Telescope astronomy news", [
    `<item><title>Meet the star cluster that defies conventions</title><link>${base}/article/refused-${T}</link><pubDate>Fri, 09 Oct 2026 08:00:12 +0000</pubDate><description>Astronomers find a cluster whose chemistry contradicts the accepted sequence of formation.</description></item>`,
    // The same article again, through the tracking parameters a feed wrapper adds: one article, not two.
    `<item><title>Meet the star cluster that defies conventions</title><link>${base}/article/refused-${T}?utm_source=rss&amp;utm_campaign=SkyTelescope</link><pubDate>Fri, 09 Oct 2026 08:00:12 +0000</pubDate><description>Astronomers find a cluster whose chemistry contradicts the accepted sequence of formation.</description></item>`,
    `<item><title>Lunar occultation times for October</title><link>${base}/article/flaky-${T}</link><pubDate>Fri, 09 Oct 2026 09:30:00 +0000</pubDate><description>Occultation timings for the coming weeks.</description></item>`,
  ]),
});
feeds.set(`/feed-astronomy-${T}.xml`, {
  status: 200,
  type: "application/rss+xml; charset=UTF-8",
  body: rssFeed("Astronomy Magazine news", [
    `<item><title>Newly selected NASA mission will hunt for caves on the Moon</title><link>${base}/article/open-${T}</link><pubDate>Fri, 09 Oct 2026 17:49:35 +0000</pubDate><category>News</category><content:encoded><![CDATA[<p>A newly selected mission will look for lunar caves.</p>${"<p>It carries radar and a small rover, and the team explains the plan in the announcement. </p>".repeat(9)}]]></content:encoded><description>A newly selected mission will look for lunar caves.</description></item>`,
    `<item><title>How to spot Saturn this weekend</title><link>${base}/article/saturn-${T}</link><pubDate>Fri, 09 Oct 2026 12:00:00 +0000</pubDate><category>News</category><description>Saturn reaches opposition next week.</description></item>`,
    `<item><title>Ten recipes for a clearer sky</title><link>${base}/article/lifestyle-${T}</link><pubDate>Fri, 09 Oct 2026 09:00:00 +0000</pubDate><category>Life</category><description>Lifestyle content that is not astronomy news.</description></item>`,
  ]),
});
/** One source answering 503 must fail alone (A9). */
const BROKEN = `jsi-broken-${T}`;
feeds.set(`/feed-broken-${T}.xml`, { status: 503, type: "text/plain", body: "upstream is unwell" });

/** A8: two different links that share one headline, one of which the source updates later. */
const DUPES = `jsi-dupes-${T}`;
const dupesFeed = (firstSummary: string) => rssFeed("Duplicate headline probe", [
  `<item><title>Same headline, different story</title><link>${base}/article/dupe-a-${T}</link><pubDate>Fri, 09 Oct 2026 07:00:00 +0000</pubDate><description>${firstSummary}</description></item>`,
  `<item><title>Same headline, different story</title><link>${base}/article/dupe-b-${T}</link><pubDate>Fri, 09 Oct 2026 07:05:00 +0000</pubDate><description>A separate story that happens to share the headline.</description></item>`,
]);
feeds.set(`/feed-dupes-${T}.xml`, { status: 200, type: "application/rss+xml; charset=UTF-8", body: dupesFeed("The first story's own abstract.") });

// §2.1: a source that goes quiet, and the same source coming back. Neither run may be visible to a
// reader: an outage does not withdraw what was published, and recovery does not re-import it.
const HISTORY = `jsi-history-${T}`;
const RECOVERY = `jsi-recovery-${T}`;
const entry = (title: string, link: string, bodyHtml: string, date: string) =>
  `<item><title>${escape(title)}</title><link>${link}</link><pubDate>${date}</pubDate><category>News</category><content:encoded><![CDATA[${bodyHtml}]]></content:encoded><description>${escape(title)}</description></item>`;
feeds.set(`/feed-history-${T}.xml`, {
  status: 200,
  type: "application/rss+xml; charset=UTF-8",
  body: rssFeed("History probe", [entry("A published find the source later cannot re-serve", `${base}/article/history-${T}`, articleText("一颗恒星的两份光谱"), "Fri, 09 Oct 2026 06:00:00 +0000")]),
});
const recoveryFeed = (withSecond: boolean) => rssFeed("Recovery probe", [
  entry("The entry offered again after the outage", `${base}/article/recovery-a-${T}`, articleText("射电阵列重新开机"), "Fri, 09 Oct 2026 05:00:00 +0000"),
  ...(withSecond ? [entry("Genuinely new after the outage", `${base}/article/recovery-b-${T}`, articleText("一次新的掩星观测"), "Fri, 09 Oct 2026 06:30:00 +0000")] : []),
]);
feeds.set(`/feed-recovery-${T}.xml`, { status: 200, type: "application/rss+xml; charset=UTF-8", body: recoveryFeed(false) });

// The five shipped samples: clearly synthetic feeds that mirror the shapes the candidate feeds
// answer with (an RDF index, a bare-day date, an entry that carries no description at all), which a
// hand-written inline feed cannot prove.
const FIXTURES = ["science-space.rdf.xml", "sky-telescope.rss.xml", "astronomy-magazine.rss.xml", "nature.rdf.xml", "scientific-american.rss.xml"];
for (const file of FIXTURES) {
  feeds.set(`/fixture/${file}`, { status: 200, type: "application/xml", body: readFileSync(new URL(`./fixtures/journal/${file}`, import.meta.url), "utf8") });
}

// ---------------------------------------------------------------- the paid models, as local stubs
interface Req { step: string; user: string }
const requests: Req[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = system.includes("宽召回的天文相关性预筛") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
    : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "summarize";
  requests.push({ step, user });
  const answer = (content: unknown) => ({
    id: `stub-${requests.length}`, model: "stub",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  if (step === "prefilter") return answer({ label: user.includes("BLOCKME") ? "BLOCK" : "PASS", reason: "测试" });
  // Below the T1 threshold (60 × 2): the item is written by the cheaper title/summary step, not selected.
  if (step === "score") return answer({ attentionScore: 30 });
  if (step === "structure") return answer({ category: "stars-transients", tags: ["科研成果"], subjects: [], scope: "single", fact: null });
  if (step === "understand") return answer({ itemType: "news", authorRole: "relayer", tags: [], editorialJudgment: "理由", titleZh: "理解标题", summaryZh: "理解摘要。" });
  return answer("title_zh: 导读标题\nsummary_zh: 这是中文导读摘要，只依据来源公开提供的那部分材料写成。");
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";
// An origin no provider names is paced at one call per 10 s with two concurrent (provider-pacing.ts,
// the local 6-RPM guard): a stub origin must therefore be admitted as a named provider, or a single
// analysis (structure beside two score calls) starves on that gate. The same idiom as the other
// model-calling tests; the receipts, budgets and permit ceiling still apply unchanged.
process.env.AGNES_BASE_URL = `${provider.url}/v1`;
process.env.AGNES_REQUESTS_PER_MINUTE = "60000";
process.env.AGNES_MAX_CONCURRENT = "4";

// ---------------------------------------------------------------- sources
const SCIENCE = `jsi-science-${T}`;
const SKY = `jsi-sky-${T}`;
const ASTRONOMY = `jsi-astronomy-${T}`;

async function source(id: string, name: string, config_: Record<string, unknown>, tags: string[] = []) {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, site_fulltext, syndicate_fulltext, tags, next_fetch_at)
    VALUES (${id}, ${name}, 'rss', ${sql.json(config_ as never)}, 'T1', 'editorial', 1440, false, false, ${tags}, '2100-01-01')`;
}

before(async () => {
  // Phase 1's three astronomy streams. None of them may ever show or redistribute full text (A14).
  await source(SCIENCE, "Science · Space（RSS · 仅公开摘要）", { feedUrl: `${base}/feed-science-${T}.xml`, _aihot: { initialBackfillLimit: 30 } });
  await source(SKY, "Sky & Telescope · astronomy news（RSS）", { feedUrl: `${base}/feed-sky-${T}.xml`, _aihot: { initialBackfillLimit: 30 } }, ["官方", "天文新闻"]);
  await source(ASTRONOMY, "Astronomy Magazine · News（RSS）", {
    feedUrl: `${base}/feed-astronomy-${T}.xml`, allowCategories: ["News", "Science"], _aihot: { initialBackfillLimit: 30 },
  }, ["官方", "天文新闻"]);
  await source(BROKEN, "Sky & Telescope · 暂时故障（RSS）", { feedUrl: `${base}/feed-broken-${T}.xml` });
  await source(DUPES, "同题探针（RSS）", { feedUrl: `${base}/feed-dupes-${T}.xml` });
  await source(HISTORY, "历史保留探针（RSS）", { feedUrl: `${base}/feed-history-${T}.xml` });
  await source(RECOVERY, "恢复接续探针（RSS）", { feedUrl: `${base}/feed-recovery-${T}.xml` });
});
after(async () => {
  await provider.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const articleOf = async (url: string) =>
  (await sql<{ id: string; title: string; coverage: string | null; access: string | null; body_status: string; body_text: string | null; excerpt: string | null; revision: number; raw: Record<string, any> | null }[]>`
    SELECT id, title, coverage, access, body_status, body_text, excerpt, revision, raw FROM articles WHERE url = ${url}`)[0]!;
const analysisOf = async (id: string) =>
  (await sql<{ relevance: string; selected: boolean; title_zh: string | null; summary_zh: string | null; output: Record<string, any> }[]>`
    SELECT relevance, selected, title_zh, summary_zh, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;
const publicationOf = async (id: string) =>
  (await sql<{ eligible: boolean; selected: boolean; visibility: string; body_mode: string; syndicate: boolean }[]>`
    SELECT eligible, selected, visibility, body_mode, syndicate FROM publications WHERE article_id = ${id}`)[0] ?? null;
const lastJob = async (id: string) =>
  (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id} ORDER BY created_on DESC LIMIT 1`)[0]?.name ?? null;
const promptsOf = (needle: string) => requests.filter((r) => r.user.includes(needle));
const poolItem = async (id: string, now: Date) => (await loadPool({ channel: "news", category: null, tag: null, q: null, page: 1, now })).items.find((i) => i.id === id) ?? null;

/**
 * The worker's own order: the body step first (bounded, one read), then the judgement on whatever it
 * holds. A state other than pass/block/unknown carries the recorded cause, so a failure names itself.
 */
const runPipeline = async (id: string): Promise<string> => {
  await extractArticleBody(id);
  const result = await processArticle(id);
  if (["pass", "block", "unknown"].includes(result.state)) return result.state;
  const [a] = await sql<{ processing_error: string | null }[]>`SELECT processing_error FROM articles WHERE id = ${id}`;
  return `${result.state}（${a?.processing_error ?? "未记录原因"}）`;
};

test("采集：一源抓不动不拖停他源，RDF 与 RSS 2.0 都进得来，摘要与片段分得清，追踪参数不产生第二篇", async () => {
  // The outage first: it must not touch the sources that answer.
  const broken = await collectSource(BROKEN);
  assert.equal(broken.status, "failed", "a source answering 503 fails on its own");
  assert.match(broken.error ?? "", /503/);
  const [health] = await sql<{ health: string; fail_count: number; last_error: string | null }[]>`
    SELECT health, fail_count, last_error FROM sources WHERE id = ${BROKEN}`;
  assert.deepEqual([health!.health, health!.fail_count], ["degraded", 1], "the failure is recorded on its own source, with a bounded wait");

  const science = await collectSource(SCIENCE);
  assert.deepEqual([science.status, science.found, science.created], ["ok", 6, 6]);
  const sky = await collectSource(SKY);
  // Three entries, one of them the same article through a tracker: two articles.
  assert.deepEqual([sky.status, sky.found, sky.created], ["ok", 3, 2], "the UTM variant is the same article");
  const astronomy = await collectSource(ASTRONOMY);
  // The lifestyle entry is dropped by allowCategories before it is stored at all (A5).
  assert.deepEqual([astronomy.status, astronomy.found, astronomy.created], ["ok", 3, 2]);
  assert.equal((await sql`SELECT 1 FROM articles WHERE url = ${`${base}/article/lifestyle-${T}`}`).length, 0);

  const abstract = await articleOf(`${base}/article/paywall-${T}`);
  assert.deepEqual([abstract.coverage, abstract.body_text, abstract.body_status], ["official_abstract", null, "pending"]);
  assert.ok(abstract.excerpt!.includes("far-infrared"), "the source's own abstract is the excerpt");

  const noSummary = await articleOf(`${base}/article/paywall-nodesc-${T}`);
  assert.deepEqual([noSummary.coverage, noSummary.body_text], ["metadata_only", null]);

  // The feed hands over a long block. It is kept as material — but a feed is not the article because
  // it is chatty, and no length threshold is evidence that a page was read in full (task.md).
  const feedCarried = await articleOf(`${base}/article/open-${T}`);
  assert.deepEqual([feedCarried.coverage, feedCarried.body_status, feedCarried.access], ["official_abstract", "ok", null]);
  assert.ok(feedCarried.body_text!.length > 280, "the text the feed carried is kept");

  // An entry the feed only summarised stays pending until the page itself is read (A4).
  const notYetRead = await articleOf(`${base}/article/opensite-${T}`);
  assert.deepEqual([notYetRead.coverage, notYetRead.body_status], ["official_abstract", "pending"]);

  const dayOnly = await articleOf(`${base}/article/dayprecision-${T}`);
  assert.equal(dayOnly.raw!.datePrecision, "day", "the source's own precision is recorded with the material (A10)");
  assert.equal(datePrecisionOf("2026-10-08"), "day");
  assert.equal(datePrecisionOf("2026-10-08T02:00:00Z"), "instant");
});

test("Task 2：五个真实 feed 样本（RDF 与 RSS 2.0）逐条解析正确，空摘要与去追踪都成立", async () => {
  const parse = async (file: string) => {
    const row: SourceRow = {
      id: `fixture-${file}`, name: file, kind: "rss", config: { feedUrl: `${base}/fixture/${file}` },
      tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 1440,
      enabled: false, cursor: null, fail_count: 0,
    };
    return (await fetchRss(row)).candidates;
  };

  // Every sample: three entries, each with what a digest needs, and never a body from a summary.
  const urls: string[] = [];
  for (const file of FIXTURES) {
    const items = await parse(file);
    assert.equal(items.length, 3, `${file} yields its three entries`);
    for (const it of items) {
      assert.ok(it.title.length > 0, `${file}: every entry has a title`);
      assert.ok(/^https?:\/\//.test(it.url), `${file}: every entry has a link`);
      assert.ok(it.publishedAt instanceof Date, `${file}: every entry has a parseable date`);
      assert.notEqual(it.coverage, "full_text", `${file}: a feed's own teaser is never mistaken for a body`);
      assert.equal(it.bodyText, null);
      // The tracking parameters a feed wrapper appends are gone from the shipped sample.
      assert.ok(!/utm_|mc_cid|\?$/.test(it.url), `${file}: the sample carries no tracker`);
      urls.push(it.url);
    }
  }
  assert.equal(new Set(urls).size, urls.length, "the five samples share no article");

  // RDF index (Science): a bare dc:date is an instant, and the description is an official abstract.
  const science = await parse("science-space.rdf.xml");
  assert.equal(science[0]!.url, "https://www.science.org/content/article/synthetic-sample-report-one-about-a-placeholder-mission");
  assert.equal(science[0]!.publishedAt!.toISOString(), "2026-10-08T02:00:00.000Z");
  assert.equal((science[0]!.raw as Record<string, unknown>).datePrecision, "instant");
  assert.deepEqual([science[0]!.coverage, contentKindOf(science[0]!.url, science[0]!.categories)], ["official_abstract", "news"]);
  assert.equal(science[0]!.author, "Example Author");

  // RDF index (Nature) whose date is a calendar day only: day precision is recorded as such, and an
  // entry with no description is left as metadata rather than given a made-up summary.
  const nature = await parse("nature.rdf.xml");
  for (const it of nature) {
    assert.equal((it.raw as Record<string, unknown>).datePrecision, "day");
    assert.deepEqual([it.coverage, it.excerpt], ["metadata_only", null]);
    assert.equal(contentKindOf(it.url, it.categories), "news", "nature.com/articles/d41586-… is the journal's own news, not a paper");
  }

  // RSS 2.0 (Sky & Telescope): an observing column is a guide even though its feed category says news,
  // and a news story is news.
  const sky = await parse("sky-telescope.rss.xml");
  assert.equal(contentKindOf(sky[0]!.url, sky[0]!.categories), "guide", "«This Week's Sky at a Glance» is a guide, by its own URL");
  assert.equal(contentKindOf(sky[1]!.url, sky[1]!.categories), "news");
  assert.ok(sky.every((i) => i.coverage === "official_abstract"));

  // RSS 2.0 (Astronomy Magazine): categories survive, and the observing column is a guide too.
  const astronomy = await parse("astronomy-magazine.rss.xml");
  assert.ok(astronomy[0]!.categories!.includes("News"), "the entry's own categories are kept");
  assert.equal(contentKindOf(astronomy[1]!.url, astronomy[1]!.categories), "guide");

  // RSS 2.0 (Scientific American): the feed is general science, so it carries items that are not
  // astronomy at all — the samples keep them, which is exactly why the second screen exists.
  const sciam = await parse("scientific-american.rss.xml");
  assert.ok(sciam.every((i) => i.coverage === "official_abstract"), "every entry carries the site's own abstract, never a body");
  assert.ok(sciam.some((i) => /earthquake|hurricane/i.test(i.title)), "the sample is not pre-filtered: judging, not the feed, decides what is astronomy");
});

test("A8：同题不同链接是两篇文章，同链接的更新是修订而不是替换", async () => {
  const first = await collectSource(DUPES);
  // Identity is the link. A title is a headline, not a key: these two must both exist.
  assert.deepEqual([first.found, first.created, first.revised], [2, 2, 0]);
  const a = await articleOf(`${base}/article/dupe-a-${T}`);
  const b = await articleOf(`${base}/article/dupe-b-${T}`);
  assert.equal(a.title, b.title);
  assert.notEqual(a.id, b.id, "one headline over two links is two articles, never one merged item");
  assert.deepEqual([a.coverage, b.coverage], ["official_abstract", "official_abstract"]);

  // The source updates one of them. The changed article gains a revision; its neighbour is untouched,
  // and no article is deleted in the process.
  feeds.set(`/feed-dupes-${T}.xml`, { status: 200, type: "application/rss+xml; charset=UTF-8", body: dupesFeed("The first story's own abstract, now naming the instrument.") });
  const second = await collectSource(DUPES, { force: true });
  assert.deepEqual([second.found, second.created, second.revised], [2, 0, 1], "only the article whose material changed is revised");
  const aAfter = await articleOf(`${base}/article/dupe-a-${T}`);
  const bAfter = await articleOf(`${base}/article/dupe-b-${T}`);
  assert.deepEqual([aAfter.id, bAfter.id], [a.id, b.id], "both articles survive the update");
  assert.equal(aAfter.revision, a.revision + 1);
  assert.equal(bAfter.revision, b.revision, "a same-titled neighbour is not dragged along");
  // An update to a feed's own summary never promotes it to a body (the stored text stays what it was).
  assert.deepEqual([aAfter.coverage, aAfter.body_text], ["official_abstract", null]);
});

/**
 * The scope of a feed's text is decided by what the source declares, never by how long the text is:
 * a length threshold is not evidence that a page was read in full (task.md), and the recorded scope
 * is what the writer and the reader are told.
 */
test("覆盖范围由来源声明决定，不由字数决定：feed 自带的长文本从不记成完整正文", async () => {
  const longBody = `<p>${"The team describes the instrument and its first light. ".repeat(12)}</p>`;
  feeds.set(`/feed-scope-${T}.xml`, {
    status: 200,
    type: "application/rss+xml; charset=UTF-8",
    body: rssFeed("Scope probe", [
      `<item><title>Scope probe entry</title><link>${base}/article/scope-${T}</link><pubDate>Fri, 09 Oct 2026 10:00:00 +0000</pubDate><content:encoded><![CDATA[${longBody}]]></content:encoded><description>A short summary of it.</description></item>`,
    ]),
  });
  const row = (config_: Record<string, unknown>): SourceRow => ({
    id: `scope-${T}`, name: "Scope probe", kind: "rss", config: { feedUrl: `${base}/feed-scope-${T}.xml`, ...config_ },
    tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 1440,
    enabled: false, cursor: null, fail_count: 0,
  });

  // Nothing in the source says its feed carries the article: a long block is still not the article.
  const [undeclared] = (await fetchRss(row({}), { force: true })).candidates;
  assert.ok(undeclared!.bodyText!.length > 280, "the text really is long");
  assert.equal(undeclared!.coverage, "official_abstract", "length alone never makes it the article");
  assert.equal(
    textRoleLabel({ hasBody: !!undeclared!.bodyText, hasExcerpt: !!undeclared!.excerpt, coverage: undeclared!.coverage }),
    "官方摘要",
    "a long feed block is never introduced as the article",
  );

  // The source declares that its feed carries the article: now, and only now, it is recorded as such.
  const [declared] = (await fetchRss(row({ summaryIsBody: true }), { force: true })).candidates;
  assert.equal(declared!.coverage, "full_text", "a declared article-carrying feed is the article");
  assert.equal(
    textRoleLabel({ hasBody: !!declared!.bodyText, hasExcerpt: !!declared!.excerpt, coverage: declared!.coverage }),
    "正文",
    "the declaration is what lets the text be read as the article",
  );

  // Coverage that was never recorded keeps the old reading, so rows stored before it existed are safe.
  assert.equal(textRoleLabel({ hasBody: true, hasExcerpt: false, coverage: null }), "正文");
  assert.equal(textRoleLabel({ hasBody: true, hasExcerpt: true, coverage: "public_excerpt" }), "公开可读片段");
  assert.equal(textRoleLabel({ hasBody: false, hasExcerpt: false, coverage: "metadata_only" }), "（无）");

  // The whole prompt context must agree with itself: the quality line and the scope line are read
  // together, so one input can never say both "官方摘要（不是完整正文）" and "完整正文".
  const long = "The team describes the instrument and its first light. ".repeat(12);
  const ctxOf = (over: Partial<AnalyzeInputArticle>) =>
    renderContext({
      id: `scope-ctx-${T}`, revision: 1, title: "Scope probe entry", url: `${base}/article/scope-${T}`,
      author: null, publishedAt: null, discoveredAt: null, bodyText: null, excerpt: null,
      bodyStatus: "ok", coverage: null, access: null, datePrecision: null, contentKind: "news",
      xPost: null, media: [],
      source: { name: "Scope probe", kind: "rss", tier: "T2", firstParty: false, tags: [], fetchesBody: false },
      ...over,
    });
  const qualityOf = (text: string) => text.split("\n").find((l) => l.startsWith("【材料质量】"))!;

  const abstractCtx = ctxOf({ bodyText: long, excerpt: "A short summary.", coverage: "official_abstract", access: "subscribe" });
  assert.ok(abstractCtx.includes("【材料范围】官方摘要（不是完整正文）"), "the scope line states the limit");
  assert.ok(!abstractCtx.includes("完整正文（"), "a long block a summary source handed over is never called the full article");
  assert.ok(
    qualityOf(abstractCtx).includes("仅官方摘要") && qualityOf(abstractCtx).includes("原文需订阅"),
    "the quality line states the same limit (and the access finding), not the length",
  );

  const fragmentCtx = ctxOf({ bodyText: long, coverage: "public_excerpt" });
  assert.ok(!fragmentCtx.includes("完整正文（"), "a fragment stored in bodyText is still a fragment");

  // A recorded scope that says the text is the article, and a row with no scope at all, keep the old reading.
  const fullCtx = ctxOf({ bodyText: long, coverage: "full_text" });
  assert.ok(fullCtx.includes("【材料范围】完整正文") && fullCtx.includes("【材料质量】完整正文（"), "a declared article-carrying feed reads as the article");
  const legacyCtx = ctxOf({ bodyText: long, coverage: null });
  assert.ok(legacyCtx.includes("【材料质量】完整正文（"), "a row stored before the scope was tracked reads as before");
});

test("A1/A2：官方摘要与订阅页片段都写成导读，且不声称读过全文", async () => {
  const abstract = await articleOf(`${base}/article/paywall-${T}`);
  assert.equal(await runPipeline(abstract.id), "pass");
  const run = await analysisOf(abstract.id);
  assert.deepEqual([run.output.coverage, run.output.access, run.output.writer], ["official_abstract", "subscribe", "summarize"]);
  assert.deepEqual([run.title_zh, run.summary_zh], ["导读标题", "这是中文导读摘要，只依据来源公开提供的那部分材料写成。"]);

  const prompt = promptsOf("far-infrared").find((r) => r.step === "summarize")!;
  assert.ok(prompt.user.includes("官方摘要（来源自己提供的摘要，不是完整正文）："), "the writer is told what it holds");
  assert.ok(!prompt.user.includes("正文内容："), "a feed abstract is never handed over as the article's text");
  assert.ok(prompt.user.includes("材料不是原文全文"), "the summary-backed intro is written under its own rule");

  // The page states a limit: the summary is still written, and the reader is told what the original allows.
  assert.equal(readerNote({ coverage: "official_abstract", access: null, fullText: false }), "本介绍依据原文公开摘要整理。");
  assert.equal(readerNote({ coverage: "official_abstract", access: "subscribe", fullText: false }), "本介绍依据原文公开摘要整理。阅读全文需订阅原网站。");
  assert.equal(readerNote({ coverage: "full_text", access: "subscribe", fullText: true }), null, "a page the site may show in full carries no paywall claim");
  assert.equal(readerNote({ coverage: null, access: null, fullText: false }), null, "nothing recorded, nothing claimed");
});

test("A2：确认订阅只读一次，片段降级，之后不再排抽取任务", async () => {
  const bare = await articleOf(`${base}/article/paywall-nodesc-${T}`);
  assert.equal(await extractArticleBody(bare.id), "unconfirmed");
  const after1 = await articleOf(`${base}/article/paywall-nodesc-${T}`);
  assert.deepEqual([after1.coverage, after1.access, after1.body_status], ["public_excerpt", "subscribe", "unconfirmed"]);
  assert.ok(after1.excerpt!.length >= 200, "the free fragment is kept as the excerpt, never as a body");
  assert.notEqual(after1.revision, bare.revision, "new material is a new revision, so the earlier judgement is stale");

  // Confirmed restrictions are read once: the next routing decision is the analysis, not another read.
  await queueProcessing(bare.id);
  assert.equal(await lastJob(bare.id), QUEUES.analyze, "no extraction retry loop after a confirmed subscription wall");

  assert.equal(await processArticle(bare.id).then((r) => r.state), "pass");
  const run = await analysisOf(bare.id);
  assert.deepEqual([run.output.coverage, run.output.access], ["public_excerpt", "subscribe"]);

  // The 403 page: no stated reason, so nothing is claimed beyond an uncertainty, and no paid read is spent.
  const refused = await articleOf(`${base}/article/refused-${T}`);
  assert.equal(await extractArticleBody(refused.id), "unconfirmed");
  const refusedAfter = await articleOf(`${base}/article/refused-${T}`);
  assert.deepEqual([refusedAfter.access, refusedAfter.coverage], ["maybe", "official_abstract"]);
  assert.equal(readerNote({ coverage: refusedAfter.coverage, access: refusedAfter.access, fullText: false }), "本介绍依据原文公开摘要整理。阅读全文可能需要登录或订阅。");

  // An outage is not a wall: nothing is recorded against the original, and the bounded retry keeps it,
  // while a confirmed wall is never queued for extraction again.
  const flaky = await articleOf(`${base}/article/flaky-${T}`);
  await assert.rejects(() => extractArticleBody(flaky.id), ExtractTransientError);
  const flakyAfter = await articleOf(`${base}/article/flaky-${T}`);
  assert.deepEqual([flakyAfter.body_status, flakyAfter.access], ["pending", null], "a temporary failure is not a subscription");
  await queueProcessing(flaky.id);
  assert.equal(await lastJob(flaky.id), QUEUES.extractBody, "an outage stays on the bounded extraction retry");
});

test("A3：只有标题时保持元数据状态，不写实质内容，也不假通过分析", async () => {
  const bare = await articleOf(`${base}/article/refused-nodesc-${T}`);
  assert.equal(await runPipeline(bare.id), "unknown");
  const run = await analysisOf(bare.id);
  assert.deepEqual([run.relevance, run.title_zh, run.summary_zh], ["unknown", "", ""]);
  assert.equal(run.output.unknownReason, "material", "缺少材料与「写不出可用内容」在记录里是两件事");
  const [a] = await sql<{ coverage: string | null; processing_state: string }[]>`SELECT coverage, processing_state FROM articles WHERE id = ${bare.id}`;
  assert.deepEqual([a!.coverage, a!.processing_state], ["metadata_only", "analyzed"]);
  // A detail page existing is not the pool listing it: without an intro the item is written nowhere
  // readers browse, and the page it does have carries no summary to index.
  const pub = await publicationOf(bare.id);
  assert.equal(pub!.eligible, false, "a title-only item never enters the pool");
  assert.equal(await poolItem(bare.id, new Date()), null, "the item is absent from the public pool");
  const detail = await loadItemDetail(bare.id);
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") {
    assert.ok(!detail.item.summary, "no intro was written for it");
    assert.equal(detail.item.indexable, false);
  }
});

test("A4/A14：回源读到全文的源不退化，feed 自带的长文本不冒充全文，也不越权展示正文或图片", async () => {
  // A page that really is openly readable: the bounded read brings the text back, and that read is
  // the only thing allowed to record the article as read in full.
  const open = await articleOf(`${base}/article/opensite-${T}`);
  assert.equal(await runPipeline(open.id), "pass");
  const readBack = await articleOf(`${base}/article/opensite-${T}`);
  assert.deepEqual([readBack.coverage, readBack.body_status, readBack.access], ["full_text", "ok", "open"], "a page read in full is recorded as such, and an open page is not a wall");
  const openPub = await publicationOf(open.id);
  assert.deepEqual([openPub!.body_mode, openPub!.eligible, openPub!.syndicate], ["summary", true, false], "site_fulltext=false keeps the body off the site and out of redistribution");
  const openDetail = await loadItemDetail(open.id);
  assert.equal(openDetail.kind, "found");
  if (openDetail.kind === "found") {
    assert.equal(openDetail.item.accessNote ?? null, null, "no subscription claim on an openly readable page");
    assert.equal(openDetail.item.body, null, "holding the body is not a licence to show it");
  }

  // The same treatment for an entry the feed itself carried: the material is used, the licence is
  // unchanged, and nothing tells the reader — or the writer — that the article was read in full.
  const feedCarried = await articleOf(`${base}/article/open-${T}`);
  assert.equal(await runPipeline(feedCarried.id), "pass");
  const notFetched = await articleOf(`${base}/article/open-${T}`);
  assert.equal(notFetched.access, null, "a body the feed itself carried is never re-read from the page");
  const run = await analysisOf(feedCarried.id);
  assert.equal(run.output.coverage, "official_abstract", "the recorded scope travels with the judgement");
  const prompt = promptsOf("lunar caves").find((r) => r.step === "summarize")!;
  assert.ok(prompt.user.includes("官方摘要（来源自己提供的摘要，不是完整正文）："), "the writer is told the feed's block is not the article");
  assert.ok(!prompt.user.includes("正文内容："), "a long feed block is never handed over as the article's text");
  assert.ok(prompt.user.includes("材料不是原文全文"), "a summary-backed intro is written under its own rule");

  const pub = await publicationOf(feedCarried.id);
  assert.deepEqual([pub!.body_mode, pub!.eligible, pub!.syndicate], ["summary", true, false], "site_fulltext=false keeps the body off the site and out of redistribution");
  const detail = await loadItemDetail(feedCarried.id);
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") {
    assert.match(detail.item.accessNote ?? "", /公开摘要/, "the reader is told what the intro was written from");
    assert.ok(!/需登录|需订阅/.test(detail.item.accessNote ?? ""), "no wall was found, so no wall is claimed");
    assert.equal(detail.item.body, null, "holding the body is not a licence to show it");
    assert.equal(detail.item.newsImage, null, "no image permission was given");
  }
});

test("A5/A6：非天文不进入动态，新闻与论文摘要分型", async () => {
  const blocked = await articleOf(`${base}/article/blockme-${T}`);
  assert.equal(await runPipeline(blocked.id), "block");
  assert.equal((await publicationOf(blocked.id))!.eligible, false, "a general-science story stays out of the astronomy pool");

  // The item's own nature is decided from its URL and the feed's categories, not from a journal's fame.
  assert.equal(contentKindOf("https://www.nature.com/articles/s41550-026-99999-0"), "research");
  assert.equal(contentKindOf("https://www.nature.com/articles/d41586-026-99998-z"), "news");
  assert.equal(contentKindOf("https://www.science.org/content/article/synthetic-rule-probe"), "news");
  assert.equal(contentKindOf("https://skyandtelescope.org/astronomy-news/observing-news/synthetic-rule-probe/"), "guide");
  assert.equal(contentKindOf("https://example.com/x", ["Research"]), "research");
  const news = await articleOf(`${base}/article/open-${T}`);
  assert.equal((await analysisOf(news.id)).output.contentKind, "news");
});

test("A7：重复处理同一版本不产生新的模型请求", async () => {
  const abstract = await articleOf(`${base}/article/paywall-${T}`);
  const before = provider.hits();
  assert.equal(await processArticle(abstract.id).then((r) => r.state), "pass");
  assert.equal(provider.hits(), before, "the same revision reuses its receipts instead of paying again");
});

test("A10：日精度日期不编造时刻，历史条目不冒充今天的新发现", async () => {
  const dayOnly = await articleOf(`${base}/article/dayprecision-${T}`);
  assert.equal(await runPipeline(dayOnly.id), "pass");
  const score = promptsOf("Solar wind switchbacks").find((r) => r.step === "score")!;
  assert.ok(score.user.includes("2026-10-08（原文只精确到日）"), "the scored time is the source's own precision");
  assert.ok(!/2026-10-08T0?[08]:/.test(score.user), "no invented time of day");
  assert.ok(!/T0?8:00/.test(promptsOf("switchbacks").find((r) => r.step === "summarize")!.user));
  const [row] = await sql<{ timeline_at: Date; discovered_at: Date }[]>`SELECT timeline_at, discovered_at FROM articles WHERE id = ${dayOnly.id}`;
  assert.ok(row!.timeline_at < row!.discovered_at, "a first import is archived by source time, not shown as today's find");
});

test("A11：摘要导读进入公共 pool，非精选、不推送", async () => {
  const abstract = await articleOf(`${base}/article/paywall-${T}`);
  const item = await poolItem(abstract.id, new Date());
  assert.ok(item, "the summary-backed item is listed in the public pool");
  assert.equal(item!.selected, false);
  const pub = await publicationOf(abstract.id);
  assert.deepEqual([pub!.visibility, pub!.eligible, pub!.selected], ["public", true, false]);
  assert.equal(
    readerNote({ coverage: "official_abstract", access: "subscribe", fullText: pub!.body_mode === "full" }),
    "本介绍依据原文公开摘要整理。阅读全文需订阅原网站。",
    "the reader-facing note is the recorded range plus the recorded limit",
  );
  const notify = await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.notifySelected} AND data->>'articleId' = ${abstract.id}`;
  assert.equal(notify.length, 0, "a summary-backed intro is never pushed");
});

test("A12：读者浏览详情不再调用模型、不再抓原网站", async () => {
  const abstract = await articleOf(`${base}/article/paywall-${T}`);
  const models = provider.hits();
  const collects = feedRequests.length;
  const first = await loadItemDetail(abstract.id);
  const second = await loadItemDetail(abstract.id, "original");
  assert.equal(first.kind, "found");
  assert.equal(second.kind, "found");
  if (first.kind === "found") assert.equal(first.item.accessNote, "本介绍依据原文公开摘要整理。阅读全文需订阅原网站。");
  if (second.kind === "found") assert.equal(second.item.accessNote, "本介绍依据原文公开摘要整理。阅读全文需订阅原网站。");
  assert.equal(provider.hits(), models, "reading a page calls no model");
  assert.equal(feedRequests.length, collects, "reading a page does not collect the feed again");
});

test("§2.1：源暂时抓不动时，已发布的历史文章照旧留在动态里，日期、分类与判定都不动", async () => {
  const first = await collectSource(HISTORY);
  assert.deepEqual([first.status, first.created], ["ok", 1]);
  const article = await articleOf(`${base}/article/history-${T}`);
  assert.equal(await runPipeline(article.id), "pass");
  const before = await articleOf(`${base}/article/history-${T}`);
  const pubBefore = await publicationOf(article.id);
  const runBefore = await analysisOf(article.id);
  const [timesBefore] = await sql<{ timeline_at: Date; discovered_at: Date }[]>`SELECT timeline_at, discovered_at FROM articles WHERE id = ${article.id}`;
  assert.ok(await poolItem(article.id, new Date()), "先是一次正常的发布");

  // The source goes quiet. The run fails on its own and says so — it is never filed as "nothing new".
  feeds.set(`/feed-history-${T}.xml`, { status: 503, type: "text/plain", body: "upstream is unwell" });
  const failed = await collectSource(HISTORY, { force: true });
  assert.equal(failed.status, "failed", "不可达不等于正常无新增");
  const [health] = await sql<{ health: string; fail_count: number; last_error: string | null }[]>`
    SELECT health, fail_count, last_error FROM sources WHERE id = ${HISTORY}`;
  assert.equal(health!.health, "degraded");
  assert.ok(health!.fail_count >= 1 && /503/.test(health!.last_error ?? ""), "失败留在后台并带上原因");

  // Nothing was withdrawn and nothing was rewritten: the reader sees exactly what it saw before.
  const after = await articleOf(`${base}/article/history-${T}`);
  assert.deepEqual([after.id, after.revision, after.coverage, after.body_status], [before.id, before.revision, before.coverage, before.body_status]);
  assert.deepEqual(await publicationOf(article.id), pubBefore, "资格、可见性与正文模式都没变");
  const runAfter = await analysisOf(article.id);
  assert.deepEqual([runAfter.title_zh, runAfter.summary_zh], [runBefore.title_zh, runBefore.summary_zh], "已发布的判定没有被重写");
  const [timesAfter] = await sql<{ timeline_at: Date; discovered_at: Date }[]>`SELECT timeline_at, discovered_at FROM articles WHERE id = ${article.id}`;
  assert.deepEqual([timesAfter!.timeline_at, timesAfter!.discovered_at], [timesBefore!.timeline_at, timesBefore!.discovered_at], "时间线位置也没被挪动");
  assert.ok(await poolItem(article.id, new Date()), "它仍然在动态里");
});

test("§2.1：网络恢复后按正常增量去重接续，老条目不会重新入库一次", async () => {
  const first = await collectSource(RECOVERY);
  assert.deepEqual([first.status, first.found, first.created], ["ok", 1, 1]);

  feeds.set(`/feed-recovery-${T}.xml`, { status: 503, type: "text/plain", body: "upstream is unwell" });
  assert.equal((await collectSource(RECOVERY, { force: true })).status, "failed");

  // Recovery: the same entry is offered again beside one that is genuinely new.
  feeds.set(`/feed-recovery-${T}.xml`, { status: 200, type: "application/rss+xml; charset=UTF-8", body: recoveryFeed(true) });
  const back = await collectSource(RECOVERY, { force: true });
  assert.deepEqual([back.status, back.found, back.created, back.revised], ["ok", 2, 1, 0], "只接上真正新增的那条，老条目不再入库");
  const [old] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE url = ${`${base}/article/recovery-a-${T}`}`;
  assert.equal(old!.n, 1, "恢复不是重复入库");
  const [fresh] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE url = ${`${base}/article/recovery-b-${T}`}`;
  assert.equal(fresh!.n, 1, "新增的那条只入一次");
});

test("访问判定的边界：订阅、登录、验证码、暂时故障各归各位", () => {
  assert.equal(accessFromPage("<p>Subscribe to continue reading</p>"), "subscribe");
  assert.equal(accessFromPage("<p>Sign in to read the rest</p>"), "login");
  assert.equal(accessFromPage("<p>Already a subscriber? Log in to continue.</p>"), "subscribe", "a page naming subscribers is a paid wall, not a login wall");
  assert.equal(accessFromPage("<title>Just a moment...</title>"), "challenge");
  assert.equal(accessFromPage("<p>An ordinary article</p>"), null);
  assert.equal(accessFromStatus(401), "login");
  assert.equal(accessFromStatus(402), "subscribe");
  assert.equal(accessFromStatus(403), null, "a bare 403 states nothing by itself");
  assert.equal(accessFromStatus(429), null, "a rate limit is an outage, not a paywall");
  // A bot challenge is stated as an uncertainty, never as a subscription.
  assert.equal(readerNote({ coverage: "official_abstract", access: "challenge", fullText: false }), "本介绍依据原文公开摘要整理。阅读全文可能需要登录或订阅。");
  assert.equal(readerNote({ coverage: "official_abstract", access: "login", fullText: false }), "本介绍依据原文公开摘要整理。阅读全文需在原网站登录。");
  assert.equal(readerNote({ coverage: "metadata_only", access: null, fullText: false }), "原文提供的信息有限，这里只依据标题与公开元数据。");
  assert.equal(readerNote({ coverage: "public_excerpt", access: "subscribe", fullText: false }), "本介绍依据原文公开可读片段整理。阅读全文需订阅原网站。");
});

test("A15：候选来源只写进配置，一律不启用生产采集", () => {
  const pack = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as {
    sources: Array<{ id: string; name: string; kind: "rss"; config: Record<string, unknown>; enabled?: boolean; site_fulltext?: boolean; syndicate_fulltext?: boolean }>;
  };
  const journals = pack.sources.filter((s) => s.id.startsWith("rss-journal-"));
  // §2.1: every verified candidate feed is kept in the open configuration — a deployment whose network
  // cannot reach one is not a reason to delete it — while none of them is enabled by a seed.
  assert.equal(journals.length, 10, "十份经核查的候选 feed 都保留在同一处配置里");
  for (const entry of journals) {
    assert.equal(entry.kind, "rss");
    assert.equal(entry.enabled, false, `${entry.id} must not be enabled by a seed`);
    assert.equal(entry.site_fulltext, false, `${entry.id} may not show the article itself`);
    assert.equal(entry.syndicate_fulltext, false, `${entry.id} may not redistribute the article`);
    // No collector key the RSS kind does not implement: a silent fallback would parse menus as articles.
    assert.deepEqual(unsupportedConfig("rss", entry.config), [], `${entry.id} carries a key the RSS collector ignores`);
  }
  // Two of the ten are kept as configuration only: the plan leaves them out of the first version.
  const laterOnly = journals.filter((s) => /aps-physics|nature-astronomy/.test(s.id));
  assert.equal(laterOnly.length, 2, "首版不接入的两份也保留了配置");
  for (const entry of laterOnly) assert.equal(entry.enabled, false);
  const firstVersion = journals.filter((s) => !laterOnly.includes(s));
  assert.equal(firstVersion.length, 8, "首版八份（三份天文专流 + 四份综合 + 一份观测指南）");
});
