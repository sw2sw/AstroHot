import { MathText } from "../components/MathText";
import { Link, data as withHeaders, redirect, useLoaderData } from "react-router";
import type {ImageryViewItem} from '../features/imagery/types';
import {safeImageUrl} from '../features/imagery/view';
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { apiDeadlineCache, apiGet, loadOr404 } from "../lib/api.server";
import { filterParams, itemListLd, listPath, pageMeta, readFilters, siteLd } from "../lib/seo";
import type { Screen } from "../components/shell/screens";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { ActiveFilters, CategoryTabs, FeedBar, SearchField } from "../features/feed/Filters";
import calendarEvents from "../features/calendar/events.json";
import { shanghaiDate, weekdayLabel } from "../features/calendar/model";

export const handle: Screen = { tab: "featured", name: "精选" };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const filters = readFilters(url.searchParams);
  const upstream = new Headers();
  const [data, imageryFeed] = await Promise.all([
    loadOr404<TimelineResponse>(listPath("/api/site/timeline", filterParams(filters)), { responseHeaders: upstream, signal: request.signal }),
    apiGet<{items:ImageryViewItem[]}>('/api/imagery/items?limit=1',{signal:AbortSignal.any([request.signal,AbortSignal.timeout(2000)])}).catch(()=>null),
  ]);
  return withHeaders({ data, filters, imagery:imageryFeed?.items[0] ?? null }, { headers: apiDeadlineCache(60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath("/", loaderData ? filterParams(loaderData.filters) : {});
  const titles = loaderData?.data.cards.map((c) => c.item.title) ?? [];
  return pageMeta({ path, jsonLd: path === "/" ? [...siteLd(), itemListLd("/", "精选", titles)] : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

/**
 * Home entry to the sky calendar: today's date, its recorded events, and the two ways in. The card is a
 * plain shell, not one big link: the calendar and the observing guides are separate actions, side by side
 * on the last row, so neither can swallow the other's tap.
 */
export function HomeCalendarCard({ today }: { today: string }) {
  const events = calendarEvents.filter(event => event.date === today);
  const weekday = weekdayLabel(today);
  const link = "text-sm font-semibold text-ink-2 transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent";
  return <div className="card flex min-h-24 min-w-0 flex-col justify-center gap-1.5 p-4 text-left">
    <p data-home-row="date" className="num text-2xl font-bold leading-tight tracking-[-0.02em] text-ink">{Number(today.slice(4, 6))}月{Number(today.slice(6))}日 <span className="ml-1 text-sm font-medium text-ink-3">{weekday}</span></p>
    {events.length > 0 && <p data-home-row="event" title={events.map(event => event.title).join(" · ")} className="min-w-0 truncate text-sm text-accent">{events.map(event => event.title).join(" · ")}</p>}
    <p data-home-row="link" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5">
      <Link to={`/calendar?date=${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`} className={link}>天象日历 →</Link>
      <Link to="/observing-guides" className={link}>观测指南 →</Link>
    </p>
  </div>;
}

/**
 * Home entry to the topic banner: the award topic spans the content area above the two cards,
 * so the entry stays on the main column and does not live only in the sidebar.
 */
export function HomeNobelLink() {
  return <Link to="/nobel" reloadDocument className="mb-4 flex min-h-16 items-center justify-between gap-3 rounded-card border border-[#c6a05a]/60 bg-[#c6a05a]/10 px-4 py-3 transition-colors hover:bg-[#c6a05a]/20">
    <div className="min-w-0"><p className="text-base font-bold text-ink">诺贝尔奖 2026 专题</p><p className="mt-0.5 text-xs text-ink-2">合成演示 · 非真实获奖信息</p></div>
    <span className="shrink-0 text-sm font-semibold text-accent">查看专题 →</span>
  </Link>;
}

export default function Home() {
  const { data, filters, imagery } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${filters.tag}` : "精选";
  return (
    <div className="pb-6">
      {/* Phones: the bar (精选 | 全部, filter, search), the filter in use, today's hot topics, the feed. */}
      <FeedBar base="/" category={filters.category} channel={filters.channel} />
      <ActiveFilters base="/" category={filters.category} channel={filters.channel} tag={filters.tag} />
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField keep={{ category: filters.category }} />
        </div>
      </div>

      <HomeNobelLink />
      <div className={`mb-4 grid items-stretch gap-4 ${imagery ? "xl:grid-cols-2" : ""} [&>*]:h-full`}>
      {imagery && <Link to="/imagery" className="card flex min-w-0 items-center gap-3 p-3 hover:bg-bg-sunk">{safeImageUrl(imagery) && <img src={safeImageUrl(imagery)!} alt={imagery.altEn ?? imagery.titleEn} className="h-20 w-28 shrink-0 rounded-card bg-bg-sunk object-contain" loading="lazy"/>}<div className="min-w-0"><p className="text-xs text-ink-4">天文影像 · 最近存档 {imagery.sourceDate}</p><p className="truncate text-sm font-semibold"><MathText text={imagery.titleZh?.trim() || imagery.titleEn} /></p><p className="truncate text-xs text-ink-3"><MathText text={imagery.titleEn} /></p></div><span className="ml-auto shrink-0 text-sm text-accent">详情 →</span></Link>}
      <HomeCalendarCard today={shanghaiDate()} />
      </div>
      {data.hot && <HotTopics entries={data.hot} />}

      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}
