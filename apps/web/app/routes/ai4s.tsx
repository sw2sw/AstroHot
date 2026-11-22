// The AI4S column (AI 赋能科学): its own flat lists (精选 / 全部动态) and a discipline filter whose
// "天文相关（AI4A）" entry is the verified AI4A subset. Reads the shared public API only; cards are text-first
// (the column has no image permission), reuse the site's card density, math rendering and native detail
// dialog, and state a limited intro's basis honestly instead of inventing a score or a full read. The
// original link lives in the detail (the shared item page), not on the card. A light head check surfaces
// the site's "有新内容，点击更新" prompt (照 arxiv): nothing moves until the reader clicks, and a failed
// update keeps the list they were reading.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, redirect, useLoaderData, useNavigate, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/ai4s";
import type { Ai4sFeedResponse, Ai4sItemSummary, ConferenceSummary } from "@aihot/contracts/site";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { AI4S_DOMAINS, AI4S_DOMAIN_KEYS, AI4S_DOMAIN_LABEL } from "@aihot/industry/ai4s";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { itemListLd, listPath, pageMeta } from "../lib/seo";
import { PillTabs } from "../components/ui/Tabs";
import { Pagination } from "../features/feed/DayList";
import { DayHeader, TimelineSlot } from "../features/feed/Timeline";
import { EmptyState } from "../components/ui/Page";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { IntentLink } from "../components/ui/IntentLink";
import { SelectedBadge } from "../components/ui/Badge";
import { ScoreLabel } from "../components/ui/Score";
import { MathText } from "../components/MathText";
import { SourceLine } from "../features/feed/parts";
import { markRead, useReadSet } from "../lib/local-state";
import { rememberPreview } from "../features/item/preview";
import { rememberOrigin, useReturnFocus } from "../features/item/return-focus";
import { loadRecentConferences } from "../lib/conferences.server";
import { ConferenceRecent } from "../features/conferences/Recent";
import { adoptSignal, coerceGroups, evaluateContent, useNewContentNotice, type ContentBaseline, type ContentSignal } from "../features/feed/new-content";
import { NewContentBanner } from "../features/feed/NewContentBanner";

export const handle: Screen = { tab: "featured", name: "AI4S" };

const TITLE = "AI4S · AI赋能科学";
const SUBTITLE = "追踪科研进展，关注AI与天文";

function cleanDomain(raw: string | null): string | null {
  if (!raw || raw === "all") return null;
  return raw === "astro" || (AI4S_DOMAIN_KEYS as readonly string[]).includes(raw) ? raw : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "selected" ? "selected" : "all";
  const domain = cleanDomain(url.searchParams.get("domain"));
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const data = await loadOr404<Ai4sFeedResponse>(
    listPath("/api/site/ai4s", { tab: tab === "selected" ? "selected" : null, domain, page: page > 1 ? page : null }),
    { signal: request.signal },
  );
  if (data.total > 0 && data.page > data.pageCount) throw redirect(pageHref(url.searchParams, data.pageCount));
  // 近期会议：首页一次公开读，不触发模型、不写库；没有就不显示这一块。
  const recent = page === 1 ? await loadRecentConferences("ai4s", request.signal) : [];
  return { data, recent };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const d = loaderData?.data;
  const path = listPath("/ai4s", { tab: d?.tab === "selected" ? "selected" : null, domain: d?.domain ?? null, page: (d?.page ?? 1) > 1 ? d!.page : null });
  return pageMeta({
    title: TITLE,
    description: `${SUBTITLE}。AI 赋能科学（AI4S）科研进展栏目，天文相关（AI4A）为其中经过原文证据核验的子集。`,
    path,
    jsonLd: itemListLd(path, TITLE, d?.items.map((i) => i.title) ?? []),
  });
}

export function headers() {
  return edgeTtl(60);
}

/**
 * Set immediately before the click-to-update navigation and consumed by shouldRevalidate below (照 arxiv).
 * The fresh head has ALREADY been fetched and parsed at that point, so re-running the loader would be a
 * second request for data the reader already has — and if it failed, the reader would lose the list they
 * were reading. Disarmed on the next tick so a later navigation is never affected.
 */
