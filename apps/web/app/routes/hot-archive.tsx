import { Link, useLoaderData } from "react-router";
import type { StoryArchiveResponse } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { EmptyState } from "../components/ui/Page";
import { MathText } from "../components/MathText";
import { loadOr404, edgeTtl } from "../lib/api.server";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "hot", name: "往期事件" };
export const headers = () => edgeTtl(60);
export const meta = () => [{ title: "往期事件" }];

export async function loader({ request }: { request: Request }) {
  const raw = new URL(request.url).searchParams.get("page") ?? "1";
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Response("Invalid page", { status: 400 });
  const archive = await loadOr404<StoryArchiveResponse>(`/api/site/stories?page=${raw}`, { signal: request.signal });
  return { archive, page: Number(raw) };
}

const pathFor = (page: number) => page === 1 ? "/hot/archive" : `/hot/archive?page=${page}`;

export default function HotArchive() {
  const { archive, page } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-4 pt-2">
        <Link to="/hot" className="inline-flex min-h-11 items-center text-sm text-accent hover:underline">← 返回热点榜</Link>
        <h1 className="text-xl font-bold text-ink">往期事件</h1>
        <p className="mt-1 text-sm text-ink-3">按最近报道时间排序</p>
      </header>
      {archive.entries.length ? (
        <ul className="card divide-y divide-line-soft">
          {archive.entries.map(({ publicId, title, latestReportAt }) => (
            <li key={publicId}>
              <Link to={`/story/${publicId}`} className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-3 px-4 py-3 text-ink hover:text-accent">
                <span className="font-semibold"><MathText text={title} /></span>
                <time dateTime={latestReportAt} className="num text-xs text-ink-4">{beijingDate(latestReportAt)}</time>
              </Link>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="暂无可浏览的事件" />}
      {(page > 1 || archive.hasNext) && (
        <nav aria-label="往期事件分页" className="mt-4 flex items-center gap-4 text-sm">
          {page > 1 && <Link className="inline-flex min-h-11 items-center text-accent" to={pathFor(page - 1)}>上一页</Link>}
          <span className="text-ink-3">第 {page} 页</span>
          {archive.hasNext && page < 999999 && <Link className="inline-flex min-h-11 items-center text-accent" to={pathFor(page + 1)}>下一页</Link>}
        </nav>
      )}
    </div>
  );
}
