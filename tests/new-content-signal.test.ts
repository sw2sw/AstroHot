// The reader-side new-content signal, produced by the REAL write and read layers and fed to the real
// decision function (REVIEW-SHEEP-ROUND4 D2/D6, ROUND5 W1..W3, ROUND6 R6-1..R6-3).
//
// Why this file exists: the round-4 fixtures were built with raw INSERTs and handed the admitted item
// a deliberately NEWER release date, so they only proved the one sample they had built. Here every
// publication is produced by `publishArticle` / `publishArticleTx` — the real publish entry — the
// SEO redecision by `setSeoDecision` (the real admin entry) and the arXiv side by `importArxivReport`;
// the signal is then read back through `loadTimeline` / `loadArxivFeed`. What is under test is the
// chain "write entry -> public read layer -> decision", not a shape handed straight to the decision.
//
// Local rows and a local database copy only: no real source, no model, no network.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql, type Tx } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle, publishArticleTx, setSeoDecision } from "@aihot/backend/publication/publish";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadArxivFeed, parseArxivQuery } from "@aihot/backend/publication/arxiv";
import { importArxivReport } from "@aihot/backend/arxiv/store";
import { evaluateContent, type ContentBaseline, type ContentSignal } from "../apps/web/app/features/feed/new-content.ts";

after(closeDb);

const original = JSON.parse(readFileSync(new URL("fixtures/arxiv-pilot.json", import.meta.url), "utf8"));

type Fixture = { tag: string; source: string };

/** One filter scope: its own source row, so every row this file writes is tagged and filterable. */
async function fixture(label: string): Promise<Fixture> {
  const t = `${label}-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${t},'New content','rss','T1','editorial','2100-01-01')`;
  return { tag: t, source: t };
}

/**
 * One report of the scope: material through the real content entry, an analysis outcome (which is
 * what decides tags, score and selection), then the real publish entry. `score` is the ranking input
 * that decides a fact's representative, so a test can choose which member speaks for the group.
 */
async function material(f: Fixture, name: string, timelineAt: Date, score = 80): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: f.source, url: `https://example.test/${f.tag}/${name}`, title: `${f.tag} ${name}`,
    bodyText: "A new public result with evidence.", bodyStatus: "ok", via: "fetch",
  });
  await sql`UPDATE articles SET discovered_at = ${timelineAt}, timeline_at = ${timelineAt} WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,tags)
    VALUES (${articleId},1,'rule','pass','galaxies-cosmology',${`中文 ${name}`},'摘要',${score},true,${[f.tag]})`;
  return articleId;
}

/** An already-public import: the release instant is the item's own date, never "now". */
const publish = (articleId: string, releasedAt: Date) => publishArticle(articleId, { releasedAt });

