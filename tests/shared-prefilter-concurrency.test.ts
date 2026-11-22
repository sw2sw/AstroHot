// The shared-prefilter path under concurrency: one paid call per revision, a second worker reuses the
// settled receipt, and an answer that comes back after the article changed is kept for traceability
// but never written back — it must not re-route an article that now has a newer revision.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SRC = `conc-${T}`;

type Step = "shared" | "score" | "understand" | "summarize" | "structure" | "ai4s-structure";
const sharedRequests: string[] = [];

/** Holds the next shared-prefilter request open so a test can change the article mid-flight. */
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;

const stepOf = (system: string, user: string): Step =>
  system.includes("双维预筛") ? "shared"
    : system.includes("事件注意力评分器") ? "score"
      : system.includes("内容理解编辑") ? "understand"
        : system.includes("AI4S 栏目（AI 赋能科学）的资料结构化助手") ? "ai4s-structure"
          : system.includes("资料结构化助手") ? "structure"
            : user.includes("title_zh") ? "summarize" : (() => { throw new Error("unknown request"); })();

const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  if (step === "shared") {
    sharedRequests.push(user.slice(0, 40));
    if (hold) {
      const current = hold;
      hold = null;
      current.entered.open();
      await current.release.promise;
    }
  }
  const answer = (content: unknown) => ({ id: `stub-${sharedRequests.length}`, model: "stub", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "shared") {
    // AI4S-only: this route would move the article into the AI4S column if it were still current.
    return answer({ astronomy: "BLOCK", ai4s: "PASS", reason: "AI 辅助科研" });
  }
  if (step === "score") return answer({ attentionScore: 80 });
  if (step === "understand") return answer({ itemType: "research_result", authorRole: "principal", tags: [], editorialJudgment: "理由", titleZh: "理解标题", summaryZh: "理解摘要。第二句补充关键数字。" });
  if (step === "ai4s-structure") return answer({ scope: "single", domain: "methods-tools", astroApplication: { applies: false, evidence: null }, fact: null });
  if (step === "structure") return answer({ category: "stars-transients", tags: ["科研成果"], subjects: [], scope: "single", fact: null });
  return answer("title_zh: 翻译标题\nsummary_zh: 翻译摘要。第二句补充影响。");
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config)
    VALUES (${SRC}, '并发测试综合科学源', 'rss', 'T1', 'editorial', '2100-01-01', ${sql.json({ sharedPrefilter: true } as never)})`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

let n = 0;
const article = async (marker: string) => {
  n += 1;
  return (await upsertMaterial({
    sourceId: SRC, url: `https://example.com/${marker}-${n}-${T}`, title: `${marker} AI 辅助科研结果 ${T}`,
    bodyText: `${marker}: the team used a model to analyse survey data and reported a quantitative result (${T}).`,
    bodyStatus: "ok", coverage: "full_text", via: "fetch", publishedAt: new Date("2026-11-20T02:00:00Z"),
  } as never)).articleId;
};
const stateOf = async (id: string) =>
  (await sql<{ revision: number; content_scope: string; processing_state: string }[]>`
    SELECT revision, content_scope, processing_state FROM articles WHERE id = ${id}`)[0]!;

test("C1 two concurrent workers: one pays, the other yields, and its retry reuses the receipt", async () => {
  const id = await article("CONC");
  const before = sharedRequests.length;
  // Two workers on the same revision at once. The receipt layer refuses the second ("in flight") rather
  // than buying a second call; the content job turns that into processing_state='new' with a retry,
  // which is what the queue does in production.
  const settled = await Promise.allSettled([analyzeArticle(id), analyzeArticle(id)]);
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  assert.equal(sharedRequests.length - before, 1, "one paid prefilter call for both workers");
  assert.equal(rejected.length, 1, "the other worker yields instead of paying again");
  assert.match(String(rejected[0]!.reason), /in flight/i, "the refusal is the receipt layer's in-flight signal, not a model failure");

  const receipts = async () =>
    (await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM receipts WHERE subject = ${`article:${id}@1`}`)[0]!.c;
  const afterBoth = await receipts();
  const retry = await analyzeArticle(id);
  assert.equal(sharedRequests.length - before, 1, "the retry buys nothing: it reuses the settled receipt");
  assert.equal(await receipts(), afterBoth, "no new paid receipt is created by the retry");
  assert.equal(retry?.output?.relevance, "pass");
  assert.equal((await stateOf(id)).content_scope, "ai4s", "the route is applied exactly as a single run would");
  const rows = await sql<{ input_revision: number }[]>`SELECT input_revision FROM analyses WHERE article_id = ${id}`;
  assert.deepEqual(rows.map((r) => r.input_revision), [1, 1], "both runs judged the same revision; the second replays it, it does not fork the article");
});

test("C2 an answer that returns after the article changed never re-routes it", async () => {
  const id = await article("LATE");
  const entered = gate();
  const release = gate();
  hold = { entered, release };
  const running = analyzeArticle(id);
  await entered.promise;
  // A newer revision arrives while the shared prefilter is still in flight.
  await sql`UPDATE articles SET revision = revision + 1 WHERE id = ${id}`;
  release.open();
  const res = await running;

  assert.equal(res!.stale, true, "the judgement is recorded as belonging to an older revision");
  const state = await stateOf(id);
  assert.equal(state.content_scope, "astro", "the late AI4S route must not move a newer revision's article");
  assert.equal(state.processing_state, "new", "the newer revision is still unprocessed, so the sweep picks it up");
  const rows = await sql<{ input_revision: number }[]>`SELECT input_revision FROM analyses WHERE article_id = ${id}`;
  assert.deepEqual(rows.map((r) => r.input_revision), [1], "kept against the revision it was judged on");
});

test("C3 a later run for the new revision is not served the old revision's receipt", async () => {
  const id = await article("RERUN");
  const before = sharedRequests.length;
  await analyzeArticle(id);
  // A new revision is a new subject: the shared prefilter must be asked again, not replayed.
  await sql`UPDATE articles SET revision = revision + 1, body_text = body_text || ' (revised)' WHERE id = ${id}`;
  await analyzeArticle(id);
  assert.equal(sharedRequests.length - before, 2, "each revision pays for its own prefilter");
});
