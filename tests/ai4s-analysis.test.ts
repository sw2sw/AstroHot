// The AI4S column's judging and public projection: its own prompts (never the astronomy ones),
// scores only on full text, an explicit off-switch fixture, AI4A only with
// grounded original evidence, and a read layer isolated from the astronomy site. Cross-listing and
// manual selection stay editorial overrides on the same identity. Synthetic scenarios on local stubs.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadAi4sFeed } from "@aihot/backend/publication/ai4s";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { overrideFields } from "@aihot/backend/admin/content";
import { SELECTION } from "@aihot/industry/selection";

// These scenarios exercise the off-switch AI4S policy. Set this file's fixtures to off explicitly,
// then restore the configured value after the tests.
const SELECTION_FIXTURE = SELECTION as { ai4sAutoSelection: boolean };
const DEPLOYMENT_AI4S_AUTO_SELECTION = SELECTION_FIXTURE.ai4sAutoSelection;
SELECTION_FIXTURE.ai4sAutoSelection = false;

const T = tag();
const AI4S_SOURCE = `test-ai4s-${T}`;
const ASTRO_SOURCE = `test-ai4s-astro-${T}`;

type Step = "prefilter" | "score" | "understand" | "summarize" | "structure" | "ai4s-structure";
interface Req { step: Step; marker: string; system: string }
const requests: Req[] = [];
const MARKERS = ["AIFULL", "AIABS", "AIASTRO", "AIFAKE", "AIBLOCK", "ASTROREG"];
const scoreAnswers: Record<string, number[]> = { AIFULL: [80, 82], AIASTRO: [85, 85], AIFAKE: [80, 80], ASTROREG: [78, 72] };
const ASTRO_EVIDENCE = "AI classified 12 million galaxy spectra in the survey.";
const ai4sStructureAnswers: Record<string, unknown> = {
  AIFULL: { scope: "single", domain: "physics", astroApplication: { applies: false, evidence: null }, fact: { title: "格点定义证明", subject: "SYNTHETIC Lab", action: "证明", object: "标准模型格点定义", occurredAt: null, evidence: "a lattice proof of the Standard Model", conditions: [] } },
  AIABS: { scope: "single", domain: "research-meta", astroApplication: { applies: false, evidence: null }, fact: null },
  AIASTRO: { scope: "single", domain: "astronomy-astrophysics", astroApplication: { applies: true, evidence: ASTRO_EVIDENCE, referent: "galaxy spectra" }, fact: { title: "星系光谱分类", subject: "某巡天团队", action: "发布", object: "光谱分类结果", occurredAt: null, evidence: ASTRO_EVIDENCE, conditions: [] } },
  AIFAKE: { scope: "single", domain: "astronomy-astrophysics", astroApplication: { applies: true, evidence: "AI solved dark matter completely." }, fact: null },
  AIBLOCK: { scope: "unknown", domain: null, astroApplication: null, fact: null },
};

const stepOf = (system: string, user: string): Step =>
  system.includes("AI4S 栏目（AI 赋能科学）做宽召回") || system.includes("宽召回的天文相关性预筛") ? "prefilter"
  : system.includes("事件注意力评分器") ? "score"
  : system.includes("内容理解编辑") ? "understand"
  : system.includes("AI4S 栏目（AI 赋能科学）的资料结构化助手") ? "ai4s-structure"
  : system.includes("资料结构化助手") ? "structure"
  : user.includes("title_zh") ? "summarize" : (() => { throw new Error("unknown request"); })();

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, system });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: marker === "AIBLOCK" ? "BLOCK" : "PASS", reason: "测试" });
  if (step === "score") return answer({ attentionScore: scoreAnswers[marker]!.shift() });
  if (step === "understand") return answer({ itemType: "research_result", authorRole: "principal", tags: [], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  if (step === "ai4s-structure") return answer(ai4sStructureAnswers[marker]);
  if (step === "structure") return answer({ category: "stars-transients", tags: ["科研成果"], subjects: [], scope: "single", fact: { title: `事实 ${marker}`, subject: "某实验室", action: "发布", object: "黑洞观测结果", occurredAt: null, evidence: "a black hole result", conditions: [] } });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${AI4S_SOURCE}, 'SYNTHETIC Science（测试）', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${ASTRO_SOURCE}, '天文测试源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  SELECTION_FIXTURE.ai4sAutoSelection = DEPLOYMENT_AI4S_AUTO_SELECTION;
  await provider.close(); await stopBoss(); await closeDb();
});

