// 观测指南保留的人工收录名单；自动周刊由公共读取层补充。
// 这里只保存文章身份，不决定显示次序；合并列表统一按文章发布时间倒序分页。
import type { SiteItemDetail } from "@aihot/contracts/site";

/** 保留原有人工收录身份；展示次序由公共读取层的发布时间排序决定。 */
export const OBSERVING_GUIDE_IDS = [
  // 本发行包不附带任何第三方指南条目：此前收录的 id 指向私有部署里的具体文章，
  // 已随第三方内容素材一并移除。列表为空时页面显示明确的空态，不编造、不用占位卡顶替。
  // 部署者先在自己站点里发布（或收录）观测指南，再把它们的公开详情 id 填进来。
] as const;

/** 一张指南卡所需的字段，全部来自公开详情本身，不编造。 */
export interface GuideCard {
  id: string;
  title: string;
  summary: string | null;
  /** 读者看到的来源名（与站内其他地方同一套 publicSourceName）。 */
  sourceName: string;
  /** 来源自己的发布时间；来源没给就是 null。绝不是本站的采集时间。 */
  publishedAt: string | null;
}

/** 一条 id 的结果：有卡，或没有卡的原因（其余 id 不受影响）。 */
export type GuideOutcome =
  | { kind: "guide"; card: GuideCard }
  | { kind: "withdrawn" }
  | { kind: "unreadable" };

export interface GuidesView {
  nextCursor?: string | null;
  guides: GuideCard[];
  /** 公开详情已没有这一页（404）的 id 数：从列表里悄悄去掉，不做成占位卡。 */
  withdrawn: number;
  /** 这一次没读到的 id 数（网络或上游失败）：与「没有指南」是两件事。 */
  unreadable: number;
}

/** 公开详情 → 卡片字段的窄映射：只取页面真正展示的字段。 */
export function toGuideCard(item: SiteItemDetail): GuideCard {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    sourceName: item.source.name,
    publishedAt: item.publishedAt,
  };
}

/** 各 id 的结果合并成页面状态，保持名单顺序。 */
export function guidesView(outcomes: readonly GuideOutcome[]): GuidesView {
  const guides: GuideCard[] = [];
  let withdrawn = 0;
  let unreadable = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "guide") guides.push(outcome.card);
    else if (outcome.kind === "withdrawn") withdrawn += 1;
    else unreadable += 1;
  }
  return { guides, withdrawn, unreadable };
}

/**
 * 页面状态：有内容；没有内容、但这一次没读到（不能说成「本站没有指南」）；名单本来就没有可用项。
 * 「全站没有指南」与「这一次没读到」是两件事，要对读者说清是哪一件。
 */
export function guidesState(view: GuidesView): "guides" | "unavailable" | "empty" {
  if (view.guides.length > 0) return "guides";
  return view.unreadable > 0 ? "unavailable" : "empty";
}
