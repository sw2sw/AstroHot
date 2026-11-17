// 栏目里的「近期学术会议」：最多三条，没有就不画这一块。整块只是一次公开读，不触发模型、不写库。
import { Link } from "react-router";
import type { ConferenceScope, ConferenceSummary } from "@aihot/contracts/site";
import { placeLabel, rangeLabel, scheduleBadge } from "./format";

export function ConferenceRecent({ items, scope }: { items: ConferenceSummary[]; scope: Exclude<ConferenceScope, "all"> }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="conf-recent" className="mb-5 mt-5" data-conf-recent={scope}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="conf-recent" className="text-[13px] font-semibold text-ink-3">近期学术会议</h2>
        <Link to={`/conferences?scope=${scope}`} className="text-[12.5px] text-accent hover:underline">查看全部</Link>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <li key={c.id} className="min-w-0">
            <Link
              to={`/conferences?scope=${scope}#conf-${c.id}`}
              className="flex h-full min-h-[64px] flex-col justify-center rounded-card border border-line-soft bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong active:bg-bg-sunk"
            >
              <span className="line-clamp-2 text-[13.5px] font-medium leading-[1.5] text-ink">
                {c.name}
                {scheduleBadge(c) && <span className="ml-1.5 rounded-full bg-bg-sunk px-1.5 py-0.5 text-[11px] font-normal text-ink-4">{scheduleBadge(c)}</span>}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-4">
                <span className="num">{rangeLabel(c)}</span>
                {placeLabel(c) && <span>· {placeLabel(c)}</span>}
                {c.phase === "ongoing" && <span className="text-accent">进行中</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
