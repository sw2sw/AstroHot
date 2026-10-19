import { Link, redirect, useLoaderData, useNavigate } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArxivFeed } from "@aihot/contracts/arxiv";
import { loadOr404, edgeTtl } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { MathText } from "../components/MathText";
import type { Screen } from "../components/shell/screens";
import { adoptSignal, coerceGroups, evaluateContent, useNewContentNotice, type ContentBaseline, type ContentSignal } from "../features/feed/new-content";
import { NewContentBanner } from "../features/feed/NewContentBanner";
import { ArxivPagination } from "../features/arxiv/ArxivPagination";

export const handle: Screen = { home: "me", name: "arXiv 候选" };
const NOTE = "AI 根据标题与摘要整理，请以论文原文为准。";
const CATEGORIES = ["astro-ph.CO", "astro-ph.EP", "astro-ph.GA", "astro-ph.HE", "astro-ph.IM", "astro-ph.SR"];
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  "astro-ph.CO": "宇宙学与河外天体物理",
  "astro-ph.EP": "地球与行星天体物理",
  "astro-ph.GA": "星系天文学",
  "astro-ph.HE": "高能天体物理",
  "astro-ph.IM": "天文仪器与方法",
  "astro-ph.SR": "太阳与恒星天体物理",
};
function categoryLabel(code: string): string {
  const label = CATEGORY_LABELS[code];
  return label ? `${label}（${code}）` : code;
}
/** Reject missing/invalid source dates before constructing a Date (null would become 1970). */
function utcDay(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const calendarDay = value.slice(0, 10);
  const midnight = new Date(`${calendarDay}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendarDay) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
function announcementDay(paper: ArxivFeed["items"][number]): string | null {
  return paper.announced_on?.length === 10 ? utcDay(paper.announced_on) : null;
}
function sourceDay(paper: ArxivFeed["items"][number]): string {
  return announcementDay(paper) ?? utcDay(paper.submitted_at) ?? "日期未知";
}
function sourceKind(paper: ArxivFeed["items"][number]): string {
  return announcementDay(paper) ? "公告" : utcDay(paper.submitted_at) ? "提交（UTC）" : "来源未提供日期";
}
function dayGroup(paper: ArxivFeed["items"][number]): string {
  return `${sourceDay(paper)}|${sourceKind(paper)}`;
}
function PaperDates({ paper }: { paper: ArxivFeed["items"][number] }) {
  const submitted = utcDay(paper.submitted_at);
  const updated = utcDay(paper.updated_at);
  if (!submitted && !updated) return null;
  return <p className="mt-1 text-xs text-ink-4">提交（UTC）：{submitted ? <time dateTime={paper.submitted_at!}>{submitted}</time> : "未知"} · 更新（UTC）：{updated ? <time dateTime={paper.updated_at!}>{updated}</time> : "未知"}</p>;
}
const STUDIES = { observation: "观测", simulation: "模拟", theory: "理论", method: "方法", mixed: "混合研究" };

/**
 * Set immediately before the click-to-update navigation and consumed by shouldRevalidate below. The
 * fresh head has ALREADY been fetched and parsed at that point, so re-running the loader would be a
 * second request for data the reader already has — and if it failed, the reader would lose the list
 * they were reading. The flag is disarmed on the next tick so a later navigation is never affected.
 */
let commitWithoutRevalidate = false;
export function shouldRevalidate() {
  if (commitWithoutRevalidate) { commitWithoutRevalidate = false; return false; }
  return true;
}

export async function loader({ request }: { request: Request }) {
  const input = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  // Keep duplicate parameters for the API to reject, rather than silently changing their meaning.
  for (const [key, value] of input) if (["page", "pageSize", "category"].includes(key)) params.append(key, value);
  const path = `/api/arxiv/items${params.size ? `?${params}` : ""}`;
  const feed = await loadOr404<ArxivFeed>(path, { signal: request.signal });
  // An out-of-range page is a real request the read layer answers with an EMPTY list while still echoing
  // the page it was asked for (publication/arxiv.ts accepts any positive page and returns it back).
  // Showing "page 11 of 10" over that empty list would be a label pretending to be data, and clamping
  // only the pager's own numbers would hide the disagreement instead of fixing it. The correction is
  // made in the DATA: the reader is sent to the page that really exists, so the URL, the paper list and
  // the pager all name the same page — a bookmarked deep page whose data shrank lands on the new last
  // page instead of an empty screen.
  const pageCount = Math.max(1, Math.ceil((Number.isFinite(feed.total) ? feed.total : 0) / (feed.pageSize > 0 ? feed.pageSize : 1)));
  if (feed.page > pageCount) {
    const corrected = new URLSearchParams(params);
    corrected.set("page", String(pageCount));
    throw redirect(`/arxiv?${corrected}`);
  }
  return { feed, category: input.get("category") };
}

export function meta() {
  return pageMeta({ title: "arXiv 天文初筛候选", path: "/arxiv", description: NOTE });
}
export function headers() { return edgeTtl(60); }

/**
 * New-content notice for the filtered candidate archive. The archive is ordered by official
 * announcement/submission dates, so newly admitted old-date papers can land on ANY page — the head
 * alone is NOT a reliable "new" signal. Detection diffs the scope-wide identity map the server
 * computes over the whole filtered set against the one the reader was shown (REVIEW-SHEEP-ROUND6
 * R6-2): a candidate id the baseline lacked is an arrival whatever the total did and however old its
 * write instant ranks against a concurrently committed one; only removals are absorbed. Timestamps
 * are witnesses, never the decision.
 */
function ArxivNewContent({ view, category, resetKey, onCommit }: {
  view: ArxivFeed; category: string | null; resetKey: string; onCommit: (page: ArxivFeed) => void;
}) {
  const navigate = useNavigate();
  // Baseline = what the reader is looking at, taken from the page the loader proved: every page of
  // this archive carries the same scope-wide signal, so a deep page is a baseline too. A
  // LEGITIMATELY EMPTY scope is a known baseline, not an unknown one — the loader proved the filter
  // is empty (an empty identity map), so the first paper to arrive can be announced on the very
  // first check instead of being absorbed (ROUND4 D6).
  const baselineRef = useRef<ContentBaseline | null>(null);
  const captureBaseline = useCallback(() => {
    baselineRef.current = view.contentTag === "" || !Array.isArray(view.groups)
      ? null
      : { total: view.total, tag: view.contentTag, groups: view.groups };
  }, [view]);
  useEffect(() => { captureBaseline(); }, [captureBaseline]);

  const check = useCallback(async (signal: AbortSignal) => {
    const res = await fetch(listPath("/api/arxiv/items", { page: 1, pageSize: view.pageSize, category }), { signal });
    if (!res.ok) throw new Error(String(res.status));
    const page = (await res.json()) as ArxivFeed;
    // The hook can drop the RESULT of a superseded check and consume() aborts the signal; nothing
    // shared is touched before this guard.
    if (signal.aborted) return false;
    const fresh: ContentSignal = {
      total: Number.isFinite(page.total) ? page.total : null,
      tag: typeof page.contentTag === "string" && page.contentTag !== "" ? page.contentTag : null,
      groups: coerceGroups(page.groups),
    };
    const verdict = evaluateContent(baselineRef.current, fresh);
    // Absorbing a shrink also REPLACES the whole basis with the server's current one: after a
    // withdrawal the reader's stored identities no longer line up, and keeping them would turn the
    // backfill into a false "new content" on the very next check (ROUND4 D3).
    if (verdict.adopt && fresh.total !== null && fresh.tag !== null) baselineRef.current = adoptSignal(fresh);
    return verdict.hasNew;
  }, [view.pageSize, category]);
  const notice = useNewContentNotice(check, resetKey);

  // The click is a CONTROLLED update: the fresh head is read and parsed first, and only a success
  // commits it as the list the reader sees (plus a URL change that reuses those bytes — never a
  // second request). A failure keeps THIS document — list, page, filters — and the banner stays up
  // as the retry entry. The request is bound to this filter and this component's lifetime.
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
      const res = await fetch(listPath("/api/arxiv/items", { page: 1, pageSize: view.pageSize, category }),
        { signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as ArxivFeed;
      // Past this point every call is a side effect, so it is gated on the request still being the
      // current one: a reader who switched category mid-flight must not be navigated back.
      if (controller.signal.aborted || applyController.current !== controller) return;
      notice.consume();
      onCommit(page);
      // The URL now names the list the reader sees. Revalidation is suppressed because the loader
      // would re-request the very page just parsed: the update must not depend on a second request.
      commitWithoutRevalidate = true;
      navigate(listPath("/arxiv", { page: 1, pageSize: view.pageSize, category }), { replace: view.page !== 1, preventScrollReset: true });
      setTimeout(() => { commitWithoutRevalidate = false; }, 0);
    } catch {
      if (!controller.signal.aborted) setUpdateState("failed");
    } finally {
      if (applyController.current === controller) applyController.current = null;
    }
  }, [category, view.pageSize, view.page, notice, onCommit, navigate]);
  if (!notice.hasNew) return null;
  return (
    <div className="py-3">
      <NewContentBanner
        visible
        updating={updateState === "updating"}
        error={updateState === "failed"}
        onClick={() => { void applyHead(); }}
      />
    </div>
  );
}

export function ArxivPageContent({ feed, category }: { feed: ArxivFeed; category: string | null }) {
  // The list the reader sees. It starts as the loader's data and is REPLACED only by the controlled
  // update below (a successful prefetch) or a real navigation (which changes `feed`).
  const [view, setView] = useState(feed);
  useEffect(() => { setView(feed); }, [feed]);
  const href = (page: number, selected = category) => listPath("/arxiv", { page, pageSize: view.pageSize, category: selected });
  return <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
    <PhoneBar back={{ to: "/more", label: "我的" }} title="arXiv 候选" />
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 py-4">
      <div>
        <h1 data-page-title="" className="text-[24px] font-semibold text-ink">arXiv 天文初筛候选</h1>
        <p role="note" className="mt-2 text-sm text-ink-3">{NOTE}</p>
        <p className="mt-1 text-xs text-ink-4">公告日期按 arXiv 批次；无公告日期时按提交日期（UTC）排列。</p>
      </div>
      <form action="https://arxiv.org/search/" method="get" target="_blank" rel="noopener noreferrer" role="search" aria-label="搜索 arXiv（在新标签页查看官方结果）" className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
        <label htmlFor="arxiv-query">搜索 arXiv</label>
        <input id="arxiv-query" name="query" required placeholder="关键词" className="w-32 rounded-control border border-line bg-transparent px-2 py-1.5 text-xs text-ink placeholder:text-ink-4" />
        <label htmlFor="arxiv-searchtype" className="sr-only">搜索范围</label>
        <select id="arxiv-searchtype" name="searchtype" className="rounded-control border border-line bg-transparent px-1.5 py-1.5 text-xs text-ink">
          <option value="all">全部字段</option>
          <option value="title">标题</option>
          <option value="author">作者</option>
          <option value="abstract">摘要</option>
        </select>
        <input type="hidden" name="abstracts" value="show" />
        <input type="hidden" name="order" value="-announced_date_first" />
        <button type="submit" className="rounded-control border border-line px-2 py-1.5 text-xs font-medium text-accent">搜索 ↗</button>
      </form>
      {view.latestBatch && view.latestBatch.outcome !== "selected" && <p role="status" className="w-full text-ink">{view.latestBatch.outcome === "no_new_papers" ? "本批次暂无已完成初筛的论文" : "本批次没有合适精选"}{view.total > 0 ? "，下方为历史候选" : ""}</p>}
    </header>
    <ArxivNewContent view={view} category={category} resetKey={category ?? "all"} onCommit={setView} />
    <h2 id="candidate-archive" className="mb-3 text-lg font-semibold text-ink">候选档案（含历史）</h2>
    <nav aria-label="天文方向过滤" className="mb-4 flex flex-wrap gap-2">
      {[null, ...CATEGORIES].map(c => <Link key={c ?? "all"} to={href(1, c)} aria-current={category === c ? "page" : undefined} className={`rounded-control border border-line px-3 py-2 text-sm ${category === c ? "bg-accent/10 text-accent" : "text-ink-3"}`}>{c ? categoryLabel(c) : "全部方向"}</Link>)}
    </nav>
    {view.items.length === 0 && <p className="card p-6 text-ink-3">{!view.latestBatch ? "尚未同步报告，候选档案暂无数据。" : view.total > 0 || view.page > 1 ? "此页暂无候选，请返回上一页。" : category ? "该方向暂无候选，请尝试其他方向或全部方向。" : "候选档案暂无精选候选。"}</p>}
    <ul aria-labelledby="candidate-archive" className="space-y-4">{view.items.map((paper, index) => <li key={paper.paper_key}>
      {(index === 0 || dayGroup(paper) !== dayGroup(view.items[index - 1]!)) && <h3 className="mb-3 text-base font-semibold text-ink">{sourceDay(paper)}<span className="ml-2 text-xs font-normal text-ink-4">{sourceKind(paper)}</span></h3>}
      <div className="card p-5">
      <h4 className="text-lg font-semibold text-ink"><MathText text={paper.title_zh} /></h4>
      <p lang="en" className="mt-1 text-sm text-ink-3"><MathText text={paper.title_original} /></p>
      <p className="mt-3 whitespace-pre-line leading-relaxed text-ink"><MathText text={paper.summary_zh} /></p>
      <p className="mt-3 text-sm text-ink-3">{STUDIES[paper.study_type]} · {paper.categories.map(categoryLabel).join(" / ")} · {paper.arxiv_id}</p>
      <PaperDates paper={paper} />
      <a className="mt-3 inline-block text-sm font-medium text-accent" href={paper.url} target="_blank" rel="noopener noreferrer">阅读 arXiv 原文 ↗</a>
      </div>
    </li>)}</ul>
    <ArxivPagination page={view.page} pageSize={view.pageSize} total={view.total} href={href} />
  </div>;
}

export default function ArxivPage() {
  const { feed, category } = useLoaderData<typeof loader>();
  return <ArxivPageContent feed={feed} category={category} />;
}

export function ErrorBoundary() {
  return <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
    <PhoneBar back={{ to: "/more", label: "我的" }} title="arXiv 候选" />
    <h1 className="py-4 text-xl font-semibold text-ink">arXiv 天文初筛候选</h1>
    <p role="note" className="text-sm text-ink-3">{NOTE}</p>
    <p role="alert" className="mt-4 text-ink-3">候选列表暂时不可用，或筛选页码无效。请稍后重试。</p>
    <Link className="mt-4 inline-block text-accent" to="/arxiv">重新打开候选列表</Link>
  </div>;
}
