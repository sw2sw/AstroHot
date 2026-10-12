// Offline contract tests: no database, credentials, downloads or paid requests.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

// Symlinked dependencies must not redirect workspace imports to another checkout.
registerHooks({ resolve(specifier, context, nextResolve) {
  const match = /^@aihot\/(backend|contracts|industry)\/(.+)$/.exec(specifier);
  if (match) {
    const dir = match[1] === "industry" ? "industry" : `packages/${match[1]}/src`;
    return nextResolve(new URL(`../${dir}/${match[2]}.ts`, import.meta.url).href, context);
  }
  return nextResolve(specifier, context);
} });
process.env.MODEL_CALLS_ENABLED = "false";
process.env.COLLECT_ENABLED = "false";
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-agnes-test-credentials";

const { MODELS } = await import("../packages/backend/src/providers/llm.ts");
test("Agnes is a general multimodal preset with reasoning and JSON mode disabled", () => {
  assert.deepEqual(MODELS["agnes-3.0-flash"], {
    key: "agnes-3.0-flash", service: "agnes", model: "agnes-3.0-flash",
    baseUrlEnv: "AGNES_BASE_URL", apiKeyEnv: "AGNES_API_KEY", jsonMode: false, vision: true,
    extra: { chat_template_kwargs: { enable_thinking: false } },
  });
});

const settings = new Map<string, { model: string }>();
const audits: unknown[] = [];
let queryHandler: ((query: string, values: any[]) => any) | null = null;
const sql = Object.assign(async (strings: TemplateStringsArray, ...values: any[]) => {
  const query = strings.join("?");
  if (queryHandler) return queryHandler(query, values);
  if (query.includes("SELECT key, value FROM settings")) return [...settings].map(([key, value]) => ({ key, value }));
  if (query.includes("INSERT INTO settings")) settings.set(values[0], values[1]);
  if (query.includes("DELETE FROM settings")) settings.delete(values[0]);
  return [];
}, { json: (value: unknown) => value, begin: async (fn: (tx: any) => unknown) => fn(sql) });
mock.module(new URL("../packages/backend/src/db.ts", import.meta.url).href, { namedExports: { sql } });
mock.module(new URL("../packages/backend/src/audit.ts", import.meta.url).href, { namedExports: { audit: async (...args: unknown[]) => { audits.push(args); } } });
const { switchModel } = await import("../packages/backend/src/admin/models.ts");
const { modelFor } = await import("../packages/backend/src/editorial/models.ts");

test("understand and ordinary text capabilities accept general multimodal models, switches remain audited", async () => {
  for (const capability of ["understand", "summarize", "score"]) {
    await switchModel(capability, "agnes-3.0-flash", "offline test", "test-admin");
    assert.equal(await modelFor(capability as "understand"), "agnes-3.0-flash");
    assert.deepEqual(settings.get(`models.${capability}`), { model: "agnes-3.0-flash" });
  }
  assert.equal(audits.length, 3);
  await switchModel("understand", "glm-5.3-flash", "text-only remains valid", "test-admin");
  assert.equal(await modelFor("understand"), "glm-5.3-flash");
  await assert.rejects(switchModel("understand", "missing", "test", "test-admin"), /unknown model/);
});

const calls: any[] = [];
const downloaded: string[] = [];
let downloadFails = false;
const copy = { itemType: "data_release", authorRole: "principal", tags: [], editorialJudgment: "以正文为准", titleZh: "星表发布", summaryZh: "研究团队发布星表。数据包含观测误差。" };
let decision: unknown = { approved: true, category: "related", reason: "星表正文与图中观测相关" };
mock.module(new URL("../packages/backend/src/providers/llm.ts", import.meta.url).href, { namedExports: {
  MODELS, ModelOutputError: class extends Error {},
  chatJson: async (opts: any) => {
    calls.push(opts);
    const data = opts.purpose === "understand_article" ? { ...copy, imageSuitability: decision }
      : opts.purpose === "prefilter_article" ? { label: "PASS", reason: "相关" }
      : opts.purpose === "score_article" ? { attentionScore: 95 }
      : { scope: "single", category: null, tags: [], subjects: [], fact: null };
    return { data: opts.schema.parse(data), model: opts.model, receiptId: calls.length, reused: false };
  },
} });
mock.module(new URL("../packages/backend/src/media/images.ts", import.meta.url).href, { namedExports: {
  produceImage: async (url: string) => { downloaded.push(url); if (downloadFails) throw new Error("offline download failure"); return { body: Buffer.from("test image"), type: "image/jpeg" }; },
} });
mock.module(new URL("../packages/backend/src/content/extract.ts", import.meta.url).href, { namedExports: { pageFetchable: () => false } });
mock.module(new URL("../packages/backend/src/jobs/queue.ts", import.meta.url).href, { namedExports: { shutdownSignal: new AbortController() } });
const { runUnderstand, analyzeArticle } = await import("../packages/backend/src/editorial/analyze.ts");
const article = {
  id: "offline-agnes", revision: 1, title: "Catalog release", url: "https://example.org/catalog", author: null,
  publishedAt: null, bodyText: "The team released a catalog of stellar observations and their errors.", excerpt: null,
  xPost: null, media: [{ kind: "image", url: "https://example.org/first.jpg", alt: "Source figure", width: 800, height: 600 }, { kind: "image", url: "https://example.org/second.jpg" }],
  source: { name: "Observatory", kind: "rss", tier: "T1", firstParty: true },
};

