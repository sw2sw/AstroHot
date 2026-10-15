// Clickable page-number navigation for the arXiv candidate archive.
//
// The archive is a flat, officially ordered list, so "where am I" and "how far does it go" are the two
// things a reader needs from it: the previous/next pair alone cannot answer either, and a deep page
// could only be reached by clicking through every page before it. The numbers are real links, so a
// page is shareable, the browser's back button restores it, and the whole control is keyboard
// reachable. Deliberately no jump-to-page input: the first version stays a plain page list.
//
// The current filter (category) and page size travel in every link, and the page number is clamped to
// the pages that really exist, so a stale or hand-typed `page` cannot produce a link to a page the
// server will reject.
import { Link } from "react-router";

/** How many pages are shown on each side of the current one before the list collapses. */
const NEIGHBOURS = 1;

/**
 * The page numbers to render, with `null` standing for an ellipsis. The first page, the last page, the
 * current page and its immediate neighbours are always present; the gaps between them collapse, so the
 * control stays the same width however long the archive grows. A single-page list yields no numbers —
 * there is nothing to navigate to.
 */
export function pageWindow(page: number, pageCount: number, neighbours = NEIGHBOURS): (number | null)[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return [];
  const current = Math.min(Math.max(page, 1), pageCount);
  const wanted = new Set<number>([1, pageCount, current]);
  for (let offset = 1; offset <= neighbours; offset += 1) {
    if (current - offset >= 1) wanted.add(current - offset);
    if (current + offset <= pageCount) wanted.add(current + offset);
  }
  const items: (number | null)[] = [];
  let previous = 0;
  for (const candidate of [...wanted].sort((a, b) => a - b)) {
    if (previous !== 0 && candidate - previous > 1) items.push(null);
    items.push(candidate);
    previous = candidate;
  }
  return items;
}

/** How many pages a filtered list has, floored at one so an empty archive still reads as one page. */
export function pageCountOf(total: number, pageSize: number): number {
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 1;
  const rows = Number.isFinite(total) && total > 0 ? total : 0;
  return Math.max(1, Math.ceil(rows / size));
}

export function ArxivPagination({ page, pageSize, total, href }: {
  page: number; pageSize: number; total: number; href: (page: number) => string;
}) {
  const pageCount = pageCountOf(total, pageSize);
  // An empty archive and a single-page one have nothing to page through: no control, no dead links.
  if (pageCount <= 1) return null;
  const current = Math.min(Math.max(page, 1), pageCount);
  const items = pageWindow(current, pageCount);
  const step = "inline-flex h-9 items-center justify-center rounded-control border border-line px-3 text-sm text-ink-3 transition-colors hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent";
  const number = "num inline-flex h-9 min-w-9 items-center justify-center rounded-control border border-line px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <nav aria-label="候选分页" className="mt-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-ink-3">
      {current > 1 ? <Link to={href(current - 1)} rel="prev" className={step}>上一页</Link> : <span aria-hidden="true" />}
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => item === null
          ? <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-ink-4">…</li>
          : <li key={item}>
              <Link
                to={href(item)}
                aria-current={item === current ? "page" : undefined}
                aria-label={`第 ${item} 页`}
                className={`${number} ${item === current ? "border-accent bg-accent/10 font-semibold text-accent" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
              >
                {item}
              </Link>
            </li>)}
      </ol>
      <span className="num">第 {current} 页 · 共 {pageCount} 页 · {total} 条</span>
      {current < pageCount ? <Link to={href(current + 1)} rel="next" className={step}>下一页</Link> : <span aria-hidden="true" />}
    </nav>
  );
}
