// 学术会议汇总页的数据：只走公开读接口，与会话、模型、数据库都无关。
import type { ConferenceHubResponse, ConferenceScope, ConferenceSummary } from "@aihot/contracts/site";
import { apiGet } from "../lib/api.server";

const shanghaiDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export function selectRecentConferences(items: readonly ConferenceSummary[], now: Date): ConferenceSummary[] {
  const today = shanghaiDay.format(now);
  const last = new Date(`${today}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 30);
  const cutoff = last.toISOString().slice(0, 10);
  return items.filter((c) => c.scheduleStatus === "scheduled" && (
    c.phase === "ongoing" || (c.phase === "upcoming" && c.startDate !== null && c.startDate <= cutoff)
  )).sort((a, b) => Number(b.phase === "ongoing") - Number(a.phase === "ongoing") ||
    (a.startDate ?? "").localeCompare(b.startDate ?? "") || a.id - b.id).slice(0, 2);
}

/** 近期会议入口用：拿不到就当作没有，不给页面添一个空推荐框或一个错误。
 *  已取消、以及新会期还没定的延期会议不占推荐位——它们在汇总页仍可查到状态。 */
export async function loadRecentConferences(scope: Exclude<ConferenceScope, "all">, signal?: AbortSignal): Promise<ConferenceSummary[]> {
  try {
    const hub = await apiGet<ConferenceHubResponse>(`/api/site/conferences?scope=${scope}`, { signal });
    return selectRecentConferences(hub.items, new Date());
  } catch {
    return [];
  }
}
