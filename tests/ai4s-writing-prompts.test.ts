// R6: the AI4S writing steps must assemble discipline-neutral requests, not the astronomy ones that
// force corona→日冕 / survey→巡天 / magnitude→星等 on life-science/materials material. These capture the
// REAL assembled request (system + user) the provider receives, via the local stub, and assert the
// astronomy forcing is gone for AI4S while the astronomy site's own request is left unchanged.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { runAnalysis, runUnderstand, AI4S_PROMPT_VERSIONS, PROMPT_VERSIONS, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";

interface Captured { system: string; user: string; model: string }
const requests: Captured[] = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]?.role === "system" ? String(body.messages[0].content) : "";
  const userMsg = body.messages.find((m) => m.role === "user");
  const user = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(userMsg?.content ?? "");
  requests.push({ system, user, model: body.model });
  const json = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }] });
  if (system.includes("注意力评分器")) return json({ attentionScore: 10 });
  if (system.includes("预筛")) return json({ label: "PASS", reason: "fixture" });
  if (system.includes("资料结构化助手")) {
    return json(system.includes("AI4S")
      ? { scope: "single", domain: "life-sciences", astroApplication: { applies: false, evidence: null }, fact: null }
      : { scope: "single", category: null, tags: [], subjects: [], fact: null });
  }
  if (system.includes("内容理解编辑")) {
    return json({ itemType: "research_result", authorRole: "principal", tags: ["科研成果"], editorialJudgment: "",
      titleZh: "某机构发布聚合物电晕新方法", summaryZh: "某机构测量了聚合物薄膜的电晕起始电压，并对五百个样本按失效量级做了调查排序，公开了数据与方法。" });
  }
  // The summarize step sends no system message; its user message is the assembled article prompt.
  return { choices: [{ message: { content: "title_zh: 某机构发布聚合物电晕新方法\nsummary_zh: 某机构测量了聚合物薄膜的电晕起始电压，并对五百个样本按失效量级做了调查排序，公开了数据与方法。" } }] };
});
for (const key of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[key] = `${provider.url}/v1`;
for (const key of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] = "test-key";
after(async () => { await provider.close(); await closeDb(); });

// Cross-discipline homographs in a NON-astronomy context: corona=电晕(放电), survey=调查, magnitude=量级.
const HOMOGRAPHS = "We measured the corona discharge onset voltage in the polymer film. A survey of 500 samples ranked them by failure magnitude.";
const article = (over: Partial<AnalyzeInputArticle> = {}): AnalyzeInputArticle => ({
  id: `writing-${tag()}`, revision: 1, title: "Corona discharge in polymer films", url: "https://example.org/materials",
  author: null, publishedAt: new Date("2026-11-01T00:00:00Z"), bodyStatus: "ok", bodyText: HOMOGRAPHS, excerpt: null,
  media: [], xPost: null, coverage: "full_text", source: { name: "Fixture Materials", kind: "rss", tier: "T1", firstParty: false },
  ...over,
});
const lastWriting = () => [...requests].reverse().find((r) => r.system.includes("内容理解编辑") || r.system === "")!;

test("the AI4S understand request carries no astronomy forcing and keeps the homograph material", async () => {
  requests.length = 0;
  await runUnderstand(article({ contentScope: "ai4s" }));
  const req = requests.find((r) => r.system.includes("内容理解编辑"))!;
  assert.ok(req, "the understand step really sent a request");
  assert.doesNotMatch(req.system, /一律按天文含义翻译/, "no forced astronomy translation rule");
  assert.doesNotMatch(req.system, /本平台 100% 是天文/, "no 100%-astronomy claim");
  assert.doesNotMatch(req.system, /corona = 日冕（太阳大气外层/, "no forced corona→日冕 default");
  assert.match(req.system, /不是 100% 天文/, "the AI4S domain rule states the column is multi-discipline");
  assert.match(req.system, /按材料自身的学科翻译/, "translation follows the material's own discipline");
  assert.match(req.user, /corona discharge onset voltage/, "the homograph material reaches the model under neutral rules");
});

test("the astronomy understand request is unchanged (still forces its own domain rules)", async () => {
  requests.length = 0;
  await runUnderstand(article({ contentScope: "astro" }));
  const req = requests.find((r) => r.system.includes("内容理解编辑"))!;
  assert.match(req.system, /一律按天文含义翻译/, "the astronomy site keeps its forced domain translation");
  assert.match(req.system, /本平台 100% 是天文/);
});

test("the AI4S summarize request is assembled from the neutral article prompt, not the astronomy one", async () => {
  requests.length = 0;
  // A low score routes writing to summarize (not understand); the full chain runs for real.
  await runAnalysis(article({ contentScope: "ai4s" }));
  const writing = requests.filter((r) => r.system === "" || r.system.includes("内容理解编辑"));
  const summarize = writing.find((r) => r.system === "")!;
  assert.ok(summarize, "the summarize step really sent a request");
  assert.doesNotMatch(summarize.user, /一律按天文含义翻译/);
  assert.doesNotMatch(summarize.user, /天文内容优先保留/, "no astronomy-priority summary guidance");
  assert.match(summarize.user, /AI4S 栏目/, "the neutral AI4S article prompt is used");
  assert.match(summarize.user, /按材料自身学科/, "summary guidance follows the material's discipline");
  assert.match(summarize.user, /corona discharge onset voltage/);
});

test("the AI4S writing prompt versions are separate from the untouched astronomy ones", () => {
  assert.match(AI4S_PROMPT_VERSIONS.understand, /^ai4s-understand@/);
  assert.match(AI4S_PROMPT_VERSIONS.summarize, /^ai4s-summarize-article[+@]/);
  assert.match(PROMPT_VERSIONS.understand, /^understand@/);
  assert.match(PROMPT_VERSIONS.summarize, /^summarize-article[+@]/);
  assert.notEqual(AI4S_PROMPT_VERSIONS.understand, PROMPT_VERSIONS.understand);
});