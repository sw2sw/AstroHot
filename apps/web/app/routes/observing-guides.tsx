// 观测指南：一份手工收录的观星指南名单（features/observing-guides/guides.ts），逐 id 走站内公开详情接口。
// 读不到的 id 不阻塞读得到的；撤回的 id 从列表上消失。页面只放收录的这几篇，不是全站指南的检索结果。
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/observing-guides";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { ApiError, apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { fullDateTime } from "../lib/format";
import { MathText } from "../components/MathText";
import { PhoneBar } from "../components/shell/PhoneBar";
import { EmptyState } from "../components/ui/Page";
import type { Screen } from "../components/shell/screens";
import { OBSERVING_GUIDE_IDS, guidesState, guidesView, toGuideCard, type GuideCard, type GuideOutcome, type GuidesView } from "../features/observing-guides/guides";

export const handle: Screen = { home: "featured", name: "观测指南" };

/** 一条 id：取到就有卡，404 就是已撤回，其余是这一次没读到——一条 id 从不影响另一条。 */
async function loadGuide(id: string, signal: AbortSignal): Promise<GuideOutcome> {
  try {
    const item = await apiGet<SiteItemDetail>(`/api/site/items/${id}`, { signal });
    return { kind: "guide", card: toGuideCard(item) };
  } catch (error) {
    return error instanceof ApiError && error.status === 404 ? { kind: "withdrawn" } : { kind: "unreadable" };
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const outcomes = await Promise.all(OBSERVING_GUIDE_IDS.map((id) => loadGuide(id, request.signal)));
  return guidesView(outcomes);
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
          {view.unreadable > 0 && <p className="mt-4 text-[12.5px] text-ink-4">还有 <span className="num">{view.unreadable}</span> 篇这次没有读到，稍后再来看看。</p>}
        </>
      ) : (
        <div className="mt-4 lg:card">
          {state === "unavailable" ? (
            <EmptyState title="观测指南暂时打不开">这份名单上的指南这次没有读到，不是没有收录。稍后再来看看。</EmptyState>
          ) : (
            <EmptyState title="暂时没有可用的观测指南">这里只放逐篇读过的观星指南，有新的会再加进来；也可以先看天象日历。</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}

export default function ObservingGuides() {
  return <ObservingGuidesPage view={useLoaderData<typeof loader>()} />;
}
