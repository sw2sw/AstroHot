// Pure-logic tests for the decision function, plus source-wiring assertions
// (R10 / ROUND4 D1..D6 / ROUND5 W1..W3 / ROUND6 R6-1..R6-3 / ROUND7 R7-1..R7-2).
//
// HONEST SCOPE: these tests run the decision function and assert how the pages are wired in source.
// The SEQUENCING the main review asked for — a late answer from a superseded filter, a callback that
// ignores its signal, consume() during an in-flight check, the backoff binding every entry path — is
// covered by real React effects in `new-content-hook.test.ts`, and the SIGNAL ITSELF (a real publish
// entry, a real read layer, real rows, a real two-transaction interleave) by
// `tests/new-content-signal.test.ts`. Still NOT verified here (or there): paint, keyboard, viewport,
// a real `visibilitychange` from a browser, a real network stack.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NEW_CONTENT_CHECK_MS, NEW_CONTENT_MAX_BACKOFF_MS, newContentBackoff,
  adoptSignal, coerceGroups, evaluateContent, type ContentBaseline, type ContentSignal, type ScopeGroup,
} from "../app/features/feed/new-content.ts";

/**
 * One identity-map entry: a group key, who speaks for it, how many members it has — and (ROUND7
 * R7-1) the MEMBER IDS those members are. Derived from the count unless given explicitly, so a
 * same-count swap has to be spelled out.
 */
const G = (key: string, rep = `r-${key}`, members = 1, memberIds?: string[]): ScopeGroup =>
  ({ key, rep, members, memberIds: memberIds ?? Array.from({ length: members }, (_, i) => `${key}#${i + 1}`) });

/** The reader's baseline: three groups (a has two members), the shape a real scope produces. */
const base = (over: Partial<ContentBaseline> = {}): ContentBaseline =>
  ({ total: 3, tag: "T1", groups: [G("a", "ra", 2), G("b"), G("c")], ...over });
const fresh = (over: Partial<ContentSignal> = {}): ContentSignal =>
  ({ total: 3, tag: "T1", groups: [G("a", "ra", 2), G("b"), G("c")], ...over });
/** A legitimately EMPTY scope: a known, EMPTY identity map. */
const empty = (over: Partial<ContentBaseline> = {}): ContentBaseline =>
  ({ total: 0, tag: "EMPTY", groups: [], ...over });

test("an unknown baseline is adopted, never turned into a prompt", () => {
  assert.deepEqual(evaluateContent(null, fresh()), { hasNew: false, adopt: true });
});

test("a signal the server did not provide decides nothing and moves nothing", () => {
  for (const broken of [fresh({ total: null }), fresh({ tag: null }), fresh({ groups: null })]) {
    assert.deepEqual(evaluateContent(base(), broken), { hasNew: false, adopt: false });
  }
});

// --- ROUND5 W1 / ROUND6 R6-2: an arrival is an identity the baseline lacks ------------------------

test("a NEW group key is announced even when the scope shrank", () => {
  // Keep two groups, withdraw none the reader would miss, admit group d: the count falls, but a key
  // the reader was never shown is an arrival no shrink may swallow.
  assert.deepEqual(evaluateContent(base(), fresh({ total: 3, groups: [G("a", "ra", 2), G("b"), G("d")] })),
    { hasNew: true, adopt: false });
});

test("a member joining a SURVIVING group is announced even when the scope shrank", () => {
  // The ROUND6 R6-2 shape: a report joins the existing group (no new key, no new speaker), while two
  // whole groups are withdrawn. No timestamp is involved — the member IDENTITY is the witness.
  assert.deepEqual(evaluateContent(base(), fresh({ total: 2, groups: [G("a", "ra", 3), G("c")] })),
    { hasNew: true, adopt: false });
});

// --- ROUND7 R7-1: member identity, not the member count, classifies within-group changes ----------

test("a WITHIN-GROUP swap the count cannot see (one leaves, one joins, rep unchanged) is announced", () => {
  // The exact R7-1 counterexample: a non-representative of group a was withdrawn and a new report
  // joined it between two checks — same key, same count, same speaker. Only the member ids tell the
  // direction, and they say: something the reader does not have is in front of them.
  assert.deepEqual(
    evaluateContent(base(), fresh({ groups: [G("a", "ra", 2, ["a#1", "a#3"]), G("b"), G("c")] })),
    { hasNew: true, adopt: false });
});

