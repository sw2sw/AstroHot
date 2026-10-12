// "有新内容，点击更新" for the two reader lists (home 精选 timeline, /arxiv 候选档案).
//
// Behaviour contract (REVIEW-SHEEP-ROUND2 R10, ROUND3 WEB-01..WEB-05, ROUND4 D1..D6, ROUND5 W1..W3,
// ROUND6 R6-1..R6-3):
// - A lightweight, read-only check of the CURRENTLY FILTERED list runs at most every 120s, only while
//   the tab is visible; returning to a visible tab checks once — but never sooner than the current
//   failure backoff allows (the next-allowed moment binds ALL paths equally).
// - No automatic refresh: the list the reader is reading never reorders, inserts, changes page or
//   loses a modal on its own. Only the reader's click applies the new head.
// - The DETECTION UNIT is "a scope identity the reader does not have". The server returns a
//   COMPARABLE identity map over the whole filtered scope (`groups`: one `key`/`rep`/`members`/
//   `memberIds` entry per group), the reader keeps the map it was shown, and the DIFF decides:
//     * a group key the baseline lacks   → an arrival (a new group; also how a candidate that became
//                                          visible on its own `visible_after` shows up). This holds
//                                          whatever the total did, so a net decrease cannot swallow
//                                          it (ROUND5 W1, ROUND6 R6-2).
//     * a surviving group with a DIFFERENT rep → the group now speaks through someone else, on any
//                                          page including ones the reader loaded long before
//                                          (ROUND5 W2/W3, ROUND6 R6-1). Keying by the stable group
//                                          key keeps a group that merely moved invisible.
//     * a surviving group with a member id the baseline's set lacks → a report joined an existing
//                                          group, judged by MEMBER IDENTITY rather than the count:
//                                          a withdrawal and a joining can leave the count untouched,
//                                          and ids — not bodies, not cards — classify the direction
//                                          (ROUND6 R6-2 for the independence from write instants,
//                                          ROUND7 R7-1 for identity over quantity).
//     * nothing but removals             → the shrink is absorbed silently, and the fresh map
//                                          BECOMES the baseline. Absorbing matters as much as staying
//                                          silent: a stale baseline is what let a later same-count
//                                          within-group replacement hide forever (ROUND7 R7-1).
//                                          This is the ONLY case that is never announced.
//   Two whole-scope hashes cannot make these distinctions — that is exactly how a net decrease used
//   to swallow a surviving group's representative swap (ROUND6 R6-1) — hence a comparable map.
//   Timestamps are witnesses only, never the decision: the newest write instant is a transaction
//   START (commit order can invert it) and a write that changes no scope identity (an SEO-only
//   redecision, a summary edit) refreshes it all the same (ROUND6 R6-3).
// - The baseline is the scope the reader has actually been shown. A deep-page append or a collapsed
//   day is NOT a new scope and never advances it, so content the reader was never shown is never
//   swallowed (ROUND4 D1). When a shrink IS absorbed, the whole basis is replaced by the server's
//   current one: the reader's stored identities no longer line up after a withdrawal, and the
//   backfill must not read as "new content" on the next check (ROUND4 D3).
// - Every check is bounded by a client-side timeout; timers, in-flight requests and results from a
//   superseded filter are all cleaned up. Applying an update REVOKES an in-flight check's authority
//   to touch the baseline, and the periodic chain is re-armed so a visible tab never stops checking
//   (ROUND4 D5).
import { useCallback, useEffect, useRef, useState } from "react";

/** Light check cadence while the tab is visible. */
export const NEW_CONTENT_CHECK_MS = 120_000;
/** Failure backoff ceiling: a struggling backend is not probed every two minutes forever. */
export const NEW_CONTENT_MAX_BACKOFF_MS = 900_000;
/** One check may not hang forever: a hung request would block every later check. */
export const NEW_CONTENT_CHECK_TIMEOUT_MS = 30_000;

/** One entry of the server's scope-wide identity map (see `ScopeGroup` in the contracts). */
export interface ScopeGroup {
  key: string;
  rep: string;
  members: number;
  /** The group's member ids, sorted (ROUND7 R7-1): the identity a count cannot classify. */
  memberIds: string[];
}

