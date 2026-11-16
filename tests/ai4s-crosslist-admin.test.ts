// B2 (round 3): a manual astronomy determination is a first-class, audited admin action — not a row an
// operator edits with SQL and not a flag the strict schema rejects. These call the same overrideFields the
// admin route calls: a cross-list is refused when nothing supports it, an approval without its reason is
// refused, the approved request reaches the astronomy projection, the audit keeps the note, and revoking
// the cross-list retires the approval it was justified by. Local _test database, no model, no network.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { overrideFields } from "@aihot/backend/admin/content";
import { Conflict } from "@aihot/backend/audit";

const T = tag();
const SRC = `xl-admin-${T}`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
    VALUES (${SRC}, 'AI4S 官方', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => { await stopBoss(); await closeDb(); });

let n = 0;
/** An eligible AI4S report; `ai4a` writes the finding the structure step would have committed. */
async function report(ai4a: boolean | null) {
  n += 1;
  const marker = `XL${n}-${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url: `https://example.com/${marker}`, title: `${marker} 标题`, bodyText: `${marker} 正文事实陈述。`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(), contentScope: "ai4s",
  } as never);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, ${`理由${n}`}, 80, true, ${[`xl-${T}`]},
      ${sql.json({ domain: "astronomy-astrophysics", ai4a } as never)})`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const crossListed = async (id: string) =>
  (await sql<{ astro_cross_listed: boolean; content_scope: string }[]>`SELECT astro_cross_listed, content_scope FROM publications WHERE article_id = ${id}`)[0]!;
const fields = async (id: string) =>
  ((await sql<{ fields: Record<string, unknown> }[]>`SELECT fields FROM editorial_overrides WHERE article_id = ${id}`)[0]?.fields ?? {}) as Record<string, unknown>;
const versionOf = async (id: string) =>
  (await sql<{ version: number }[]>`SELECT version FROM editorial_overrides WHERE article_id = ${id}`)[0]?.version ?? 0;
const NOTE = "人工天文认定：该结果直接用于恒星光谱分类，属 AI4A。";

const rejection = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return error as Error & { statusCode?: number };
  }
  return null;
};

test("a structured manual astronomy approval cross-lists through the real override path", async () => {
  const id = await report(null);
  assert.equal((await crossListed(id)).astro_cross_listed, false, "nothing cross-lists without a review");

  await overrideFields(id, { fields: { crossListed: true, astroApproved: true, astroApprovalNote: NOTE }, reason: "人工天文认定", version: 0 }, "tester");
  assert.equal((await crossListed(id)).astro_cross_listed, true, "the approval reaches the astronomy projection");
  assert.equal((await fields(id)).astroApprovalNote, NOTE, "the note is stored with the override");
  assert.equal(await versionOf(id), 1, "the override takes the same optimistic version as any other edit");

  const [audit] = await sql<{ after: Record<string, unknown>; actor: string; action: string }[]>`
    SELECT after, actor, action FROM audit_log WHERE subject = ${`content:${id}`} AND action = 'content.override' ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.action, "content.override");
  assert.equal(audit!.after.astroApprovalNote, NOTE, "the reason for the determination is in the audit trail");
});

test("an approval without its reason is refused, and nothing is projected", async () => {
  const id = await report(null);
  const error = await rejection(() => overrideFields(id, { fields: { crossListed: true, astroApproved: true }, reason: "无理由", version: 0 }, "tester"));
  assert.equal(error?.statusCode, 400);
  assert.match(String(error?.message), /认定理由/);
  assert.equal((await crossListed(id)).astro_cross_listed, false);
  assert.deepEqual(await fields(id), {}, "a rejected request writes no override");
});

test("a bare cross-list is refused instead of being accepted and then silently dropped", async () => {
  const id = await report(null);
  const error = await rejection(() => overrideFields(id, { fields: { crossListed: true }, reason: "裸交叉推荐", version: 0 }, "tester"));
  assert.equal(error?.statusCode, 400);
  assert.match(String(error?.message), /AI4A|人工天文认定/);
  assert.equal((await crossListed(id)).astro_cross_listed, false, "publication stays fail-closed");
  assert.deepEqual(await fields(id), {}, "no half-written state for the next edit to inherit");
});

test("a verified AI4A finding cross-lists without a separate approval", async () => {
  const id = await report(true);
  await overrideFields(id, { fields: { crossListed: true }, reason: "已验证 AI4A", version: 0 }, "tester");
  assert.equal((await crossListed(id)).astro_cross_listed, true);
});

test("an approval submitted without the cross-list it justifies is refused", async () => {
  const id = await report(null);
  const error = await rejection(() => overrideFields(id, { fields: { astroApproved: true, astroApprovalNote: NOTE }, reason: "只批不荐", version: 0 }, "tester"));
  assert.equal(error?.statusCode, 400);
  assert.match(String(error?.message), /crossListed/);
});

test("a stale version is refused, so two editors cannot overwrite each other", async () => {
  const id = await report(null);
  await overrideFields(id, { fields: { crossListed: true, astroApproved: true, astroApprovalNote: NOTE }, reason: "人工天文认定", version: 0 }, "tester");
  await assert.rejects(
    () => overrideFields(id, { fields: { crossListed: false }, reason: "别人先改过", version: 0 }, "tester2"),
    (error: Error) => error instanceof Conflict,
  );
  assert.equal((await crossListed(id)).astro_cross_listed, true, "the first decision stands");
});

test("revoking the cross-list retires the approval and converges the astronomy projection", async () => {
  const id = await report(null);
  await overrideFields(id, { fields: { crossListed: true, astroApproved: true, astroApprovalNote: NOTE }, reason: "人工天文认定", version: 0 }, "tester");
  assert.equal((await crossListed(id)).astro_cross_listed, true);

  await overrideFields(id, { fields: { crossListed: false }, reason: "撤销交叉推荐", version: 1 }, "tester");
  assert.equal((await crossListed(id)).astro_cross_listed, false, "the astronomy exits converge back to exclusion");
  assert.equal((await fields(id)).astroApproved, undefined, "no stale approval is left for the next edit to inherit");
  assert.equal((await fields(id)).astroApprovalNote, undefined);
});
