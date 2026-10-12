import { useLoaderData } from "react-router";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { Calendar } from "../features/calendar/Calendar";
import { shanghaiDate } from "../features/calendar/model";
import { pageMeta } from "../lib/seo";

export const handle: Screen = { tab: "me", name: "天象日历" };
export function loader({ request }: { request: Request }) {
  const today = shanghaiDate();
  const date = new URL(request.url).searchParams.get("date");
  const valid = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number(date.slice(0, 4)) >= 1000
    && Number.isFinite(new Date(`${date}T00:00:00Z`).getTime())
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  return { today, initialDate: valid ? date.replaceAll("-", "") : today };
}
export function meta() {
  return pageMeta({ title: "天象日历", path: "/calendar", description: "天象日历：按月与日期浏览的天象条目。本发行包只附带最小合成样本，部署者按自己的来源替换。" });
}

export function CalendarPageContent({ today, initialDate = today }: { today: string; initialDate?: string }) {
  return <main className="mx-auto w-full max-w-4xl space-y-6 pb-12 text-left">
    <PhoneBar back={{ to: "/", label: "精选" }} title="天象日历" />
    <header className="space-y-2 border-b border-line pb-4 pt-3">
      <h1 data-page-title="" className="text-3xl font-semibold text-ink">天象日历</h1>
    </header>
    <Calendar key={initialDate} initialDate={initialDate} />
    <section aria-labelledby="calendar-resources" className="space-y-2 border-t border-line pt-4">
      <h2 id="calendar-resources" className="text-lg font-semibold text-ink">观测参考</h2>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-accent">
        <a href="https://stellarium-web.org/" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center hover:underline">Stellarium Web ↗</a>
        <a href="https://laysky.com/" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center hover:underline">天文通 ↗</a>
      </div>
    </section>
  </main>;
}

export default function CalendarPage() {
  const dates = useLoaderData<typeof loader>();
  return <CalendarPageContent {...dates} />;
}
