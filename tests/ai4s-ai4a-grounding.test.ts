// R9 (round 3): AI4A is a structural consistency gate, not a substring match and not a claim of
// scientific verification. The claim stands only when the assigned discipline, the named referent and the
// verbatim quote agree: a pure physics result, a laboratory measurement whose only astronomy-looking word
// is a method ("spectra"), a quote that names astronomy only as a background foil, or a referent the model
// never quotes, must all leave the finding null. These exercise the real normalizer on crafted model
// outputs — no paid call, no preset Chinese answer standing in for the judgment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAi4sStructure, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";

const article = (bodyText: string): AnalyzeInputArticle => ({
  id: "ai4a-grounding", revision: 1, title: "A research result", url: "https://example.org/paper",
  author: null, publishedAt: new Date("2026-11-01T00:00:00Z"), bodyStatus: "ok", bodyText, excerpt: null,
  media: [], xPost: null, coverage: "full_text", contentScope: "ai4s",
  source: { name: "Fixture", kind: "rss", tier: "T2", firstParty: false },
});
const finding = (
  bodyText: string,
  applies: boolean | null,
  evidence: string | null,
  domain = "physics",
  referent: string | null = null,
) => normalizeAi4sStructure({ scope: "single", domain: domain as never, astroApplication: { applies, evidence, referent }, fact: null }, article(bodyText)).ai4a;

test("a direct astronomy application with a grounded quote and referent is verified AI4A", () => {
  const body = "AI classified 12 million galaxy spectra in the survey.";
  assert.equal(finding(body, true, "AI classified 12 million galaxy spectra in the survey.", "astronomy-astrophysics", "galaxy spectra"), true);
});

test("a verbatim physics quote that does not support an astronomy application stays null", () => {
  const body = "We present a candidate nonperturbative lattice definition of the Standard Model.";
  // The quote really is in the material, and the model claims applies=true with domain=physics — yet it
  // says nothing about astronomy, so grounding alone must not turn it into a verified AI4A finding.
  assert.equal(finding(body, true, "a candidate nonperturbative lattice definition of the Standard Model", "physics", null), null);
});

test("a laboratory measurement is not an astronomy application because of a method word", () => {
  // The round-2 review's case: "spectra" and "spectral" describe laboratory work just as well, so a
  // protein-spectroscopy result cannot earn AI4A — in either discipline, and with either referent.
  const body = "AI classified protein spectra in the laboratory. The pipeline predicts spectral classes from raw traces.";
  assert.equal(finding(body, true, "AI classified protein spectra in the laboratory.", "life-sciences", "protein spectra"), null);
  assert.equal(finding(body, true, "AI classified protein spectra in the laboratory.", "astronomy-astrophysics", "protein spectra"), null,
    "a mislabelled domain does not survive: the referent itself is not an astronomy object");
  assert.equal(finding(body, true, "The pipeline predicts spectral classes from raw traces.", "methods-tools", "raw traces"), null,
    "a method word and a non-astronomy referent keep the finding unknown");
});

test("astronomy named only as a background foil is not an application", () => {
  const body = "Unlike astronomical sky surveys, our model predicts protein folding.";
  assert.equal(finding(body, true, "Unlike astronomical sky surveys, our model predicts protein folding.", "life-sciences", "astronomical sky surveys"), null);
  const zh = "不同于天文巡天，我们的模型预测蛋白质折叠。";
  assert.equal(finding(zh, true, "不同于天文巡天，我们的模型预测蛋白质折叠。", "life-sciences", "巡天"), null);
});

test("a contrast about method does not erase a real astronomy application", () => {
  const body = "Unlike previous methods, we classified galaxy spectra with a neural network.";
  assert.equal(finding(body, true, "Unlike previous methods, we classified galaxy spectra with a neural network.", "astronomy-astrophysics", "galaxy spectra"), true);
});

test("the discipline must be consistent with the astronomy claim", () => {
  const body = "AI classified 12 million galaxy spectra in the survey.";
  const quote = "AI classified 12 million galaxy spectra in the survey.";
  assert.equal(finding(body, true, quote, "life-sciences", "galaxy spectra"), null, "a life-sciences paper cannot be a verified astronomy application");
  assert.equal(finding(body, true, quote, "chemistry", "galaxy spectra"), null);
  assert.equal(finding(body, true, quote, null as never, "galaxy spectra"), null, "an unstated discipline cannot support the claim");
  assert.equal(finding(body, true, quote, "methods-tools", "galaxy spectra"), true, "a general method applied to astronomy data still qualifies");
});

test("a referent the model never quotes keeps the finding unknown", () => {
  const body = "AI classified 12 million galaxy spectra in the survey.";
  assert.equal(finding(body, true, "AI classified 12 million galaxy spectra in the survey.", "astronomy-astrophysics", "exoplanet atmospheres"), null,
    "the named referent must appear in its own evidence");
  assert.equal(finding(body, true, "AI classified 12 million galaxy spectra in the survey.", "astronomy-astrophysics", null), null,
    "no named object means no verified application");
});

test("an invented quote and an explicit non-application keep their existing meanings", () => {
  assert.equal(finding("Some unrelated text about proteins.", true, "AI classified galaxy spectra.", "astronomy-astrophysics", "galaxy spectra"), null, "not verbatim → unknown");
  assert.equal(finding("We study protein folding with AI.", false, null, "life-sciences", null), false, "applies=false stays false");
  assert.equal(finding("We study protein folding with AI.", null, null, "life-sciences", null), null, "applies=null stays null");
});
