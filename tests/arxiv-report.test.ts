import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateArxivReport, arxivBaseId, arxivVersion } from "../packages/backend/src/arxiv/report.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/arxiv/report.json", import.meta.url), "utf8"));
const fresh = () => structuredClone(fixture);
function rejects(change: (r: any) => void, field: RegExp) {
  const r = fresh(); change(r); assert.throws(() => validateArxivReport(r), field);
}
test("real public fixture contains 22 papers and survives validation", () => {
  assert.equal(fixture.items.length, 22);
  assert.deepEqual(validateArxivReport(fixture), fixture);
});

test("rejects illegal report, counts, items and paper container types with paths", () => {
  for (const value of [null, [], "report", 1, true]) assert.throws(() => validateArxivReport(value), /report/);
  for (const value of [null, [], "counts"]) rejects(r => r.counts = value, /counts/);
  for (const value of [null, {}, "items"]) rejects(r => r.items = value, /items/);
  for (const value of [null, [], "paper"]) rejects(r => r.items[0] = value, /items\[0\]/);
  rejects(r => r.ranked_selected_ids = {}, /ranked_selected_ids/);
});

test("rejects schema, report type, timezone and mode outside the frozen contract", () => {
  for (const [key, value] of [["schema_version", 2], ["schema_version", "1"], ["report_type", "daily"], ["timezone", "UTC"], ["mode", "weekly"], ["mode", null]] as [string, unknown][]) {
    rejects(r => r[key] = value, new RegExp(String(key)));
  }
});

test("rejects unsafe publication, peer review, analysis, verdict and study states", () => {
  for (const key of ["publication_status", "peer_review_status", "analysis_scope", "verdict", "study_type"]) {
    rejects(r => r.items[0][key] = "published", new RegExp(key));
    rejects(r => r.items[0][key] = null, new RegExp(key));
  }
});

test("enforces required nonnull text and field-specific text limits", () => {
  const reportLimits = { run_id: 256, coverage: 1000, review_status: 256, note_zh: 6000 };
  const paperLimits = { title_original: 1000, title_zh: 1000, summary_zh: 6000, reason_zh: 4000, fulltext_review_question: 4000, evidence_abstract_quote: 12000 };
  for (const [key, max] of Object.entries(reportLimits)) {
    for (const value of [null, {}, [], 7, " ", "x".repeat(max + 1)]) rejects(r => r[key] = value, new RegExp(key));
  }
  for (const [key, max] of Object.entries(paperLimits)) {
    for (const value of [null, {}, [], 7, " ", "x".repeat(max + 1)]) rejects(r => r.items[0][key] = value, new RegExp(key));
  }
});

test("modern versioned ID helpers reject old IDs, invalid months and noncanonical versions", () => {
  for (const id of ["2610.1234v1", "2610.12345v12", "9901.0001v2"]) {
    assert.equal(arxivBaseId(id), id.split("v")[0]);
    assert.equal(arxivVersion(id), Number(id.split("v")[1]));
  }
  for (const id of ["astro-ph/0601001v1", "2610.123v1", "2610.123456v1", "2600.1234v1", "2613.1234v1", "2610.1234v0", "2610.1234v01", "2610.1234v-1", "2610.1234", "2610.1234v1junk", "2610.1234v9007199254740992", " 2610.1234v1", "2610.1234v1\n"]) {
    assert.throws(() => arxivBaseId(id), /arxiv_id/);
    assert.throws(() => arxivVersion(id), /arxiv_id/);
    rejects(r => r.items[0].arxiv_id = id, /arxiv_id/);
  }
  for (const id of [null, 1, {}]) {
    assert.throws(() => arxivBaseId(id as any), /arxiv_id/);
    rejects(r => r.items[0].arxiv_id = id, /arxiv_id/);
  }
});