/** The editorial withdrawal this project's own tests use (topics-withdrawal.test.ts). */
const withdraw = (articleId: string) => sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${articleId}`;

async function newFact(title: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,title) VALUES(gen_random_uuid(),${title}) RETURNING id`;
  return row!.id;
}
const joinFact = (factId: number, articleId: string) =>
  sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${factId},${articleId},'report')`;

type TimelineFeed = Awaited<ReturnType<typeof loadTimeline>>;
const readScope = (f: Fixture, now: Date, cursor: string | null = null, limit = 20) =>
  loadTimeline({ channel: "all", category: null, tag: f.tag, now, limit, cursor });

/** The reader-side signal, taken straight from the response the public read layer produced. */
const signalOf = (feed: TimelineFeed): ContentSignal =>
  ({ total: feed.total, tag: feed.contentTag, groups: feed.groups });
const baselineOf = (feed: TimelineFeed): ContentBaseline => {
  const signal = signalOf(feed);
  return { total: signal.total!, tag: signal.tag!, groups: signal.groups! };
};
const groupOf = (scope: { groups: readonly { key: string; rep: string; members: number; memberIds: string[] }[] | null }, key: string) =>
  scope.groups?.find((g) => g.key === key);

// --- W1: a member joining the scope is visible whatever the total did -----------------------------

test("W1: a net decrease carrying an item released EARLIER than the surviving maximum is announced", async () => {
  const f = await fixture("w1");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);

  // The reader's baseline: five reports whose DISPLAY dates run 09..02.
  const p5 = await material(f, "p5", at(2));
  const p4 = await material(f, "p4", at(3));
  const p3 = await material(f, "p3", at(4));
  const p2 = await material(f, "p2", at(5));
  const p1 = await material(f, "p1", at(9));
  for (const [id, day] of [[p5, 2], [p4, 3], [p3, 4], [p2, 5], [p1, 9]] as const) await publish(id, at(day));

  const before = await readScope(f, now);
  assert.equal(before.total, 5);
  assert.equal(before.cards[0]!.key, `a${p1}`, "the newest displayed report leads");
  const base = baselineOf(before);

  // The review's counterexample: keep the newest item, withdraw two deep ones, and admit one item
  // that was released BEFORE the surviving maximum. Net −1, no displayed date moves.
  await withdraw(p4);
  await withdraw(p3);
  const p6 = await material(f, "p6", at(3));
  await publish(p6, at(3));

  const after = await readScope(f, now);
  assert.equal(after.total, 4, "the scope really is one smaller");
  assert.equal(after.cards[0]!.key, `a${p1}`, "the head never moved");
  assert.equal(after.cards[0]!.anchorAt, before.cards[0]!.anchorAt, "no displayed date moved either");
  assert.ok(groupOf(after, `a${p6}`), "the arrival is a group key the baseline never had");
  assert.ok(!groupOf(base, `a${p6}`));
  assert.ok(Date.parse(after.admittedAt!) > Date.parse(before.admittedAt!),
    "server witness: the admitted row was WRITTEN into the scope");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: true, adopt: false },
    "the identity diff sees the new key even though the count fell");

  // A pure retraction of the same shape (nothing written) is absorbed, and stays absorbed.
  const retractedBase = baselineOf(after);
  await withdraw(p2);
  await withdraw(p5);
  const shrunk = await readScope(f, now);
  assert.equal(shrunk.total, 2);
  assert.equal(shrunk.admittedAt, after.admittedAt, "no write happened");
  assert.deepEqual(evaluateContent(retractedBase, signalOf(shrunk)), { hasNew: false, adopt: true });
  assert.deepEqual(
    evaluateContent(baselineOf(shrunk), signalOf(shrunk)),
    { hasNew: false, adopt: false }, "a stable re-check never re-reports the withdrawal");
});

// --- W2: a surviving group that only MOVED is not a representative swap --------------------------

test("W2: a pure retraction that moves a surviving group past another one is silent, twice", async () => {
  const f = await fixture("w2");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);

  const x = await newFact("W2 fact X");
  const y = await newFact("W2 fact Y");
  // The representative is published FIRST, so its stored anchor is its own date; the earliest member
  // arrives after it, which is exactly what makes the group's anchor able to move later.
  const x2 = await material(f, "x2", at(5), 90);
  await joinFact(x, x2);
  await publish(x2, at(5));
  const x1 = await material(f, "x1", at(2), 1);
  await joinFact(x, x1);
  await publish(x1, at(2));
  const y1 = await material(f, "y1", at(4), 90);
  await joinFact(y, y1);
  await publish(y1, at(4));
  const y1b = await material(f, "y1b", at(3), 5);
  await joinFact(y, y1b);
  await publish(y1b, at(3));

  const before = await readScope(f, now);
  assert.equal(before.total, 2);
  assert.deepEqual(before.cards.map((c) => c.key), [`f${y}`, `f${x}`], "X sits behind Y");
  assert.equal(before.cards[1]!.anchorAt, at(2).toISOString(), "X is anchored by its earliest member");
  const base = baselineOf(before);

  // Withdraw X's EARLIEST member — not its representative (the ROUND6 R6-1 third assertion: a
  // non-representative withdrawal that only reorders). The group survives, so the count and the
  // identity set hold; its anchor moves from 03-02 to 03-05 and it crosses Y.
  await withdraw(x1);
  const moved = await readScope(f, now);
  assert.deepEqual(moved.cards.map((c) => c.key), [`f${x}`, `f${y}`], "X really did cross Y");
  assert.equal(moved.cards[0]!.anchorAt, at(5).toISOString(), "the display anchor really moved");
  assert.equal(moved.total, before.total, "no group entered or left");
  assert.equal(moved.contentTag, before.contentTag, "the identity set is unchanged");
  assert.equal(moved.admittedAt, before.admittedAt, "and nothing was written");
  assert.deepEqual(moved.groups.map((g) => [g.key, g.rep]), before.groups.map((g) => [g.key, g.rep]),
    "neither group's key nor representative moved");
  assert.equal(groupOf(moved, `f${x}`)!.members, 1, "the withdrawal shows as one member fewer in its own group");
  assert.equal(groupOf(before, `f${x}`)!.members, 2);
  // ROUND7 R7-1: the withdrawal is silent, but its fresh map is ADOPTED — a stale baseline is what
  // let a later same-count within-group replacement hide forever. The re-check against the adopted
  // baseline is silent too.
  assert.deepEqual(evaluateContent(base, signalOf(moved)), { hasNew: false, adopt: true });
  assert.deepEqual(evaluateContent(baselineOf(moved), signalOf(moved)), { hasNew: false, adopt: false });

  // The other half of W2: a representative that really changes on the SAME group key is still news.
  // Withdrawing Y's representative leaves the group alive with another speaker, so nothing entered,
  // nothing left, and only "which card does the group show" changed.
  const movedBase = baselineOf(moved);
  await withdraw(y1);
  const swapped = await readScope(f, now);
  assert.equal(swapped.total, moved.total);
  assert.equal(swapped.contentTag, moved.contentTag);
  assert.equal(swapped.admittedAt, moved.admittedAt, "no write: the swap is invisible to every other field");
  assert.equal(groupOf(moved, `f${y}`)!.rep, y1, "before: the withdrawn member spoke for Y");
  assert.equal(groupOf(swapped, `f${y}`)!.rep, y1b, "after: the surviving member does");
  assert.deepEqual(evaluateContent(movedBase, signalOf(swapped)), { hasNew: true, adopt: false });
});

// --- W3: the representative signal reaches the pages the reader already loaded --------------------

test("W3: a representative replaced in a DEEP group the reader loaded is announced", async () => {
  const f = await fixture("w3");
  const now = new Date("2026-05-01T00:00:00Z");
  // 22 standalone groups, newest first, so the fact group lands past the first page of 20.
  for (let i = 21; i >= 0; i--) {
    const when = new Date(Date.UTC(2026, 3, 22 - (21 - i)));
    await publish(await material(f, `s${i}`, when), when);
  }
  const g = await newFact("W3 deep fact");
  const deepWhen = new Date("2026-03-20T00:00:00Z");
  const g1 = await material(f, "g1", deepWhen, 90);
  await joinFact(g, g1);
  await publish(g1, deepWhen);
  const g2 = await material(f, "g2", deepWhen, 5);
  await joinFact(g, g2);
  await publish(g2, deepWhen);

  const page1 = await readScope(f, now);
  assert.equal(page1.total, 23);
  assert.equal(page1.cards.length, 20, "page one is full");
  assert.ok(!page1.cards.some((c) => c.key === `f${g}`), "the fact group is NOT on page one");
  assert.ok(page1.nextCursor, "there is a second page");
  const page2 = await readScope(f, now, page1.nextCursor);
  const loaded = page2.cards.find((c) => c.key === `f${g}`);
  assert.ok(loaded, "the reader loaded the deep group");
  assert.equal(loaded!.item.id, g1, "and is showing the group's first representative");
  const base = baselineOf(page1);
  assert.equal(groupOf(page1, `f${g}`)!.rep, g1, "the scope map records who the deep group speaks through");

  // Only the deep group's representative changes: its earliest member is published first, so the
  // group's own anchor does not move when that member's tenure ends.
  await withdraw(g1);
  const after = await readScope(f, now);
  assert.equal(after.total, base.total, "no group entered or left");
  assert.deepEqual(after.cards.map((c) => c.key), page1.cards.map((c) => c.key), "page one is untouched");
  assert.equal(after.contentTag, base.tag);
  assert.equal(after.admittedAt, page1.admittedAt, "no write: no page-one field can see this");
  assert.equal(groupOf(after, `f${g}`)!.rep, g2, "but the identity map records the new speaker");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: true, adopt: false });

  // What the reader clicks to get: the same deep group, now speaking through its surviving member.
  const deepAfter = await readScope(f, now, after.nextCursor);
  assert.equal(deepAfter.cards.find((c) => c.key === `f${g}`)?.item.id, g2);
  // The reader's own list is never replaced on its own — that is the client D1 wiring, asserted in
  // apps/web/tests/new-content.test.ts.
});

// --- R6-1: a net decrease must not swallow a surviving group's representative swap ----------------

test("R6-1: a surviving DEEP group's representative swap is announced even when another whole group leaves", async () => {
  const f = await fixture("r6a");
  const now = new Date("2026-05-01T00:00:00Z");

  // 22 standalone fillers so the fact group sits on page two; then a whole group B the reader has;
  // then M, a retained group with the newest write.
  for (let i = 21; i >= 0; i--) {
    const when = new Date(Date.UTC(2026, 3, 22 - (21 - i)));
    await publish(await material(f, `s${i}`, when), when);
  }
  const g = await newFact("R6-1 deep fact");
  const deepWhen = new Date("2026-03-20T00:00:00Z");
  const g1 = await material(f, "g1", deepWhen, 90);
  await joinFact(g, g1);
  await publish(g1, deepWhen);
  const g2 = await material(f, "g2", deepWhen, 5);
  await joinFact(g, g2);
  await publish(g2, deepWhen);
  const b1 = await material(f, "b1", new Date("2026-03-19T00:00:00Z"));
  await publish(b1, new Date("2026-03-19T00:00:00Z"));
  const m1 = await material(f, "m1", new Date("2026-03-25T00:00:00Z"));
  await publish(m1, new Date("2026-03-25T00:00:00Z"));

  const page1 = await readScope(f, now);
  assert.equal(page1.total, 25);
  assert.ok(!page1.cards.some((c) => c.key === `f${g}`), "the fact group is NOT on page one");
  const page2 = await readScope(f, now, page1.nextCursor);
  assert.ok(page2.cards.some((c) => c.key === `f${g}`), "the reader loaded the deep group");
  const base = baselineOf(page1);
  assert.ok(groupOf(base, `a${b1}`), "group B is in the baseline");
  assert.equal(groupOf(base, `f${g}`)!.rep, g1);

  // The review's exact mixed case (R6-1): withdraw the deep group's representative — the group
  // SURVIVES and speaks through g2 — while entirely withdrawing group B. The count falls, nothing
  // new is written (M's write instant stays the scope maximum), and only the identity map can tell
  // the surviving group's swap from the group that left.
  await withdraw(g1);
  await withdraw(b1);
  const after = await readScope(f, now);
  assert.equal(after.total, 24, "the scope really shrank (a net decrease)");
  assert.equal(after.admittedAt, page1.admittedAt, "no write happened: the timestamp witness did not move");
  assert.ok(!groupOf(after, `a${b1}`), "group B is gone");
  assert.equal(groupOf(after, `f${g}`)!.rep, g2, "but the surviving deep group changed its speaker");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: true, adopt: false },
    "the swap must not be swallowed by the shrink");

  // Absorbing the state must not re-report it on the next check.
  assert.deepEqual(evaluateContent(baselineOf(after), signalOf(after)), { hasNew: false, adopt: false });
});

// --- R6-1: only whole-group withdrawals are silent ------------------------------------------------

test("R6-1: withdrawing whole groups only is silent, on consecutive checks", async () => {
  const f = await fixture("r6b");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);
  const c1 = await material(f, "c1", at(2));
  await publish(c1, at(2));
  const b1 = await material(f, "b1", at(4));
  await publish(b1, at(4));
  const a1 = await material(f, "a1", at(6));
  await publish(a1, at(6));

  const base = baselineOf(await readScope(f, now));
  assert.equal(base.total, 3);

  await withdraw(a1);
  const shrunk = await readScope(f, now);
  assert.equal(shrunk.total, 2);
  assert.deepEqual(evaluateContent(base, signalOf(shrunk)), { hasNew: false, adopt: true },
    "a withdrawal is not news");
  // The second consecutive check against the SAME change stays silent.
  assert.deepEqual(evaluateContent(base, signalOf(shrunk)), { hasNew: false, adopt: true });
  // Another whole-group withdrawal after the absorb is again only a shrink.
  await withdraw(b1);
  const shrunk2 = await readScope(f, now);
  assert.deepEqual(evaluateContent(baselineOf(shrunk), signalOf(shrunk2)), { hasNew: false, adopt: true });
  assert.deepEqual(evaluateContent(baselineOf(shrunk2), signalOf(shrunk2)), { hasNew: false, adopt: false });
});

// --- R6-2: commit order, not transaction start, decides what the reader can see ------------------

test("R6-2: an admission from an EARLIER-started transaction that committed LATER is announced even with a net decrease", async () => {
  const f = await fixture("r6c");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);

  const fact = await newFact("R6-2 fact");
  const f1 = await material(f, "f1", at(5), 90);
  await joinFact(fact, f1);
  await publish(f1, at(5));
  const x1 = await material(f, "x1", at(4));
  await publish(x1, at(4));
  const y1 = await material(f, "y1", at(3));
  await publish(y1, at(3));
  const m1 = await material(f, "m1", at(9));
  await publish(m1, at(9));

  // The late commit's candidate: materialised and joined to the fact, but NOT yet published. It will
  // join the EXISTING group as a plain member (low score, so the representative does not change) —
  // the hardest shape: no new group key, no new speaker, only one more member.
  const p1 = await material(f, "p1", at(2), 10);
  await joinFact(fact, p1);

  // Transaction A starts FIRST and writes the admission, but does not commit yet.
  const a = await sql.reserve();
  try {
    await a.unsafe("BEGIN");
    // The release instant is explicit, exactly as every real import path stamps it: without it the
    // row would carry the real wall clock and fall outside this test's fixed "now".
    await publishArticleTx(a as unknown as Tx, p1, { releasedAt: at(2) });

    // Transaction B starts LATER, writes a retained in-scope item (a real content change through the
    // real entry) and commits FIRST. Its write instant becomes the scope maximum the reader baselines.
    const b = await sql.reserve();
    try {
      await b.unsafe("BEGIN");
      await b`UPDATE articles SET title = title || ' 修订' WHERE id = ${m1}`;
      await publishArticleTx(b as unknown as Tx, m1);
      await b.unsafe("COMMIT");
    } finally { b.release(); }

    // The reader's baseline: contains B's M, does NOT contain A's candidate.
    const base = await readScope(f, now);
    assert.equal(base.total, 4);
    assert.equal(groupOf(base, `f${fact}`)!.members, 1);
    const baseAdmitted = base.admittedAt;

    // A completes: the candidate is now truly visible, but its write instant ranks BELOW the baseline
    // maximum — exactly the interleaving a timestamp maximum cannot witness.
    await a.unsafe("COMMIT");

    // Meanwhile two whole groups are withdrawn: the count net-decreases.
    await withdraw(x1);
    await withdraw(y1);
    const after = await readScope(f, now);
    assert.equal(after.total, 2, "the scope net-shrank around the hidden arrival (4 groups, 2 withdrawn)");
    assert.equal(after.admittedAt, baseAdmitted, "the newest write instant did NOT move — the inversion");
    const factGroup = groupOf(after, `f${fact}`)!;
    assert.equal(factGroup.members, 2, "the fact group quietly gained a member");
    assert.equal(factGroup.rep, f1, "and its representative is unchanged");
    assert.deepEqual(evaluateContent(baselineOf(base), signalOf(after)), { hasNew: true, adopt: false },
      "the member count sees the arrival that the write instant cannot");
    assert.deepEqual(evaluateContent(baselineOf(after), signalOf(after)), { hasNew: false, adopt: false });
  } finally { a.release(); }
});

// --- R6-3: a write that changes no scope identity is not new content ------------------------------

test("R6-3: an SEO-only redecision of an in-scope item is silent, twice", async () => {
  const f = await fixture("r6d");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);
  const s1 = await material(f, "s1", at(4));
  await publish(s1, at(4));
  const k1 = await material(f, "k1", at(9));
  await publish(k1, at(9));

  const baseFeed = await readScope(f, now);
  const base = baselineOf(baseFeed);
  assert.equal(base.total, 2);

  // The real admin entry (publish.ts setSeoDecision): the projection really changes (indexable
  // flips), so the row's updated_at is refreshed — but no group enters or leaves, no member joins,
  // and no representative changes.
  await setSeoDecision(sql as unknown as Tx, s1, false);
  const [row] = await sql<{ indexable: boolean }[]>`SELECT indexable FROM publications WHERE article_id = ${s1}`;
  assert.equal(row!.indexable, false, "the SEO write really happened");

  const after = await readScope(f, now);
  assert.equal(after.total, base.total, "the item is still in the scope");
  assert.deepEqual(after.groups, base.groups, "key, representative and member counts are all unchanged");
  assert.equal(after.contentTag, base.tag);
  assert.notEqual(after.admittedAt, baseFeed.admittedAt,
    "the write instant DID move — which is exactly why it must never be the decision");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: false, adopt: false },
    "a metadata-only write must not be announced");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: false, adopt: false }, "twice");

  // And a real admission on top of it still is.
  const p9 = await material(f, "p9", at(3));
  await publish(p9, at(3));
  const grown = await readScope(f, now);
  assert.deepEqual(evaluateContent(baselineOf(after), signalOf(grown)), { hasNew: true, adopt: false });
});

// --- R6-2: an item the clock admits on its own is an arrival too ---------------------------------

test("R6-2: a pre-written item becoming visible on its own visible_after gate is announced", async () => {
  const f = await fixture("r6e");
  const early = new Date("2026-03-20T00:00:00Z");
  const late = new Date("2026-03-26T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);

  const k1 = await material(f, "k1", at(2));
  await publish(k1, at(2));
  // Pre-written while the reader is looking: selected, but gated until 03-25, so it is NOT in the
  // reader's scope yet and needs NO further write to become visible.
  const g1 = await material(f, "g1", at(6));
  await publish(g1, at(25));

  const before = await readScope(f, early);
  assert.equal(before.total, 1, "the gated item is not in the baseline scope");
  const base = baselineOf(before);

  // The clock crosses the gate. No publication write happens; the identity map must still see it.
  const after = await readScope(f, late);
  assert.equal(after.total, 2, "the gated item is now in the scope");
  assert.ok(groupOf(after, `a${g1}`) && !groupOf(base, `a${g1}`), "as a group key the baseline never had");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: true, adopt: false });
});

// --- R7-1: member identity, not the count; and a withdrawal must move the baseline ----------------

test("R7-1: a non-representative withdrawal is absorbed, so a later same-count join is announced", async () => {
  const f = await fixture("r7a");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);

  const g = await newFact("R7-1 fact");
  const g1 = await material(f, "g1", at(4), 90);
  await joinFact(g, g1);
  await publish(g1, at(4));
  const g2 = await material(f, "g2", at(4), 5);
  await joinFact(g, g2);
  await publish(g2, at(4));

  const base = baselineOf(await readScope(f, now));
  assert.equal(base.total, 1);
  assert.deepEqual(groupOf(base, `f${g}`)!.memberIds.sort(), [g1, g2].sort(),
    "the map carries the group's member identity, ids only");

  // Step 1: the non-representative is withdrawn. Same group key, same representative, one member
  // fewer — silent, and (the R7-1 fix) the fresh map is ADOPTED instead of leaving the stale one.
  await withdraw(g2);
  const shrunk = await readScope(f, now);
  assert.equal(shrunk.total, base.total, "the group survived");
  assert.equal(groupOf(shrunk, `f${g}`)!.rep, g1, "and still speaks through g1");
  assert.deepEqual(groupOf(shrunk, `f${g}`)!.memberIds, [g1]);
  assert.deepEqual(evaluateContent(base, signalOf(shrunk)), { hasNew: false, adopt: true });
  const absorbed = baselineOf(shrunk);

  // Step 2: a new non-representative joins and the member count returns to its ORIGINAL value.
  // Against the stale baseline this shape was invisible forever (the R7-1 permanent miss); against
  // the adopted one the new member is an ordinary arrival the ids see.
  const g3 = await material(f, "g3", at(4), 5);
  await joinFact(g, g3);
  await publish(g3, at(4));
  const joined = await readScope(f, now);
  assert.equal(groupOf(joined, `f${g}`)!.members, 2, "the count is back — exactly the shape that used to hide");
  assert.equal(groupOf(joined, `f${g}`)!.rep, g1, "and the representative never moved");
  assert.deepEqual(groupOf(joined, `f${g}`)!.memberIds.sort(), [g1, g3].sort());
  assert.deepEqual(evaluateContent(absorbed, signalOf(joined)), { hasNew: true, adopt: false });
  assert.deepEqual(evaluateContent(baselineOf(joined), signalOf(joined)), { hasNew: false, adopt: false });
});

test("R7-1: a WITHIN-GROUP swap (one leaves, one joins, rep and count unchanged) is announced", async () => {
  const f = await fixture("r7b");
  const now = new Date("2026-03-21T00:00:00Z");
  const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T00:00:00Z`);

  const g = await newFact("R7-1 swap fact");
  const g1 = await material(f, "g1", at(4), 90);
  await joinFact(g, g1);
  await publish(g1, at(4));
  const g2 = await material(f, "g2", at(4), 5);
  await joinFact(g, g2);
  await publish(g2, at(4));

  const base = baselineOf(await readScope(f, now));

  // Both changes land between two checks: the old member is withdrawn and a new one joins. Same
  // group key, same count, same representative, same total — no count, hash or timestamp can tell
  // the direction, which is exactly why the member ids are part of the map (ROUND7 R7-1).
  await withdraw(g2);
  const g3 = await material(f, "g3", at(4), 5);
  await joinFact(g, g3);
  await publish(g3, at(4));

  const after = await readScope(f, now);
  assert.equal(after.total, base.total);
  assert.equal(groupOf(after, `f${g}`)!.members, groupOf(base, `f${g}`)!.members, "the count did not move");
  assert.equal(groupOf(after, `f${g}`)!.rep, g1, "the representative did not move");
  assert.deepEqual(groupOf(after, `f${g}`)!.memberIds.sort(), [g1, g3].sort(), "but the membership did");
  assert.deepEqual(evaluateContent(base, signalOf(after)), { hasNew: true, adopt: false },
    "something the reader does not have is in front of them");
  assert.deepEqual(evaluateContent(baselineOf(after), signalOf(after)), { hasNew: false, adopt: false });
});