let commitWithoutRevalidate = false;
export function shouldRevalidate() {
  if (commitWithoutRevalidate) { commitWithoutRevalidate = false; return false; }
  return true;
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/ai4s?${s}` : "/ai4s";
}

function filterHref(params: URLSearchParams, over: { tab?: "selected" | "all"; domain?: string | null }) {
  const sp = new URLSearchParams(params);
  sp.delete("page");
  if (over.tab !== undefined) {
    if (over.tab === "selected") sp.set("tab", "selected");
    else sp.delete("tab");
  }
  if (over.domain !== undefined) {
    if (over.domain) sp.set("domain", over.domain);
    else sp.delete("domain");
  }
  const s = sp.toString();
  return s ? `/ai4s?${s}` : "/ai4s";
}

/** The API path of the filtered head (page one), shared by the check and the controlled update. */
function headPath(tab: "selected" | "all", domain: string | null) {
  return listPath("/api/site/ai4s", { tab: tab === "selected" ? "selected" : null, domain, page: null });
}

/**
 * The domain chip of a card. A verified AI4A card already carries the 「天文相关（AI4A）」 badge;
 * printing 天文与天体物理 beside it repeats the same fact in other words, so that one label is dropped
 * for this combination. Every other domain still gets its own chip.
 */
function ai4sDomainLabel(item: Pick<Ai4sItemSummary, "ai4a" | "domain">): string | null {
  if (!item.domain) return null;
  if (item.ai4a === true && item.domain === "astronomy-astrophysics") return null;
  return AI4S_DOMAIN_LABEL[item.domain] ?? item.domain;
}

/** One compact, text-first report. No image: the column holds no thumbnail permission. The original
 * link is in the detail (the shared item page), so the card carries no external anchor. */
export function Ai4sCard({ item, read, onOpen, at }: { item: Ai4sItemSummary; read: boolean; onOpen: (id: string) => void; at: string }) {
  const open = () => {
    // The shared article page renders the article's astronomy projection (its home column). This
    // card's selection and score belong to the AI4S column, so a cross-listed row must not cache them
    // as that page's chrome — only a native AI4S row's card is the same projection.
    if (!item.crossListed) rememberPreview(item);
    // Recorded before the navigation, so the list that comes back can put focus on this card again.
    rememberOrigin(item.id);
    onOpen(item.id);
  };
  return (
    <article className="@container relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[22px] items-center gap-1.5 text-[12.5px] leading-[18px] text-ink-4 lg:min-h-[18px] lg:gap-2">
        <SourceLine item={item} className="text-ink-4" />
        <time dateTime={at} className="mono shrink-0 text-[12px] lg:hidden">· {beijingTime(at)}</time>
        {item.selected && <span className="hidden lg:inline-flex"><SelectedBadge /></span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 lg:gap-1.5">
          <span className="hidden lg:inline-flex"><ScoreLabel score={item.score} /></span>
          <span className="lg:hidden"><ScoreLabel score={item.score} compact /></span>
        </span>
      </header>

      <div className="min-w-0">
        <h3 className={`mt-1.5 line-clamp-2 text-[17px] font-[650] leading-[1.5] lg:mt-2 lg:line-clamp-none lg:leading-[1.55] ${read ? "text-ink-4" : "text-ink"}`}>
          <IntentLink viewTransition to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
            <MathText text={item.title} />
          </IntentLink>
        </h3>
        {item.originalTitle && item.originalTitle !== item.title && (
          <p lang="en" className="mt-0.5 line-clamp-1 text-[12.5px] leading-[1.5] text-ink-4"><MathText text={item.originalTitle} /></p>
        )}
        {item.summary && <p className="mt-1 line-clamp-2 text-[14.5px] leading-[1.7] text-ink-3 lg:mt-2 lg:line-clamp-3 lg:text-[15px] lg:leading-[1.75]"><MathText text={item.summary} /></p>}
      </div>

      {(item.ai4a === true || ai4sDomainLabel(item) || item.accessNote) && (
        <div className="relative z-10 mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-4">
          {item.ai4a === true && <span className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">天文相关（AI4A）</span>}
          {ai4sDomainLabel(item) && <span>{ai4sDomainLabel(item)}</span>}
          {item.accessNote && <span className="text-note">{item.accessNote}</span>}
        </div>
      )}
    </article>
  );
}

/**
 * New-content notice for the filtered column (照 arxiv 的 commitWithoutRevalidate 模式). The feed carries
 * a scope-wide identity map; the check diffs it against the one the reader was shown, and only a click
 * applies the fresh head. A failure keeps THIS document — list, page, filters — and the banner stays up
 * as the retry entry. The request is bound to this filter and this component's lifetime.
 */
export function Ai4sNewContent({ view, tab, domain, resetKey, onCommit }: {
  view: Ai4sFeedResponse; tab: "selected" | "all"; domain: string | null; resetKey: string; onCommit: (page: Ai4sFeedResponse) => void;
}) {
  const navigate = useNavigate();
  const baselineRef = useRef<ContentBaseline | null>(null);
  const captureBaseline = useCallback(() => {
    baselineRef.current = view.contentTag === "" || !Array.isArray(view.groups)
      ? null
      : { total: view.total, tag: view.contentTag, groups: view.groups };
  }, [view]);
  useEffect(() => { captureBaseline(); }, [captureBaseline]);

  const check = useCallback(async (signal: AbortSignal) => {
    const res = await fetch(headPath(tab, domain), { signal });
    if (!res.ok) throw new Error(String(res.status));
    const page = (await res.json()) as Ai4sFeedResponse;
    // A superseded check must not write the baseline of a filter the reader already left.
    if (signal.aborted) return false;
    const fresh: ContentSignal = {
      total: Number.isFinite(page.total) ? page.total : null,
      tag: typeof page.contentTag === "string" && page.contentTag !== "" ? page.contentTag : null,
      groups: coerceGroups(page.groups),
    };
    const verdict = evaluateContent(baselineRef.current, fresh);
    if (verdict.adopt && fresh.total !== null && fresh.tag !== null) baselineRef.current = adoptSignal(fresh);
    return verdict.hasNew;
  }, [tab, domain]);
  const notice = useNewContentNotice(check, resetKey);

  const [updateState, setUpdateState] = useState<"updating" | "failed" | null>(null);
  const applyController = useRef<AbortController | null>(null);
  useEffect(() => () => applyController.current?.abort(), []);
  useEffect(() => { applyController.current?.abort(); applyController.current = null; setUpdateState(null); }, [resetKey]);
  const applyHead = useCallback(async () => {
    if (applyController.current) return;
    const controller = new AbortController();
    applyController.current = controller;
    setUpdateState("updating");
    try {
      const res = await fetch(headPath(tab, domain), { signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as Ai4sFeedResponse;
      // Past this point every call is a side effect, gated on the request still being the current one:
      // a reader who switched filters mid-flight must not be navigated back.
      if (controller.signal.aborted || applyController.current !== controller) return;
      notice.consume();
      onCommit(page);
      commitWithoutRevalidate = true;
      navigate(listPath("/ai4s", { tab: tab === "selected" ? "selected" : null, domain, page: null }), { replace: view.page !== 1, preventScrollReset: true });
      setTimeout(() => { commitWithoutRevalidate = false; }, 0);
    } catch {
      if (!controller.signal.aborted) setUpdateState("failed");
    } finally {
      if (applyController.current === controller) applyController.current = null;
    }
  }, [tab, domain, view.page, notice, onCommit, navigate]);
  if (!notice.hasNew) return null;
  return (
    <div className="py-3">
      <NewContentBanner visible updating={updateState === "updating"} error={updateState === "failed"} onClick={() => { void applyHead(); }} />
    </div>
  );
}

export function Ai4sPageContent({ data, recent = [] }: { data: Ai4sFeedResponse; recent?: ConferenceSummary[] }) {
  // The list the reader sees: starts as the loader's data, replaced only by a successful controlled
  // update or a real navigation (which changes `data`).
  const [view, setView] = useState(data);
  useEffect(() => { setView(data); }, [data]);
  // Coming back from a detail: focus returns to the card that opened it, for keyboard and pointer alike.
  useReturnFocus();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/ai4s";
  const readSet = useReadSet();
  const today = beijingDate(Date.now());
  const tab = view.tab;
  const domain = view.domain;
  const days = useMemo(() => {
    const out: Array<{ day: string; items: Ai4sItemSummary[] }> = [];
    for (const it of view.items) {
      const d = beijingDate(it.timelineAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(it);
      else out.push({ day: d, items: [it] });
    }
    return out;
  }, [view.items]);
  const domainItems = [{ key: "all", label: "全部领域" }, { key: "astro", label: "天文相关（AI4A）" }, ...AI4S_DOMAINS.map((d) => ({ key: d.key as string, label: d.label }))];
  const updated = view.updatedAt ? beijingTime(view.updatedAt) : null;
  const resetKey = `${tab}|${domain ?? "all"}`;

  return (
    <div className="pb-6">
      <PhoneBar back={{ to: "/", label: "精选" }} />
      <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{TITLE}</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">{SUBTITLE}</p>

      <div className="mb-4 mt-4 flex flex-wrap items-center justify-between gap-3">
        <PillTabs
          size="xs"
          layoutId="ai4s-tab"
          label="栏目视图"
          active={tab}
          items={(["all", "selected"] as const).map((t) => ({ key: t, label: t === "selected" ? "精选" : "全部动态", to: filterHref(params, { tab: t }) }))}
        />
        <span className="text-[12px] text-ink-4">
          共 <span className="num">{view.total >= 2000 ? "2000+" : view.total}</span> 条{updated ? <> · 更新于 <span className="num">{updated}</span></> : null}
        </span>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5" role="group" aria-label="领域筛选">
        {domainItems.map((d) => {
          const on = (domain ?? "all") === d.key;
          return (
            <Link
              key={d.key}
              to={filterHref(params, { domain: d.key === "all" ? null : d.key })}
              aria-current={on ? "true" : undefined}
              className={`inline-flex h-8 items-center rounded-full px-3 text-[13px] transition-colors ${on ? "bg-ink font-medium text-bg" : "bg-bg-sunk text-ink-3 hover:text-ink dark:bg-bg-muted/60"}`}
            >
              {d.label}
            </Link>
          );
        })}
      </div>

      {tab === "all" && <ConferenceRecent items={recent} scope="ai4s" />}

      <Ai4sNewContent view={view} tab={tab} domain={domain} resetKey={resetKey} onCommit={setView} />

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {view.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState title={tab === "selected" ? "这个筛选下暂无精选内容" : "这个筛选下暂无内容"}>
              {tab === "selected"
                ? "当前筛选下没有已精选的科研进展，可在「全部动态」浏览。"
                : domain === "astro"
                  ? "当前筛选下没有经过原文证据核验的天文相关（AI4A）材料，可换个领域看看。"
                  : domain
                    ? "当前领域下暂无已收录的科研进展，可换个领域或回到全部领域。"
                    : "当前筛选下暂无已收录的科研进展。"}
            </EmptyState>
          </div>
        ) : (
          days.map(({ day, items: list }) => (
            <section key={day} aria-label={day}>
              <DayHeader day={day} today={today} count={null} />
              <ol className="lg:pt-1">
                {list.map((it) => (
                  <TimelineSlot key={it.id} at={it.timelineAt}>
                    <Ai4sCard item={it} read={readSet.has(it.id)} onOpen={markRead} at={it.timelineAt} />
                  </TimelineSlot>
                ))}
              </ol>
            </section>
          ))
        )}
      </div>
      <Pagination page={view.page} pageCount={view.pageCount} href={(p) => pageHref(params, p)} />
      {view.page >= 50 && <p className="mt-4 text-center text-[12px] text-ink-4">最多提供 50 页。</p>}
    </div>
  );
}

export default function Ai4sPage() {
  const { data, recent } = useLoaderData<typeof loader>();
  return <Ai4sPageContent data={data} recent={recent} />;
}