test("paper_key matches base ID and duplicate base identities are rejected", () => {
  rejects(r => r.items[0].paper_key = "arxiv:wrong", /paper_key/);
  rejects(r => r.items[0].paper_key = null, /paper_key/);
  rejects(r => r.items[1] = structuredClone(r.items[0]), /arxiv_id/);
  rejects(r => {
    r.items[1].arxiv_id = arxivBaseId(r.items[0].arxiv_id) + "v2";
    r.items[1].paper_key = r.items[0].paper_key;
    r.items[1].url = "https://arxiv.org/abs/" + r.items[1].arxiv_id;
  }, /arxiv_id/);
});

test("URL is the exact HTTPS arxiv abs versioned ID without credentials or suffixes", () => {
  for (const url of [null, "http://arxiv.org/abs/2612.99999v1", "https://evil.test/abs/2612.99999v1", "https://arxiv.org@evil.test/abs/2612.99999v1", "https://user:pass@arxiv.org/abs/2612.99999v1", "https://arxiv.org/abs/2612.99999v1?x=1", "https://arxiv.org/abs/2612.99999v1#x", "https://arxiv.org/abs/2612.99999", "https://arxiv.org:443/abs/2612.99999v1", "https://arxiv.org/abs/2612.99999v2", "https://arxiv.org/abs/2612.99999v1/"]) rejects(r => r.items[0].url = url, /url/);
});

test("categories contain an astronomy subtype and authors are bounded string arrays", () => {
  for (const value of [null, {}, "astro-ph.GA", [], [""], [" "], [1], ["astro-ph"], ["hep-th"], ["astro-ph.XX"], ["astro-ph.GA", null], ["astro-ph.GA", "x".repeat(129)]]) rejects(r => r.items[0].categories = value, /categories/);
  for (const value of [null, {}, "author", [null], [1], [" "], ["x".repeat(501)]]) rejects(r => r.items[0].authors = value, /authors/);
  const r = fresh(); r.items[0].authors = []; assert.equal(validateArxivReport(r).items[0].authors.length, 0);
  for (const subtype of ["GA", "CO", "EP", "HE", "SR", "IM"]) {
    const r = fresh(); r.items[0].categories = ["astro-ph." + subtype]; assert.deepEqual(validateArxivReport(r).items[0].categories, r.items[0].categories);
  }
});

test("accepts real leap dates and explicit offsets but rejects normalized impossible dates and missing zones", () => {
  for (const date of [null, "2026-02-29", "2024-02-30", "2026-04-31", "2026-00-01", "2026-13-01", "2026-1-01", "2026-10-04junk", "2026-10-04\n"]) rejects(r => r.issue_date = date, /issue_date/);
  const stampKeys = ["generated_at_utc", "input_collected_at_utc", "submitted_at", "updated_at"];
  for (const key of stampKeys) for (const stamp of [null, "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-01T25:00:00Z", "2026-10-01T00:60:00Z", "2026-10-01T00:00:60Z", "2026-10-01T00:00:00", "2026-10-01", "2026-10-01T00:00:00+24:00", "2026-10-01T00:00:00+08:60", "2026-10-01T00:00:00Zjunk", "2026-10-01T00:00:00Z\n"]) {
    rejects(r => { if (key === "submitted_at" || key === "updated_at") r.items[0][key] = stamp; else r[key] = stamp; }, new RegExp(key));
  }
  const r = fresh(); r.issue_date = "2024-02-29";
  r.generated_at_utc = "2024-02-29T23:59:59.123456789+08:00";
  r.input_collected_at_utc = "2024-02-29T00:00:00-05:30";
  assert.equal(validateArxivReport(r).issue_date, "2024-02-29");
});

test("updated_at cannot precede submitted_at including submillisecond precision and offset equivalence", () => {
  rejects(r => r.items[0].updated_at = "2026-09-30T00:00:00Z", /updated_at/);
  rejects(r => { r.items[0].submitted_at = "2026-10-01T00:00:00.123457Z"; r.items[0].updated_at = "2026-10-01T00:00:00.123456Z"; }, /updated_at/);
  const r = fresh(); r.items[0].submitted_at = "2026-10-01T08:00:00.123+08:00";
  r.items[0].updated_at = "2026-10-01T00:00:00.123000Z";
  assert.doesNotThrow(() => validateArxivReport(r));
});

