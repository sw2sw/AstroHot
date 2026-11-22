import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validateAi4sPass } from "../packages/backend/src/editorial/ai4s-relevance.ts";
import { relevanceCases } from "./fixtures/ai4s/relevance.ts";

for (const c of relevanceCases) test(c.title, () => {
  assert.equal(validateAi4sPass(c.evidence, c.body), c.expected);
});
const good = relevanceCases[0];
test("missing, malformed and fabricated evidence cannot authorize AI4S", () => {
  for (const e of [undefined, null, {}, { ...good.evidence, quote: "Invented neural solver result" },
    { ...good.evidence, aiMethod: "nonexistent method" }, { ...good.evidence, researchTask: "nonexistent task" }]) {
    assert.equal(validateAi4sPass(e, good.body), "UNKNOWN");
  }
});
test("composite is held even if the model claims the title aligns", () => {
  assert.equal(validateAi4sPass({ ...good.evidence, scope: "composite" }, good.body), "UNKNOWN");
  assert.equal(validateAi4sPass({ ...good.evidence, scope: "composite", titleAligned: false }, good.body), "UNKNOWN");
});
test("whitespace normalization is not a keyword classifier", () => {
  assert.equal(validateAi4sPass(good.evidence, good.body.replaceAll(" ", "\n ")), "PASS");
});
test("both prefilters use identical AI4S editorial criteria", () => {
  const prompt = (name: string) => readFileSync(new URL(`../industry/prompts/${name}.md`, import.meta.url), "utf8");
  const criteria = (s: string, start: number) => s.slice(s.indexOf("PASS：", start), s.indexOf("\n\n", s.indexOf("PASS：", start)));
  const shared = prompt("shared-prefilter");
  assert.equal(criteria(shared, shared.indexOf("【ai4s】")), criteria(prompt("ai4s-prefilter"), 0));
});
