// 学术会议汇总（/conferences）：天文与 AI4S 两个栏目里被识别为会议通知的内容，按会议身份去重后
// 在这里汇总。会议不是新闻：它不参与精选、不改变原文章的栏目或跨列，也不产生额外模型调用。
// 页面只读一次公开接口；日期精度保留到日，没有日期就进「待定」，不改写成猜测的时间。
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, redirect, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/conferences";
import type { ConferenceHubResponse, ConferenceScope, ConferenceSummary } from "@aihot/contracts/site";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { fullDateTime } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { Pagination } from "../features/feed/DayList";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { deadlineLabel, phaseBadge, placeLabel, rangeLabel } from "../features/conferences/format";

export const handle: Screen = { tab: "featured", name: "学术会议" };

const TITLE = "学术会议";
const SUBTITLE = "天文与 AI4S 两个栏目的会议通知，按会议汇总";

const cleanScope = (raw: string | null): ConferenceScope => (raw === "astro" || raw === "ai4s" ? raw : "all");

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const scope = cleanScope(url.searchParams.get("scope"));
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const data = await loadOr404<ConferenceHubResponse>(
    listPath("/api/site/conferences", { scope: scope === "all" ? null : scope, page: page > 1 ? page : null }),
    { signal: request.signal },
  );
  if (data.total > 0 && data.page > data.pageCount) throw redirect(pageHref(url.searchParams, data.pageCount));
  return { data };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const d = loaderData?.data;
  const path = listPath("/conferences", { scope: d && d.scope !== "all" ? d.scope : null, page: (d?.page ?? 1) > 1 ? d!.page : null });
  return pageMeta({
    title: TITLE,
    description: `${SUBTITLE}。会期、地点、报名与投稿截止都取自通知原文；原文没有写明的信息不补。`,
    path,
  });
}

