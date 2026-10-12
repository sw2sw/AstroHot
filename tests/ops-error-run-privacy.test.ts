// Targeted regression: a job failure must not leave its credentials anywhere a caller persists or
// reads the run error back from. recordRun redacts the row (job_runs.error), the ops event
// (ops_error_events), AND the error it throws onward — because the worker serialises that thrown
// error into pg-boss's own job output, which the admin runs view reads back. This test drives a
// real queue so the pg-boss output is exercised, then checks every surface the text can reach:
// job_runs, ops_error_events, the thrown error, the admin runs view, and the report the read-only
// CLI renders (the CLI binary itself is also run out-of-process by the acceptance harness, which
// this environment forbids spawning from inside the runner). The original failure category and the
// non-secret diagnostic must survive the redaction.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { ensureQueue, getBoss, recordRun, stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { runsOverview } from "../packages/backend/src/admin/runs.ts";
import { queryOpsErrors, renderOpsErrorReport } from "../packages/backend/src/operations/error-report.ts";

const SECRET = {
  dsn: "postgres://appuser:s3cr3tP@203.0.113.5:5432/aihot_prod",
  token: "TOK_live_ABCDEF1234567890",
  password: "Hunter2xyz!",
};
// Every substring that must never appear in a persisted or printed surface.
const LEAVES = [SECRET.dsn, SECRET.token, SECRET.password, "s3cr3tP", "appuser", "Hunter2xyz"];
const DIAGNOSTIC = "upstream fetch failed for source=arxiv mode=bulk";

function throwingHandler() {
  return async () => {
    const error = new Error(`${DIAGNOSTIC} via ${SECRET.dsn}?api_key=${SECRET.token}&password=${SECRET.password}`);
    error.name = "UpstreamError";
    throw error;
  };
}

function assertRedacted(text: string | null | undefined, where: string) {
  const s = String(text ?? "");
  for (const leaf of LEAVES) assert.ok(!s.includes(leaf), `${where} leaked a credential (${leaf})`);
}

after(async () => {
  await stopBoss().catch(() => {});
  await closeDb();
});

test("a failed run leaves no credential in job_runs, ops records, or the error it throws", async () => {
  let thrown: unknown = null;
  await assert.rejects(recordRun("privacy.probe", throwingHandler()), (error) => {
    thrown = error;
    return true;
  });

  const runRow = (await sql`SELECT id, status, error FROM job_runs WHERE job = 'privacy.probe' ORDER BY id DESC LIMIT 1`)[0]!;
  // Failure category is unchanged: the run is failed, not silently "ok".
  assert.equal(runRow.status, "failed");
  assertRedacted(runRow.error, "job_runs.error");
  // Necessary diagnostics survive the redaction.
  assert.ok(String(runRow.error).includes(DIAGNOSTIC), "the failure diagnostic must be kept");

  const opsRow = (
    await sql`SELECT code, sanitized_message FROM ops_error_events WHERE observation_key = ${`job_run:${runRow.id}`}`
  )[0]!;
  assert.equal(opsRow.code, "task_failed");
  assertRedacted(opsRow.sanitized_message, "ops_error_events.sanitized_message");
  assert.ok(String(opsRow.sanitized_message).includes(DIAGNOSTIC), "the ops diagnostic must be kept");

  // The error handed to the caller carries no credential either — it is the same text pg-boss stores.
  assertRedacted(thrown instanceof Error ? thrown.message : String(thrown), "thrown error message");
  assert.ok(thrown instanceof Error && thrown.message.includes(DIAGNOSTIC), "the thrown diagnostic must be kept");
});

test("the admin runs view exposes no credential from a failed run", async () => {
  await assert.rejects(recordRun("privacy.admin", throwingHandler()));
  // The runs view reads pgboss.job, whose schema pg-boss creates on first start.
  await getBoss();
  const overview = await runsOverview();
  const probeTimeline = JSON.stringify(overview.timeline.filter((row) => String(row.job).startsWith("privacy.")));
  assertRedacted(probeTimeline, "admin runs timeline");
  assert.ok(probeTimeline.includes(DIAGNOSTIC), "the admin view keeps the diagnostic");
});

