// The AI4S auto-selection policy enables the column's existing threshold
// rule. The thresholds themselves are unchanged (industry/selection.ts). The regression below uses
// the real normalizer and fixture analyses, with no database, provider or network access.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAnalysis, type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { SELECTION } from "@aihot/industry/selection";

const run = (scores: number[] | null): AnalysisRun => ({
  prefilter: { label: "PASS", reason: "fixture", model: "fixture", receiptId: 1, reused: true },
  scores: scores === null ? null : { model: "fixture", threshold: SELECTION.thresholds.T1, values: scores, receiptIds: [], reused: true },
  writing: { kind: "understand", model: "fixture", titleZh: "标题", summaryZh: "完整原文摘要。", reasonZh: "fixture", receiptIds: [], reused: true },
  structure: { model: "fixture", receiptId: 1, reused: true, category: null, tags: [], subjects: [], scope: "single", fact: null, domain: "physics", ai4a: null },
});

test("AI4S auto-selection is enabled with the existing tier thresholds", () => {
  assert.equal(SELECTION.ai4sAutoSelection, true);
  assert.deepEqual(SELECTION.thresholds, { T1: 60, T1_5: 65, T2: 70 });
});

test("an AI4S analysis at its tier threshold is auto-selected", () => {
  const out = normalizeAnalysis(run([60, 60]), "ai4s");
  assert.equal(out.selected, true);
  assert.equal(out.score, 60);
  assert.equal(out.threshold, 60);
});

test("a weak official abstract with no score is not selected", () => {
  const out = normalizeAnalysis(run(null), "ai4s");
  assert.equal(out.selected, false);
  assert.equal(out.score, null);
});

test("an AI4S analysis below its tier threshold is not selected", () => {
  assert.equal(normalizeAnalysis(run([59, 59]), "ai4s").selected, false);
});

test("the AI4S-off branch remains intact when auto-selection is explicitly off", () => {
  // The real branch reads SELECTION.ai4sAutoSelection at normalization time; flip it off and restore it.
  const mutable = SELECTION as { ai4sAutoSelection: boolean };
  const original = mutable.ai4sAutoSelection;
  mutable.ai4sAutoSelection = false;
  try {
    assert.equal(normalizeAnalysis(run([60, 60]), "ai4s").selected, false, "the same threshold-passing run is not selected while the switch is off");
  } finally {
    mutable.ai4sAutoSelection = original;
  }
  assert.equal(normalizeAnalysis(run([60, 60]), "ai4s").selected, true, "restoring the switch restores selection");
});
