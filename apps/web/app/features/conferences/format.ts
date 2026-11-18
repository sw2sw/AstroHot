// 会议卡片与详情的文案：日期只到日、地点只说有证据的，缺什么就不写什么。
import type { ConferenceDeadlineKind, ConferenceDeadlineView, ConferenceSummary } from "@aihot/contracts/site";

const DEADLINE_LABEL: Record<ConferenceDeadlineKind, string> = {
  registration: "报名截止",
  early_registration: "早鸟截止",
  abstract: "摘要截止",
  paper: "论文截止",
  other: "截止",
};

/** 会期：单日只写一天，跨月/跨年照实写全；没有日期就是待定。 */
export function rangeLabel(c: Pick<ConferenceSummary, "startDate" | "endDate">): string {
  if (!c.startDate) return "日期待定";
  const end = c.endDate ?? c.startDate;
  return end === c.startDate ? c.startDate : `${c.startDate} — ${end}`;
}

/** 地点：线上、城市，或两者都有；都没有就不写。 */
export function placeLabel(c: Pick<ConferenceSummary, "city" | "online">): string | null {
  if (c.online === true) return c.city ? `线上 · ${c.city}` : "线上";
  return c.city ?? null;
}

/** 一个截止日期连同它的状态；状态只由日期决定，当天不算过期。 */
export function deadlineLabel(d: ConferenceDeadlineView): string {
  const state = d.state === "closed" ? "已截止" : d.state === "today" ? "今天截止" : "";
  return `${DEADLINE_LABEL[d.kind]} ${d.date}${state ? `（${state}）` : ""}`;
}

/** 人工状态：只有明确的改期/取消才显示，正常会议的时钟状态由会期表达。 */
export function scheduleBadge(c: Pick<ConferenceSummary, "scheduleStatus">): string | null {
  return c.scheduleStatus === "cancelled" ? "已取消" : c.scheduleStatus === "postponed" ? "已延期" : null;
}

/**
 * 卡片上的状态徽章：人工状态优先于日期状态，一张卡只出一个状态。取消的会不再同时显示「进行中」，
 * 延期未定新的日期时也不显示「日期待定」以外的时钟结论。
 */
export function phaseBadge(c: Pick<ConferenceSummary, "phase">): string | null {
  switch (c.phase) {
    case "cancelled": return "已取消";
    case "postponed": return "已延期";
    case "ongoing": return "进行中";
    case "undated": return "日期待定";
    default: return null;
  }
}