test("a real pg-boss job output carries no credential, and the rendered report prints none", async () => {
  const boss = await getBoss();
  await ensureQueue("privacy.probe", { policy: "standard", retryLimit: 0, expireInSeconds: 60 });
  await boss.work("privacy.probe", { pollingIntervalSeconds: 0.5 }, async () =>
    recordRun("privacy.pgboss", throwingHandler()),
  );
  await boss.send("privacy.probe", {});

  let jobRow: { state: string; output: unknown } | undefined;
  for (let i = 0; i < 60; i++) {
    const rows = await sql<{ state: string; output: unknown }[]>`
      SELECT state, output FROM pgboss.job WHERE name = 'privacy.probe' ORDER BY created_on DESC LIMIT 1`;
    if (rows[0] && (rows[0].state === "failed" || rows[0].state === "completed")) {
      jobRow = rows[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(jobRow?.state, "failed", "the job must reach a terminal failed state");
  const outputText = JSON.stringify(jobRow?.output ?? null);
  assertRedacted(outputText, "pgboss.job.output");
  assert.ok(outputText.includes(DIAGNOSTIC), "the pg-boss output keeps the diagnostic");

  // The exact text the read-only CLI prints (its binary is run out-of-process by the harness).
  const since = new Date(Date.now() - 3600_000).toISOString();
  const until = new Date(Date.now() + 3600_000).toISOString();
  const report = await queryOpsErrors({ since, until, stage: null, limit: 100, offset: 0 });
  const rendered = renderOpsErrorReport(report);
  assertRedacted(rendered, "rendered ops report");
  assert.ok(rendered.includes(DIAGNOSTIC), "the rendered report keeps the diagnostic");
});

// A `cause` is not always an Error: a driver or provider can hang a plain string off it, and a
// string is exactly the shape a DSN arrives in. Redaction must replace the member in place — not
// merely compute a redacted copy and drop it, which would leave the original string on the error.
test("a string cause is redacted in place, not left beside the error", async () => {
  let thrown: unknown = null;
  await assert.rejects(
    recordRun("privacy.cause", async () => {
      throw new Error(`${DIAGNOSTIC} outer`, { cause: `retry against ${SECRET.dsn}` });
    }),
    (error) => {
      thrown = error;
      return true;
    },
  );

  const cause = (thrown as { cause?: unknown } | null)?.cause;
  assert.equal(typeof cause, "string", "the string cause must stay a string");
  assertRedacted(cause as string, "string cause");
  assert.ok((cause as string).includes("retry against"), "the cause keeps its non-secret text");

  const runRow = (await sql`SELECT error FROM job_runs WHERE job = 'privacy.cause' ORDER BY id DESC LIMIT 1`)[0]!;
  assertRedacted(runRow.error, "job_runs.error (string cause)");
});

// AggregateError members can be plain strings too. Redaction must rewrite each member in place;
// returning a redacted copy without assigning it back leaves the original string in the array,
// which is what a serialiser then writes out.
test("a string member inside an AggregateError is redacted in place", async () => {
  let thrown: unknown = null;
  await assert.rejects(
    recordRun("privacy.agg", async () => {
      throw new AggregateError(
        [new Error(`${DIAGNOSTIC} primary`), `fallback via ${SECRET.dsn}`],
        `${DIAGNOSTIC} aggregate`,
      );
    }),
    (error) => {
      thrown = error;
      return true;
    },
  );

  const members = (thrown as AggregateError | null)?.errors ?? [];
  const asText = JSON.stringify(
    Array.from(members).map((member) => (typeof member === "string" ? member : String(member))),
  );
  assertRedacted(asText, "AggregateError string member");
  assert.ok(asText.includes("fallback via"), "the member keeps its non-secret text");

  const runRow = (await sql`SELECT error FROM job_runs WHERE job = 'privacy.agg' ORDER BY id DESC LIMIT 1`)[0]!;
  assertRedacted(runRow.error, "job_runs.error (aggregate member)");
});
