// One real notice through the ordinary pipeline: ingestion → the existing analysis call (prefilter,
// two scores, structure, writing) → the conference projection → the public hub. The point of this file
// is what does NOT change: no extra model request for a notice, no conference row for an ordinary
// article, and no change to the article's own selection, column or cross-listing.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadConferenceHub } from "@aihot/backend/publication/conferences";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const ASTRO = `test-e2e-astro-${T}`;
const AI4S = `test-e2e-ai4s-${T}`;

const NOTICE_BODY = [
  "第25届天文信息学与虚拟天文台学术研讨会（CVO2026）将于2026年11月24日至28日在西安召开。",
  "现已开放报名，注册范围2026年9月28日至2026年11月28日；摘要投稿截止2026年10月15日。",
  "主办：国家天文科学数据中心。",
].join("\n");
const ORDINARY_BODY = "The survey released its first data release, covering 1,200 square degrees of the southern sky.";

const requests: Array<{ system: string; user: string }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = String(body.messages[0]?.content ?? "");
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  requests.push({ system, user });
  const answer = (content: unknown) => ({
    id: `stub-${requests.length}`, model: "stub",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  if (system.includes("宽召回")) return answer({ label: "PASS", reason: "测试" });
  if (system.includes("注意力评分器")) return answer({ attentionScore: user.includes("低关注度") ? 5 : 76 });
  if (system.includes("内容理解编辑")) return answer({ itemType: "science_outreach", authorRole: "relayer", tags: [], editorialJudgment: "会议通知", titleZh: `会议标题 ${T}`, summaryZh: "会议将在中国西安召开，现已开放报名。" });
  if (system.includes("资料结构化助手")) {
    const isNotice = user.includes("第25届天文信息学与虚拟天文台学术研讨会");
    const conference = isNotice ? {
      isNotice: true, ambiguous: false, name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届",
      startDate: "2026-11-24", endDate: "2026-11-28", timezone: null, city: "西安", venue: null, online: false,
      organizer: "国家天文科学数据中心", officialUrl: null, registrationUrl: null,
      deadlines: [{ kind: "abstract", date: "2026-10-15", quote: "摘要投稿截止2026年10月15日" }],
      evidence: "第25届天文信息学与虚拟天文台学术研讨会（CVO2026）将于2026年11月24日至28日在西安召开。",
    } : { isNotice: false, ambiguous: false, name: null, edition: null, startDate: null, endDate: null, timezone: null, city: null, venue: null, online: null, organizer: null, officialUrl: null, registrationUrl: null, deadlines: [], evidence: null };
    if (system.includes("AI4S 栏目")) return answer({ scope: "single", domain: "astronomy-astrophysics", astroApplication: { applies: false, evidence: null, referent: null }, fact: null, conference });
    return answer({
      category: "outreach-images", tags: isNotice ? ["学术会议", "望远镜"] : ["科研成果"], subjects: [], scope: "single",
      fact: { title: "会议通知", subject: "国家天文科学数据中心", action: "开放报名", object: "第25届 CVO 研讨会", occurredAt: null, evidence: null, conditions: [] },
      conference,
    });
  }
  return answer(`title_zh: 标题 ${T}\nsummary_zh: 摘要正文。补充一句。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${ASTRO}, '会议 E2E 天文源', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${AI4S}, '会议 E2E AI4S 源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close(); await stopBoss(); await closeDb();
});

let n = 0;
async function ingest(body: string, source = ASTRO, scope: "astro" | "ai4s" = "astro") {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.org/e2e-${T}-${n}`, title: "会议通知", bodyText: body,
    bodyStatus: "ok", coverage: "full_text", via: "ingest", contentScope: scope,
  });
  return { articleId };
}