// --- arXiv: the same property through the real import entry --------------------------------------

const arxivQuery = parseArxivQuery({ page: "1", pageSize: "20", category: "astro-ph.GA" });
const paper = (arxivId: string, submitted: string) => ({
  ...original.items.filter((p: { verdict: string }) => p.verdict === "SELECT")[0],
  base_id: arxivId.replace(/v\d+$/, ""),
  paper_key: `arxiv:${arxivId.replace(/v\d+$/, "")}`,
  arxiv_id: arxivId, url: `https://arxiv.org/abs/${arxivId}`,
  verdict: "SELECT", categories: ["astro-ph.GA"], submitted_at: submitted, updated_at: submitted,
});
const importReport = (runId: string, generatedAt: string, issueDate: string, items: unknown[]) => importArxivReport({
  ...original, run_id: runId, generated_at_utc: generatedAt, issue_date: issueDate,
  items, paper_count: items.length, candidate_pool_count: items.length,
  // Counted by verdict: a re-decided item (e.g. a candidate returning as REVIEW) is part of the
  // report but no longer a SELECT.
  counts: {
    SELECT: items.filter((p) => (p as { verdict: string }).verdict === "SELECT").length,
    REVIEW: items.filter((p) => (p as { verdict: string }).verdict === "REVIEW").length,
    DEFER: items.filter((p) => (p as { verdict: string }).verdict === "DEFER").length,
  },
  ranked_selected_ids: (items as { verdict: string; arxiv_id: string }[]).filter((p) => p.verdict === "SELECT").map((p) => p.arxiv_id),
});
const arxivSignal = (feed: Awaited<ReturnType<typeof loadArxivFeed>>): ContentSignal =>
  ({ total: feed.total, tag: feed.contentTag, groups: feed.groups });