const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (await upsertMaterial({
    sourceId: AI4S_SOURCE, url: `https://example.com/${marker}-${T}`, title: `${marker} science result ${T}`,
    bodyText: `${marker}: a lattice proof of the Standard Model with detailed methods. ${ASTRO_EVIDENCE} (${T})`,
    bodyStatus: "ok", coverage: "full_text", contentScope: "ai4s", via: "fetch", publishedAt: new Date("2026-11-15T22:00:01Z"), ...extra,
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const analysisRow = async (id: string) =>
  (await sql<{ selected: boolean; relevance: string; score: string | null; output: Record<string, any> }[]>`
    SELECT selected, relevance, score, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;
const pubRow = async (id: string) =>
  (await sql<{ content_scope: string; domain: string | null; ai4a: boolean | null; astro_cross_listed: boolean; eligible: boolean; selected: boolean; selection_candidate: boolean; score: string | null }[]>`
    SELECT content_scope, domain, ai4a, astro_cross_listed, eligible, selected, selection_candidate, score FROM publications WHERE article_id = ${id}`)[0]!;
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
/** Editorial overrides go through the admin path (version-checked, validated), as an operator's do. */
const override = async (id: string, fields: Record<string, unknown>, reason: string, clear?: string[]) => {
  const version = (await sql<{ version: number }[]>`SELECT version FROM editorial_overrides WHERE article_id = ${id}`)[0]?.version ?? 0;
  return overrideFields(id, { fields, reason, version, ...(clear ? { clear } : {}) }, "tester");
};
const pool = () => loadPool({ channel: "all", category: null, tag: null });

test("auto-selection for the AI4S column stays off until an authorized calibration", () => {
  assert.equal(SELECTION.ai4sAutoSelection, false);
});

test("ai4s full-text material uses the column's own prompts, is scored, but never auto-selected", async () => {
  const id = await article("AIFULL");
  const res = await analyzeArticle(id);
  assert.deepEqual(calls("AIFULL").sort(), ["ai4s-structure", "prefilter", "score", "score", "understand"]);
  assert.deepEqual([res!.output!.selected, res!.output!.score, res!.output!.relevance], [false, 81, "pass"], "80 + 82 >= 2 × 60, yet the column does not auto-select");
  assert.deepEqual([res!.output!.domain, res!.output!.ai4a], ["physics", false]);
  const r = await analysisRow(id);
  assert.equal(r.selected, false);
  assert.deepEqual([r.output.domain, r.output.ai4a, r.output.contentScope], ["physics", false, "ai4s"]);
  assert.ok(requests.find((q) => q.marker === "AIFULL" && q.step === "prefilter")!.system.includes("AI4S 栏目"));
  assert.ok(requests.find((q) => q.marker === "AIFULL" && q.step === "score")!.system.includes("AI4S 栏目"));
  assert.ok(!requests.find((q) => q.marker === "AIFULL" && q.step === "score")!.system.includes("天文爱好者"), "the astronomy scorer's readership never leaks into the column");
  await publishArticle(id);
  const p = await pubRow(id);
  assert.deepEqual([p.content_scope, p.domain, p.ai4a, p.astro_cross_listed], ["ai4s", "physics", false, false]);
  assert.deepEqual([p.eligible, p.selected, p.selection_candidate], [true, false, false]);
  const all = await loadAi4sFeed({ tab: "all" });
  assert.ok(ids(all.items).includes(id));
  assert.equal((await loadAi4sFeed({ tab: "selected" })).items.length, 0);
  assert.ok(!ids((await pool()).items).includes(id), "the astronomy pool never lists an ai4s item");
});

test("ai4s abstract-only material is a limited intro: no score call, a faithful summary and a reader note", async () => {
  const id = await article("AIABS", { bodyText: null, bodyStatus: "unconfirmed", coverage: "official_abstract", excerpt: `AIABS: the science blog shares new findings and methods (${T}).` });
  const res = await analyzeArticle(id);
  assert.deepEqual(calls("AIABS").sort(), ["ai4s-structure", "prefilter", "summarize"], "no paid score on a summary");
  assert.deepEqual([res!.output!.score, res!.output!.selected, res!.output!.relevance], [null, false, "pass"]);
  await publishArticle(id);
  const p = await pubRow(id);
  assert.deepEqual([p.eligible, p.selected, p.score], [true, false, null]);
  const item = (await loadAi4sFeed({ tab: "all" })).items.find((i) => i.id === id)!;
  assert.equal(item.score, null, "no invented score on a limited intro");
  assert.equal(item.accessNote, "本介绍依据原文公开摘要整理。");
  assert.equal(item.summary, `翻译摘要 AIABS。第二句补充影响。`);
  assert.equal(item.links.original, `https://example.com/AIABS-${T}`);
  assert.ok(item.source.name.includes("SYNTHETIC Science"));
  assert.ok(item.publishedAt, "the source date stays visible");
  const detail = await loadItemDetail(id);
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") {
    assert.equal(detail.item.contentScope, "ai4s");
    assert.equal(detail.item.body, null, "a limited intro shows no full body");
    assert.equal(detail.item.originalAbstract, `AIABS: the science blog shares new findings and methods (${T}).`, "the public official abstract is exposed for the column's bilingual reading");
  }
});

test("AI4A is true only with grounded original evidence; an invented quote leaves it unknown", async () => {
  const astro = await article("AIASTRO");
  const fake = await article("AIFAKE");
  const a = await analyzeArticle(astro);
  const f = await analyzeArticle(fake);
  assert.deepEqual([a!.output!.ai4a, a!.output!.domain], [true, "astronomy-astrophysics"]);
  assert.deepEqual([f!.output!.ai4a, f!.output!.domain], [null, "astronomy-astrophysics"], "applies without a verbatim quote is not a verified astronomy application");
  await publishArticle(astro);
  await publishArticle(fake);
  assert.equal((await pubRow(astro)).ai4a, true);
  assert.equal((await pubRow(fake)).ai4a, null);
  const astroTab = await loadAi4sFeed({ tab: "all", domain: "astro" });
  assert.ok(ids(astroTab.items).includes(astro));
  assert.ok(!ids(astroTab.items).includes(fake));
  const physicsTab = await loadAi4sFeed({ tab: "all", domain: "physics" });
  assert.ok(!ids(physicsTab.items).includes(astro));
});

test("the ai4s prefilter's BLOCK stops the item exactly like the astronomy one", async () => {
  const id = await article("AIBLOCK");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.relevance, res!.output!.selected], ["block", false]);
  assert.deepEqual(calls("AIBLOCK"), ["prefilter"]);
  await publishArticle(id);
  assert.equal((await pubRow(id)).eligible, false);
  assert.ok(!ids((await loadAi4sFeed({ tab: "all" })).items).includes(id));
});

