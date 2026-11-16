// B1 (round 3): the AI4S bilingual panel may only show text the source published in the open. The stored
// body is not a public abstract under any licence — the site may hold it for judging while the source
// forbids showing it — so a row with an internal body and no public excerpt must publish no body text in
// any field, at any visibility. What the panel does show is labelled as what it is. Real request path
// (/api/site/items/:id), fake identities on a local _test database, no model, no network.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const AI4S = `rights-ai4s-${T}`;
const ASTRO = `rights-astro-${T}`;
const INTERNAL = `INTERNAL-FULLTEXT-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, site_fulltext, next_fetch_at) VALUES
    (${AI4S}, 'AI4S 官方', 'rss', 'T1', 'editorial', true, false, '2100-01-01'),
    (${ASTRO}, '天文媒体', 'rss', 'T2', 'editorial', false, false, '2100-01-01')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

let n = 0;
/** One published row: `coverage`/`excerpt` are what the collecting channel recorded, `body` is internal. */
async function published(input: {
  scope?: "astro" | "ai4s"; excerpt?: string | null; coverage?: string | null; body?: string | null; visibility?: "summary-only";
} = {}) {
  n += 1;
  const marker = `RIGHTS${n}-${T}`;
  const body = input.body === undefined ? `${INTERNAL} 正文第一段。${INTERNAL} 正文第二段。` : input.body;
  const { articleId } = await upsertMaterial({
    sourceId: input.scope === "astro" ? ASTRO : AI4S, url: `https://example.com/${marker}`, title: `${marker} 标题`,
    excerpt: input.excerpt ?? null, bodyText: body, bodyHtml: body ? `<p>${body}</p>` : null, bodyStatus: "ok",
    // A source that forbids site full text keeps body_mode 'summary' even though the text is stored.
    coverage: (input.coverage ?? null) as never, via: "fetch", publishedAt: new Date(), contentScope: input.scope ?? "ai4s",
  } as never);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`中文导读${n}`}, ${`理由${n}`}, 70, true, ${[`rights-${T}`]},
      ${sql.json({ domain: "astronomy-astrophysics", ai4a: true } as never)})`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  if (input.visibility) {
    await sql`INSERT INTO editorial_overrides (article_id, visibility, reason) VALUES (${articleId}, 'summary-only', '权限回归：人工改为仅摘要')`;
  }
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return { id: articleId, marker };
}

const detail = async (id: string) => {
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  return { status: res.statusCode, body: res.body, json: res.statusCode === 200 ? JSON.parse(res.body) as Record<string, any> : null };
};

test("an internal body with no public excerpt publishes no body text in any field", async () => {
  const { id } = await published({ excerpt: null, coverage: "full_text" });
  const res = await detail(id);
  assert.equal(res.status, 200);
  assert.equal(res.json!.originalAbstract ?? null, null, "no public excerpt means no original abstract");
  assert.equal(res.json!.originalAbstractLabel ?? null, null);
  assert.ok(!res.body.includes(INTERNAL), "the stored body never reaches a public field");
  assert.equal(res.json!.body, null, "the source forbids site full text: body_mode stays summary");
});

test("an unrecorded coverage is not evidence that the excerpt came from the open", async () => {
  const { id } = await published({ excerpt: "A public-looking sentence nobody recorded the origin of.", coverage: null });
  const res = await detail(id);
  assert.equal(res.json!.originalAbstract ?? null, null, "only a recorded official_abstract/public_excerpt qualifies");
});

test("a recorded official abstract is shown and labelled as one", async () => {
  const abstract = "We release a pipeline that classifies 12 million galaxy spectra, reducing error by 12%.";
  const { id } = await published({ excerpt: abstract, coverage: "official_abstract" });
  const res = await detail(id);
  assert.equal(res.json!.originalAbstract, abstract);
  assert.equal(res.json!.originalAbstractLabel, "官方摘要（原文）");
  assert.ok(!res.body.includes(INTERNAL), "the internal body stays out even beside a public abstract");
});

test("a readable fragment from a limited page is labelled as a fragment, not an official abstract", async () => {
  const fragment = "Only the opening paragraph of the article was readable.";
  const { id } = await published({ excerpt: fragment, coverage: "public_excerpt" });
  const res = await detail(id);
  assert.equal(res.json!.originalAbstract, fragment);
  assert.equal(res.json!.originalAbstractLabel, "公开可读片段（原文）");
});

test("summary-only visibility publishes neither the body nor an unverified abstract", async () => {
  const leaked = await published({ excerpt: null, coverage: "full_text", visibility: "summary-only" });
  const res = await detail(leaked.id);
  assert.equal(res.json!.readingMode, "summary-only");
  assert.equal(res.json!.body, null);
  assert.equal(res.json!.originalAbstract ?? null, null);
  assert.ok(!res.body.includes(INTERNAL));

  const withAbstract = await published({ excerpt: "An official abstract the source published.", coverage: "official_abstract", visibility: "summary-only" });
  const kept = await detail(withAbstract.id);
  assert.equal(kept.json!.originalAbstract, "An official abstract the source published.", "a public abstract may still accompany a summary-only page");
});

test("astronomy rows never carry the AI4S bilingual field", async () => {
  const { id } = await published({ scope: "astro", excerpt: "An astronomy feed summary.", coverage: "official_abstract" });
  const res = await detail(id);
  assert.equal(res.json!.originalAbstract ?? null, null);
});