const arxivBaseline = (feed: Awaited<ReturnType<typeof loadArxivFeed>>): ContentBaseline => {
  const signal = arxivSignal(feed);
  return { total: signal.total!, tag: signal.tag!, groups: signal.groups! };
};

test("W1 (arXiv): a report imported late with an OLDER generated_at is still announced", async () => {
  await sql`TRUNCATE arxiv_papers, arxiv_reports CASCADE`;
  const p1 = paper("2601.90001v1", "2026-03-01T00:00:00+00:00");
  await importReport("nc-r1", "2026-03-20T03:00:00Z", "2026-03-20", [p1]);
  const first = await loadArxivFeed(arxivQuery);
  assert.equal(first.total, 1);
  assert.ok(first.admittedAt);
  const [beforeMax] = await sql<{ g: Date }[]>`SELECT max(generated_at) AS g FROM arxiv_papers`;

  // A late import of OLDER material that also carries one paper the archive did not have.
  const p2 = paper("2601.90002v1", "2026-02-01T00:00:00+00:00");
  await importReport("nc-r2", "2026-03-10T03:00:00Z", "2026-03-10", [p1, p2]);
  const after = await loadArxivFeed(arxivQuery);
  assert.equal(after.total, 2);

  // This is precisely where the arrival used to hide: importing an older report cannot raise a
  // maximum over generated_at, so the old signal was blind to it.
  const [afterMax] = await sql<{ g: Date }[]>`SELECT max(generated_at) AS g FROM arxiv_papers`;
  assert.equal(afterMax!.g.getTime(), beforeMax!.g.getTime(), "the displayed run date never moved");
  assert.ok(Date.parse(after.admittedAt!) > Date.parse(first.admittedAt!), "the write instant did");
  assert.ok(after.groups.some((g) => g.key === p2.base_id) && !first.groups.some((g) => g.key === p2.base_id),
    "the identity map gained the new candidate");
  assert.deepEqual(evaluateContent(arxivBaseline(first), arxivSignal(after)), { hasNew: true, adopt: false });

  // Re-importing the same older report changes nothing and announces nothing.
  await importReport("nc-r3", "2026-03-08T03:00:00Z", "2026-03-08", [p1, p2]);
  const again = await loadArxivFeed(arxivQuery);
  assert.equal(again.total, 2);
  assert.equal(again.admittedAt, after.admittedAt, "an ignored re-import writes no row");
  assert.deepEqual(evaluateContent(arxivBaseline(after), arxivSignal(again)), { hasNew: false, adopt: false });
});

