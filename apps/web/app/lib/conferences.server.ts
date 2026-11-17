// 学术会议汇总页的数据：只走公开读接口，与会话、模型、数据库都无关。
import type { ConferenceHubResponse, ConferenceScope, ConferenceSummary } from "@aihot/contracts/site";
import { apiGet } from "../lib/api.server";

/** 近期会议入口用：拿不到就当作没有，不给页面添一个空推荐框或一个错误。
 *  已取消、以及新会期还没定的延期会议不占推荐位——它们在汇总页仍可查到状态。 */
export async function loadRecentConferences(scope: Exclude<ConferenceScope, "all">, signal?: AbortSignal): Promise<ConferenceSummary[]> {
  try {
    const hub = await apiGet<ConferenceHubResponse>(`/api/site/conferences?scope=${scope}`, { signal });
    return hub.items
      .filter((c) => (c.phase === "ongoing" || c.phase === "upcoming") && c.scheduleStatus === "scheduled")
      .slice(0, 3);
  } catch {
    return [];
  }
}