export function headers() {
  return edgeTtl(60);
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/conferences?${s}` : "/conferences";
}

function scopeHref(scope: ConferenceScope) {
  return scope === "all" ? "/conferences" : `/conferences?scope=${scope}`;
}

/** 整卡打开详情：按钮而不是链接，卡内不嵌套任何链接。 */
export function ConferenceCard({ item, onOpen }: { item: ConferenceSummary; onOpen: (c: ConferenceSummary, el: HTMLElement) => void }) {
  const place = placeLabel(item);
  const badge = phaseBadge(item);
  return (
    <li id={`conf-${item.id}`} className="min-w-0">
      <button
        type="button"
        onClick={(event) => onOpen(item, event.currentTarget)}
        aria-haspopup="dialog"
        className="flex h-full w-full flex-col items-start gap-1.5 rounded-card border border-line-soft bg-surface px-3.5 py-3 text-left transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:bg-bg-sunk lg:px-4 lg:py-3.5"
      >
        <span className="flex w-full flex-wrap items-center gap-1.5 text-[12px] text-ink-4">
          <span className="num">{rangeLabel(item)}</span>
          {badge && <span className={`rounded-full px-1.5 py-0.5 ${item.phase === "ongoing" ? "bg-accent/10 font-medium text-accent" : "bg-bg-sunk"}`}>{badge}</span>}
        </span>
        <span className="line-clamp-2 text-[15.5px] font-[650] leading-[1.5] text-ink lg:text-[16px]">{item.name}</span>
        {place && <span className="text-[12.5px] text-ink-3">{place}</span>}
        {item.deadlines.length > 0 && (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-ink-4">
            {item.deadlines.map((d) => (
              <span key={d.kind} className={d.state === "closed" ? "text-ink-4 line-through decoration-1" : d.state === "today" ? "text-accent" : ""}>
                {deadlineLabel(d)}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-[13.5px] leading-[1.6]">
      <dt className="w-[4.5em] shrink-0 text-ink-4">{label}</dt>
      <dd className="min-w-0 text-ink-2">{children}</dd>
    </div>
  );
}

/** 安全外链：新窗口打开，带 rel，不把站内读者交给来源页的脚本。 */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline-offset-2 hover:underline">{children}</a>;
}

function ConferenceDialog({ item, onClose, opener }: { item: ConferenceSummary; onClose: () => void; opener: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    // ESC 关闭后焦点回到打开它的那张卡（原生 dialog 只在部分浏览器里自动做，这里显式兜底）。
    return () => {
      if (el.open) el.close();
      opener?.focus();
    };
  }, [opener]);
  const place = placeLabel(item);
  const badge = phaseBadge(item);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-card border border-line bg-surface p-5 text-left text-ink shadow-xl backdrop:bg-black/65 sm:p-6 [overflow-wrap:anywhere]"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-4">
        <span className="num">{rangeLabel(item)}</span>
        {badge && <span className={`rounded-full px-1.5 py-0.5 ${item.phase === "ongoing" ? "bg-accent/10 font-medium text-accent" : "bg-bg-sunk"}`}>{badge}</span>}
      </div>
      <h2 id={titleId} className="mt-1.5 text-xl font-semibold leading-8">{item.name}{item.edition ? <span className="ml-2 text-[13px] font-normal text-ink-4">{item.edition}</span> : null}</h2>
      <dl className="mt-3 border-t border-line-soft pt-2">
        <Field label="会期">
          <span className="num">{item.startDate ? rangeLabel(item) : "原文未写明日期"}</span>
        </Field>
        {place && <Field label="地点">{place}</Field>}
        {item.venue && <Field label="会场">{item.venue}</Field>}
        {item.organizer && <Field label="主办">{item.organizer}</Field>}
        {item.deadlines.length > 0 && (
          <Field label="截止">
            <span className="flex flex-col gap-0.5">
              {item.deadlines.map((d) => <span key={d.kind}>{deadlineLabel(d)}</span>)}
            </span>
          </Field>
        )}
        {item.registrationUrl && <Field label="报名"><ExternalLink href={item.registrationUrl}>{item.registrationUrl}</ExternalLink></Field>}
        {item.officialUrl && <Field label="官网"><ExternalLink href={item.officialUrl}>{item.officialUrl}</ExternalLink></Field>}
        <Field label="更新"><span className="num">{fullDateTime(item.verifiedAt)}</span></Field>
      </dl>
      {item.notice && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <p className="text-[12px] text-ink-4">信息来源（通知原文）</p>
          <Link viewTransition to={`/items/${item.notice.id}`} className="mt-1 block text-[14px] font-medium leading-[1.6] text-ink hover:text-accent">
            {item.notice.title}
          </Link>
          {item.notice.summary && <p className="mt-1.5 line-clamp-4 text-[13.5px] leading-[1.75] text-ink-3">{item.notice.summary}</p>}
          <p className="mt-1 text-[12px] text-ink-4">{item.notice.source}</p>
        </div>
      )}
      <button type="button" autoFocus onClick={() => dialog.current?.close()} className="mt-5 min-h-11 rounded-control border border-line px-4 text-sm hover:bg-bg-sunk">关闭 ×</button>
    </dialog>
  );
}

export function ConferencesPageContent({ data }: { data: ConferenceHubResponse }) {
  const [params] = useSearchParams();
  const [open, setOpen] = useState<{ item: ConferenceSummary; opener: HTMLElement } | null>(null);
  const openDetail = useCallback((item: ConferenceSummary, el: HTMLElement) => setOpen({ item, opener: el }), []);
  const close = useCallback(() => setOpen(null), []);

  const upcoming = data.items.filter((c) => c.phase === "ongoing" || c.phase === "upcoming");
  const ended = data.items.filter((c) => c.phase === "ended");
  // A person's state is its own group: a cancelled or unsettled event is not listed as upcoming, and it
  // is not filed under "ended" on the strength of dates it no longer holds.
  const unsettled = data.items.filter((c) => c.phase === "cancelled" || c.phase === "postponed");
  const undated = data.items.filter((c) => c.phase === "undated");
  const filters: Array<{ key: ConferenceScope; label: string }> = [
    { key: "all", label: "全部" }, { key: "astro", label: "天文" }, { key: "ai4s", label: "AI4S" },
  ];

  return (
    <div className="pb-8">
      <PhoneBar back={{ to: "/", label: "精选" }} />
      <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{TITLE}</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">{SUBTITLE}</p>

      <div className="mb-4 mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="会议方向筛选">
          {filters.map((f) => {
            const on = data.scope === f.key;
            return (
              <Link
                key={f.key}
                to={scopeHref(f.key)}
                aria-current={on ? "true" : undefined}
                className={`inline-flex h-8 items-center rounded-full px-3 text-[13px] transition-colors ${on ? "bg-ink font-medium text-bg" : "bg-bg-sunk text-ink-3 hover:text-ink dark:bg-bg-muted/60"}`}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
        <span className="text-[12px] text-ink-4">共 <span className="num">{data.total}</span> 个会议</span>
      </div>

      {data.items.length === 0 ? (
        <div className="mt-2 lg:card">
          <EmptyState title="这个筛选下暂无已识别的会议">
            {data.scope === "ai4s"
              ? "AI4S 栏目还没有会议通知，可看「全部」或「天文」。"
              : "新的会议通知会出现在这里；已结束的会议按会期倒序归档。"}
          </EmptyState>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <section aria-labelledby="conf-upcoming" className="mt-1">
              <h2 id="conf-upcoming" className="mb-2 text-[13px] font-semibold text-ink-3">近期</h2>
              <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {upcoming.map((c) => <ConferenceCard key={c.id} item={c} onOpen={openDetail} />)}
              </ul>
            </section>
          )}
          {undated.length > 0 && (
            <section aria-labelledby="conf-undated" className="mt-6">
              <h2 id="conf-undated" className="mb-2 text-[13px] font-semibold text-ink-3">日期待定</h2>
              <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {undated.map((c) => <ConferenceCard key={c.id} item={c} onOpen={openDetail} />)}
              </ul>
            </section>
          )}
          {ended.length > 0 && (
            <section aria-labelledby="conf-ended" className="mt-6">
              <h2 id="conf-ended" className="mb-2 text-[13px] font-semibold text-ink-3">已结束</h2>
              <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {ended.map((c) => <ConferenceCard key={c.id} item={c} onOpen={openDetail} />)}
              </ul>
            </section>
          )}
          {unsettled.length > 0 && (
            <section aria-labelledby="conf-unsettled" className="mt-6">
              <h2 id="conf-unsettled" className="mb-2 text-[13px] font-semibold text-ink-3">已取消 / 已延期</h2>
              <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {unsettled.map((c) => <ConferenceCard key={c.id} item={c} onOpen={openDetail} />)}
              </ul>
            </section>
          )}
        </>
      )}

      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
      <p className="mt-5 text-[12px] leading-[1.8] text-ink-4">
        会议信息取自通知原文：原文没写的日期、地点与截止时间不补齐，日期只精确到日。
      </p>
      {open && <ConferenceDialog item={open.item} opener={open.opener} onClose={close} />}
    </div>
  );
}

export default function ConferencesPage() {
  const { data } = useLoaderData<typeof loader>();
  return <ConferencesPageContent data={data} />;
}