// --- R7-2: arXiv member identity carries the VERSION, so a swap cannot hide behind a shrink ------

test("R7-2: an accepted v1->v2 replacement is announced even when another candidate leaves", async () => {
  await sql`TRUNCATE arxiv_papers, arxiv_reports CASCADE`;
  const x1 = paper("2601.90010v1", "2026-03-01T00:00:00+00:00");
  const y1 = paper("2601.90011v1", "2026-03-02T00:00:00+00:00");
  await importReport("r72-r1", "2026-03-20T03:00:00Z", "2026-03-20", [x1, y1]);
  const first = await loadArxivFeed(arxivQuery);
  assert.equal(first.total, 2);
  const xGroup = first.groups.find((g) => g.key === x1.base_id)!;
  assert.equal(xGroup.rep, "2601.90010v1", "the map's rep is the VERSIONED identity, not the base id");
  assert.deepEqual(xGroup.memberIds, ["2601.90010v1"]);
  const base = arxivBaseline(first);

  // One real report import does BOTH: X comes back as v2 (the version guard accepts it) and Y
  // returns re-decided out of the candidate scope. Net −1, and X's group key never changes —
  // the old map (key/rep = base id, members = 1) could not see the replacement at all, so the
  // simultaneous total drop swallowed it through the absorb path (the R7-2 counterexample).
  const x2 = paper("2601.90010v2", "2026-03-05T00:00:00+00:00");
  await importReport("r72-r2", "2026-03-21T03:00:00Z", "2026-03-21", [x2, { ...y1, verdict: "REVIEW" }]);
  const after = await loadArxivFeed(arxivQuery);
  assert.equal(after.total, 1, "Y really left the candidate scope");
  assert.equal(after.groups.find((g) => g.key === x1.base_id)!.rep, "2601.90010v2",
    "the replacement really went through the version guard");
  assert.deepEqual(evaluateContent(base, arxivSignal(after)), { hasNew: true, adopt: false },
    "the version swap must not be swallowed by the simultaneous shrink");
  assert.deepEqual(evaluateContent(arxivBaseline(after), arxivSignal(after)), { hasNew: false, adopt: false });
});