/**
 * What one check learned about the filtered list. EVERY field is scope-wide — none of them is a
 * page, a position or a display value:
 * - `total`  the filtered count.
 * - `tag`    a fingerprint of the scope's IDENTITY SET (group keys only, sorted) — never anchors or
 *            other presentation values, so anchor drift on a surviving group does not move it.
 * - `groups` the scope's comparable identity map, one entry per group of the WHOLE filtered scope.
 *            This is what decides; `total`/`tag` are coarse witnesses.
 * `null` anywhere means the response did not carry a usable scope identity: nothing is decided.
 */
export interface ContentSignal {
  total: number | null;
  tag: string | null;
  groups: ScopeGroup[] | null;
}

/**
 * What the reader is actually looking at: the same signal, captured when the scope the reader has
 * been shown was committed. A `null` baseline is a genuinely unknown scope, not an empty one.
 */
export interface ContentBaseline {
  total: number;
  tag: string;
  groups: ScopeGroup[];
}

export interface ContentVerdict {
  /** Content the reader does not have is in front of them. */
  hasNew: boolean;
  /**
   * The fresh scope should become the new baseline WITHOUT prompting — used when the scope shrank
   * (retractions are not new content) or when there was no usable baseline to compare against.
   */
  adopt: boolean;
}

function byKey(groups: ScopeGroup[]): Map<string, ScopeGroup> {
  return new Map(groups.map((g) => [g.key, g]));
}

/**
 * Coerces a response's identity map: entries that are not a full `key`/`rep`/`members`/`memberIds`
 * tuple are dropped (ROUND7 R7-1 — a map without member identity cannot classify within-group
 * changes, so it must not be half-trusted). Shared by both reader lists.
 */
export function coerceGroups(value: unknown): ScopeGroup[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((g): g is ScopeGroup =>
    typeof g === "object" && g !== null
    && typeof (g as ScopeGroup).key === "string" && typeof (g as ScopeGroup).rep === "string"
    && typeof (g as ScopeGroup).members === "number" && Number.isFinite((g as ScopeGroup).members)
    && Array.isArray((g as ScopeGroup).memberIds)
    && (g as ScopeGroup).memberIds.every((id) => typeof id === "string"));
}

/**
 * Decides "new content" from the server's scope-wide identity map, by DIFFING it against the map the
 * reader was shown. Additions are looked for first — a new group key, a member joining a surviving
 * group (by MEMBER IDENTITY, not the count — ROUND7 R7-1), then a surviving group that changed its
 * representative — and only a scope whose every change is a REMOVAL is absorbed silently. None of
 * these directions can be produced by a withdrawal, a reorder or a metadata-only write, and none of
 * them depends on a write instant, so commit-order inversions cannot hide an arrival either.
 *
 * Member identity, not the member count, is what the within-group comparison uses (ROUND7 R7-1): a
 * withdrawal and a joining can leave the count untouched, so the reader diffs the two id sets. A
 * pure removal (in a surviving group, or a whole group leaving) updates nothing and is absorbed by
 * the caller adopting the fresh baseline — which is also what keeps a later same-count replacement
 * from hiding behind a stale baseline.
 */