test("input_sha256 must be exactly 64 lowercase hexadecimal characters", () => {
  for (const value of [null, 1, "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(64) + "\n"]) rejects(r => r.input_sha256 = value, /input_sha256/);
});

test("counts are nonnegative safe integers and reports contain at most 1000 papers", () => {
  for (const key of ["paper_count", "candidate_pool_count"]) for (const value of [null, "22", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) rejects(r => r[key] = value, new RegExp(key));
  for (const key of ["SELECT", "REVIEW", "DEFER"]) for (const value of [null, "5", -1, 1.5, NaN, Infinity]) rejects(r => r.counts[key] = value, /counts/);
  rejects(r => { r.items = Array(1001).fill(r.items[0]); }, /items/);
});

test("rejects 1001 otherwise valid distinct papers before processing them", () => {
  const r = fresh();
  r.items = Array.from({ length: 1001 }, (_, i) => ({ ...structuredClone(fixture.items[0]), arxiv_id: `2610.${String(i).padStart(5, "0")}v1`, paper_key: `arxiv:2610.${String(i).padStart(5, "0")}`, url: `https://arxiv.org/abs/2610.${String(i).padStart(5, "0")}v1`, verdict: "DEFER" }));
  r.paper_count = 1001; r.candidate_pool_count = 1001; r.counts = { SELECT: 0, REVIEW: 0, DEFER: 1001 }; r.ranked_selected_ids = [];
  assert.throws(() => validateArxivReport(r), /items.*1000/);
});

test("paper_count, pool size and every verdict count match the actual papers", () => {
  rejects(r => r.paper_count++, /paper_count/);
  rejects(r => r.candidate_pool_count = r.paper_count - 1, /candidate_pool_count/);
  for (const key of ["SELECT", "REVIEW", "DEFER"]) rejects(r => r.counts[key]++, /counts/);
  rejects(r => { r.counts.SELECT--; r.counts.REVIEW++; }, /counts/);
});

test("ranked_selected_ids uniquely and exactly covers SELECT versioned IDs", () => {
  rejects(r => r.ranked_selected_ids.pop(), /ranked_selected_ids/);
  rejects(r => r.ranked_selected_ids.push(r.ranked_selected_ids[0]), /ranked_selected_ids/);
  rejects(r => r.ranked_selected_ids[0] = r.items.find((p: any) => p.verdict === "DEFER").arxiv_id, /ranked_selected_ids/);
  rejects(r => r.ranked_selected_ids[0] = arxivBaseId(r.ranked_selected_ids[0]), /ranked_selected_ids/);
  for (const id of [null, 7, "", "bad-id"]) rejects(r => r.ranked_selected_ids[0] = id, /ranked_selected_ids/);
  const r = fresh(); r.ranked_selected_ids.reverse(); assert.deepEqual(validateArxivReport(r).ranked_selected_ids, r.ranked_selected_ids);
});

test("rejects sparse arrays rather than silently skipping required entries", () => {
  rejects(r => delete r.items[0], /items/);
  rejects(r => delete r.items[0].authors[0], /authors/);
  rejects(r => delete r.items[0].categories[0], /categories/);
  rejects(r => delete r.ranked_selected_ids[0], /ranked_selected_ids/);
});

test("zero-paper pilot and daily batches are valid", () => {
  for (const mode of ["pilot", "daily"]) {
    const r = fresh(); r.mode = mode; r.items = []; r.paper_count = 0;
    r.candidate_pool_count = 0; r.counts = { SELECT: 0, REVIEW: 0, DEFER: 0 }; r.ranked_selected_ids = [];
    assert.deepEqual(validateArxivReport(r), r);
    r.candidate_pool_count = 60; assert.equal(validateArxivReport(r).paper_count, 0);
  }
});
test("explicit allowlist drops unknown keys, __proto__ and constructor at every object level", () => {
  const r = fresh();
  for (const object of [r, r.counts, ...r.items]) {
    Object.defineProperty(object, "__proto__", { value: { polluted: true }, enumerable: true });
    object.constructor = { polluted: true }; object.untrusted_extra = { nested: "secret" };
  }
  for (const a of [r.items, r.ranked_selected_ids, ...r.items.flatMap((p: any) => [p.authors, p.categories])]) a.extra = "secret";
  const result = validateArxivReport(r);
  assert.deepEqual(result, fixture);
  for (const object of [result, result.counts, ...result.items]) {
    assert.equal(Object.hasOwn(object, "__proto__"), false);
    assert.equal(Object.hasOwn(object, "constructor"), false);
    assert.equal(Object.hasOwn(object, "untrusted_extra"), false);
    assert.equal(Object.getPrototypeOf(object), Object.prototype);
  }
  assert.equal(({} as any).polluted, undefined);
});
test("result owns every nested object and array and mutating it cannot alter the input", () => {
  const r = fresh(); const out = validateArxivReport(r);
  assert.notEqual(out, r); assert.notEqual(out.counts, r.counts);
  assert.notEqual(out.items, r.items); assert.notEqual(out.ranked_selected_ids, r.ranked_selected_ids);
  out.items.forEach((p, i) => { assert.notEqual(p, r.items[i]); assert.notEqual(p.authors, r.items[i].authors); assert.notEqual(p.categories, r.items[i].categories); });
  out.items[0].authors.push("new author"); out.items[0].categories.push("hep-th");
  out.items[0].title_zh = "changed"; out.counts.SELECT = 0; out.ranked_selected_ids.reverse();
  assert.deepEqual(r, fixture);
});
test("custom object prototypes are rejected instead of inherited as required fields", () => {
  assert.throws(() => validateArxivReport(Object.create(fixture)), /report/);
  rejects(r => r.items[0] = Object.create(r.items[0]), /items/);
  rejects(r => r.counts = Object.create(r.counts), /counts/);
});
test("all required fields reject null or missing values with their field name", () => {
  for (const key of Object.keys(fixture)) {
    rejects(r => r[key] = null, new RegExp(key));
    rejects(r => delete r[key], new RegExp(key));
  }
  for (const key of Object.keys(fixture.items[0])) {
    rejects(r => r.items[0][key] = null, new RegExp(key));
    rejects(r => delete r.items[0][key], new RegExp(key));
  }
  for (const key of ["SELECT", "REVIEW", "DEFER"]) rejects(r => delete r.counts[key], /counts/);
});

test("unknown array methods and iterators cannot inject fields or change copied values", () => {
  const r = fresh();
  r.items.map = () => [{ __proto__: { polluted: true }, injected: true }];
  r.items[0].authors[Symbol.iterator] = function* () { yield "injected"; };
  r.ranked_selected_ids[Symbol.iterator] = function* () { yield "injected"; };
  assert.deepEqual(validateArxivReport(r), fixture);
});

test("required fields must be own data properties; accessors are never invoked", () => {
  const r = fresh(); const original = Object.getOwnPropertyDescriptor(Object.prototype, "schema_version");
  try {
    Object.defineProperty(Object.prototype, "schema_version", { value: 1, configurable: true });
    delete r.schema_version;
    assert.throws(() => validateArxivReport(r), /schema_version/);
  } finally {
    if (original) Object.defineProperty(Object.prototype, "schema_version", original);
    else delete (Object.prototype as any).schema_version;
  }
  let called = false;
  for (const [target, key, path] of [["report", "run_id", /run_id/], ["paper", "title_zh", /title_zh/], ["counts", "SELECT", /counts.SELECT/]]) {
    const r = fresh(); const obj = target === "report" ? r : target === "paper" ? r.items[0] : r.counts;
    Object.defineProperty(obj, key as string, { get() { called = true; throw new Error("getter invoked"); }, configurable: true });
    assert.throws(() => validateArxivReport(r), path as RegExp);
    assert.equal(called, false);
  }
  const a = fresh(); Object.defineProperty(a.items[0].authors, "0", { get() { called = true; return "author"; } });
  assert.throws(() => validateArxivReport(a), /authors/); assert.equal(called, false);
});
