// R8: coverage type is not material sufficiency. A sufficient official abstract is paid-scored within
// its proven range (and the request says the full text was not read); a thin teaser stays unscored with
// zero paid receipts. These run the real score step against a local stub and count its receipts.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { runSelectionScores, ai4sMaterialSufficient, buildScoreInput, SCORE_CALLS, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";

const requests: Array<{ user: string }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const last = body.messages[body.messages.length - 1]!.content;
  requests.push({ user: typeof last === "string" ? last : JSON.stringify(last) });
  return { choices: [{ message: { content: JSON.stringify({ attentionScore: 70 }) } }] };
});
for (const key of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[key] = `${provider.url}/v1`;
for (const key of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] = "test-key";
after(async () => { await provider.close(); await closeDb(); });

const article = (coverage: string, bodyText: string, tier = "T1"): AnalyzeInputArticle => ({
  id: `abstract-${tag()}`, revision: 1, title: "A research result", url: "https://example.org/paper",
  author: null, publishedAt: new Date("2026-11-01T00:00:00Z"), bodyStatus: "ok", bodyText, excerpt: null,
  media: [], xPost: null, coverage, contentScope: "ai4s", source: { name: "Fixture", kind: "rss", tier, firstParty: false },
});
const SUFFICIENT = "We release an open pipeline that refines protein structures from cryo-EM maps. On a held-out set of 200 maps it reduces model error by 12% versus the prior method, with a reproducible benchmark.";
const TEASER_LATTICE = "SYNTHETIC: A fictional team discusses a toy research idea with an AI assistant. Technical details are not available.";
const TEASER_BLOG = "SYNTHETIC: A fictional science community has a new discussion space. Technical details are not available.";
const THIN_TWO = "We started a new science blog. It will share findings soon.";
// Round 3: one sentence can carry a result, and two sentences can carry nothing. Sentence count is not
// the question; a stated finding is. Promised, planned or explicitly withheld results are not findings.
const SUFFICIENT_ONE = "We detect a 3.2σ excess in the outskirts of the galaxy cluster Abell 1689.";
const HOLLOW_TWO = "We plan to improve the tool. Results are not available.";

test("sufficiency is judged by substance, not the coverage label or a bare length", () => {
  assert.equal(ai4sMaterialSufficient(article("full_text", "anything")), true);
  assert.equal(ai4sMaterialSufficient(article("official_abstract", SUFFICIENT)), true, "a concrete result with a method/quantity is scoreable");
  assert.equal(ai4sMaterialSufficient(article("official_abstract", TEASER_LATTICE)), false, "the synthetic short teaser stays unscored");
  assert.equal(ai4sMaterialSufficient(article("official_abstract", TEASER_BLOG)), false, "a blog description is not a research claim");
  assert.equal(ai4sMaterialSufficient(article("official_abstract", THIN_TWO)), false, "two sentences without a result are still insufficient");
  assert.equal(ai4sMaterialSufficient(article("official_abstract", SUFFICIENT_ONE)), true, "one sentence that states a measurement is sufficient");
  assert.equal(ai4sMaterialSufficient(article("official_abstract", HOLLOW_TWO)), false, "a plan plus a withheld result is not a finding, however many sentences");
  assert.equal(ai4sMaterialSufficient(article("metadata_only", "")), false);
});

test("a sufficient official abstract is double-scored, with paid receipts and a 'full text not read' note", async () => {
  requests.length = 0;
  const receipts: number[] = [];
  const scores = await runSelectionScores(article("official_abstract", SUFFICIENT), {}, (id) => receipts.push(id));
  assert.ok(scores, "a sufficient abstract is scored, not barred by its coverage label");
  assert.equal(scores!.values.length, SCORE_CALLS);
  assert.equal(scores!.threshold, 60);
  assert.equal(receipts.length, SCORE_CALLS, "exactly the independent score calls are paid");
  assert.equal(requests.length, SCORE_CALLS);
  assert.ok(requests.every((r) => r.user.includes("未阅读全文")), "every score request states the full text was not read");
});

test("a thin teaser incurs zero paid score calls", async () => {
  requests.length = 0;
  const receipts: number[] = [];
  const scores = await runSelectionScores(article("official_abstract", TEASER_LATTICE), {}, (id) => receipts.push(id));
  assert.equal(scores, null);
  assert.equal(receipts.length, 0, "no receipt is spent on an insufficient intro");
  assert.equal(requests.length, 0, "no provider call is made");
});

test("the score input states the limited range only for non-full-text AI4S material", () => {
  assert.match(buildScoreInput(article("official_abstract", SUFFICIENT)), /未阅读全文/);
  assert.doesNotMatch(buildScoreInput(article("full_text", SUFFICIENT)), /未阅读全文/);
});