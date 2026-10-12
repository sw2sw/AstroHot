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
test("candidate UI and desktop/mobile entry; HTTP only", () => {
 const page = source("apps/web/app/routes/arxiv.tsx");
 assert.match(page, /AI 根据标题与摘要整理，请以论文原文为准/);
 assert.match(page, /loadOr404<ArxivFeed>/); assert.match(page, /提交（UTC）/); assert.match(page, /paper\.announced_on/);
 assert.doesNotMatch(page, /lastSyncedAt|pilot/);
 assert.doesNotMatch(page, /@aihot\/backend|100\.87\.232\.12|published/);
 for (const p of ["apps/web/app/routes.ts", "apps/web/app/components/shell/nav.ts", "apps/web/app/routes/more.tsx"]) assert.match(source(p), /arxiv/);
});
