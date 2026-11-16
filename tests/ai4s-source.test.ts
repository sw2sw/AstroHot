// Authored synthetic feed tests: category, bounded first import and persisted date floor.
// No real feed response or excerpt is distributed.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

const T = tag();
const BASELINE_URLS = [
  "https://example.invalid/ai4s/research-demo",
  "https://example.invalid/ai4s/community-demo",
];
const NOT_BEFORE = "2026-11-15T22:00:00.000Z";
const fixture = readFileSync(fileURLToPath(new URL("./fixtures/ai4s/synthetic-science-rss.xml", import.meta.url)), "utf8");

let feedXml = fixture;
let feedStatus = 200;
const server = http.createServer((_req, res) => {
  if (feedStatus === 304) { res.writeHead(304); res.end(); return; }
  res.writeHead(feedStatus, { "content-type": "application/rss+xml", etag: '"ai4s-test-v1"' });
  res.end(feedXml);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await stopBoss(); await closeDb(); });

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
interface SyntheticItem { url: string; title: string; date: string | null; category: string; summary?: string }
function rssOf(items: SyntheticItem[]): string {
  return `<rss version="2.0"><channel><title>合成测试列表</title>${items.map((i) =>
    `<item><title>${escape(i.title)}</title><link>${escape(i.url)}</link>${i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ""}<description>${escape(i.summary ?? `摘要 ${i.title}`)}</description><category>${escape(i.category)}</category></item>`).join("")}</channel></rss>`;
}