test("the same understand call reviews only the first image and retains an auditable decision", async () => {
  await switchModel("understand", "agnes-3.0-flash", "vision test", "test-admin");
  calls.length = 0; downloaded.length = 0;
  const writing = await runUnderstand(article);
    assert.ok(writing);
  assert.equal(calls.length, 1);
  assert.deepEqual(downloaded, ["https://example.org/first.jpg"]);
  assert.equal(calls[0].user.length, 2);
  assert.equal(calls[0].user[1].type, "image_url");
  assert.match(calls[0].user[0].text, /imageSuitability/);
  assert.match(calls[0].system, /不得.*图片.*科学|图片.*不得.*科学/);
  assert.deepEqual((writing as any).imageReview, { ...decision as object, url: article.media[0]!.url, status: "approved" });
});

test("omitted or malformed image review keeps valid text, marks incomplete and never repeats understanding", async () => {
  const saved = decision;
  try {
    for (const [answer, status] of [[undefined, "missing"], [{ approved: true }, "invalid"]] as const) {
      decision = answer; calls.length = 0; downloaded.length = 0;
      const writing = await runUnderstand(article);
    assert.ok(writing);
      assert.equal(calls.length, 1);
      assert.equal(writing.titleZh, copy.titleZh);
      assert.equal(writing.summaryZh, copy.summaryZh);
      assert.equal(writing.imageReview?.approved, false);
      assert.equal(writing.imageReview?.status, status);
      assert.equal(writing.imageReview?.url, article.media[0]!.url);
      assert.deepEqual(downloaded, [article.media[0]!.url]);
    }
  } finally { decision = saved; }
});

