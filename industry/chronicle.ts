// 主题页“大事记”的行业规则。通用的几步在框架里（packages/backend/src/publication/topic-chronicle.ts）：
// 从近 12 个月已公开的精选里，按这里的规则定类型，比精选分门槛，把同一件事并成一个节点，按每月名额取舍，
// 再写成事件名；机构主题只收这家机构自己的（看事实主体，没有主体时看标题在发布动作之前先点名谁）。
// 换行业时改这个文件：节点类型（名称、门槛、名额、画在哪一行）、内容形态主题收哪些类型、发布动作、
// 一篇报道算哪类节点。合并同一发布、写事件名两项可选，删掉就用框架行为。
// 机构编年史还可接人工整理：industry/chronicles/{topic slug}.json，格式见 industry/README.md。

/** 主题的分组（topics.json 的 group）：机构、方向、形态。 */
type Group = "company" | "field" | "genre";

export interface ChronicleKind {
  label: string;
  above?: true;
  launch?: true;
  company?: { min: number; perMonth: number };
  other?: { min: number };
}

export interface ChronicleItem {
  title: string;
  originalTitle: string | null;
  category: string | null;
  tags: string[];
  release: boolean;
  factAction: string | null;
}

export interface ChronicleEvent {
  kind: string;
  label: string;
  head: { title: string };
  reports: ReadonlyArray<{ title: string }>;
}

export interface ChronicleRules {
  kinds: Record<string, ChronicleKind>;
  forms: Record<string, { kinds: string[]; perMonth?: number }>;
  launchVerb: RegExp;
  kindOf(item: ChronicleItem, group: Group): string | null;
  sameEvent?(a: ChronicleEvent, b: ChronicleEvent): boolean;
  eventName?(title: string, kind: string, topic: { slug: string; orgNames: readonly string[] }): string;
}

// ── 节点类型 ─────────────────────────────────────────────────────────────
const kinds: Record<string, ChronicleKind> = {
  research: { label: "研究", other: { min: 60 } },
  discovery: { label: "发现", above: true, launch: true, company: { min: 60, perMonth: 2 }, other: { min: 65 } },
  data: { label: "数据", company: { min: 55, perMonth: 2 }, other: { min: 60 } },
  mission: { label: "任务", company: { min: 50, perMonth: 1 }, other: { min: 55 } },
  image: { label: "图像", company: { min: 50, perMonth: 2 }, other: { min: 55 } },
  organization: { label: "机构", company: { min: 60, perMonth: 1 } },
};

// 形态主题映射（保留框架需要的 forms；无对应就留空）
const forms = {
  "data-releases": { kinds: ["data"], perMonth: 5 },
  "images-outreach": { kinds: ["image", "research"], perMonth: 5 },
  "research-results": { kinds: ["research", "discovery"] },
};

const RELEASED = /发布|公布|公开|宣布|放图|上新|捕获|抵达|确认|发现|confirm|discover|release|announce|detect/i;
const COMMENTARY_ACTION = /^(?:opinion|analysis|commentary|interpretation|解读|综述|回顾|解释)(?:$|：|:)/i;
const NOT_A_LAUNCH = [
  /预计|将|预告|即将|计划|有望|拟|准备/i,
  /科普|活动|讲座|公开课|征集|报名|庆祝|拜年|悼念|致敬|祝贺/i,
  /撮|发射|入轨|完成演示|测试成功/,
];

// 看发现动作及其之前的跨分句证据；无具体动作时保留整个主句，不在公布处截断。
// 不把已经发现后的后续观测计划当成预告。
function completedDiscovery(title: string): boolean {
  const action = title.match(/确认|发现|confirm|discover|detect/i);
  const evidence = action ? title.slice(0, action.index! + action[0].length) : title.split(/[，；。！？]/u)[0];
  return !NOT_A_LAUNCH.some((pattern) => pattern.test(evidence));
}

function kindOf(item: ChronicleItem, group: Group): string | null {
  const c = item.category;
  // category 是 taxonomy.ts CATEGORIES 的 key（中文 label 会对不上）。
  if (c === "planets-solar-system" || c === "stars-transients") return group === "company" ? null : "research";
  if (c === "observatories-data") return "data";
  if (c === "solar-space-weather") return "mission";
  if (c === "outreach-images") return "image";
  // 默认按标签找
  const t = item.tags.join(" ");
  if (/发现|暂现|罕见/.test(t)) return completedDiscovery(item.title) ? "discovery" : null;
  if (/数据|巡天|公开|目录/.test(t)) return "data";
  if (/任务|卫星|发射|运行|飞船/.test(t)) return "mission";
  if (/图片|图像|科学图/.test(t)) return "image";
  // 没类别:按标题发布动作
  if (RELEASED.test(item.title) && completedDiscovery(item.title)) return group === "company" ? "discovery" : "research";
  return null;
}

const sameEvent = (a: ChronicleEvent, b: ChronicleEvent): boolean =>
  a.label.replace(/[\s\n]/g, "") === b.label.replace(/[\s\n]/g, "");

const eventName = (title: string, kind: string, topic: { slug: string; orgNames: readonly string[] }): string => {
  // 去掉发布前的机构名与冒号后缀，取紧凑标题
  const names = [...topic.orgNames].sort((x, y) => y.length - x.length);
  let t = title.trim();
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = t.match(new RegExp(`^(?:${esc})(?:：|:)?(?:\\s+)?(?![从通过]?你|发布)`));
    if (m) t = t.slice(m[0].length).trim();
  }
  // 截到第一个句逗分号为“事名”
  return t.split(/[，；。！？]|(?<!\d),|,(?!\d)/u)[0].trim() || title.trim();
};

export const CHRONICLE: ChronicleRules = {
  kinds,
  forms,
  launchVerb: RELEASED,
  kindOf,
  sameEvent,
  eventName,
};