test("a pure member withdrawal is absorbed WITH a baseline update, so a later same-count join cannot hide", () => {
  // The R7-1 permanent-miss chain, in three steps. 1) The withdrawal alone: silent, but the fresh
  // map is adopted (the old code left the stale baseline standing — the actual bug).
  const afterWithdraw = fresh({ groups: [G("a", "ra", 1), G("b"), G("c")] });
  assert.deepEqual(evaluateContent(base(), afterWithdraw), { hasNew: false, adopt: true });
  const absorbed = adoptSignal(afterWithdraw);
  // 2) A re-check against the absorbed state is silent.
  assert.deepEqual(evaluateContent(absorbed, afterWithdraw), { hasNew: false, adopt: false });
  // 3) A new member joins and the count is back to the ORIGINAL value: against the STALE baseline
  // this was invisible forever; against the adopted one it is an ordinary arrival.
  assert.deepEqual(
    evaluateContent(absorbed, fresh({ groups: [G("a", "ra", 2, ["a#1", "a#3"]), G("b"), G("c")] })),
    { hasNew: true, adopt: false });
});

// --- ROUND5 W2/W3 / ROUND6 R6-1: surviving groups are compared by key, wherever they sit ----------

test("a replaced representative is news wherever in the scope it happened", () => {
  // Same keys, same counts: only "who speaks for group a" changed — on a group the reader may have
  // loaded on a deep page long ago.
  assert.deepEqual(evaluateContent(base(), fresh({ groups: [G("a", "r2", 2), G("b"), G("c")] })),
    { hasNew: true, adopt: false });
});

test("a representative swap is announced even when another whole group left (the R6-1 mix)", () => {
  // The exact case two whole-scope hashes got wrong: the count falls (group c left), nothing new
  // arrives, and the surviving group a changed its speaker. The shrink must not swallow the swap.
  assert.deepEqual(evaluateContent(base(), fresh({ total: 2, groups: [G("a", "r2", 2), G("b")] })),
    { hasNew: true, adopt: false });
});

test("a group that only moved position is not a representative swap", () => {
  // The cross-position retraction of ROUND5 W2: nothing entered, no key, rep or count changed — the
  // map is order-independent, so first and second check are both silent.
  const moved = fresh({ groups: [G("c"), G("a", "ra", 2), G("b")] });
  assert.deepEqual(evaluateContent(base(), moved), { hasNew: false, adopt: false });
  assert.deepEqual(evaluateContent(base(), moved), { hasNew: false, adopt: false });
});

test("a member leaving a surviving group is a removal, not news — but it does move the baseline", () => {
  // A non-representative was withdrawn: one member fewer by identity, nobody new, no key changed.
  // Silent (ROUND7 R7-1), and adopt:true — the caller replaces the whole basis, which is exactly
  // what keeps a later same-count replacement from hiding behind a stale baseline.
  assert.deepEqual(evaluateContent(base(), fresh({ groups: [G("a", "ra", 1), G("b"), G("c")] })),
    { hasNew: false, adopt: true });
});

// --- ROUND6 R6-3: a write that changes no scope identity is not new content -----------------------

test("an SEO-only or summary write that moves no identity is silent, twice", () => {
  // The projection row was really written (its write instant moved), but no group entered or left,
  // no member joined and no representative changed: nothing to announce.
  assert.deepEqual(evaluateContent(base(), fresh()), { hasNew: false, adopt: false });
  assert.deepEqual(evaluateContent(base(), fresh()), { hasNew: false, adopt: false });
});

// --- removals, empties, and the defensive net -----------------------------------------------------

test("a pure retraction is the only thing absorbed, and it never prompts on its own", () => {
  assert.deepEqual(evaluateContent(base(), fresh({ total: 2, groups: [G("a", "ra", 2), G("b")] })),
    { hasNew: false, adopt: true });
  const absorbed = adoptSignal(fresh({ total: 2, groups: [G("a", "ra", 2), G("b")] }));
  assert.deepEqual(evaluateContent(absorbed, fresh({ total: 2, groups: [G("a", "ra", 2), G("b")] })),
    { hasNew: false, adopt: false });
});

test("an unchanged scope never prompts", () => {
  assert.deepEqual(evaluateContent(base(), fresh()), { hasNew: false, adopt: false });
});

test("a growth or identity change the map fails to explain still prompts", () => {
  // Defensive agreement: if the count grew or the identity set moved but the map shows no arrival,
  // believe the growth rather than silently absorbing it.
  assert.deepEqual(evaluateContent(base(), fresh({ total: 4 })), { hasNew: true, adopt: false });
  assert.deepEqual(evaluateContent(base(), fresh({ tag: "T2" })), { hasNew: true, adopt: false });
});

