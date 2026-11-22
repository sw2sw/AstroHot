// One shared prefilter for mixed-topic science sources: a single paid request returns both
// relevance labels, the route decides which column's chain runs, both-PASS keeps the astronomy
// column (so its display right is never silently lost) and records the AI4S finding from one extra
// structure call on the same identity, and an UNKNOWN holds the item instead of reading it as "no".
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, routeSharedPrefilter } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SHARED_SOURCE = `test-shared-${T}`;
const PLAIN_SOURCE = `test-plain-${T}`;

type Step = "shared" | "prefilter" | "score" | "understand" | "summarize" | "structure" | "ai4s-structure";
interface Req { step: Step; marker: string; system: string }
const requests: Req[] = [];

const MARKERS = ["ASTRO", "AIONLY", "BOTH", "NONE", "HOLD", "PLAIN"];
const sharedAnswers: Record<string, unknown> = {
  ASTRO: { astronomy: "PASS", ai4s: "BLOCK", reason: "天文观测结果" },
  AIONLY: { astronomy: "BLOCK", ai4s: "PASS", reason: "AI 辅助数学证明" },
  BOTH: { astronomy: "PASS", ai4s: "PASS", reason: "AI 参与天文研究" },
  NONE: { astronomy: "BLOCK", ai4s: "BLOCK", reason: "芯片销售" },
  HOLD: { astronomy: "BLOCK", ai4s: "UNKNOWN", reason: "材料不足" },
};
const ai4sStructureAnswers: Record<string, unknown> = {
  AIONLY: { scope: "single", domain: "methods-tools", astroApplication: { applies: false, evidence: null }, fact: null },
  BOTH: { scope: "single", domain: "astronomy-astrophysics", astroApplication: { applies: true, evidence: "AI classified 12 million galaxy spectra in the survey.", referent: "galaxy spectra" }, fact: null },
};

const stepOf = (system: string, user: string): Step =>
  system.includes("双维预筛") ? "shared"
    : system.includes("宽召回的天文相关性预筛") ? "prefilter"
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
  if (step === "shared") return answer(sharedAnswers[marker] ?? { astronomy: "UNKNOWN", ai4s: "UNKNOWN", reason: "缺" });
  if (step === "prefilter") return answer({ label: "PASS", reason: "天文" });
  if (step === "score") return answer({ attentionScore: 80 });
  if (step === "understand") return answer({ itemType: "research_result", authorRole: "principal", tags: [], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充关键数字。` });
  if (step === "ai4s-structure") return answer(ai4sStructureAnswers[marker]);
  if (step === "structure") return answer({ category: "stars-transients", tags: ["科研成果"], subjects: [], scope: "single", fact: null });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config) VALUES
    (${SHARED_SOURCE}, '综合科学源（测试）', 'rss', 'T1', 'editorial', '2100-01-01', ${sql.json({ sharedPrefilter: true } as never)}),
    (${PLAIN_SOURCE}, '普通天文源（测试）', 'rss', 'T1', 'editorial', '2100-01-01', '{}'::jsonb)`;
});
after(async () => {
  await provider.close(); await stopBoss(); await closeDb();
});