const ai4sConfig = () => ({
  feedUrl: `${base}/rss`,
  allowCategories: ["Science"],
  summaryIsBody: false,
  contentScope: "ai4s",
  _aihot: { initialBackfillLimit: 2, initialUrlAllowlist: BASELINE_URLS, initialNotBefore: NOT_BEFORE },
});
async function mkSource(name: string, cfg: Record<string, unknown>, initialized = false) {
  const id = `ai4s-${T}-${name}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'AI4S 边界测试','rss',${sql.json(cfg as never)},'T1','editorial',
      ${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
  return id;
}
const stored = (id: string) => sql`SELECT url,title,content_scope,backfill,backfill_reason,coverage,body_status,excerpt,published_at FROM articles WHERE source_id=${id} ORDER BY url`;
const cursorOf = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

test("the public industry pack ships a disabled synthetic AI4S example", async () => {
  const { sources } = JSON.parse(readFileSync(fileURLToPath(new URL("../industry/sources.json", import.meta.url)), "utf8"));
  const entry = sources.find((s: { id: string }) => s.id === "rss-ai4s-synthetic");
  assert.ok(entry, "rss-ai4s-synthetic exists in industry/sources.json");
  assert.equal(entry.enabled, false);
  assert.equal(entry.kind, "rss");
  assert.equal(entry.tier, "T1");
  assert.equal(entry.participation_mode, "editorial");
  assert.equal(entry.first_party, true);
  assert.equal(entry.site_fulltext, false);
  assert.equal(entry.syndicate_fulltext, false);
  assert.equal(entry.config.feedUrl, "https://example.invalid/ai4s/rss.xml");
  assert.deepEqual(entry.config.allowCategories, ["Science"]);
  assert.equal(entry.config.summaryIsBody, false);
  assert.equal(entry.config.contentScope, "ai4s");
  assert.equal(entry.config.cardImageAllowed, false);
  assert.deepEqual(entry.config._aihot.initialUrlAllowlist, BASELINE_URLS);
  assert.equal(entry.config._aihot.initialNotBefore, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(unsupportedConfig("rss", entry.config), []);
});

test("config validation accepts the scope and onboarding keys, and refuses malformed ones", () => {
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", contentScope: "ai4s" }), []);
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", contentScope: "astro" }), []);
  assert.deepEqual(unsupportedConfig("web_list", { url: "https://example.com/", contentScope: "ai4s" }), []);
  assert.ok(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", contentScope: "bogus" }).includes("contentScope=bogus"));
  assert.ok(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", _aihot: { initialUrlAllowlist: "not-an-array" } }).includes("_aihot.initialUrlAllowlist"));
  assert.ok(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", _aihot: { initialUrlAllowlist: ["ftp://example.com/x"] } }).includes("_aihot.initialUrlAllowlist"));
  assert.ok(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", _aihot: { initialNotBefore: "not-a-date" } }).includes("_aihot.initialNotBefore"));
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://example.com/rss", _aihot: { initialUrlAllowlist: BASELINE_URLS, initialNotBefore: NOT_BEFORE } }), []);
});

test("the first import stores only the two baseline Science URLs, as ai4s first-import backfill", async () => {
  feedXml = fixture;
  const id = await mkSource("first", ai4sConfig());
  const run = await collectSource(id);
  assert.deepEqual([run.status, run.found, run.created, run.revised], ["ok", 3, 2, 0]);
  const rows = await stored(id);
  assert.deepEqual(rows.map((r) => r.url).sort(), [...BASELINE_URLS].sort());
  for (const r of rows) {
    assert.equal(r.content_scope, "ai4s");
    assert.equal(r.backfill, true);
    assert.equal(r.backfill_reason, "first-import");
    assert.equal(r.coverage, "official_abstract");
    assert.equal(r.body_status, "pending");
    assert.ok(r.excerpt && r.excerpt.length > 20, "the feed's own abstract is kept");
  }
  const lattice = rows.find((r) => r.url === BASELINE_URLS[0])!;
  assert.equal(lattice.title, "SYNTHETIC: A toy research workflow");
  assert.equal(lattice.published_at.toISOString(), "2026-11-15T22:00:01.000Z");
  const cursor = await cursorOf(id);
  assert.ok(cursor.initializedAt, "the first import marks the source initialized");
  assert.equal(cursor.onboardingNotBefore, NOT_BEFORE);
  assert.equal(cursor.rss, undefined, "the first round persists no RSS validator");
});

test("later runs take same-day new Science entries, hold undated new identities, never older history or other categories", async () => {
  const [{ id }] = (await sql`SELECT id FROM sources WHERE id LIKE ${`ai4s-${T}-first%`}`) as Array<{ id: string }>;
  const sameDay = { url: `${base}/article/${T}/same-day`, title: "同日新 Science 条目", date: "2026-11-15T23:30:00.000Z", category: "Science" };
  const older = { url: `${base}/article/${T}/older`, title: "更早的历史条目", date: "2026-11-01T10:00:00.000Z", category: "Science" };
  const undated = { url: `${base}/article/${T}/undated`, title: "无日期 Science 条目", date: null, category: "Science" };
  const research = { url: `${base}/article/${T}/research`, title: "Research 类别新条目", date: "2026-11-16T01:00:00.000Z", category: "Research" };
  feedXml = rssOf([
    { url: BASELINE_URLS[0]!, title: "SYNTHETIC: A toy research workflow", date: "2026-11-15T22:00:01.000Z", category: "Science", summary: "SYNTHETIC: A fictional team discusses a toy research idea with an AI assistant. Technical details are not available." },
    { url: BASELINE_URLS[1]!, title: "SYNTHETIC: A fictional research community bulletin", date: "2026-11-15T22:00:00.000Z", category: "Science", summary: "SYNTHETIC: A fictional science community has a new discussion space. Technical details are not available." },
    sameDay, older, undated, research,
  ]);
  const run = await collectSource(id);
  assert.deepEqual([run.status, run.found, run.created, run.revised], ["ok", 6, 1, 0]);
  const urls = (await stored(id)).map((r) => r.url);
  assert.ok(urls.includes(sameDay.url), "a new URL published after the boundary on the same day enters");
  assert.ok(!urls.includes(undated.url), "R7: an undated new identity cannot prove it is after the floor, so it is held, not admitted");
  assert.ok(!urls.includes(older.url), "history older than the persisted boundary never enters");
  assert.ok(!urls.includes(research.url), "the Science category filter still applies");
  assert.equal(urls.length, 3);
  const cursor = await cursorOf(id);
  assert.equal(cursor.onboardingNotBefore, NOT_BEFORE, "the boundary survives later runs");
  assert.ok(cursor.rss, "a regular run persists its RSS validator");
  const again = await collectSource(id);
  assert.deepEqual([again.status, again.created, again.revised], ["ok", 0, 0]);
});

test("R7: a first-round old URL whose later date is deleted or corrupt stays out — zero ingest, zero paid", async () => {
  // Own allowlisted identities (identity_key is global): the shared baseline URLs are already stored above.
  const base1 = `${base}/article/${T}/hold-base-1`;
  const base2 = `${base}/article/${T}/hold-base-2`;
  const oldUrl = `${base}/article/${T}/hold-old`;
  const cfg = { ...ai4sConfig(), _aihot: { initialBackfillLimit: 2, initialUrlAllowlist: [base1, base2], initialNotBefore: NOT_BEFORE } };
  const summary = "A sufficiently detailed official abstract describing the method and its measured result.";
  // Round one lists an old Science URL outside the allowlist, with a valid pre-floor date: it is excluded.
  feedXml = rssOf([
    { url: base1, title: "onboard 基线条目一", date: "2026-11-15T22:00:01.000Z", category: "Science", summary },
    { url: base2, title: "onboard 基线条目二", date: "2026-11-15T22:00:00.000Z", category: "Science", summary },
    { url: oldUrl, title: "首轮被排除的旧 Science URL", date: "2026-10-01T00:00:00.000Z", category: "Science" },
  ]);
  const id = await mkSource("holdneg", cfg);
  const first = await collectSource(id);
  assert.equal(first.created, 2, "the first import pins only the two allowlisted URLs");
  assert.ok(!(await stored(id)).some((r) => r.url === oldUrl), "the old non-allowlisted URL is excluded in round one");

  // Round two: the same URL returns with its pubDate deleted. A new identity with an unverifiable date is held.
  feedXml = rssOf([
    { url: base1, title: "onboard 基线条目一", date: null, category: "Science", summary },
    { url: oldUrl, title: "首轮被排除的旧 Science URL", date: null, category: "Science" },
  ]);
  const second = await collectSource(id);
  assert.equal(second.created, 0, "R7: the undated old URL is not ingested");
  assert.ok(!(await stored(id)).some((r) => r.url === oldUrl), "R7: zero ingest for the held new identity");
  assert.ok((await stored(id)).some((r) => r.url === base1), "a known identity with a deleted date is still re-offered idempotently");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM receipts`)[0]!.n, 0, "R7: zero paid — the held identity never reaches extraction or analysis");

  // Round three: a corrupt (unparseable) pubDate is equally unverifiable, and equally held.
  feedXml = `<rss version="2.0"><channel><title>合成</title><item><title>坏日期旧 URL</title><link>${escape(oldUrl)}</link><pubDate>not-a-real-date</pubDate><description>摘要</description><category>Science</category></item></channel></rss>`;
  const third = await collectSource(id);
  assert.equal(third.created, 0, "R7: a corrupt date on a new identity is held too");
  assert.ok(!(await stored(id)).some((r) => r.url === oldUrl), "still zero ingest after the corrupt-date round");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int n FROM receipts`)[0]!.n, 0, "still zero paid");
});

test("a source without contentScope stays astro, and an explicit astro scope stores astro", async () => {
  feedXml = rssOf([{ url: `${base}/article/${T}/astro`, title: "天文默认条目", date: new Date().toISOString(), category: "Science" }]);
  const plain = await mkSource("plain", { feedUrl: `${base}/rss` }, true);
  assert.equal((await collectSource(plain)).created, 1);
  assert.equal((await stored(plain))[0]!.content_scope, "astro");
  const explicit = await mkSource("explicit", { feedUrl: `${base}/rss`, contentScope: "astro" }, true);
  feedXml = rssOf([{ url: `${base}/article/${T}/astro-explicit`, title: "天文显式条目", date: new Date().toISOString(), category: "Science" }]);
  assert.equal((await collectSource(explicit)).created, 1);
  assert.equal((await stored(explicit))[0]!.content_scope, "astro");
});

test("a disabled source is skipped, a 304 adds nothing, and one source's failure does not block another", async () => {
  feedStatus = 200;
  feedXml = rssOf([{ url: `${base}/article/${T}/cond`, title: "条件请求条目", date: "2026-11-16T02:00:00.000Z", category: "Science" }]);
  const disabled = `ai4s-${T}-disabled`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,enabled,cursor,next_fetch_at)
    VALUES (${disabled},'AI4S 停用源','rss',${sql.json({ feedUrl: `${base}/rss`, allowCategories: ["Science"], contentScope: "ai4s" } as never)},'T1','editorial',false,${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  const skipped = await collectSource(disabled);
  assert.deepEqual([skipped.status, skipped.created], ["skipped", 0], "A14: a disabled source is paused, never collected");
  assert.equal((await stored(disabled)).length, 0);

  const cond = await mkSource("cond", ai4sConfig(), true);
  assert.equal((await collectSource(cond)).created, 1, "a regular run stores the item and persists its RSS validator");
  assert.ok((await cursorOf(cond)).rss, "the validator is persisted after a successful store");
  feedStatus = 304;
  const notModified = await collectSource(cond);
  assert.deepEqual([notModified.status, notModified.created, notModified.revised], ["ok", 0, 0], "A14: a 304 adds no identity and revises nothing");
  assert.ok((await cursorOf(cond)).rss, "the validator survives a 304");
  feedStatus = 200;
  feedXml = rssOf([
    { url: `${base}/article/${T}/cond`, title: "条件请求条目", date: "2026-11-16T02:00:00.000Z", category: "Science" },
    { url: `${base}/article/${T}/cond-new`, title: "304 之后的新条目", date: "2026-11-16T03:00:00.000Z", category: "Science" },
  ]);
  assert.equal((await collectSource(cond)).created, 1, "after a 304 the next real listing still admits new Science entries");

  const bad = await mkSource("bad", { feedUrl: `${base}/rss`, contentScope: "ai4s" }, true);
  feedStatus = 500;
  const failed = await collectSource(bad);
  assert.equal(failed.created, 0);
  assert.notEqual(failed.status, "ok", "a refusing feed is an error/retry for that source only");
  feedStatus = 200;
  const good = await mkSource("good", { feedUrl: `${base}/rss`, contentScope: "ai4s" }, true);
  feedXml = rssOf([{ url: `${base}/article/${T}/good`, title: "不受影响条目", date: "2026-11-16T04:00:00.000Z", category: "Science" }]);
  assert.equal((await collectSource(good)).created, 1, "A14: one source's failure does not block a healthy source");
});