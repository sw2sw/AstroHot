// 观测指南：人工收录与两个固定周刊，公共读取层统一按来源发布时间分页。
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/observing-guides";
import { ApiError, apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { fullDateTime } from "../lib/format";
import { MathText } from "../components/MathText";
import { PhoneBar } from "../components/shell/PhoneBar";
import { EmptyState } from "../components/ui/Page";
import type { Screen } from "../components/shell/screens";
import { OBSERVING_GUIDE_IDS, guidesState, type GuideCard, type GuidesView } from "../features/observing-guides/guides";

export const handle: Screen = { home: "featured", name: "观测指南" };

export async function loader({ request }: Route.LoaderArgs): Promise<GuidesView> {
  const params = new URLSearchParams({ ids: OBSERVING_GUIDE_IDS.join(",") });
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor) params.set("cursor", cursor);
  try {
    return await apiGet<GuidesView>(`/api/site/observing-guides?${params}`, { signal: request.signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw error;
    return { guides: [], withdrawn: 0, unreadable: 1, nextCursor: null };
  }
}

export function headers() {
  return edgeTtl(60);
}

export function meta() {
  return pageMeta({
    title: "观测指南",
    path: "/observing-guides",
    description: "本周观星指南：一手来源的原文与要点。观测条件因地点与时区而异，请结合当地天气与星图参考原文。",
  });
}

/** 一张指南卡：站内既有的紧凑卡片（来源、发布时间、整卡指向详情），没有缩略图与摘要就不画。 */
function GuideListItem({ guide }: { guide: GuideCard }) {
  return (
    <li data-guide-id={guide.id} className="relative border-b border-line-soft py-4 lg:card lg:px-[18px] lg:py-[15px] lg:card-hover">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-4">
        <span className="min-w-0 truncate text-ink-3">{guide.sourceName}</span>
        {guide.publishedAt && <span className="num shrink-0">· {fullDateTime(guide.publishedAt)}</span>}
      </div>
      <h2 className="mt-1.5 text-[16px] font-[650] leading-[1.55] text-ink">
        <Link viewTransition to={`/items/${guide.id}`} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
          <MathText text={guide.title} />
        </Link>
      </h2>
      {guide.summary && <p className="mt-1.5 line-clamp-3 text-[14px] leading-[1.75] text-ink-3"><MathText text={guide.summary} /></p>}
    </li>
  );
}

export function ObservingGuidesPage({ view }: { view: GuidesView }) {
  const state = guidesState(view);
  return (
    <div className="pb-8" data-guides-state={state}>
      <PhoneBar back={{ to: "/", label: "精选" }} title="观测指南" />
      <header className="border-b border-line pb-4 pt-3 lg:pt-0">
        <h1 data-page-title="" className="text-3xl font-semibold text-ink">观测指南</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">观测条件因地点与时区而异，请结合当地天气与星图参考原文。</p>
      </header>
      {state === "guides" ? (
        <>
          <ul className="mt-2 lg:mt-4 lg:space-y-3">
            {view.guides.map((guide) => <GuideListItem key={guide.id} guide={guide} />)}
          </ul>
          {view.nextCursor && <Link className="mt-4 inline-block py-3 text-accent" to={`?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页 →</Link>}
          {view.unreadable > 0 && <p className="mt-4 text-[12.5px] text-ink-4">部分观测指南这次没有读到，稍后再来看看。</p>}
        </>
      ) : (
        <div className="mt-4 lg:card">
          {state === "unavailable" ? (
            <EmptyState title="观测指南暂时打不开">观测指南这次没有读到，稍后再来看看。</EmptyState>
          ) : (
            <EmptyState title="暂时没有可用的观测指南">也可以先看天象日历。</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}

export default function ObservingGuides() {
  return <ObservingGuidesPage view={useLoaderData<typeof loader>()} />;
}