test("astronomy material keeps auto-selection and stays out of the ai4s column", async () => {
  const id = (await upsertMaterial({
    sourceId: ASTRO_SOURCE, url: `https://example.com/ASTROREG-${T}`, title: `ASTROREG black hole result ${T}`,
    bodyText: `ASTROREG: a black hole result with an observation table. (${T})`, bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-11-15T22:00:01Z"),
  } as never)).articleId;
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [true, 75]);
  assert.deepEqual(calls("ASTROREG").sort(), ["prefilter", "score", "score", "structure", "understand"]);
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${id}`;
  await publishArticle(id);
  const p = await pubRow(id);
  assert.deepEqual([p.content_scope, p.domain, p.ai4a, p.selected], ["astro", null, null, true]);
  assert.ok(!ids((await loadAi4sFeed({ tab: "all" })).items).includes(id));
  assert.ok(ids((await pool()).items).includes(id));
});

test("cross-listing into astronomy needs an astronomy approval, and is revocable", async () => {
  const [{ id }] = (await sql<{ id: string }[]>`SELECT id FROM articles WHERE url = ${`https://example.com/AIFULL-${T}`}`) as Array<{ id: string }>;
  // A bare cross-list request on a non-AI4A item (domain=physics, ai4a=false) is refused by the admin path
  // itself: the override's generic reason is not an astronomy review (B2), so nothing is written.
  await assert.rejects(
    () => override(id, { crossListed: true }, "想交叉列入天文列表"),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  await publishArticle(id);
  assert.equal((await pubRow(id)).astro_cross_listed, false, "a bare crossListed request without AI4A or manual approval is rejected");
  assert.ok(!ids((await pool()).items).includes(id), "the unapproved item never reaches the astronomy pool");
  // An independent, structured, auditable manual astronomy determination admits it.
  await override(id, { crossListed: true, astroApproved: true, astroApprovalNote: "人工天文认定：该格点方法用于巡天数据校准。" }, "人工天文认定");
  assert.equal((await pubRow(id)).astro_cross_listed, true);
  assert.ok(ids((await pool()).items).includes(id), "the approved item reaches the astronomy pool");
  assert.ok(ids((await loadAi4sFeed({ tab: "all" })).items).includes(id), "and stays in its own column");
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${id}`)[0]!.n, 1, "no second analysis for the second column");
  // Revoking the approval converges: the item leaves the astronomy pool.
  await override(id, { crossListed: false }, "撤销交叉推荐");
  assert.equal((await pubRow(id)).astro_cross_listed, false);
  assert.ok(!ids((await pool()).items).includes(id));
});

