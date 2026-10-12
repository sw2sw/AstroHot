// §2.1（先生确认）：没有可发布内容的源不留下占位卡，后台抓取失败也不进入读者页。
// 读者列表只由已发布条目组成（读层 pool 只取 eligible 行），从不按已配置的来源拼版；
// 来源自己的失败留在后台（admin），且该记录确实还在那里。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("没有可发布内容的源不留下占位卡：读者列表只由已发布条目组成", async () => {
  const all = await source("../app/routes/all.tsx");
  // One quiet empty state for the whole list, never one card per configured source.
  assert.equal((all.match(/<EmptyState/g) ?? []).length, 1, "整张列表只有一处安静的空态");
  assert.doesNotMatch(all, /sources|feedUrl|interval_minutes/, "读者列表不从已配置的来源拼出来");
});

test("后台抓取失败不进入读者页：health / last_error / fail_count 只在后台", async () => {
  const readers = [
    await source("../app/routes/all.tsx"),
    await source("../app/features/feed/Timeline.tsx"),
    await source("../app/routes/item.tsx"),
  ];
  for (const file of readers) {
    assert.doesNotMatch(file, /last_error|fail_count|fetch_runs|degraded/, "来源自己的失败留在后台，不做成读者可见的错误");
  }
  // The record still exists — in the admin, where it belongs.
  const admin = await source("../app/routes/admin/runs.tsx");
  assert.match(admin, /last_error/, "失败仍被单独记录，只是不暴露给读者");
});