test("a notice costs exactly the same model requests as an ordinary article", async () => {
  const ordinary = await ingest(ORDINARY_BODY);
  requests.length = 0;
  await analyzeArticle(ordinary.articleId);
  const plainCost = requests.length;

  const notice = await ingest(NOTICE_BODY);
  requests.length = 0;
  const result = await analyzeArticle(notice.articleId);
  assert.equal(requests.length, plainCost);
  assert.ok(result?.analysisId);

  const [row] = await sql<{ title_zh: string; tags: string[] }[]>`SELECT title_zh, tags FROM analyses WHERE id = ${result!.analysisId}`;
  assert.ok(row!.title_zh);
  // The existing 学术会议 category tag is reused, not duplicated by a parallel one.
  assert.equal(row!.tags[0], "学术会议");

  const [conference] = await sql<{ id: number; name: string; city: string | null; start_date: string | null }[]>`
    SELECT id, name, city, start_date::text FROM conferences WHERE name LIKE ${"第25届%"}`;
  assert.ok(conference);
  assert.equal(conference!.city, "西安");
  assert.equal(conference!.start_date, "2026-11-24");

  // The notice reaches the public hub through the same publication the rest of the site reads.
  await publishArticle(notice.articleId);
  const hub = await loadConferenceHub({ scope: "astro", now: new Date("2026-11-17T04:00:00Z") });
  assert.ok(hub.items.some((c) => c.name.startsWith("第25届")));

  // An ordinary article creates no conference and is not held back by the recognition step.
  const [none] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM conference_notices WHERE article_id = ${ordinary.articleId}`;
  assert.equal(none!.count, 0);
});

test("an AI4S notice takes the same path and stays in its own column", async () => {
  const notice = await ingest(NOTICE_BODY, AI4S, "ai4s");
  requests.length = 0;
  const result = await analyzeArticle(notice.articleId);
  assert.ok(result?.analysisId);
  const [row] = await sql<{ tags: string[] }[]>`SELECT tags FROM analyses WHERE id = ${result!.analysisId}`;
  // The AI4S structure step has no tag vocabulary of its own, so the tag is written by the deterministic
  // path: a recognised notice carries it in this column exactly as it does in the astronomy one.
  assert.equal(row!.tags[0], "学术会议");
  const [conference] = await sql<{ id: number; domain: string }[]>`
    SELECT c.id, c.domain FROM conferences c JOIN conference_notices n ON n.conference_id = c.id WHERE n.article_id = ${notice.articleId}`;
  assert.ok(conference);
  // The same meeting already had an astronomy notice, so the event is now cross-column — while the
  // AI4S article itself stays in its own column and gains no astronomy rights.
  assert.equal(conference!.domain, "both");
  await publishArticle(notice.articleId);
  const hub = await loadConferenceHub({ scope: "ai4s", now: new Date("2026-11-17T04:00:00Z") });
  assert.ok(hub.items.some((c) => c.id === conference!.id));
});

test("a low-scored AI4S notice is still recognised, and still costs one structure call", async () => {
  // The score only decides selection; it never gates the structure call, so a notice the column will not
  // feature is still a conference. The request count proves no extra model call was added for it.
  const plain = await ingest(`${ORDINARY_BODY} 低关注度`, AI4S, "ai4s");
  requests.length = 0;
  await analyzeArticle(plain.articleId);
  const plainCost = requests.length;

  const notice = await ingest(`${NOTICE_BODY}\n低关注度`, AI4S, "ai4s");
  requests.length = 0;
  const result = await analyzeArticle(notice.articleId);
  assert.equal(requests.length, plainCost);
  assert.ok(result?.analysisId);

  const [row] = await sql<{ tags: string[]; selected: boolean; score: number | null }[]>`
    SELECT tags, selected, score FROM analyses WHERE id = ${result!.analysisId}`;
  assert.equal(row!.selected, false);
  assert.ok((row!.score ?? 0) < 40);
  assert.equal(row!.tags[0], "学术会议");
  const [noticeRow] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM conference_notices WHERE article_id = ${notice.articleId}`;
  assert.equal(noticeRow!.count, 1);
  const [plainNotice] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM conference_notices WHERE article_id = ${plain.articleId}`;
  assert.equal(plainNotice!.count, 0, "an ordinary AI4S story is not a notice");
});