// --- D6: an empty scope is a known baseline -------------------------------------------------------

test("a filter that is really empty announces its first item on the first check", () => {
  assert.deepEqual(evaluateContent(empty(), fresh({ total: 1, tag: "T2", groups: [G("d")] })),
    { hasNew: true, adopt: false }, "the first group of an empty filter is an arrival");
  assert.deepEqual(evaluateContent(empty(), fresh({ total: 0, tag: "EMPTY", groups: [] })),
    { hasNew: false, adopt: false }, "still empty, nothing to say");
  assert.deepEqual(evaluateContent(base(), fresh({ total: 0, tag: "EMPTY", groups: [] })),
    { hasNew: false, adopt: true }, "everything withdrawn back to empty is a shrink, not news");
});

// --- D3: absorbing a shrink must not turn the deletion backfill into news -------------------------

test("absorbing a shrink REPLACES the whole basis", () => {
  const before = base();
  const after = fresh({ total: 2, groups: [G("a", "ra", 2), G("b")] });
  const verdict = evaluateContent(before, after);
  assert.deepEqual(verdict, { hasNew: false, adopt: true });
  const absorbed = adoptSignal(after);
  // The reader's stored scope must NOT survive: the server already filled the gap, so comparing
  // against the old numbers would report the backfill as "new content" on the next check.
  assert.deepEqual(absorbed, { total: 2, tag: "T1", groups: [G("a", "ra", 2), G("b")] });
  assert.deepEqual(evaluateContent(absorbed, after), { hasNew: false, adopt: false });
  // A genuinely new admission after that is still announced.
  assert.deepEqual(evaluateContent(absorbed, fresh({ total: 3, tag: "T3", groups: [G("a", "ra", 2), G("b"), G("e")] })),
    { hasNew: true, adopt: false });
});

test("backoff doubles and caps", () => {
  assert.equal(newContentBackoff(0), NEW_CONTENT_CHECK_MS);
  assert.equal(newContentBackoff(1), NEW_CONTENT_CHECK_MS * 2);
  assert.equal(newContentBackoff(50), NEW_CONTENT_MAX_BACKOFF_MS);
});

// --- source wiring ------------------------------------------------------------------------------

test("the decision compares no position, no whole-scope hash and no write instant", () => {
  const module = readFileSync(new URL("../app/features/feed/new-content.ts", import.meta.url), "utf8");
  // W2: a positional comparison is exactly what mistook a reorder for a swap; the field is gone.
  assert.doesNotMatch(module, /headIdentityChanged|NEW_CONTENT_HEAD|\.head\b/);
  // ROUND6 R6-3: timestamps are witnesses, never the decision — the signal carries none at all.
  assert.doesNotMatch(module, /admission|admittedAt|repTag/);
  // ROUND6 R6-1/R6-2, ROUND7 R7-1: the comparable identity map with MEMBER IDS is what decides, and
  // the removal-only shrink is the only silent direction.
  assert.match(module, /export interface ScopeGroup \{/);
  assert.match(module, /memberIds: string\[\];/);
  assert.match(module, /groups: ScopeGroup\[\] \| null;/);
  assert.match(module, /if \(!was\) return \{ hasNew: true, adopt: false \};/);
  assert.match(module, /if \(freshIds\.some\(\(id\) => !wasIds\.has\(id\)\)\) return \{ hasNew: true, adopt: false \};/);
  assert.match(module, /if \(g\.rep !== was\.rep\) return \{ hasNew: true, adopt: false \};/);
  assert.match(module, /if \(onlyRemovals\) return \{ hasNew: false, adopt: true \};/);
  // ROUND7 R7-1: a map without member identity must not be half-trusted by the coercion.
  assert.match(module, /Array\.isArray\(\(g as ScopeGroup\)\.memberIds\)/);
});

test("the timeline commits the detection baseline only where the HEAD list is established", () => {
  const timeline = readFileSync(new URL("../app/features/feed/Timeline.tsx", import.meta.url), "utf8");
  // The blanket "every state change re-captures the baseline" effect is gone: a deep-page append or
  // a collapsed day is not a new scope (ROUND4 D1).
  assert.doesNotMatch(timeline, /captureBaseline/);
  // The deep-page append path no longer writes the scope-wide numbers into the list state.
  assert.doesNotMatch(timeline, /cards: \[\.\.\.prev\.cards, \.\.\.added\][\s\S]{0,400}total: page\.total/);
  // A cursor reset re-reads the head, commits it as the new scope, and parses BEFORE deciding.
  assert.match(timeline, /const fresh = \(await head\.json\(\)\) as TimelineResponse;[\s\S]{0,120}if \(!current\(\)\) return;/);
  assert.match(timeline, /commitHead\(next\)/);
  // Absorbing a shrink replaces the basis, and a superseded check is refused after parse.
  assert.match(timeline, /baseline\.current = adoptSignal\(fresh\)/);
  assert.match(timeline, /await res\.json\(\)\) as TimelineResponse;[\s\S]{0,700}if \(signal\.aborted\) return false;/);
  // The fresh signal is coerced from the response's identity map — never from the rendered page,
  // and never from the response's timestamp witnesses (ROUND6 R6-3).
  assert.match(timeline, /groups: coerceGroups\(page\.groups\),/);
  assert.doesNotMatch(timeline, /admittedAt|repTag/);
  // ListState v7: only a v7 snapshot's identity map is trusted (v6 compared member counts, which
  // cannot classify a within-group swap — ROUND7 R7-1).
  assert.match(timeline, /version: 7/);
  assert.match(timeline, /const known = data\.version === 7;/);
  // The coercion is shared with the arXiv page, not re-defined here.
  assert.doesNotMatch(timeline, /function coerceGroups\(/);
  assert.match(timeline, /import \{[^}]*coerceGroups[^}]*\} from "\.\/new-content";/);
});