test("a verified AI4A finding cross-lists without a separate manual approval", async () => {
  const [{ id }] = (await sql<{ id: string }[]>`SELECT id FROM articles WHERE url = ${`https://example.com/AIASTRO-${T}`}`) as Array<{ id: string }>;
  assert.equal((await pubRow(id)).ai4a, true);
  await override(id, { crossListed: true }, "AI4A 交叉列入");
  assert.equal((await pubRow(id)).astro_cross_listed, true, "a verified AI4A finding is itself the astronomy approval");
  assert.ok(ids((await pool()).items).includes(id));
  await override(id, { crossListed: false }, "撤销交叉推荐");
  assert.equal((await pubRow(id)).astro_cross_listed, false);
  assert.ok(!ids((await pool()).items).includes(id));
});

test("a manual selection override still admits an ai4s item while auto-selection is off", async () => {
  const [{ id }] = (await sql<{ id: string }[]>`SELECT id FROM articles WHERE url = ${`https://example.com/AIFULL-${T}`}`) as Array<{ id: string }>;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${id}`;
  await override(id, { selected: true }, "人工精选");
  await publishArticle(id);
  const p = await pubRow(id);
  assert.deepEqual([p.selection_candidate, p.selected], [true, true]);
  const selected = await loadAi4sFeed({ tab: "selected" });
  assert.ok(ids(selected.items).includes(id));
  assert.ok(!ids((await pool()).items).includes(id), "selected in its own column does not leak into astronomy");
  await override(id, {}, "撤销人工精选", ["selected"]);
  assert.equal((await pubRow(id)).selected, false);
});

test("the feed carries a scope-wide identity map for the click-to-update diff (照 arxiv)", async () => {
  const feed = await loadAi4sFeed({ tab: "all" });
  assert.equal(typeof feed.contentTag, "string");
  assert.ok(feed.contentTag.length > 0, "an empty scope still yields a stable fingerprint, not a missing signal");
  assert.ok(Array.isArray(feed.groups));
  assert.ok(feed.groups.length >= feed.items.length, "the map covers the whole filtered scope, not just the page");
  for (const g of feed.groups) {
    assert.equal(typeof g.key, "string");
    assert.equal(g.rep, g.key, "a flat list: every item is its own group, keyed by its stable article id");
    assert.equal(g.members, 1);
    assert.deepEqual(g.memberIds, [g.key]);
  }
  const ids = new Set(feed.items.map((i) => i.id));
  assert.ok(feed.items.every((i) => feed.groups.some((g) => g.key === i.id)), "every shown item has an identity entry");
  // A second read of the same scope is identical: the signal is deterministic, so a quiet check never
  // mistakes its own ordering for new content.
  const again = await loadAi4sFeed({ tab: "all" });
  assert.equal(again.contentTag, feed.contentTag);
  assert.deepEqual(again.groups, feed.groups);
  assert.ok(ids.size > 0);
});