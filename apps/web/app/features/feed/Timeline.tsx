// The day-grouped feed (精选 home, topics): a time rail with cards on desktop, rows under grey day bars on
// phones. Keeps its place across back navigation and loads further pages. A light head check surfaces a
// compact "有新内容" prompt (R10); nothing moves until the reader clicks it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";
import { Collapse } from "../../components/ui/Presence";
import type { ScopeGroup, TimelineCard, TimelineFilters, TimelineResponse } from "@aihot/contracts/site";
import { FeedItem } from "./FeedItem";
import { IconChevronDown } from "../../components/icons";
import { RingMark } from "../../components/Logo";
import { EmptyState } from "../../components/ui/Page";
import { beijingDate, beijingTime, beijingWeekday } from "@aihot/contracts/time";
import { monthDayYear, weekdayShort } from "../../lib/format";
import { isHydrated } from "../../lib/hydration";
import { markRead, useReadSet } from "../../lib/local-state";
import { filterParams, listPath } from "../../lib/seo";
import { isReload, readSnapshot, restoreAnchor, saveSnapshot, useSaveOnLeave } from "../../lib/restore";
import { adoptSignal, coerceGroups, evaluateContent, useNewContentNotice, type ContentBaseline, type ContentSignal } from "./new-content";
import { NewContentBanner } from "./NewContentBanner";

const AUTO_BATCHES = 3;

interface ListState {
  version: 7;
  cards: TimelineCard[];
  nextCursor: string | null;
  dayCounts: Record<string, number>;
  collapsed: string[];
  batches: number;
  /** Groups in the whole filtered scope when this HEAD was read; null for an older snapshot. */
  total: number | null;
  /** Identity-set fingerprint of the scope when this head was read; null for an older snapshot. */
  tag: string | null;
  /** The scope's comparable identity map when this head was read; null for an older snapshot. */
  groups: ScopeGroup[] | null;
}

/** The scope fields a head establishes, with the response's names folded into the detection ones. */
type HeadSignal = { total: number | null; tag: string | null; groups: ScopeGroup[] | null };

function fromResponse(r: TimelineResponse): ListState {
  return {
    version: 7, cards: r.cards, nextCursor: r.nextCursor, dayCounts: r.dayCounts, collapsed: [], batches: 1,
    // Coerced, not trusted: a response that carries no scope signal (a partial or stubbed body) must
    // leave the baseline UNKNOWN rather than hand the comparison `undefined`.
    total: typeof r.total === "number" ? r.total : null,
    tag: typeof r.contentTag === "string" ? r.contentTag : null,
    groups: coerceGroups(r.groups),
  };
}

/**
 * Restores a saved list. Snapshots written before version 7 (v2 had no scope signal at all, v3's tag
 * mixed in display anchors and its "newest" was the first card's sort anchor, v4's "newest" was a
 * release/discovery date a historic import can leave untouched, v5 compared whole-scope hashes which
 * cannot tell a group that left from a surviving group that changed its speaker — ROUND6 R6-1, v6
 * compared member COUNTS, which cannot classify a within-group swap and never adopted a surviving
 * group's pure member withdrawal — ROUND7 R7-1) keep their cards, cursor and folding, but their
 * signal fields are UNKNOWN: the baseline stays unknown until the first successful check
 * re-establishes it, instead of a differently-defined value being compared against the new signal.
 */
function restoreList(data: (Omit<ListState, "version"> & { version?: number }) | undefined): ListState | null {
  if (!data || (data.version !== 2 && data.version !== 3 && data.version !== 4 && data.version !== 5 && data.version !== 6 && data.version !== 7) || data.cards.length === 0) return null;
  const known = data.version === 7;
  return {
    version: 7,
    cards: data.cards,
    nextCursor: data.nextCursor ?? null,
    dayCounts: data.dayCounts ?? {},
    collapsed: data.collapsed ?? [],
    batches: data.batches ?? 1,
    total: known && typeof data.total === "number" ? data.total : null,
    tag: known && typeof data.tag === "string" ? data.tag : null,
    groups: known ? coerceGroups(data.groups) : null,
  };
}