test("the timeline restores a pre-v7 snapshot with an explicitly unknown signal", () => {
  const timeline = readFileSync(new URL("../app/features/feed/Timeline.tsx", import.meta.url), "utf8");
  assert.match(timeline, /function restoreList\(/);
  assert.match(timeline, /data\.version !== 2 && data\.version !== 3 && data\.version !== 4 && data\.version !== 5 && data\.version !== 6 && data\.version !== 7/);
});

test("coerceGroups drops entries without member identity", () => {
  assert.deepEqual(coerceGroups([{ key: "a", rep: "ra", members: 1, memberIds: ["a#1"] }, { key: "b", rep: "rb", members: 1 }]),
    [{ key: "a", rep: "ra", members: 1, memberIds: ["a#1"] }]);
  assert.deepEqual(coerceGroups([{ key: "a", rep: "ra", members: 1, memberIds: [1] }]), [],
    "an entry with non-string ids is dropped, leaving the rest of the map");
  assert.deepEqual(coerceGroups([{ key: "a", rep: "ra", members: 1 }]), []);
  assert.equal(coerceGroups("nope"), null);
});

test("the arXiv update commits the response it fetched instead of re-requesting the document", () => {
  const arxiv = readFileSync(new URL("../app/routes/arxiv.tsx", import.meta.url), "utf8");
  // No full-document navigation is left anywhere in the update path.
  assert.equal((arxiv.match(/window\.location\.assign/g) ?? []).length, 0);
  // The parsed page becomes the visible list, and only a successful parse reaches the commit.
  assert.match(arxiv, /const page = \(await res\.json\(\)\) as ArxivFeed;[\s\S]{0,600}onCommit\(page\);/);
  assert.match(arxiv, /if \(controller\.signal\.aborted \|\| applyController\.current !== controller\) return;/);
  // The URL change reuses those bytes: revalidation is suppressed for that one navigation.
  assert.match(arxiv, /export function shouldRevalidate\(\)/);
  assert.match(arxiv, /commitWithoutRevalidate = true;[\s\S]{0,200}navigate\(/);
  // The view is what renders, so a failed update cannot take the reader's list away.
  assert.match(arxiv, /const \[view, setView\] = useState\(feed\)/);
  // An empty candidate scope is a KNOWN baseline (an empty identity map), not an unknown one
  // (ROUND4 D6); the signal is the identity map, never the timestamp witnesses (ROUND6 R6-2/R6-3),
  // coerced through the shared member-identity check (ROUND7 R7-1/R7-2).
  assert.match(arxiv, /view\.contentTag === "" \|\| !Array\.isArray\(view\.groups\)/);
  assert.match(arxiv, /groups: coerceGroups\(page\.groups\),/);
  assert.match(arxiv, /baselineRef\.current = adoptSignal\(fresh\)/);
  assert.doesNotMatch(arxiv, /NEW_CONTENT_HEAD/);
});