const article = async (marker: string, sourceId = SHARED_SOURCE, bodyText?: string) =>
  (await upsertMaterial({
    sourceId, url: `https://example.com/${marker}-${T}`, title: `${marker} science result ${T}`,
    bodyText: bodyText ?? `${marker}: a detailed scientific report with methods, results and a quantitative finding (${T}).`,
    bodyStatus: "ok", coverage: "full_text", via: "fetch", publishedAt: new Date("2026-11-20T02:00:00Z"),
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const analysisRow = async (id: string) =>
  (await sql<{ relevance: string; output: Record<string, any> }[]>`SELECT relevance, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;
const articleScope = async (id: string) =>
  (await sql<{ content_scope: string }[]>`SELECT content_scope FROM articles WHERE id = ${id}`)[0]!.content_scope;
const pubScope = async (id: string) =>
  (await sql<{ content_scope: string; displayable: boolean; astro_cross_listed: boolean; ai4s_cross_listed: boolean; ai4s_selected: boolean }[]>`
    SELECT content_scope, (eligible AND visibility = 'public') AS displayable, astro_cross_listed, ai4s_cross_listed, ai4s_selected
    FROM publications WHERE article_id = ${id}`)[0]!;

test("route table: each label pair maps to exactly one chain, and UNKNOWN never becomes a no", () => {
  assert.deepEqual(routeSharedPrefilter({ astronomy: "PASS", ai4s: "BLOCK" }), { scope: "astro", excluded: false, held: false, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "BLOCK", ai4s: "PASS" }), { scope: "ai4s", excluded: false, held: false, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "PASS", ai4s: "PASS" }), { scope: "astro", excluded: false, held: false, extraAi4sStructure: true });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "BLOCK", ai4s: "BLOCK" }), { scope: null, excluded: true, held: false, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "BLOCK", ai4s: "UNKNOWN" }), { scope: null, excluded: false, held: true, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "UNKNOWN", ai4s: "UNKNOWN" }), { scope: null, excluded: false, held: true, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "UNKNOWN", ai4s: "BLOCK" }), { scope: "astro", excluded: false, held: false, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "UNKNOWN", ai4s: "PASS" }), { scope: "ai4s", excluded: false, held: false, extraAi4sStructure: false });
  assert.deepEqual(routeSharedPrefilter({ astronomy: "PASS", ai4s: "UNKNOWN" }), { scope: "astro", excluded: false, held: false, extraAi4sStructure: false });
});

test("A01 astronomy-only news keeps the astronomy chain and never enters AI4S", async () => {
  const id = await article("ASTRO");
  const res = await analyzeArticle(id);
  assert.equal(res!.output!.relevance, "pass");
  assert.equal(res!.output!.contentScope, "astro");
  assert.deepEqual(calls("ASTRO").sort(), ["score", "score", "shared", "structure", "understand"]);
  assert.equal(await articleScope(id), "astro");
  await publishArticle(id);
  assert.equal((await pubScope(id)).content_scope, "astro");
});

test("A02 AI-assisted mathematics reaches the AI4S column instead of being dropped by astronomy", async () => {
  const id = await article("AIONLY");
  const res = await analyzeArticle(id);
  assert.equal(res!.output!.relevance, "pass", "a BLOCK from astronomy must not stop the AI4S candidate");
  assert.equal(res!.output!.contentScope, "ai4s");
  assert.equal(await articleScope(id), "ai4s", "the primary column follows the route");
  assert.deepEqual(calls("AIONLY").sort(), ["ai4s-structure", "score", "score", "shared", "understand"]);
  assert.ok(requests.find((r) => r.marker === "AIONLY" && r.step === "score")!.system.includes("AI4S 栏目"), "the AI4S scorer, not the astronomy one");
  await publishArticle(id);
  assert.equal((await pubScope(id)).content_scope, "ai4s");
});

test("A03 both dimensions pass: one identity, one shared prefilter, astronomy stays primary, AI4S finding recorded", async () => {
  // The AI4A quote must be a verbatim substring of the original material: the guard rejects a model
  // claim it cannot ground, so the fixture carries the exact sentence.
  const id = await article("BOTH", SHARED_SOURCE, "BOTH: AI classified 12 million galaxy spectra in the survey. A benchmark release for the team (2026).");
  const res = await analyzeArticle(id);
  assert.equal(res!.output!.relevance, "pass");
  assert.equal(res!.output!.contentScope, "astro", "both-PASS keeps the astronomy column; its display right is not silently lost");
  assert.equal(calls("BOTH").filter((s) => s === "shared").length, 1, "the shared prefilter runs exactly once");
  assert.equal(calls("BOTH").filter((s) => s === "structure").length, 1);
  assert.equal(calls("BOTH").filter((s) => s === "ai4s-structure").length, 1, "one AI4S structure call, not a second pipeline");
  assert.deepEqual([res!.output!.domain, res!.output!.ai4a], ["astronomy-astrophysics", true]);
  const row = await analysisRow(id);
  assert.deepEqual(row.output.sharedPrefilter && [row.output.sharedPrefilter.astronomy, row.output.sharedPrefilter.ai4s], ["PASS", "PASS"]);
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM articles WHERE identity_key = ${(await sql<{ identity_key: string }[]>`SELECT identity_key FROM articles WHERE id = ${id}`)[0]!.identity_key}`;
  assert.equal(count, 1, "one article identity, not a copy");
  await publishArticle(id);
  const pub = await pubScope(id);
  assert.equal(pub.content_scope, "astro");
  // A07: the AI4A finding does not grant a cross-list on its own; that stays an audited decision.
  assert.equal(pub.astro_cross_listed, false);
  // The other direction is analysis-driven: the AI4S dimension of this judgement gives the article a
  // display right in the AI4S column, while the AI4S column's own selection stays off (it has no
  // AI4S-scored judgement to select on).
  assert.equal(pub.ai4s_cross_listed, true);
  assert.equal(pub.ai4s_selected, false);
});

test("A04 non-science AI news is excluded on both dimensions and buys no analysis", async () => {
  const id = await article("NONE");
  const res = await analyzeArticle(id);
  assert.equal(res!.output!.relevance, "block");
  assert.deepEqual(calls("NONE"), ["shared"]);
});

test("A05 an unresolved dimension holds the item with its reason instead of calling it irrelevant", async () => {
  const id = await article("HOLD");
  const res = await analyzeArticle(id);
  assert.equal(res!.output!.relevance, "unknown");
  assert.deepEqual(calls("HOLD"), ["shared"], "no score, structure or writing is bought while unresolved");
  const row = await analysisRow(id);
  assert.equal(row.output.unknownReason, "shared-prefilter");
});

test("A06 re-running the same task reuses the receipt: no second prefilter is paid for", async () => {
  const id = await article("ASTRO");
  const before = calls("ASTRO").length;
  await analyzeArticle(id);
  assert.equal(calls("ASTRO").length, before, "the same revision and attempt reuse every settled receipt");
});

test("A09 a source outside the shared scope still uses the single-column astronomy prefilter", async () => {
  const id = await article("PLAIN", PLAIN_SOURCE);
  await analyzeArticle(id);
  assert.deepEqual(calls("PLAIN").sort(), ["prefilter", "score", "score", "structure", "understand"]);
  assert.equal(await articleScope(id), "astro");
  assert.ok(!requests.some((r) => r.marker === "PLAIN" && r.step === "shared"));
});
