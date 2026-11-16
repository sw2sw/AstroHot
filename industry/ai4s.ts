// AI4S 栏目（AI 赋能科学）的学科域。天文主站的分类与规则不变：这里只服务 contentScope='ai4s'
// 的材料结构化，domain 描述材料的主要学科，AI4A（天文应用）由结构化步骤另行判定并需原文证据。
export const AI4S_DOMAINS = [
  { key: "astronomy-astrophysics", label: "天文与天体物理", guide: "AI 用于天体观测、巡天数据、天体物理理论或空间任务科学的研究进展。" },
  { key: "physics", label: "物理", guide: "AI 用于粒子物理、凝聚态、量子物理等物理学研究（含格点场论、标准模型等理论工作）。" },
  { key: "life-sciences", label: "生命科学", guide: "AI 用于蛋白质、基因组、药物发现、神经科学等生命科学研究。" },
  { key: "chemistry", label: "化学", guide: "AI 用于分子设计、反应预测、合成路线等化学研究。" },
  { key: "materials", label: "材料科学", guide: "AI 用于新材料发现、性质预测与材料筛选。" },
  { key: "earth-climate", label: "地球与气候", guide: "AI 用于气象、气候建模、海洋、地质与地球观测研究。" },
  { key: "methods-tools", label: "科研方法与工具", guide: "面向科研的通用 AI 方法、模型能力、基准、开源工具与数据基础设施发布。" },
  { key: "research-meta", label: "科研动态与政策", guide: "AI4S 相关的栏目与平台公告、科研合作、资助、政策与社区动态（非具体研究成果）。" },
] as const;

export type Ai4sDomainKey = (typeof AI4S_DOMAINS)[number]["key"];
export const AI4S_DOMAIN_KEYS = AI4S_DOMAINS.map((d) => d.key) as unknown as readonly [Ai4sDomainKey, ...Ai4sDomainKey[]];
export const AI4S_DOMAIN_LABEL: Record<string, string> = Object.fromEntries(AI4S_DOMAINS.map((d) => [d.key, d.label]));