test("R7-2: a candidate leaving without any replacement is still only a shrink", async () => {
  await sql`TRUNCATE arxiv_papers, arxiv_reports CASCADE`;
  const x1 = paper("2601.90020v1", "2026-03-01T00:00:00+00:00");
  const y1 = paper("2601.90021v1", "2026-03-02T00:00:00+00:00");
  await importReport("r72s-r1", "2026-03-20T03:00:00Z", "2026-03-20", [x1, y1]);
  const first = await loadArxivFeed(arxivQuery);
  const base = arxivBaseline(first);

  await importReport("r72s-r2", "2026-03-21T03:00:00Z", "2026-03-21", [{ ...y1, verdict: "REVIEW" }]);
  const after = await loadArxivFeed(arxivQuery);
  assert.equal(after.total, 1);
  assert.deepEqual(evaluateContent(base, arxivSignal(after)), { hasNew: false, adopt: true },
    "a pure withdrawal is not news");
  assert.deepEqual(evaluateContent(arxivBaseline(after), arxivSignal(after)), { hasNew: false, adopt: false });
});

test("an EMPTY candidate scope is a known baseline, so its first paper is announced", async () => {
  await sql`TRUNCATE arxiv_papers, arxiv_reports CASCADE`;
  const empty = await loadArxivFeed(arxivQuery);
  assert.equal(empty.total, 0);
  assert.equal(empty.admittedAt, null);
  assert.ok(empty.contentTag.length > 0, "an empty scope must still carry a fingerprint");
  assert.equal((await loadArxivFeed(arxivQuery)).contentTag, empty.contentTag, "and it must be stable");
  assert.deepEqual(empty.groups, [], "an empty scope is a known EMPTY identity map");
  const baseline = arxivSignal(empty);
  // Still empty, nothing to say.
  assert.deepEqual(evaluateContent({ total: 0, tag: empty.contentTag, groups: [] }, baseline),
    { hasNew: false, adopt: false });

  await importReport("nc-first", "2026-03-10T03:00:00Z", "2026-03-10", [paper("2601.90003v1", "2026-03-01T00:00:00+00:00")]);
  const populated = await loadArxivFeed(arxivQuery);
  assert.equal(populated.total, 1);
  assert.notEqual(populated.contentTag, empty.contentTag);
  assert.ok(populated.admittedAt);
  assert.deepEqual(evaluateContent({ total: 0, tag: empty.contentTag, groups: [] }, arxivSignal(populated)),
    { hasNew: true, adopt: false }, "the first paper of an empty filter is announced, not swallowed");
});