export function evaluateContent(baseline: ContentBaseline | null, fresh: ContentSignal): ContentVerdict {
  // No usable scope identity on the fresh side: decide nothing and do not silently move the baseline.
  if (fresh.total === null || fresh.tag === null || fresh.groups === null) return { hasNew: false, adopt: false };
  if (baseline === null) return { hasNew: false, adopt: true };
  const prev = byKey(baseline.groups);
  // Whether the fresh scope's only changes were REMOVALS: a surviving group lost members, or whole
  // groups left. Such a shrink is absorbed, never announced.
  let onlyRemovals = fresh.groups.length < prev.size;
  for (const g of fresh.groups) {
    const was = prev.get(g.key);
    // A group key the reader was never shown: an arrival, whatever the total did (ROUND5 W1 /
    // ROUND6 R6-2 — a net decrease must not be allowed to swallow this).
    if (!was) return { hasNew: true, adopt: false };
    // The group now speaks through someone else — wherever that group sits, including pages the
    // reader loaded long before (ROUND5 W2/W3, ROUND6 R6-1).
    if (g.rep !== was.rep) return { hasNew: true, adopt: false };
    // A member the reader does not have joined the group — even alongside one that left, which the
    // member count alone cannot classify (ROUND7 R7-1: the within-group swap counterexample).
    const freshIds = g.memberIds ?? [];
    const wasIds = new Set(was.memberIds ?? []);
    if (was.memberIds !== undefined && g.memberIds !== undefined) {
      if (freshIds.some((id) => !wasIds.has(id))) return { hasNew: true, adopt: false };
      // Only removals in this group: remembered, and announced by nobody.
      if (freshIds.length < was.memberIds.length) onlyRemovals = true;
    } else if (g.members > was.members) {
      // Degraded map without member identity: the count is the best available witness (ROUND6 R6-2).
      return { hasNew: true, adopt: false };
    }
  }
  // Only removals (or nothing) differ. A shrink is absorbed, never announced: nothing was admitted,
  // which is exactly what a pure retraction looks like from the outside. The caller replaces the
  // whole basis on adopt — a stale baseline is what let a later same-count replacement hide.
  if (onlyRemovals) return { hasNew: false, adopt: true };
  // Defensive: a growth or an identity-set change the map failed to explain still counts as news —
  // the map, not the count, is the primary witness, but these two must agree.
  if (fresh.total > baseline.total || fresh.tag !== baseline.tag) return { hasNew: true, adopt: false };
  return { hasNew: false, adopt: false };
}

/**
 * The baseline an absorbed scope becomes. The WHOLE basis is replaced, not just its numbers: after a
 * withdrawal the reader's stored identities no longer line up with the server's ordering, so keeping
 * them would turn the deletion backfill into a false "new content" on the next check. Only a check
 * with a usable scope identity may call this.
 */
export function adoptSignal(fresh: ContentSignal): ContentBaseline {
  return { total: fresh.total!, tag: fresh.tag!, groups: fresh.groups! };
}

/** Backoff after a failed check: 2× per consecutive failure, capped. */
export function newContentBackoff(failures: number): number {
  return Math.min(NEW_CONTENT_CHECK_MS * 2 ** Math.max(0, failures), NEW_CONTENT_MAX_BACKOFF_MS);
}

export interface NewContentNotice {
  hasNew: boolean;
  /** Run one check now (also resets the backoff clock on success). */
  checkNow: () => void;
  /** Consume the prompt after the reader clicked "更新". */
  consume: () => void;
}

/**
 * Drives the visibility-gated, backoff-ed, self-cleaning check loop. `check` must:
 * - abort on `signal`,
 * - throw on transport failure,
 * - verify `signal.aborted` after EVERY await and touch no shared state once it is aborted (the hook
 *   can only drop the RESULT of a superseded check — it cannot undo a baseline the callback already
 *   wrote, so `consume()` aborts the in-flight signal precisely to make that guard trip),
 * - return whether content the reader does not have is present.
 * `resetKey` is the active filter identity: changing it clears the prompt, the backoff and the
 * in-flight request.
 */
