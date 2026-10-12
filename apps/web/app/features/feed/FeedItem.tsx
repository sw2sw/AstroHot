// One report in a feed. Desktop (≥ 961px): a white card beside the time rail. Phones: a compact row with
// the time in the source line, the bookmark at hand, the reason in one line and duplicate reports
// behind one button that opens a sheet. One markup, two presentations.
import { memo } from "react";
import { Link } from "react-router";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, FeedItemSummary, TimelineFilters } from "@aihot/contracts/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { SameEventBadge, SelectedBadge } from "../../components/ui/Badge";
import { ScoreLabel } from "../../components/ui/Score";
import { MathText } from "../../components/MathText";
import { beijingTime } from "@aihot/contracts/time";
import { MediaThumbs, SourceLine, StarButton } from "./parts";
import { GroupButton, GroupSources } from "./ReadingGroup";
import { QuotedLine } from "../item/QuotedPost";
import { rememberPreview } from "../item/preview";

export interface FeedItemProps {
  item: FeedItemSummary;
  group?: GroupInfo | null;
  filters?: TimelineFilters;
  read?: boolean;
  onOpen?: (id: string) => void;
  /** Show category and tags under the text (全部动态, topics, search). */
  showTags?: boolean;
  /** The time the item sits at in its list; phones show it in the source line (desktop: on the rail). */
  at?: string;
}

export const FeedItem = memo(function FeedItem({ item, group, filters, read = false, onOpen, showTags = false, at }: FeedItemProps) {
  const isX = item.channel === "x" && !!item.x;
  const newsThumbnail = !isX ? item.thumbnail : null;
  const open = () => {
    rememberPreview(item);
    onOpen?.(item.id);
  };
  const showSources = !!group && (group.additionalSourceCount > 0 || group.reportCount > 1);
  const tags = showTags ? item.tags.slice(0, 3) : [];

  return (
    <article className="@container relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[22px] items-center gap-1.5 text-[12.5px] leading-[18px] text-ink-4 lg:min-h-[18px] lg:gap-2">
        <SourceLine item={item} className="text-ink-4" />
        {at && (
          <time dateTime={at} className="mono shrink-0 text-[12px] lg:hidden">
            · {beijingTime(at)}
          </time>
        )}
        {item.selected && (
          <span className="hidden lg:inline-flex">
            {item.sameEvent ? <SameEventBadge /> : <SelectedBadge />}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 lg:gap-1.5">
          <span className="hidden lg:inline-flex">
            <ScoreLabel score={item.score} />
          </span>
          <span className="lg:hidden">
            <ScoreLabel score={item.score} compact />
          </span>
          <span className="-my-[11px] -mr-3 inline-flex lg:-my-1 lg:mr-0">
            <StarButton item={item} className="size-11 lg:size-[26px]" />
          </span>
        </span>
      </header>

      <div data-news-layout={newsThumbnail ? "image-text" : undefined}
        className={newsThumbnail ? "mt-2 grid items-start gap-3 @[520px]:grid-cols-[220px_minmax(0,1fr)]" : undefined}>
      {newsThumbnail && (
        <figure className="w-full max-w-[220px]">
          <div className="aspect-[16/9] overflow-hidden rounded-md bg-black/5">
            <img src={newsThumbnail.url} srcSet={newsThumbnail.srcSet} sizes="220px"
              width={newsThumbnail.width ?? undefined} height={newsThumbnail.height ?? undefined}
              alt={newsThumbnail.alt ?? item.title} loading="lazy" decoding="async"
              className="h-full w-full object-contain" />
          </div>
          {(newsThumbnail.caption || newsThumbnail.credit) && (
            <figcaption className="relative z-10 mt-1 truncate text-[11px] leading-snug text-ink-4">
              <IntentLink viewTransition to={`/items/${item.id}`} onClick={open}
                title={[newsThumbnail.caption, newsThumbnail.credit].filter(Boolean).join(" · ")}
                aria-label={`${[newsThumbnail.caption, newsThumbnail.credit].filter(Boolean).join(" · ")}；打开详情查看完整署名`}
                className="hover:text-accent">
                {[newsThumbnail.caption, newsThumbnail.credit].filter(Boolean).join(" · ")}
              </IntentLink>
            </figcaption>
          )}
        </figure>
      )}

      <div className="min-w-0">
      {isX ? (
        <p className={`mt-1.5 whitespace-pre-line text-[15px] leading-[1.75] line-clamp-5 lg:mt-2 lg:line-clamp-4 ${read ? "text-ink-4" : "text-ink"}`}>
          <IntentLink viewTransition to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
            <MathText text={item.summary ?? item.title} />
          </IntentLink>
        </p>
      ) : (
        <>
          <h3 className={`${newsThumbnail ? "mt-0" : "mt-1.5 lg:mt-2"} line-clamp-2 text-[17px] font-[650] leading-[1.5] lg:line-clamp-none lg:leading-[1.55] ${read ? "text-ink-4" : "text-ink"}`}>
            <IntentLink viewTransition to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
              <MathText text={item.title} />
            </IntentLink>
          </h3>
          {item.summary && <p className="mt-1 line-clamp-2 text-[14.5px] leading-[1.7] text-ink-3 lg:mt-2 lg:line-clamp-3 lg:text-[15px] lg:leading-[1.75]"><MathText text={item.summary} /></p>}
        </>
      )}
      </div>
      </div>

      {isX && item.x!.media.length > 0 && <MediaThumbs media={item.x!.media} className="mt-2.5" />}
      {isX && item.x!.quoted?.text && <QuotedLine quoted={item.x!.quoted} />}

      {(tags.length > 0 || (showTags && item.category)) && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-4 lg:flex">
          {showTags && item.category && (
            <Link to={`/all?category=${item.category}`} className="hover:text-accent">
              {CATEGORY_LABELS[item.category]}
            </Link>
          )}
          {tags.map((t) => (
            <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="hover:text-accent">
              #{t}
            </Link>
          ))}
        </div>
      )}

      {item.sameEvent && (
        <p className="relative z-10 mt-2 line-clamp-1 text-[12.5px] text-ink-4">
          同一新闻，精选展示
          <Link viewTransition to={`/items/${item.sameEvent.id}`} className="text-ink-3 transition-colors hover:text-accent">
            《<MathText text={item.sameEvent.title} />》
          </Link>
        </p>
      )}
      {group && showSources && (
        <div className="mt-2 hidden lg:block">
          <GroupSources group={group} filters={filters} parentId={item.id} />
        </div>
      )}

      {item.reason && (
        <div className="mt-1 lg:mt-3 lg:border-t lg:border-line-soft lg:pt-3">
          <p className="line-clamp-1 text-[13px] leading-[1.65] text-note lg:line-clamp-none lg:leading-[1.75]">推荐理由：<MathText text={item.reason} /></p>
        </div>
      )}

      {/* Phones: duplicate reports open in a sheet. */}
      {group && showSources && <GroupButton group={group} filters={filters} parentId={item.id} />}
    </article>
  );
});