/** Sticky day header under the phone bar: a quiet row on desktop, a grey full-width bar on phones. */
export function DayHeader({ day, today, count, collapsed, onToggle, aside }: { day: string; today: string; count: number | null; collapsed?: boolean; onToggle?: () => void; aside?: React.ReactNode }) {
  const date = monthDayYear(day);
  const weekday = beijingWeekday(day);
  const short = weekdayShort(day);
  const phoneRow = (
    <>
      <span className="text-[14px] font-bold text-ink">{day === today ? "今天" : date}</span>
      {day === today && <span className="text-[12.5px] text-ink-4">{date}</span>}
      <span className="text-[12.5px] text-ink-4">{short}</span>
      <span className="ml-auto flex items-center gap-1 text-[12.5px] text-ink-4">
        {aside}
        {count !== null && (
          <span>
            <span className="num">{count}</span> 条
          </span>
        )}
        {onToggle && <IconChevronDown size={15} className={`transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />}
      </span>
    </>
  );
  return (
    <div className="bleed sticky top-[var(--bar-h)] z-20 bg-daybar lg:mx-0 lg:bg-bg lg:px-0">
      {/* Phones: a full-width day bar; on the timeline the whole bar folds the day. */}
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} aria-label={`${collapsed ? "展开" : "收起"}${date}`} className="flex h-11 w-full items-center gap-2 text-left lg:hidden">
          {phoneRow}
        </button>
      ) : (
        <div className="flex h-9 items-center gap-2 lg:hidden">{phoneRow}</div>
      )}
      {/* Desktop: date text shares the page's left edge, regardless of how many digits it has. */}
      <div className="hidden h-11 items-center gap-3 lg:flex">
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="whitespace-nowrap text-left text-[18px] font-semibold leading-6 text-ink">
            {date}
          </button>
        ) : (
          <time dateTime={day} className="whitespace-nowrap text-[18px] font-semibold leading-6 text-ink">{date}</time>
        )}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `展开${date}` : `收起${date}`}
            className="grid size-6 place-items-center justify-self-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
          >
            <IconChevronDown size={14} className={`transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        ) : null}
        <span className="text-[13px] text-ink-4">
          {weekday}
          {count !== null && (
            <>
              {" · "}
              <span className="num">{count}</span> 条
            </>
          )}
        </span>
        {aside && <span className="ml-auto text-[12px] text-ink-4">{aside}</span>}
      </div>
    </div>
  );
}

/**
 * One dated slot: the time, the rail (desktop) and the item. As on the original timeline, the rail is a
 * 1px line from this node's centre to the next one's, so the day reads as one continuous thread.
 */
export function TimelineSlot({ at, children, fresh = false, delay = 0, dataKey }: { at: string; children: React.ReactNode; fresh?: boolean; delay?: number; dataKey?: string }) {
  return (
    <li
      data-card-key={dataKey}
      className={`group/slot bleed touch:has-[a:active]:bg-bg-sunk/70 lg:mx-0 lg:px-0 lg:touch:has-[a:active]:bg-transparent ${fresh ? "animate-fade-up" : ""}`}
      style={fresh ? { animationDelay: `${delay}ms` } : undefined}
    >
      {/* Phones: the row without the rail (the item shows its time); a hairline between rows. */}
      <div className="grid grid-cols-[minmax(0,1fr)] border-b border-line-soft py-3.5 group-last/slot:border-b-0 lg:grid-cols-[64px_22px_minmax(0,1fr)] lg:border-b-0 lg:py-0 lg:pb-3 lg:group-last/slot:pb-0">
        <time dateTime={at} className="mono hidden text-ink-3 lg:block lg:pt-[17px] lg:text-[12.5px] lg:font-semibold lg:leading-6">
          {beijingTime(at)}
        </time>
        <span aria-hidden="true" className="relative hidden lg:block">
          <span className="absolute -bottom-[41px] left-[10.5px] top-[29px] w-px bg-line-strong group-last/slot:hidden" />
          <span className="absolute left-[7.5px] top-[25.5px] size-[7px] rounded-full bg-accent shadow-[0_0_0_4px_var(--bg)] transition-transform duration-300 group-hover/slot:scale-[1.15]" />
        </span>
        {children}
      </div>
    </li>
  );
}

