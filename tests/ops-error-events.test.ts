// Acceptance for the operational-error recorder and its read-only query: idempotent appends over
// per-execution observation identities, redaction of the secret formats real provider errors use,
// private evidence with enforced permissions and safe concurrency, recording gaps that stay visible,
// parent de-duplication, window-consistent aggregation, and honest paging. Everything runs on the
// per-file database copy and the scratch data directory the runner hands out, with no real source or
// provider call.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { config } from "../packages/backend/src/config.ts";
import { sql, type Db } from "../packages/backend/src/db.ts";
import { recordOpsError, sanitizeOpsMessage, withRecordingFailure } from "../packages/backend/src/operations/error-events.ts";
import { queryOpsErrors, renderOpsErrorReport } from "../packages/backend/src/operations/error-report.ts";

const evidenceDir = path.join(config.dataDir, "ops", "error-evidence");
const reset = async () => {
  await sql`TRUNCATE ops_error_events RESTART IDENTITY`;
};
const countEvents = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ops_error_events`)[0]!.n;
const IS_WINDOWS = process.platform === "win32";
/**
 * A directory link built with whatever the platform really offers: a POSIX symlink elsewhere, and a
 * Windows junction here. A junction IS a reparse point that lstat reports as a link and that a write
 * really follows into the target — exactly the hazard the recorder must refuse — and unlike a Windows
 * directory symlink it needs no elevated privilege, so the ancestor check is exercised on both
 * platforms instead of being skipped on the one this project is developed on.
 */
const linkDirectory = async (target: string, link: string) => {
  const { symlink } = await import("node:fs/promises");
  await symlink(target, link, IS_WINDOWS ? "junction" : "dir");
};

/** Captures console.error for one async body: what the recorder prints when the floor is reached. */
async function captureStderr(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines;
}

test("operational error recording acceptance", async (t) => {
  await t.test("the same real observation is one row and two real attempts are two", async () => {
    await reset();
    const input = { stage: "arxiv.collect", code: "rss_parse_failed", message: "feed unreadable", observationKey: "obs-1", targetId: "rss.arxiv.org" };
    const first = await recordOpsError(input);
    assert.equal(first.recorded, true);
    assert.notEqual(first.id, null);
    // A restart or a redelivery sees the same observation again: it must not add a row.
    const repeated = await recordOpsError(input);
    assert.deepEqual(repeated, { recorded: true, id: null, evidenceRef: null });
    const second = await recordOpsError({ ...input, observationKey: "obs-2" });
    assert.equal(second.recorded, true);
    assert.notEqual(second.id, null);
    assert.equal(await countEvents(), 2);
    const [group] = await sql<{ n: number; target: string | null }[]>`
      SELECT count(*)::int AS n, min(target_id) AS target FROM ops_error_events
      WHERE group_key = 'arxiv.collect:rss_parse_failed:rss.arxiv.org'`;
    assert.equal(group!.n, 2); // occurrences are counted from rows, never from how often someone looked
    assert.equal(group!.target, "rss.arxiv.org");
    // Identifiers are constrained to a safe charset: a hostile message cannot become query syntax.
    const hostile = await recordOpsError({
      stage: "job", code: "task_failed", message: "x", observationKey: "job:1'); DROP TABLE ops_error_events;--",
    });
    assert.equal(hostile.recorded, true);
    const [safe] = await sql<{ observation_key: string }[]>`
      SELECT observation_key FROM ops_error_events WHERE observation_key LIKE 'job:%'`;
    assert.doesNotMatch(safe!.observation_key, /[';)/]/);
  });

  await t.test("credentials of every real format — bare, JSON-quoted, cookie lists, URL params — never reach the row", async () => {
    await reset();
    const raw = [
      "fetch failed https://user:s3cr3t@example.test/feed?x=1",
      "Authorization: Bearer abc123def456",
      "Cookie: session=deadbeef01; csrf=deadbeef02; sid=deadbeef03",
      '{"api_key":"jsonsecret123","model":"qwen","other":"keepme"}',
      "https://example.test/callback?token=urltok999&state=ok",
      "DSN postgres://aihot:pgpass@127.0.0.1:5432/aihot",
      String.raw`path C:\Users\user\apps\worker.ts and /home/user/apps/x.ts`,
    ].join("; ");
    await recordOpsError({ stage: "job", code: "task_failed", message: raw, observationKey: "redact-1" });
    const [row] = await sql<{ sanitized_message: string }[]>`
      SELECT sanitized_message FROM ops_error_events WHERE observation_key = 'redact-1'`;
    const stored = row!.sanitized_message;
    for (const secret of [
      "s3cr3t", "abc123def456", "deadbeef01", "deadbeef02", "deadbeef03",
      "jsonsecret123", "urltok999", "pgpass", "user\\apps", "home/user",
    ]) {
      assert.equal(stored.includes(secret), false, `leaked ${secret}`);
    }
    // The shape of the failure survives, so an operator can still recognise it.
    assert.match(stored, /example\.test/);
    assert.match(stored, /"model":"qwen"/);
    assert.match(stored, /other":"keepme/);
    assert.match(stored, /state=ok/);
    assert.match(stored, /\[redacted\]/);
    // The rendered reports inherit the same protection.
    const now = new Date();
    const report = await queryOpsErrors({
      since: new Date(now.getTime() - 3600_000).toISOString(), until: new Date(now.getTime() + 60_000).toISOString(), limit: 10, offset: 0,
    });
    const rendered = renderOpsErrorReport(report);
    for (const secret of ["deadbeef01", "jsonsecret123", "urltok999"]) {
      assert.equal(rendered.includes(secret), false, `report leaked ${secret}`);
    }
    // A bare word is not a secret.
    assert.equal(sanitizeOpsMessage("Bearer"), "Bearer");
  });

  await t.test("a failed response is kept offline under its own hash, and repeats reuse the file", async () => {
    await reset();
    const body = "<rss version=\"2.0\"><channel><item>truncated";
    const sha = createHash("sha256").update(body, "utf8").digest("hex");
    const recorded = await recordOpsError({
      stage: "arxiv.collect",
      code: "announcement_conflict",
      message: "Official announcement evidence conflict",
      observationKey: "evidence-1",
      targetId: "rss.arxiv.org",
      details: { cacheDay: "2026-10-09" },
      evidence: { content: body, source: { host: "rss.arxiv.org", path: "/rss/astro-ph", httpStatus: 200 } },
    });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.evidenceRef, `ops/error-evidence/${sha}.txt`);
    assert.equal(await readFile(path.join(config.dataDir, recorded.evidenceRef!), "utf8"), body);
    const [row] = await sql<{ evidence_sha256: string; evidence_truncated: boolean; details: Record<string, unknown> }[]>`
      SELECT evidence_sha256, evidence_truncated, details FROM ops_error_events WHERE observation_key = 'evidence-1'`;
    assert.equal(row!.evidence_sha256, sha);
    assert.equal(row!.evidence_truncated, false);
    assert.equal(row!.details.cacheDay, "2026-10-09");
    // Identical content is one file: recording it under a second observation adds no new document.
    const before = readdirSync(evidenceDir).length;
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "same body", observationKey: "evidence-2",
      evidence: { content: body },
    });
    assert.equal(readdirSync(evidenceDir).length, before);
    // A copy the caller had to truncate is never presented as the complete document.
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "cut", observationKey: "evidence-3",
      evidence: { content: body, truncated: true },
    });
    const [cut] = await sql<{ evidence_truncated: boolean }[]>`
      SELECT evidence_truncated FROM ops_error_events WHERE observation_key = 'evidence-3'`;
    assert.equal(cut!.evidence_truncated, true);
    // details is a real allow-list: unknown object shapes do not pass through.
    await recordOpsError({
      stage: "job", code: "task_failed", message: "d", observationKey: "details-1",
      details: { ok: "fine", count: 3, flag: true, nested: { evil: "structure" }, evilKey: "dropped-key" },
    });
    const [details] = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE observation_key = 'details-1'`;
    assert.deepEqual(details!.details, { ok: "fine", count: 3, flag: true, nested: "[omitted]", evilKey: "dropped-key" });
    // A key that NAMES a secret redacts its VALUE whole — the text sanitizer cannot see a bare
    // value without its key= context, so the structured path must not rely on it.
    await recordOpsError({
      stage: "job", code: "task_failed", message: "e", observationKey: "details-2",
      details: { api_key: "bare-secret-777", token: "bare-token-888", password: "hunter2",
        association: "exact_receipt", count: 3 },
    });
    const [secreted] = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE observation_key = 'details-2'`;
    assert.deepEqual(secreted!.details, {
      api_key: "[redacted]", token: "[redacted]", password: "[redacted]",
      association: "exact_receipt", count: 3,
    });
    // The evidence source travels with the evidence as bounded safe fields — never dropped.
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "s", observationKey: "source-1",
      details: { cacheDay: "2026-10-09" },
      evidence: { content: "<feed>source-meta</feed>",
        source: { host: "export.arxiv.org", path: "/api/query?token=leak-me", httpStatus: 429, durationMs: 123.4 } },
    });
    const [sourced] = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE observation_key = 'source-1'`;
    assert.equal(sourced!.details.evidenceHost, "export.arxiv.org");
    assert.equal(sourced!.details.evidencePath, "/api/query"); // query string never enters the row
    assert.equal(sourced!.details.evidenceStatus, 429);
    assert.equal(sourced!.details.evidenceDurationMs, 123);
    assert.equal(JSON.stringify(sourced!.details).includes("leak-me"), false);
  });

  await t.test("pre-existing wide-permission targets are corrected, unusable ones refused, and concurrent same-content writes stay atomic", async () => {
    await reset();
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) {
      // A pre-created 0755 evidence directory is corrected before anything private lands in it. The
      // mode is set with chmod on the directory that already exists — a NON-recursive mkdir here
      // would just raise EEXIST and prove nothing about the correction path.
      chmodSync(evidenceDir, 0o755);
      const body = "<feed>wide-dir</feed>";
      const rec = await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: "w", observationKey: "perm-1", evidence: { content: body },
      });
      assert.equal(rec.recorded, true);
      const { stat } = await import("node:fs/promises");
      const dirMode = (await stat(evidenceDir)).mode & 0o777;
      assert.equal(dirMode & 0o077, 0, `evidence directory left wide: ${dirMode.toString(8)}`);
      // A wide-permission existing file is corrected too.
      chmodSync(path.join(config.dataDir, rec.evidenceRef!), 0o644);
      await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: "w2", observationKey: "perm-2", evidence: { content: body },
      });
      const fileMode = (await stat(path.join(config.dataDir, rec.evidenceRef!))).mode & 0o777;
      assert.equal(fileMode & 0o077, 0, `evidence file left wide: ${fileMode.toString(8)}`);
    }
    // A hash-named file with DIFFERENT content is corruption: the recorder refuses it and the gap is
    // stated on stderr, instead of silently overwriting the evidence.
    const corrupted = "<feed>corrupted-content</feed>";
    const corruptedSha = createHash("sha256").update(corrupted, "utf8").digest("hex");
    writeFileSync(path.join(evidenceDir, `${corruptedSha}.txt`), "not the document");
    const lines = await captureStderr(async () => {
      const refused = await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: "w3", observationKey: "perm-3", evidence: { content: corrupted },
      });
      assert.equal(refused.recorded, false);
    });
    assert.equal(await readFile(path.join(evidenceDir, `${corruptedSha}.txt`), "utf8"), "not the document");
    // perm-1 and perm-2 inserted rows (POSIX branch); perm-3 added NOTHING: the corrupted target
    // was refused and the gap stated, so the count is exactly the two real recordings.
    assert.equal(await countEvents(), IS_WINDOWS ? 0 : 2);
    assert.match(lines.join("\n"), /ops_error_recording_failed/);
    // Same content written CONCURRENTLY: both succeed, one file, complete bytes.
    const concurrent = "<feed>concurrent</feed>";
    const results = await Promise.all(["cc-1", "cc-2", "cc-3"].map((key) =>
      recordOpsError({ stage: "arxiv.collect", code: "rss_parse_failed", message: "cc", observationKey: key, evidence: { content: concurrent } })));
    for (const result of results) assert.equal(result.recorded, true);
    const concurrentSha = createHash("sha256").update(concurrent, "utf8").digest("hex");
    assert.equal(await readFile(path.join(evidenceDir, `${concurrentSha}.txt`), "utf8"), concurrent);
    assert.equal(readdirSync(evidenceDir).filter((name) => name.endsWith(".tmp")).length, 0);
  });

  await t.test("symbolic links at private paths are refused, never followed", { skip: IS_WINDOWS && "POSIX symlink semantics" }, async () => {
    await reset();
    const outside = path.join(config.dataDir, "outside");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const { rmSync } = await import("node:fs");
    const { symlink, rm, lstat } = await import("node:fs/promises");
    const lines = await captureStderr(async () => {
      // 1) The evidence DIRECTORY itself is a link to outside: refused, nothing lands out there.
      rmSync(evidenceDir, { recursive: true, force: true });
      await symlink(outside, evidenceDir, "dir");
      const dirRefused = await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: "d", observationKey: "link-1", evidence: { content: "<feed>x</feed>" },
      });
      assert.equal(dirRefused.recorded, false);
      // Restore the REAL directory for the file-level cases.
      rmSync(evidenceDir);
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      // 2) A content-addressed evidence file is a link to outside: refused, outside untouched.
      const body = "<feed>link-target</feed>";
      const sha = createHash("sha256").update(body, "utf8").digest("hex");
      await symlink(path.join(outside, "planted.txt"), path.join(evidenceDir, `${sha}.txt`));
      const fileRefused = await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: "f", observationKey: "link-2", evidence: { content: body },
      });
      assert.equal(fileRefused.recorded, false);
      // 3) fallback.jsonl as a link: the recording gap is never appended through it.
      // Step 2's refused write leaves a REAL fallback.jsonl here: the recorder's floor appends the
      // redacted gap to <evidenceDir>/fallback.jsonl whenever it cannot record an event. That file is
      // this case's OWN synthetic fixture, so clear it before planting the link — lstat-verified to be
      // a plain regular file inside THIS case's scratch data dir and never a link, so nothing outside
      // can be followed. Without this the symlink below fails with EEXIST before the product ever sees
      // the hazard, which is a defect in the fixture's ordering, not in the product.
      const fallbackPath = path.join(evidenceDir, "fallback.jsonl");
      const fallbackInfo = await lstat(fallbackPath).catch(() => undefined);
      if (fallbackInfo !== undefined) {
        assert.ok(fallbackInfo.isFile() && !fallbackInfo.isSymbolicLink(), "fixture cleanup: fallback must be a plain regular file");
        assert.ok(fallbackPath.startsWith(`${config.dataDir}${path.sep}`), "fixture cleanup: fallback must stay inside the scratch data dir");
        await rm(fallbackPath);
      }
      await symlink(path.join(outside, "fallback-out.jsonl"), fallbackPath);
      const brokenDb = postgres("postgres://aihot:aihot@127.0.0.1:59999/nowhere", { max: 1, connect_timeout: 1 });
      const gap = await recordOpsError(
        { stage: "job", code: "task_failed", message: "g", observationKey: "link-3" },
        brokenDb as unknown as Db,
      );
      assert.equal(gap.recorded, false);
      await brokenDb.end({ timeout: 1 }).catch(() => {});
    });
    assert.match(lines.join("\n"), /ops_error_recording_failed/);
    assert.equal(readdirSync(outside).length, 0); // nothing ever followed a link out of the sandbox
  });

  await t.test("the FIRST concurrent creation of the private chain loses no event", async () => {
    await reset();
    const { rmSync } = await import("node:fs");
    const opsDir = path.join(config.dataDir, "ops");
    // Nothing is pre-created: every recorder really does lstat "absent" and they race on mkdir. That
    // is the ordinary first-time race between NORMAL writers, not a hostile ancestor swap — and it
    // must not turn into a recording gap (ROUND4 D7). EEXIST from a concurrent writer is re-verified
    // by the same link/type/mode checks, so a link at the level is still refused (see the ancestor
    // test below, which runs on this platform too through a junction).
    rmSync(opsDir, { recursive: true, force: true });
    const body = "<feed>first-race</feed>";
    const results = await Promise.all(["fr-1", "fr-2", "fr-3", "fr-4"].map((key) =>
      recordOpsError({ stage: "arxiv.collect", code: "rss_parse_failed", message: "race", observationKey: key, evidence: { content: body } })));
    for (const result of results) assert.equal(result.recorded, true);
    assert.equal(await countEvents(), 4);
    const sha = createHash("sha256").update(body, "utf8").digest("hex");
    assert.equal(await readFile(path.join(evidenceDir, `${sha}.txt`), "utf8"), body);
    assert.equal(readdirSync(evidenceDir).filter((name) => name.endsWith(".tmp")).length, 0);

    // The same race one level deeper: `ops` exists, only the leaf is missing.
    rmSync(evidenceDir, { recursive: true, force: true });
    const body2 = "<feed>leaf-race</feed>";
    const deeper = await Promise.all(["lr-1", "lr-2", "lr-3"].map((key) =>
      recordOpsError({ stage: "arxiv.collect", code: "rss_parse_failed", message: "race2", observationKey: key, evidence: { content: body2 } })));
    for (const result of deeper) assert.equal(result.recorded, true);
    assert.equal(await countEvents(), 7);
    const sha2 = createHash("sha256").update(body2, "utf8").digest("hex");
    assert.equal(await readFile(path.join(evidenceDir, `${sha2}.txt`), "utf8"), body2);
  });

  await t.test("a failure body that could not be READ is incomplete evidence, never an empty body", async () => {
    await reset();
    type Row = { evidence_ref: string | null; evidence_truncated: boolean; details: Record<string, unknown> };
    // 1) The read was rejected (or timed out) before any byte: the origin's document exists but could
    //    not be read out. No empty file is invented — the event says the body is unknown instead.
    const rec = await recordOpsError({
      stage: "arxiv.collect", code: "source_http_failed", message: "503 body unreadable", observationKey: "d8-unread",
      details: { httpStatus: 503, failedBodyBytes: 0, failedBodyTruncated: true },
      evidence: { content: "", bytes: new Uint8Array(0), truncated: true,
        source: { host: "export.arxiv.org", path: "/api/query", httpStatus: 503 } },
    });
    assert.equal(rec.recorded, true);
    assert.equal(rec.evidenceRef, null);
    const [unread] = await sql<Row[]>`SELECT evidence_ref, evidence_truncated, details FROM ops_error_events WHERE observation_key = 'd8-unread'`;
    assert.equal(unread!.evidence_ref, null);
    assert.equal(unread!.evidence_truncated, true, "an unreadable body is not a complete one");
    assert.equal(unread!.details.bodyUnavailable, true);
    assert.equal(unread!.details.evidenceStatus, 503); // the endpoint metadata is kept without any file

    // 2) A COMPLETE, genuinely empty body is a different fact: no file, but nothing is incomplete.
    await recordOpsError({
      stage: "arxiv.collect", code: "source_http_failed", message: "503 empty body", observationKey: "d8-empty",
      details: { httpStatus: 503, failedBodyBytes: 0, failedBodyTruncated: false },
      evidence: { content: "", bytes: new Uint8Array(0), truncated: false },
    });
    const [empty] = await sql<Row[]>`SELECT evidence_ref, evidence_truncated, details FROM ops_error_events WHERE observation_key = 'd8-empty'`;
    assert.equal(empty!.evidence_ref, null);
    assert.equal(empty!.evidence_truncated, false);
    assert.equal("bodyUnavailable" in empty!.details, false);

    // 3) The report states the difference instead of showing a clean group with no evidence.
    const now = new Date();
    const report = await queryOpsErrors({
      since: new Date(now.getTime() - 3600_000).toISOString(), until: new Date(now.getTime() + 60_000).toISOString(), limit: 100, offset: 0,
    });
    const group = report.groups.find((g) => g.code === "source_http_failed")!;
    assert.equal(group.occurrences, 2);
    assert.equal(group.bodiesUnread, 1);
    assert.equal(group.evidence.length, 0);
    assert.match(renderOpsErrorReport(report), /未能读取/);
  });

  await t.test("a recorder that cannot write keeps the original failure, prints a redacted gap, and lands it in the fallback", async () => {
    await reset();
    // A database that cannot be reached, so the recorder itself fails.
    const unreachableClient = postgres("postgres://127.0.0.1:1/no-such-database", { max: 1, connect_timeout: 2, onnotice: () => {} });
    const unreachable = unreachableClient as unknown as Db;
    const original = new Error("arXiv returned HTTP 429 with password=hunter2");
    try {
      const lines = await captureStderr(async () => {
        const result = await recordOpsError(
          { stage: "arxiv.collect", code: "rate_limited", message: String(original), observationKey: "broken-1" },
          unreachable,
        );
        assert.equal(result.recorded, false);
        const merged = withRecordingFailure(original, result) as AggregateError;
        assert.ok(merged instanceof AggregateError);
        assert.equal(merged.errors[0], original); // the 429 is not replaced by "a write failed"
      });
      // The stderr floor is structured and redacted.
      const printed = lines.join("\n");
      assert.match(printed, /ops_error_recording_failed/);
      assert.equal(printed.includes("hunter2"), false);
      // The fallback file got the same redacted line.
      const fallback = await readFile(path.join(evidenceDir, "fallback.jsonl"), "utf8");
      assert.match(fallback, /ops_error_recording_failed/);
      assert.equal(fallback.includes("hunter2"), false);
    } finally {
      await unreachableClient.end({ timeout: 1 }).catch(() => {});
    }
    // A record that did land does not touch the failure at all.
    assert.equal(withRecordingFailure(original, { recorded: true, id: 1, evidenceRef: null }), original);
  });

  await t.test("a task_failed parent is hidden only when the same run has a domain event; parent-only runs stay visible", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    // Run 7 failed in the domain (rate_limited) and recordRun added its parent row on top.
    // Run 8 failed somewhere with NO domain event: only the generic catch saw it.
    const [run7, run8] = await sql<{ id: number }[]>`
      INSERT INTO job_runs (job, status) VALUES ('arxiv.collect', 'failed'), ('arxiv.analyze', 'failed')
      RETURNING id`;
    await sql`
      INSERT INTO ops_error_events (stage, code, severity, sanitized_message, observation_key, group_key, job_run_id, target_id, details)
      VALUES
        ('arxiv.collect','rate_limited','warning','arXiv returned HTTP 429','r7-domain','arxiv.collect:rate_limited:arxiv.org',${run7!.id},'arxiv.org','{}'::jsonb),
        ('job','task_failed','error','arXiv returned HTTP 429','r7-parent','job:arxiv.collect',${run7!.id},NULL,'{"job":"arxiv.collect","parent":true}'::jsonb),
        ('job','task_failed','error','worker crashed','r8-parent','job:arxiv.analyze',${run8!.id},NULL,'{"job":"arxiv.analyze","parent":true}'::jsonb)`;
    const report = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    const codes = report.groups.map((g) => `${g.groupKey}:${g.occurrences}`).sort();
    // The domain group shows once, the parent of the SAME run is not a second failure, and the
    // parent-only run keeps its generic row.
    assert.deepEqual(codes, ["arxiv.collect:rate_limited:arxiv.org:1", "job:arxiv.analyze:1"]);
    assert.equal(await countEvents(), 3);
  });

  await t.test("the expansion hides the same parents the aggregation hides, even across group pages", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    // Run 11 failed in the domain AND recordRun added its parent under the GENERIC job group.
    // Run 12 failed with no domain event: only its generic parent row exists, under the SAME group.
    // Aggregation leaves exactly one occurrence in job:arxiv.collect (run 12's); the expansion must
    // not re-admit run 11's hidden parent — its runs, messages and saved counts stay out.
    const [run11, run12] = await sql<{ id: number }[]>`
      INSERT INTO job_runs (job, status, detail) VALUES
        ('arxiv.collect', 'failed', '{"insertedPaperCount":9,"rssPaperCount":50}'::jsonb),
        ('arxiv.collect', 'failed', NULL)
      RETURNING id`;
    await sql`
      INSERT INTO ops_error_events (stage, code, severity, sanitized_message, observation_key, group_key, job_run_id, target_id, details)
      VALUES
        ('arxiv.collect','rate_limited','warning','domain failure of run 11','r11-domain','arxiv.collect:rate_limited:arxiv.org',${run11!.id},'arxiv.org','{}'::jsonb),
        ('job','task_failed','error','parent of run 11','r11-parent','job:arxiv.collect',${run11!.id},NULL,'{"job":"arxiv.collect","parent":true}'::jsonb),
        ('job','task_failed','error','parent of run 12','r12-parent','job:arxiv.collect',${run12!.id},NULL,'{"job":"arxiv.collect","parent":true}'::jsonb)`;
    // limit 1 puts the domain group on another "page": the expansion still must apply the SAME
    // parent rule the aggregation used over the whole window, not only over the selected keys.
    const report = await queryOpsErrors({ since, until, limit: 1, offset: 0 });
    const jobGroup = report.groups.find((g) => g.groupKey === "job:arxiv.collect");
    assert.notEqual(jobGroup, undefined);
    assert.equal(jobGroup!.occurrences, 1);
    assert.deepEqual(jobGroup!.jobRuns, [run12!.id]);
    assert.equal(jobGroup!.messages.join(" ").includes("run 11"), false);
    assert.equal(jobGroup!.savedCount, null); // run 12 has no detail: unknown, never run 11's 9
    assert.equal(jobGroup!.savedCountIncomplete, true);
  });

  await t.test("a group's evidence, runs and messages answer the queried window, never its whole history", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "old failure", observationKey: "win-old", targetId: "rss.arxiv.org",
      evidence: { content: "<feed>old</feed>" },
    });
    // Push the first observation three days back: same group, outside the window.
    await sql`UPDATE ops_error_events SET occurred_at = clock_timestamp() - interval '3 days' WHERE observation_key = 'win-old'`;
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "new failure", observationKey: "win-new", targetId: "rss.arxiv.org",
      evidence: { content: "<feed>new</feed>" },
    });
    const report = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    assert.equal(report.groups.length, 1);
    const group = report.groups[0]!;
    assert.equal(group.occurrences, 1); // the window's count, not the group's history
    assert.deepEqual(group.messages, ["new failure"]);
    assert.equal(group.evidence.length, 1);
    assert.equal(group.evidence[0]!.sha256, createHash("sha256").update("<feed>new</feed>", "utf8").digest("hex"));
    assert.equal(await countEvents(), 2); // the history row still exists, untouched
  });

  await t.test("open evidence counts every referenced exception, and says unknown when it cannot know", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    const seedException = async (id: number, resolved: boolean) => {
      await sql`
        INSERT INTO arxiv_hydration_exceptions (id, arxiv_id, base_id, version, kind, resolved_at)
        VALUES (${id}, '2601.00001v1', '2601.00001', 1, 'missing', ${resolved ? sql`clock_timestamp()` : sql`NULL`})
        ON CONFLICT (id) DO NOTHING`;
    };
    await seedException(9001, false); // open
    await seedException(9002, true); // resolved
    // A batch with TWO exceptions, both referenced — not just the first one.
    await recordOpsError({
      stage: "arxiv.collect", code: "hydration_missing", severity: "warning", message: "batch left versions behind",
      observationKey: "open-1", targetId: "2601.00001v1",
      details: { exceptionIds: [9001, 9002] },
      evidenceRef: "arxiv_hydration_exceptions:9001",
    });
    const report = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    const group = report.groups[0]!;
    assert.equal(group.openEvidence, 1); // exactly the still-open one
    assert.equal(group.openEvidenceUnknown, false);
    // The referenced exception row is gone: the state cannot be known, and zero would be a lie.
    await sql`DELETE FROM arxiv_hydration_exceptions WHERE id = 9002`;
    const afterDelete = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    assert.equal(afterDelete.groups[0]!.openEvidence, null);
    assert.equal(afterDelete.groups[0]!.openEvidenceUnknown, true);
    // A private-file reference has no resolution state at all: unknown, not zero.
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "m", observationKey: "open-2",
      evidence: { content: "<feed>x</feed>" },
    });
    const fileRef = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    const fileGroup = fileRef.groups.find((g) => g.code === "rss_parse_failed")!;
    assert.equal(fileGroup.openEvidence, null);
    assert.equal(fileGroup.openEvidenceUnknown, true);
  });

  await t.test("a partial sum is never dressed up as a whole, and real increments are what is counted", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    // insertedPaperCount is what a run really INSERTED; rssPaperCount is how many announcements the
    // feed carried (an announcement is not a stored paper and is never merged into the sum);
    // analyzed is a processing count. All three are independent.
    const [run1, run2] = await sql<{ id: number }[]>`
      INSERT INTO job_runs (job, status, detail) VALUES
        ('arxiv.collect', 'ok', '{"insertedPaperCount":5,"rssPaperCount":30,"newContentCount":35,"windowIngested":5}'::jsonb),
        ('arxiv.collect', 'ok', NULL)
      RETURNING id`;
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "m", observationKey: "saved-1",
      jobRunId: run1!.id,
    });
    await recordOpsError({
      stage: "arxiv.collect", code: "rss_parse_failed", message: "m", observationKey: "saved-2",
      jobRunId: run2!.id,
    });
    const report = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    const group = report.groups[0]!;
    // Run 2 has no detail: the count is unknown, not "5" or "30".
    assert.equal(group.savedCount, null);
    assert.equal(group.savedCountIncomplete, true);
    assert.equal(group.announcementCount, null);
    // With complete details, the sum is the REAL insertion increment — announcements never inflate it.
    await sql`UPDATE job_runs SET detail = '{"insertedPaperCount":4,"rssPaperCount":30,"newContentCount":34}'::jsonb WHERE id = ${run2!.id}`;
    const complete = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    assert.equal(complete.groups[0]!.savedCount, 9); // 5 + 4 real inserts, NOT 34+35 of announcements
    assert.equal(complete.groups[0]!.savedCountIncomplete, false);
    assert.equal(complete.groups[0]!.announcementCount, 60); // 30 + 30, shown separately
    // A run detail that predates the dedicated counter leaves savedCount unknown — old
    // newContentCount mixes announcements in and is never presented as "saved".
    await sql`UPDATE job_runs SET detail = '{"newContentCount":12,"analyzed":7}'::jsonb WHERE id = ${run1!.id}`;
    const legacy = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    assert.equal(legacy.groups[0]!.savedCount, null);
    assert.equal(legacy.groups[0]!.savedCountIncomplete, true);
    // Analysis runs report their processing count, separately.
    const [run3] = await sql<{ id: number }[]>`
      INSERT INTO job_runs (job, status, detail) VALUES ('arxiv.analyze', 'ok', '{"analyzed":3,"failed":1}'::jsonb) RETURNING id`;
    await recordOpsError({
      stage: "arxiv.analyze", code: "analysis_validation_failed", message: "m", observationKey: "saved-3",
      jobRunId: run3!.id,
    });
    const analyzed = await queryOpsErrors({ since, until, limit: 100, offset: 0, stage: "arxiv.analyze" });
    assert.equal(analyzed.groups[0]!.savedCount, null); // no inserted count on an analysis run
    assert.equal(analyzed.groups[0]!.analyzedCount, 3);
  });

  await t.test("the query entry only reads, pages honestly, and both forms carry the evidence", async () => {
    await reset();
    for (let i = 0; i < 3; i++) {
      await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: `feed ${i}`,
        observationKey: `cli-${i}`, targetId: "rss.arxiv.org",
      });
    }
    // A real receipt/attempt pair: the report references them, so they must exist.
    const [receipt] = await sql<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, purpose, subject, status, attempts)
      VALUES ('test:ops-events:1', 'test', 'arxiv-analysis', '2601.00001v1', 'failed', 1) RETURNING id`;
    const [attempt] = await sql<{ id: number }[]>`
      INSERT INTO receipt_attempts (receipt_id, attempt, service, status)
      VALUES (${receipt!.id}, 1, 'test', 'failed') RETURNING id`;
    await recordOpsError({
      stage: "arxiv.analyze", code: "analysis_validation_failed", message: "bad answer",
      observationKey: "cli-analysis", targetId: "2601.00001v1",
      receiptId: receipt!.id, receiptAttemptId: attempt!.id,
    });
    const before = await countEvents();
    const now = Date.now();
    const since = new Date(now - 3600_000).toISOString();
    const until = new Date(now + 60_000).toISOString();
    const report = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    assert.equal(report.groups.length, 2);
    const feed = report.groups.find((g) => g.code === "rss_parse_failed")!;
    assert.equal(feed.occurrences, 3);
    // Only the redacted message is returned — never a stored response body.
    assert.deepEqual(feed.messages, ["feed 2", "feed 1", "feed 0"]);
    // With no run linked, the saved count is stated as unknown instead of a clean zero.
    assert.equal(feed.savedCount, null);
    assert.equal(feed.openEvidence, null);
    // Paging is over groups, and EXACTLY one page is not "more".
    assert.equal((await queryOpsErrors({ since, until, limit: 1, offset: 1 })).groups.length, 1);
    assert.equal((await queryOpsErrors({ since, until, limit: 1, offset: 0 })).hasMore, true);
    assert.equal((await queryOpsErrors({ since, until, limit: 2, offset: 0 })).hasMore, false);
    assert.equal((await queryOpsErrors({ since, until, stage: "arxiv.analyze", limit: 100, offset: 0 })).groups.length, 1);
    const empty = await queryOpsErrors({
      since: new Date(now + 60_000).toISOString(), until: new Date(now + 120_000).toISOString(), limit: 100, offset: 0,
    });
    assert.equal(empty.groupCount, 0);
    // The note names what this query does NOT read — silence here is not a health certificate.
    assert.match(empty.note, /不读取 stderr/);
    assert.match(empty.note, /fallback/);
    // The markdown form carries the same numbers, the evidence references and the pagination.
    const rendered = renderOpsErrorReport(report);
    assert.match(rendered, /发生次数：3/);
    assert.match(rendered, /offset=0 limit=100 hasMore=false/);
    assert.match(rendered, new RegExp(`回执：${receipt!.id}`));
    assert.doesNotMatch(rendered, /<feed>|原始响应/);
    assert.equal(await countEvents(), before); // the query added, changed and removed nothing
  });

  await t.test("a truncated exception association makes the open count unknown, never a confident zero", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    // The single exception the producer managed to store is already resolved...
    await sql`
      INSERT INTO arxiv_hydration_exceptions (id, arxiv_id, base_id, version, kind, resolved_at)
      VALUES (9101, '2601.00002v1', '2601.00002', 1, 'missing', clock_timestamp())
      ON CONFLICT (id) DO NOTHING`;
    // ...but the producer SAID the list was cut, so an exception it never listed may still be open.
    // The listed-and-resolved ones say nothing about those, so the count must be unknown.
    await recordOpsError({
      stage: "arxiv.collect", code: "hydration_missing", severity: "warning", message: "batch left versions behind",
      observationKey: "trunc-1", targetId: "2601.00002v1",
      details: { exceptionIds: [9101], exceptionIdsIncomplete: true },
      evidenceRef: "arxiv_hydration_exceptions:9101",
    });
    const report = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    const group = report.groups[0]!;
    assert.equal(group.exceptionRefsIncomplete, true);
    assert.deepEqual(group.exceptionRefs, [9101]);
    assert.equal(group.openEvidence, null); // NOT 0
    assert.equal(group.openEvidenceUnknown, true);
    assert.match(renderOpsErrorReport(report), /未解决证据：unknown/);
    // A COMPLETE association whose single exception is resolved is still a confident zero.
    await reset();
    await recordOpsError({
      stage: "arxiv.collect", code: "hydration_missing", severity: "warning", message: "m",
      observationKey: "trunc-2", targetId: "2601.00002v1",
      details: { exceptionIds: [9101], exceptionIdsIncomplete: false },
      evidenceRef: "arxiv_hydration_exceptions:9101",
    });
    const complete = (await queryOpsErrors({ since, until, limit: 100, offset: 0 })).groups[0]!;
    assert.equal(complete.openEvidence, 0);
    assert.equal(complete.openEvidenceUnknown, false);
  });

  await t.test("a run removed by retention keeps its execution identity: no double count, no full-looking partial", async () => {
    await reset();
    const now = new Date();
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 60_000).toISOString();
    const [runA, runB, runC] = await sql<{ id: number }[]>`
      INSERT INTO job_runs (job, status, detail) VALUES
        ('arxiv.collect', 'failed', '{"insertedPaperCount":7}'::jsonb),
        ('arxiv.collect', 'failed', '{"insertedPaperCount":4}'::jsonb),
        ('arxiv.collect', 'failed', '{"insertedPaperCount":6}'::jsonb)
      RETURNING id`;
    // Run A: a domain failure plus recordRun's generic parent row for the SAME execution.
    await recordOpsError({
      stage: "arxiv.collect", code: "rate_limited", severity: "warning", message: "A domain failure",
      observationKey: "ret-a-domain", targetId: "arxiv.org", jobRunId: runA!.id,
    });
    await recordOpsError({
      stage: "job", code: "task_failed", message: "A parent", observationKey: "ret-a-parent",
      jobRunId: runA!.id, groupKey: "job:arxiv.collect", details: { job: "arxiv.collect", parent: true },
    });
    // Runs B and C report into the SAME group, so their stored counts are summed together.
    for (const [run, key] of [[runB!.id, "ret-b"], [runC!.id, "ret-c"]] as const) {
      await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: `feed ${key}`, observationKey: key,
        targetId: "rss.arxiv.org", jobRunId: run,
      });
    }
    const before = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    const sumGroup = before.groups.find((g) => g.code === "rss_parse_failed")!;
    assert.equal(sumGroup.savedCount, 10); // 4 + 6: every linked run still has its detail
    assert.equal(sumGroup.savedCountIncomplete, false);
    assert.equal(before.groups.filter((g) => g.code === "rate_limited").length, 1);

    // Retention cleans the run rows (as it is allowed to). The FK goes NULL, the run_key does not.
    await sql`DELETE FROM job_runs WHERE id = ANY(${[runA!.id, runB!.id]})`;
    const after = await queryOpsErrors({ since, until, limit: 100, offset: 0 });
    // 1) Run A's parent is STILL hidden: its identity survived the cleanup, so the domain row is the
    //    only record of that failure — the parent cannot come back and double-count it.
    assert.equal(after.groups.filter((g) => g.code === "rate_limited").length, 1);
    assert.equal(after.groups.some((g) => g.groupKey === "job:arxiv.collect"), false);
    assert.equal(after.groups.find((g) => g.code === "rate_limited")!.occurrences, 1);
    assert.deepEqual(after.groups.find((g) => g.code === "rate_limited")!.runKeys, [`run:${runA!.id}`]);
    // 2) Run B's stored count is UNREACHABLE now. Its identity is still known, so the remainder is
    //    never reported as the whole: no clean "6" as if run B had stored nothing.
    const afterSum = after.groups.find((g) => g.code === "rss_parse_failed")!;
    assert.equal(afterSum.savedCount, null);
    assert.equal(afterSum.savedCountIncomplete, true);
    assert.equal(afterSum.runKeys.includes(`run:${runB!.id}`), true); // the identity is never lost
  });

  await t.test("a linked ancestor of the private directory is refused, not created through", async () => {
    await reset();
    const { rmSync } = await import("node:fs");
    const outside = path.join(config.dataDir, "outside-ops");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const opsDir = path.join(config.dataDir, "ops");
    // `ops` itself is the link: a recursive create would build a real error-evidence directory out
    // there and the leaf lstat would then see an ordinary directory and accept it. Runs on Windows
    // too, through a junction, because that is the platform the recorder actually has to survive.
    rmSync(opsDir, { recursive: true, force: true });
    await linkDirectory(outside, opsDir);
    const lines = await captureStderr(async () => {
      const refused = await recordOpsError({
        stage: "arxiv.collect", code: "rss_parse_failed", message: "a", observationKey: "anc-1",
        evidence: { content: "<feed>ancestor</feed>" },
      });
      assert.equal(refused.recorded, false);
      // The floor also refuses: the fallback lives under the same linked directory.
      const brokenDb = postgres("postgres://aihot:aihot@127.0.0.1:59999/nowhere", { max: 1, connect_timeout: 1 });
      const gap = await recordOpsError(
        { stage: "job", code: "task_failed", message: "b", observationKey: "anc-2" },
        brokenDb as unknown as Db,
      );
      assert.equal(gap.recorded, false);
      await brokenDb.end({ timeout: 1 }).catch(() => {});
    });
    assert.match(lines.join("\n"), /ops_error_recording_failed/);
    assert.equal(readdirSync(outside).length, 0); // nothing was created or written through the link
    // Restore a real chain so the rest of the suite (and later files) see a usable directory. The
    // recursive removal takes the LINK only: a junction is never walked into its target.
    rmSync(opsDir, { recursive: true, force: true });
    assert.equal(readdirSync(outside).length, 0);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    assert.equal(await countEvents(), 0);
  });

  await t.test("kept failure evidence is the received byte prefix and its hash covers those bytes", async () => {
    await reset();
    const http = await import("../packages/backend/src/arxiv/http.ts");
    // "A" followed by a three-byte character cut in the middle by the byte budget: the TEXT copy must
    // not invent a replacement character, and the file must be the exact bytes that arrived.
    const body = Uint8Array.from([0x41, 0xe4, 0xb8, 0xad]);
    const err = await http.fetchArxivXml("https://export.arxiv.org/api/query", {
      maxBytes: 3, fetch: async () => new Response(body, { status: 503 }),
    }).then(() => null, (e) => e);
    assert.ok(err instanceof http.ArxivHttpError);
    assert.equal(err!.status, 503);
    assert.equal(err!.bodyTruncated, true);
    assert.equal(err!.bodyText, "A"); // not "A\uFFFD"
    assert.deepEqual([...err!.bodyBytes], [0x41, 0xe4, 0xb8]);
    const record = await recordOpsError({
      stage: "arxiv.collect", code: "source_http_failed", message: "HTTP 503", observationKey: "bytes-1",
      evidence: { content: err!.bodyText, bytes: err!.bodyBytes, truncated: true },
    });
    assert.equal(record.recorded, true);
    const [row] = await sql<{ evidence_sha256: string; evidence_ref: string; evidence_truncated: boolean }[]>`
      SELECT evidence_sha256, evidence_ref, evidence_truncated FROM ops_error_events WHERE observation_key = 'bytes-1'`;
    const stored = await readFile(path.join(evidenceDir, `${row!.evidence_sha256}.txt`));
    assert.deepEqual([...stored], [0x41, 0xe4, 0xb8]); // the received prefix, byte for byte
    // The hash covers those bytes — NOT a re-encoding of the decoded text.
    assert.equal(row!.evidence_sha256, createHash("sha256").update(Buffer.from([0x41, 0xe4, 0xb8])).digest("hex"));
    assert.notEqual(row!.evidence_sha256, createHash("sha256").update("A", "utf8").digest("hex"));
    assert.equal(row!.evidence_truncated, true);
  });
});
