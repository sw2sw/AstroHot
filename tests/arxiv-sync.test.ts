// Fetch/store are MOCK adapters; no external requests or database connections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncArxivReport, validateReportUrl, MAX_REPORT_BYTES } from "../packages/backend/src/arxiv/sync.ts";
test("report URL must be credential-free HTTP(S) without a fragment, and honours the optional host pin", () => {
 // With ARXIV_REPORT_HOST set, only that host is accepted; no host is hard-coded in the source.
 assert.equal(validateReportUrl("https://reports.example.org/report.json", "reports.example.org").hostname, "reports.example.org");
 for (const u of ["http://localhost/r", "https://arxiv.org/r", "https://user@reports.example.org/r", "https://reports.example.org/r#x", "file:///r"]) assert.throws(() => validateReportUrl(u, "reports.example.org"));
 // Without a pin the structural rules still apply: credentials, fragments and non-HTTP schemes are rejected.
 assert.equal(validateReportUrl("https://reports.example.org/r").hostname, "reports.example.org");
 for (const u of ["https://user:pass@reports.example.org/r", "https://reports.example.org/r#x", "file:///r", "not a url"]) assert.throws(() => validateReportUrl(u));
});
test("mock fetch: zero-paper result reaches store; redirect policy and timeout supplied", async () => {
 let stored: unknown;
 const result = await syncArxivReport("https://reports.example.org/r", {
 fetch: async (_u, init) => { assert.equal(init?.redirect, "error"); assert.ok(init?.signal); return Response.json({ items: [], paper_count: 0 }); },
 store: async x => { stored = x; return { status: "imported", runId: "zero" }; }
 });
 assert.equal(result.runId, "zero"); assert.deepEqual(stored, { items: [], paper_count: 0 });
});
test("mock fetch: failure, oversized and redirects preserve old store", async () => {
 for (const response of [new Response("err", { status: 500 }), new Response("", { status: 302 }), new Response("{}", { headers: { "content-length": String(MAX_REPORT_BYTES + 1) } }), new Response("x".repeat(MAX_REPORT_BYTES + 1)), new Response("not json")]) {
 let writes = 0;
 await assert.rejects(syncArxivReport("https://reports.example.org/r", { fetch: async () => response, store: async () => { writes++; return { status: "imported", runId: "bad" }; } }));
 assert.equal(writes, 0);
 }
});