test("ESA vision uses the same-image original while review remains bound to the collected URL", async () => {
  calls.length = 0; downloaded.length = 0;
  const original = "https://www.esa.int/var/esa/storage/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated_article.jpg";
  const canonical = "https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated.jpg";
  const writing = await runUnderstand({ ...article,
    media: [{ kind: "image", url: original }],
    source: article.source,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(downloaded, [canonical]);
  assert.ok(writing);
  assert.equal(writing.imageReview?.url, original);
});

test("first-image download failure persists operational state and never selects the second image", async () => {
  calls.length = 0; downloaded.length = 0; downloadFails = true;
  try {
    const writing = await runUnderstand(article);
    assert.ok(writing);
    assert.equal(writing.imageReview?.status, "download-failed");
    assert.equal(writing.imageReview?.approved, false);
    assert.equal(writing.imageReview?.url, article.media[0]!.url);
    assert.deepEqual(downloaded, [article.media[0]!.url]);
    assert.equal(calls.length, 1);
    assert.equal(writing.titleZh, copy.titleZh);
  } finally { downloadFails = false; }
});
test("text-only models persist no-vision state, not a false suitability rejection", async () => {
  await switchModel("understand", "glm-5.3-flash", "offline text-only", "test-admin");
  calls.length = 0; downloaded.length = 0;
  try {
    const writing = await runUnderstand(article);
    assert.ok(writing);
    assert.equal(writing.imageReview?.status, "no-vision");
    assert.equal(writing.imageReview?.approved, false);
    assert.deepEqual(downloaded, []);
    assert.equal(calls.length, 1);
  } finally { await switchModel("understand", "agnes-3.0-flash", "restore offline", "test-admin"); }
});
let persisted: any;
test("the first-image decision persists in the existing analysis output, alongside completed receipts", async () => {
  calls.length = 0;
  queryHandler = (query, values) => {
    if (query.includes("FROM articles a JOIN sources")) return [{
      id: article.id, revision: 1, title: article.title, url: article.url, author: null,
      published_at: null, discovered_at: new Date("2026-01-01"), body_text: article.bodyText, excerpt: null,
      body_status: "ok", x_post: null, x_article: null, media: article.media, source_name: "Observatory",
      source_kind: "rss", tier: "T1", first_party: true, source_tags: [], owner_entity_id: null, config: {}, translation_zh: null,
    }];
    if (query.includes("SELECT revision FROM articles")) return [{ revision: 1 }];
    if (query.includes("INSERT INTO analyses")) { persisted = values.at(-1); return [{ id: 42 }]; }
    return [];
  };
  try {
    const result = await analyzeArticle(article.id);
    assert.equal(result!.analysisId, 42);
    assert.deepEqual(persisted.imageReview, { ...decision as object, url: article.media[0]!.url, status: "approved" });
    assert.equal(calls.filter(c => c.purpose === "understand_article").length, 1);
  } finally { queryHandler = null; }
});

process.env.IMG_PROXY_SIGN_SECRET = "offline-test-signing-secret";
const { toFeedItemSummary, ITEM_COLUMNS, ITEM_FROM } = await import("../packages/backend/src/publication/items.ts");
const row = {
  id: article.id, title: copy.titleZh, original_title: article.title, summary: copy.summaryZh, reason: null,
  category: null, tags: [], score: 95, selected: true, channel: "news", url: article.url,
  published_at: null, discovered_at: new Date("2026-01-01"), timeline_at: new Date("2026-01-01"),
  seat: true, visibility: "public", body_mode: "summary", indexable: false, fact_id: null,
  source_name: "Observatory", source_mode: "editorial", x_post: null, author: null, language: "en",
  story_public_id: null, story_title: null, zh_text: null, quoted_zh: null,
  card_image_allowed: true, media: article.media, image_review: { ...decision as object, url: article.media[0]!.url, status: "approved" },
};
test("publication feed DTO exposes only the approved first image through signed cached renditions, independently of fulltext", () => {
  const feed = toFeedItemSummary(row as any) as any;
  assert.match(feed.thumbnail.url, /^\/api\/img-proxy\?/);
  assert.equal(new URL(feed.thumbnail.url, "http://localhost").searchParams.get("u"), article.media[0]!.url);
  assert.match(feed.thumbnail.srcSet, /image-/);
  assert.equal(feed.thumbnail.alt, "Source figure");
  assert.equal(feed.source.name, "Observatory");
});

test("rejected, uncertain, missing, stale or mismatched image decisions never expose a news thumbnail", () => {
  for (const image_review of [null, undefined,
    { ...row.image_review, approved: false }, { ...row.image_review, category: "uncertain" },
    { ...row.image_review, category: "ad" }, { ...row.image_review, url: article.media[1]!.url },
  ]) assert.equal((toFeedItemSummary({ ...row, image_review } as any) as any).thumbnail ?? null, null);
  assert.equal((toFeedItemSummary({ ...row, media: [] } as any) as any).thumbnail ?? null, null);
});

test("content approval is not copyright permission: unknown or refused thumbnail rights hide the image", () => {
  for (const card_image_allowed of [false, undefined, null])
    assert.equal((toFeedItemSummary({ ...row, card_image_allowed } as any) as any).thumbnail ?? null, null);
});

test("artist concepts are distinguished from observations in the durable decision and thumbnail caption", async () => {
  decision = { approved: true, category: "related", reason: "正文支持概念图用途", depiction: "artist_concept" };
  const writing = await runUnderstand(article);
    assert.ok(writing);
  assert.equal((writing as any).imageReview.depiction, "artist_concept");
  assert.match(calls.at(-1).system, /艺术家概念图/);
  const feed = toFeedItemSummary({ ...row, image_review: {
    ...(writing as any).imageReview, credit: "NASA, ESA, L. Hustak (STScI)",
    attributionUrl: "https://esahubble.org/images/heic2613a/",
  } } as any) as any;
  assert.equal(feed.thumbnail.caption, "艺术家概念图");
  assert.equal(feed.thumbnail.credit, "NASA, ESA, L. Hustak (STScI)");
  assert.equal(feed.thumbnail.attributionUrl, "https://esahubble.org/images/heic2613a/");
  decision = { approved: true, category: "related", reason: "星表正文与图中观测相关" };
});


test("sources requiring attribution need exact credit and a safe active link", () => {
  assert.equal(toFeedItemSummary({ ...row, card_image_requires_credit: true } as any).thumbnail, null);
  const credited = { ...row, card_image_requires_credit: true, image_review: {
    ...row.image_review, credit: "NASA, ESA, L. Hustak (STScI)",
  } };
  for (const attributionUrl of [undefined, '', ' ', '/images/weic2610a/', 'javascript:alert(1)', 'https://user:pass@esawebb.org/images/weic2610a/']) {
    assert.equal(toFeedItemSummary({ ...credited, image_review: { ...credited.image_review, attributionUrl } } as any).thumbnail, null);
  }
  const feed = toFeedItemSummary({ ...credited, image_review: {
    ...credited.image_review, attributionUrl: "https://esahubble.org/images/heic2613a/",
  } } as any);
  assert.equal(feed.thumbnail?.credit, "NASA, ESA, L. Hustak (STScI)");
  assert.equal(feed.thumbnail?.attributionUrl, "https://esahubble.org/images/heic2613a/");
});