export function Timeline({ initial, filters }: { initial: TimelineResponse; filters: TimelineFilters }) {
  const location = useLocation();
  const navigation = useNavigation();
  const readSet = useReadSet();
  const historyKey = location.key;

  // Back navigation (client side): restore synchronously from the snapshot. A full reload restores
  // after hydration so the first client render matches the server HTML.
  const [state, setState] = useState<ListState>(() => {
    if (isHydrated()) {
      const restored = restoreList(readSnapshot<ListState>(historyKey)?.data);
      if (restored) return restored;
    }
    return fromResponse(initial);
  });
  const restoredRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [freshKeys, setFreshKeys] = useState<Set<string>>(() => new Set());
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- New-content detection baseline ----------------------------------------------------------
  // The baseline is the SCOPE THE READER HAS BEEN SHOWN. It is committed at exactly the points where
  // the head list is established — the initial load, a filter change, a same-filter refresh, a cursor
  // reset that re-reads page one, and the reader's own click-to-update — and NOWHERE else. A deep-page
  // append or a collapsed day is not a new scope: letting either advance the baseline would swallow
  // content the reader was never shown (ROUND4 D1).
  const baseline = useRef<ContentBaseline | null>(null);
  const commitBaseline = useCallback((signal: HeadSignal) => {
    if (signal.total === null || signal.tag === null || signal.groups === null) { baseline.current = null; return; }
    baseline.current = { total: signal.total, tag: signal.tag, groups: signal.groups };
  }, []);
  const commitFromState = useCallback((s: ListState) => {
    commitBaseline({ total: s.total, tag: s.tag, groups: s.groups });
  }, [commitBaseline]);
  // A snapshot restore (or any earlier head) already committed the baseline: the one-shot mount
  // commit must not overwrite it with the server's fresh head.
  const baselineCommitted = useRef(false);
  const commitHead = useCallback((s: ListState) => { baselineCommitted.current = true; commitFromState(s); }, [commitFromState]);
  useEffect(() => {
    if (baselineCommitted.current) return;
    commitHead(stateRef.current);
  }, [commitHead]);

  // Filters (i.e. the loader data) changed. A page still loading for the old filters is cancelled, and a
  // response that arrives anyway is dropped (it belongs to another list and cursor). Back or forward to a
  // filter already visited restores what that history entry had loaded and folded; a new one starts over.
  const filterKey = listPath("/api/site/timeline", filterParams(filters));
  const lastFilterKey = useRef(filterKey);
  const pageRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pageRequest.current?.abort(), []);
  useLayoutEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      pageRequest.current?.abort();
      pageRequest.current = null;
      setLoadingMore(false);
      setLoadError(false);
      const snap = readSnapshot<ListState>(historyKey);
      const restored = restoreList(snap?.data);
      if (restored) {
        setState(restored);
        commitHead(restored);
        if (snap) restoreAnchor(snap.anchor, snap.scrollY);
      } else {
        const next = fromResponse(initial);
        setState(next);
        commitHead(next);
      }
    }
  }, [filterKey, initial, historyKey]);

  // The same list with new data (the tab tapped again at the top, or the brand tapped): start over from
  // the fresh head. A change of filters is handled above.
  const lastData = useRef({ initial, filterKey });
  useLayoutEffect(() => {
    const prev = lastData.current;
    lastData.current = { initial, filterKey };
    if (prev.initial === initial || prev.filterKey !== filterKey) return;
    pageRequest.current?.abort();
    pageRequest.current = null;
    setLoadingMore(false);
    setLoadError(false);
    const next = fromResponse(initial);
    setState(next);
    commitHead(next);
  }, [initial, filterKey]);

  useLayoutEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const snap = readSnapshot<ListState>(historyKey);
    const restored = restoreList(snap?.data);
    if (!isHydrated()) {
      // A full load keeps the server's fresh list when the reader reloaded; after a back/forward
      // that reloaded the document, it restores the saved list and position.
      if (restored && !isReload() && snap) {
        setState(restored);
        commitHead(restored);
        requestAnimationFrame(() => restoreAnchor(snap.anchor, snap.scrollY));
      }
      return;
    }
    if (restored && snap) restoreAnchor(snap.anchor, snap.scrollY);
  }, [historyKey]);

  // Save the snapshot whenever we leave this history entry.
  useEffect(() => {
    if (navigation.state === "loading" && navigation.location && navigation.location.key !== historyKey) {
      saveSnapshot(historyKey, stateRef.current);
    }
  }, [navigation.state, navigation.location, historyKey]);
  useSaveOnLeave(historyKey, () => stateRef.current);

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    if (!s.nextCursor || pageRequest.current) return;
    const key = listPath("/api/site/timeline", filterParams(filters));
    const controller = new AbortController();
    pageRequest.current = controller;
    const current = () => lastFilterKey.current === key && !controller.signal.aborted;
    setLoadingMore(true);
    setLoadError(false);
    try {
      const res = await fetch(listPath("/api/site/timeline", { ...filterParams(filters), cursor: s.nextCursor }), { signal: controller.signal });
      if (res.status === 400) {
        // Cursor no longer fits: start over from the head. The body is parsed BEFORE the ownership
        // check, so a filter switch (or an unmount) during the parse cannot let a stale body replace
        // the list the reader is now looking at (ROUND4 D4).
        const head = await fetch(key, { signal: controller.signal });
        if (!head.ok) throw new Error(String(head.status));
        const fresh = (await head.json()) as TimelineResponse;
        if (!current()) return;
        const next = fromResponse(fresh);
        setState(next);
        commitHead(next);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as TimelineResponse;
      if (!current()) return;
      setState((prev) => {
        const seen = new Set(prev.cards.map((c) => c.key));
        const added = page.cards.filter((c) => !seen.has(c.key));
        setFreshKeys(new Set(added.map((c) => c.key)));
        // A deep-page append never advances the scope signal: the reader has not been shown the new
        // head, so committing this page's scope-wide numbers would swallow exactly the content the
        // check is supposed to announce (ROUND4 D1).
        return {
          ...prev,
          cards: [...prev.cards, ...added],
          nextCursor: page.nextCursor,
          dayCounts: { ...prev.dayCounts, ...page.dayCounts },
          batches: prev.batches + 1,
        };
      });
    } catch {
      if (current()) setLoadError(true);
    } finally {
      if (pageRequest.current === controller) {
        pageRequest.current = null;
        setLoadingMore(false);
      }
    }
  }, [filters, commitHead]);

  // Auto-load a few batches when the sentinel nears the viewport, then hand over to a button.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !state.nextCursor || state.batches >= AUTO_BATCHES) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    }, { rootMargin: "900px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [state.nextCursor, state.batches, loadMore]);

  // New-content notice: a light check of the filtered list every 120s while visible; nothing moves
  // until the reader clicks. Detection diffs the scope-wide identity map the server computes against
  // the one the reader was shown (see new-content.ts): a new group key, a member joining a surviving
  // group (by member id, ROUND7 R7-1) and a surviving group that changed its representative each
  // prompt on their own; a scope whose every change is a removal never prompts, and its fresh map
  // becomes the baseline. The baseline itself is committed only where the head list is established.
  const newContentCheck = useCallback(async (signal: AbortSignal) => {
    const res = await fetch(listPath("/api/site/timeline", filterParams(filters)), { signal });
    if (!res.ok) throw new Error(String(res.status));
    const page = (await res.json()) as TimelineResponse;
    // A superseded check must not write the baseline of a filter the reader already left: the hook
    // can drop the RESULT, and consume() aborts the signal precisely so this guard trips.
    if (signal.aborted) return false;
    const fresh: ContentSignal = {
      total: typeof page.total === "number" ? page.total : null,
      tag: typeof page.contentTag === "string" ? page.contentTag : null,
      groups: coerceGroups(page.groups),
    };
    const verdict = evaluateContent(baseline.current, fresh);
    // Absorbing a shrink also REPLACES the whole basis with the server's current one: the reader's
    // stored identities no longer line up after a withdrawal, and keeping them would turn the
    // deletion backfill into a false "new content" on the very next check (ROUND4 D3).
    if (verdict.adopt && fresh.total !== null && fresh.tag !== null) baseline.current = adoptSignal(fresh);
    return verdict.hasNew;
  }, [filters]);
  const newContent = useNewContentNotice(newContentCheck, filterKey);
  // Click-to-update state: the banner stays up and becomes the retry entry when the request fails;
  // only a SUCCESS that actually replaced the list consumes the prompt (R10: 失败保留原列表+重试).
  const [updateError, setUpdateError] = useState(false);
  const [updating, setUpdating] = useState(false);
  const updatingRef = useRef(false);
  const applyNewContent = useCallback(async () => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    setUpdating(true);
    setUpdateError(false);
    // Take over the page request slot: an in-flight loadMore is aborted and ITS loading state is
    // reset HERE — the old request's finally no longer matches the controller, so without this the
    // page footer could stick on "正在加载" forever.
    pageRequest.current?.abort();
    pageRequest.current = null;
    setLoadingMore(false);
    setLoadError(false);
    const controller = new AbortController();
    pageRequest.current = controller;
    const current = () => lastFilterKey.current === filterKey && !controller.signal.aborted;
    try {
      const res = await fetch(listPath("/api/site/timeline", filterParams(filters)), { signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as TimelineResponse;
      if (!current()) return;
      // Only a SUCCESS that actually replaced the list commits: the fresh head becomes the list the
      // reader sees AND the detection baseline, and only then is the prompt consumed.
      const next = fromResponse(page);
      setState(next);
      commitHead(next);
      newContent.consume();
    } catch {
      if (current()) setUpdateError(true);
    } finally {
      if (pageRequest.current === controller) pageRequest.current = null;
      updatingRef.current = false;
      setUpdating(false);
    }
  }, [filters, filterKey, newContent.consume, commitHead]);

  const today = beijingDate(Date.now());
  const days = useMemo(() => {
    const out: Array<{ day: string; cards: TimelineCard[] }> = [];
    for (const c of state.cards) {
      const d = beijingDate(c.anchorAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.cards.push(c);
      else out.push({ day: d, cards: [c] });
    }
    return out;
  }, [state.cards]);

  const toggleDay = (day: string) =>
    setState((s) => ({ ...s, collapsed: s.collapsed.includes(day) ? s.collapsed.filter((d) => d !== day) : [...s.collapsed, day] }));

  let order = 0;
  return (
    <div className="relative">
      {newContent.hasNew && <NewContentBanner visible updating={updating} error={updateError} onClick={() => void applyNewContent()} />}
      {days.length === 0 && (
        <div className="lg:card">
          <EmptyState title="这个筛选下还没有精选内容">换个类别看看，或者去全部动态里找找。</EmptyState>
        </div>
      )}

      {days.map(({ day, cards }) => {
        const collapsed = state.collapsed.includes(day);
        const count = state.dayCounts[day] ?? cards.length;
        return (
          <section key={day} aria-label={day} className="lg:mb-1">
            <DayHeader day={day} today={today} count={count} collapsed={collapsed} onToggle={() => toggleDay(day)} />
            <Collapse open={!collapsed}>
                <ol className="lg:pt-1">
                  {cards.map((c) => {
                    const fresh = freshKeys.has(c.key);
                    const delay = fresh ? Math.min(order++, 10) * 40 : 0;
                    return (
                      <TimelineSlot key={c.key} dataKey={c.key} at={c.anchorAt} fresh={fresh} delay={delay}>
                        <FeedItem item={c.item} group={c.group} filters={filters} read={readSet.has(c.item.id)} onOpen={markRead} at={c.anchorAt} />
                      </TimelineSlot>
                    );
                  })}
                </ol>
            </Collapse>
          </section>
        );
      })}

      <div ref={sentinel} aria-hidden="true" />
      <FeedEnd loading={loadingMore} error={loadError} hasMore={!!state.nextCursor} manual={state.batches >= AUTO_BATCHES} empty={state.cards.length === 0} onMore={loadMore} />
    </div>
  );
}

/** The foot of a paged list: loading, retry, "加载更多" after a few automatic pages, or the end. */
function FeedEnd({ loading, error, hasMore, manual, empty, onMore }: { loading: boolean; error: boolean; hasMore: boolean; manual: boolean; empty: boolean; onMore: () => void }) {
  return (
    <div className="flex justify-center py-6">
      {loading ? (
        <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-4">
          <RingMark className="size-4 text-accent" spinning /> 正在加载
        </span>
      ) : error ? (
        <button type="button" onClick={onMore} className="h-9 rounded-full border border-hot/30 px-4 text-[13px] text-hot hover:bg-hot-soft">
          加载失败，点此重试
        </button>
      ) : hasMore ? (
        manual && (
          <button type="button" onClick={onMore} className="h-9 rounded-full border border-line-strong bg-surface px-5 text-[13px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink">
            加载更多
          </button>
        )
      ) : (
        !empty && <span className="text-[12px] text-ink-4">已经到底了</span>
      )}
    </div>
  );
}
