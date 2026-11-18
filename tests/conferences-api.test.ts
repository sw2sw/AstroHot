// 会议接口：公开读只有 GET、参数错误是 400，人工写入口必须登录（匿名拿不到写权限）。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../apps/api/src/app.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { projectConference } from "@aihot/backend/content/conferences";
import { publishArticle } from "@aihot/backend/publication/publish";
import { conferenceIdentityKey, type GroundedConference } from "@aihot/backend/editorial/conference";

process.env.FEISHU_INTERNAL_ENABLED = "false";
const T = tag();
const SOURCE = `test-conf-api-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, '会议接口测试源', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/api-${T}`, title: "第25届会议通知", bodyText: "第25届天文信息学与虚拟天文台学术研讨会现开放报名",
    bodyStatus: "ok", coverage: "full_text", via: "ingest",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${`会议标题 ${T}`}, ${`会议摘要 ${T}`}, false)`;
  await publishArticle(articleId);
  const conf: GroundedConference = {
    name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届", startDate: "2026-11-24", endDate: "2026-11-28",
    timezone: null, city: "西安", venue: null, online: false, organizer: "国家天文科学数据中心", officialUrl: null, registrationUrl: null,
    deadlines: [], evidence: "第25届天文信息学与虚拟天文台学术研讨会现开放报名",
    nameNorm: "天文信息学与虚拟天文台学术研讨会",
    identityKey: conferenceIdentityKey({ name: "第25届天文信息学与虚拟天文台学术研讨会", edition: "第25届", startDate: "2026-11-24" }),
  };
  await sql.begin((tx) => projectConference(tx, { articleId, revision: 1, contentScope: "astro", conference: conf }));
});
after(async () => {
  await app.close();
  await closeDb();
});

test("the public hub answers with the contract and a shareable cache", async () => {
  const res = await app.inject({ method: "GET", url: "/api/site/conferences?scope=astro" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["cache-control"] as string, /public/);
  const body = res.json() as { scope: string; items: Array<{ name: string; startDate: string; notice: { id: string } | null }>; total: number; page: number; pageSize: number };
  assert.equal(body.scope, "astro");
  const found = body.items.find((c) => c.name.startsWith("第25届"));
  assert.ok(found);
  assert.equal(found!.startDate, "2026-11-24");
  assert.ok(found!.notice?.id);
  assert.equal(body.pageSize, 20);
});

test("an unknown scope or a malformed page is refused as a client error", async () => {
  const scope = await app.inject({ method: "GET", url: "/api/site/conferences?scope=nope" });
  assert.equal(scope.statusCode, 400);
  const page = await app.inject({ method: "GET", url: "/api/site/conferences?page=0" });
  assert.equal(page.statusCode, 400);
});

test("the conference write path is authenticated: no anonymous correction", async () => {
  const [row] = await sql<{ id: number }[]>`SELECT id FROM conferences WHERE name LIKE ${"第25届%"}`;
  const anonymous = await app.inject({
    method: "POST", url: `/api/admin/conferences/${row!.id}/override`,
    payload: { version: 1, reason: "匿名改会期", fields: { startDate: "2027-01-01" } },
  });
  assert.ok([401, 403].includes(anonymous.statusCode), `got ${anonymous.statusCode}`);
  const [after] = await sql<{ start_date: string }[]>`SELECT start_date::text FROM conferences WHERE id = ${row!.id}`;
  assert.equal(after!.start_date, "2026-11-24");
});
