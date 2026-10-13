// Offline composition boundary: real compose + edition, only database/provider I/O replaced.
// Run: node --experimental-test-module-mocks --test tests/report-empty-input.test.ts
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("offline empty-input composition regressions", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], { encoding: "utf8", timeout: 30000, env });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /# pass 7\b/, "all offline child regressions actually ran");
  });
} else {

process.env.MODEL_CALLS_ENABLED = "false";
process.env.COLLECT_ENABLED = "false";
process.env.FEISHU_CONTENT_PUSH_ENABLED = "false";
process.env.INDEXNOW_SUBMIT_ENABLED = "false";
let queries: string[] = [];
let writes = 0;
let modelCalls = 0;
let databaseError: Error | undefined;
let periodInputs = false;
const sql = Object.assign((parts: TemplateStringsArray, ..._values: unknown[]) => {
  const query = parts.join("?");
  queries.push(query);
  if (/INSERT|UPDATE|DELETE/.test(query)) { writes++; throw new Error("unexpected write"); }
  if (databaseError && query.includes("FROM publications p JOIN sources")) throw databaseError;
  if (periodInputs && query.includes("key <=")) return [{ key: "2026-10-12", content: { sections: [{ items: [{ itemId: "offline-item" }] }] } }];
  if (periodInputs && query.includes("p.article_id = ANY")) return [{
    id: "offline-item", title: "本地测试", summary: "合成测试摘要", url: "https://example.invalid/item",
    source_id: "offline-source", source_name: "Synthetic", source_kind: "rss", source_tier: "T1", first_party: true,
    category: null, tags: [], score: 90, timeline_at: new Date("2026-10-12T00:00:00Z"),
    fact_id: null, fact_public_id: null, story_id: null, story_public_id: null,
  }];
  return [];
}, {
  begin: async (...args: unknown[]) => (args.at(-1) as (tx: unknown) => unknown)(sql),
  json: (value: unknown) => value,
});
await mock.module("../packages/backend/src/db.ts", { namedExports: { sql } });
await mock.module("../packages/backend/src/providers/llm.ts", { namedExports: {
  chatJson: async () => { modelCalls++; throw new Error("unexpected model call"); },
} });
await mock.module("../packages/backend/src/editorial/models.ts", { namedExports: {
  modelFor: async () => { modelCalls++; throw new Error("unexpected model lookup"); },
} });
await mock.module("../packages/backend/src/providers/receipts.ts", { namedExports: {
  completeReceipt: async () => { throw new Error("unexpected receipt write"); },
} });
await mock.module("../packages/backend/src/jobs/queue.ts", { namedExports: { shutdownSignal: new AbortController() } });
const compose = await import("../packages/backend/src/reports/compose.ts");
beforeEach(() => { queries = []; writes = 0; modelCalls = 0; databaseError = undefined; periodInputs = false; });

test("scheduled empty daily and periods skip without report writes or model admission", async () => {
  const result = await compose.composeDueReports(new Date("2026-10-13T03:00:00Z"));
  assert.deepEqual(result, { generated: [], failed: [] });
  assert.equal(writes, 0);
  assert.equal(modelCalls, 0);
  assert.ok(queries.some((q) => q.includes("p.selected AND NOT p.backfill")), "uses the real daily selection boundary");
  assert.equal(queries.filter((q) => q.includes("key <=")).length, 2, "both periods read their actual daily inputs");
});

for (const [kind, key, run] of [
  ["daily", "2026-10-13", compose.composeDaily],
  ["weekly", "2026-W41", compose.composeWeekly],
  ["monthly", "2026-09", compose.composeMonthly],
] as const) {
  test(`explicit empty ${kind} composition exposes typed issue identity`, async () => {
    await assert.rejects(run(key, "admin correction"), (error: unknown) => {
      assert.ok(error instanceof compose.EmptyReportInputError);
      assert.equal(error.kind, kind);
      assert.equal(error.key, key);
      assert.match(error.message, /no selected items|no daily entries/);
      return true;
    });
    assert.equal(writes, 0);
    assert.equal(modelCalls, 0);
  });
}

test("model lookup failures on nonempty periods are not classified as empty inputs", async () => {
  periodInputs = true;
  const logger = mock.method(console, "error", () => {});
  try {
    await assert.rejects(compose.composeDueReports(new Date("2026-10-13T03:00:00Z")), /reports: weekly:2026-W41, monthly:2026-09 failed/);
    assert.equal(modelCalls, 2);
    assert.equal(writes, 0);
    assert.equal(logger.mock.callCount(), 2);
  } finally { logger.mock.restore(); }
});

for (const message of ["database connection lost", "daily 2026-10-13: no selected items in its window"]) {
  test(`real database error remains failed even with empty-looking message: ${message}`, async () => {
    databaseError = new Error(message);
    const errors: string[] = [];
    const logger = mock.method(console, "error", (line: string) => { errors.push(line); });
    try {
      await assert.rejects(compose.composeDueReports(new Date("2026-10-13T03:00:00Z")), /reports: daily:2026-10-13 failed/);
      assert.equal(errors.length, 1);
      assert.ok(errors[0]!.includes(message));
      assert.equal(modelCalls, 0);
    } finally { logger.mock.restore(); }
  });
}
}
