import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
test("arxiv public route registered and worker schedule opt-in every 30 minutes", () => {
 assert.match(source("apps/api/src/app.ts"), /registerArxiv\(app\)/);
 const schedules = source("apps/worker/src/schedules.ts");
 assert.match(schedules, /process.env.ARXIV_REPORT_URL/);
 assert.match(schedules, /name: "arxiv.sync", cron: "\*\/30 \* \* \* \*"/);
});
test("the arXiv collection is a per-minute due tick, not a fixed slot list", () => {
 const schedules = source("apps/worker/src/schedules.ts");
 // The retired 01/07/13 expression must be gone: a fixed slot is dropped whole whenever the attempt
 // before it started a little late, which is the defect the durable due instant replaces.
 assert.doesNotMatch(schedules, /0 1,7,13 \* \* \*/);
 assert.match(schedules, /name: "arxiv\.collect", cron: "\* \* \* \* \*", tz: "UTC", retryLimit: 0, record: "due"/);
 // The tick is a QUESTION before it is a run: an idle minute is gated on the durable due instant and
 // leaves no job_runs row that could read like a successful collection.
 assert.match(schedules, /import \{ collectionIsDue \} from "@aihot\/backend\/arxiv\/collection-due"/);
 assert.match(schedules, /if \(s\.record === "due"\) \{[\s\S]*?if \(!\(await collectionIsDue\(\)\)\) return undefined;[\s\S]*?\n {6}\}/);
 // A control-plane read that throws is not an idle minute: it must reach job_runs through the same
 // recordRun path, otherwise "the schedule could not be read" would look like "nothing to do".
 assert.match(schedules, /await recordRun\(s\.name, async \(\) => \{ throw error; \}\)\.catch\(\(\) => undefined\)/);
 // An existing queue keeps whatever retry policy it was created with, so a drifted arXiv collection
 // queue (retryLimit > 0) would still retry inside pg-boss seconds after a failure. ensureQueue must
 // correct it rather than trusting the queue it finds.
 const queue = source("packages/backend/src/jobs/queue.ts");
 assert.match(queue, /else if \(queueDrift\(existing, options\)\) await b\.updateQueue\(name, updatable\(options\)\)/);
});
test("candidate UI and desktop/mobile entry; HTTP only", () => {
 const page = source("apps/web/app/routes/arxiv.tsx");
 assert.match(page, /AI 根据标题与摘要整理，请以论文原文为准/);
 assert.match(page, /loadOr404<ArxivFeed>/); assert.match(page, /提交（UTC）/); assert.match(page, /paper\.announced_on/);
 assert.doesNotMatch(page, /lastSyncedAt|pilot/);
 assert.doesNotMatch(page, /@aihot\/backend|100\.87\.232\.12|published/);
 for (const p of ["apps/web/app/routes.ts", "apps/web/app/components/shell/nav.ts", "apps/web/app/routes/more.tsx"]) assert.match(source(p), /arxiv/);
});
