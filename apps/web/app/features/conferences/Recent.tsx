import { Link } from "react-router";
import type { ConferenceScope, ConferenceSummary } from "@aihot/contracts/site";
import { phaseBadge, phaseTone, placeLabel, rangeLabel } from "./format";

export function ConferenceRecent({ items, scope }: { items: ConferenceSummary[]; scope: Exclude<ConferenceScope, "all"> }) {
  if (!items.length) return null;
  const href = `/conferences?scope=${scope}`;
  return (
    <section aria-labelledby="conf-recent" data-conf-recent={scope} className="mx-auto my-4 w-[calc(100%_-_1.5rem)] max-w-[44rem]">
      <Link to={href} aria-label="查看全部近期学术会议" className="group block rounded-card border border-line-soft border-t-2 border-t-accent/40 bg-surface px-3 shadow-sm transition-colors hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-4">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <h2 id="conf-recent" className="font-[Georgia,'Songti_SC','Noto_Serif_CJK_SC',SimSun,serif] text-[15px] font-semibold tracking-wide text-ink-2">近期学术会议</h2>
          <span className="text-[12px] text-accent-ink group-hover:underline">查看全部 →</span>
        </div>
        <ul className="divide-y divide-line-soft border-t border-line-soft">
          {items.slice(0, 2).map((c) => (
            <li key={c.id} className="flex min-h-11 items-center justify-between gap-2 px-1 py-1.5">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="min-w-0 text-[13px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{c.name}</span>
                <span className="shrink-0 text-[12px] text-ink-3"><span className="num">{rangeLabel(c)}</span>{placeLabel(c) && <> · {placeLabel(c)}</>}</span>
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${phaseTone(c.phase)}`}>{phaseBadge(c)}</span>
            </li>
          ))}
        </ul>
      </Link>
    </section>
  );
}