export function useNewContentNotice(check: (signal: AbortSignal) => Promise<boolean>, resetKey: string): NewContentNotice {
  const [hasNew, setHasNew] = useState(false);
  const failures = useRef(0);
  // The next moment ANY path may issue a check (ms epoch). Visibility recovery, timers and manual
  // checks all read it: toggling tabs quickly can never bypass a failure backoff.
  const nextAllowedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<AbortController | null>(null);
  // A tab that came back while a check was in flight wants one check when things settle.
  const pendingVisibleCheck = useRef(false);
  // Bumped by consume()/resetKey: a check that started BEFORE the reader applied an update (or
  // switched filters) must not resurrect the prompt when its late answer lands.
  const generation = useRef(0);
  const checkRef = useRef(check);
  checkRef.current = check;
  const runCheckRef = useRef<() => Promise<void>>(async () => {});
  const stopped = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const schedule = useCallback((delay: number) => {
    clearTimer();
    // The handle is dropped the moment the timer FIRES: a spent handle is not a pending check, and
    // leaving it in place would make the loop believe a successor is already armed (ROUND4 D5).
    timer.current = setTimeout(() => { timer.current = undefined; void runCheckRef.current(); }, delay);
  }, [clearTimer]);

  const runCheck = useCallback(async () => {
    if (stopped.current || inFlight.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    // Backoff binds every entry path, visibility recovery included: waiting for the remainder is
    // the recovery, not a bypass of it.
    const wait = nextAllowedAt.current - Date.now();
    if (wait > 0) { schedule(wait); return; }
    const controller = new AbortController();
    inFlight.current = controller;
    const started = generation.current;
    // Whether this run left a successor behind. A run revoked mid-flight (the reader applied an
    // update) or superseded by a filter change returns without scheduling — and a tab that is still
    // visible and mounted must not be left with no chain at all.
    let chained = false;
    try {
      // Bounded lifecycle: a hung check must not block all later ones. The deadline aborts the
      // request like any other transport failure; the caller's own abort still takes precedence.
      const deadline = AbortSignal.timeout(NEW_CONTENT_CHECK_TIMEOUT_MS);
      const signal = AbortSignal.any([controller.signal, deadline]);
      const changed = await checkRef.current(signal);
      if (controller.signal.aborted || signal.aborted) return;
      // The reader applied an update (or changed filters) while this check ran: its answer describes
      // a list that is no longer on screen, so it decides nothing and does not move the clock.
      if (started !== generation.current) return;
      chained = true;
      failures.current = 0;
      nextAllowedAt.current = 0;
      if (changed) setHasNew(true);
      schedule(NEW_CONTENT_CHECK_MS);
    } catch {
      if (controller.signal.aborted || started !== generation.current) return;
      chained = true;
      // Back off: consecutive failures stretch the next attempt, never pile up retries.
      failures.current += 1;
      nextAllowedAt.current = Date.now() + newContentBackoff(failures.current);
      schedule(newContentBackoff(failures.current));
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      // The tab came back while this request ran: make sure ONE check happens now that things
      // settled — at the next allowed moment, never earlier.
      if (pendingVisibleCheck.current) {
        pendingVisibleCheck.current = false;
        if (!stopped.current && typeof document !== "undefined" && !document.hidden) {
          schedule(Math.max(0, nextAllowedAt.current - Date.now()));
        }
      } else if (!chained && !stopped.current && typeof document !== "undefined" && !document.hidden && timer.current === undefined) {
        // Revoked by consume() while in flight: the reader's click must not silently end the loop.
        // Exactly ONE normal cycle is armed — the ordinary cadence, never a tighter retry.
        schedule(NEW_CONTENT_CHECK_MS);
      }
    }
  }, [schedule]);

  runCheckRef.current = runCheck;

  // Filter (or page identity) changed: the old baseline is meaningless, a late answer from the old
  // filter must not decide anything, and the prompt starts over.
  useEffect(() => {
    stopped.current = false;
    setHasNew(false);
    failures.current = 0;
    nextAllowedAt.current = 0;
    pendingVisibleCheck.current = false;
    generation.current += 1;
    inFlight.current?.abort();
    inFlight.current = null;
    schedule(NEW_CONTENT_CHECK_MS);
    return () => {
      stopped.current = true;
      clearTimer();
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [resetKey, schedule, clearTimer]);

  // Paused while hidden: the timer AND any in-flight check are stopped, so nothing advances while
  // the reader is away. A tab that becomes visible again checks once — unless the backoff window
  // from earlier failures has not elapsed yet, in which case the timer waits out the remainder.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        clearTimer();
        inFlight.current?.abort();
        inFlight.current = null;
      } else if (inFlight.current) {
        pendingVisibleCheck.current = true;
      } else {
        void runCheck();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [runCheck, clearTimer]);

  const checkNow = useCallback(() => { void runCheck(); }, [runCheck]);
  const consume = useCallback(() => {
    // Revoke, do not merely hide. A check already in flight is ABORTED so its own `signal.aborted`
    // guard trips after the parse and it never writes the shared baseline of the list the reader just
    // replaced; bumping the generation covers anything that still gets through.
    generation.current += 1;
    inFlight.current?.abort();
    inFlight.current = null;
    setHasNew(false);
  }, []);
  return { hasNew, checkNow, consume };
}
