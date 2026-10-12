// 这个行业的分类体系：类别、标签词表、机构（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（科普、观点）：日报写过的事又有评论或持续围观的后续资料，只占一行快讯（报道信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
  { key: "planets-solar-system", label: "系外行星与太阳系", section: "系外行星与太阳系", guide: "系外行星的发现与刻画、宜居性、原行星形成，以及太阳系内行星、矮行星、小行星、彗星和卫星的科学结果与探测进展。" },
  { key: "stars-transients", label: "恒星、黑洞与暂现源", section: "恒星、黑洞与暂现源", guide: "恒星的形成、结构与演化，致密天体（白矮星、中子星、黑洞）、引力波源、超新星、伽马射线暴、潮汐瓦解等暂现源与爆发事件。" },
  { key: "galaxies-cosmology", label: "星系与宇宙学", section: "星系与宇宙学", guide: "星系动力学与演化、星系团、活动星系核，以及宇宙的大尺度结构、暗物质、暗能量、宇宙微波背景与早期宇宙。" },
  { key: "solar-space-weather", label: "太阳与空间天气", section: "太阳与空间天气", guide: "太阳的磁场与活动、日冕、耀斑与对地影响、日冕物质抛射、空间天气与空间环境对地球与航天器的影响。" },
  { key: "observatories-data", label: "望远镜、任务与数据", section: "望远镜、任务与数据", guide: "地面望远镜与空间任务的立项、建造、发射、调试、服役进展，以及巡天计划、超大型数据与算法、数据发布，以及科学基础设施。" },
  { key: "outreach-images", label: "图像与科普", section: "图像与科普", guide: "天文图像发布、公众科普解读、天象预报、机构活动与科普教育。以图像/科普为主，不把一项科研成果归成单纯图片。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; label: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布（AI 行业是新模型）。天文领域没有统一的“发布统计”主对象，
 * 因此设为 null，日报报头就不显示那个数字，改分类后也不修订已出报告。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = null;

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["astronomy", "astrophysics", "telescope", "observatory", "pulsar", "quasar", "jwst"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["research_result", "data_release", "engineering_update", "image_release", "science_outreach"] as const;

// —— 标签词表 —

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "科研成果", "数据发布", "任务进展", "图像发布", "科普",
  "天体发现", "观测/巡天", "理论进展", "学术会议", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "系外行星", "黑洞", "中子星", "脉冲星", "恒星形成", "恒星演化", "超新星", "伽马暴", "引力波",
  "恒星动力学", "星系演化", "活动星系", "暗物质", "暗能量", "宇宙学", "早期宇宙",
  "太阳", "日冕", "太阳黑子", "空间天气", "小行星", "彗星", "行星卫星", "探测器",
  "望远镜", "巡天", "数据发布",
] as const;

/** 可选的机构标签（研究机构与任务）。 */
export const ENTITY_TAGS = ["国家天文台", "紫金山天文台", "上海天文台", "ESO", "ESA", "NOIRLab", "arXiv"] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "黑洞/中子星": "黑洞与中子星",
  "超新星爆发": "超新星", "GRB": "伽马暴", "gamma-ray burst": "伽马暴", "伽玛射线暴": "伽马暴",
  "暂现源": "天体发现", "暂现事件": "天体发现", "潮汐瓦解": "天体发现",
  "行星形成": "系外行星", "原行星盘": "系外行星", "系外行星大气": "系外行星",
  "太阳大气": "太阳", "活动": "太阳与空间天气", "太阳风": "太阳与空间天气", "日冕": "太阳与空间天气",
  "巡天": "数据发布", "变测": "巡天", "变源": "巡天",
  "哈勃": "哈勃", "韦布": "韦布",
  "暗物质晕": "暗物质", "星系团": "星系", "矮星系": "星系",
  "再电离": "早期宇宙", "原初": "早期宇宙",
  "空间望远镜": "望远镜", "望远镜与任务": "望远镜",
  "数据发布": "数据发布", "公开数据": "数据发布",
  "图片": "图像发布",
  "科普教育": "科普", "教育": "科普",
  "会议": "其他", "获奖": "其他", "招聘": "其他", "机构活动": "其他",
};

// —— 机构与主体 —

/**
 * 机构主题：key → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * aliases 给结构抽取模型看；otherNames 是机构自己的其他称呼（官方账号名、下属单位），
 * 把事实的主体对到发布方时也认它们。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; otherNames?: string[] }> = {
  bao: { name: "国家天文台", displayTag: null, aliases: ["国家天文台", "NAOC", "Chinese Academy of Sciences NAOC"], otherNames: ["中国科学院国家天文台", "国家天文台台网"] },
  pmo: { name: "紫金山天文台", displayTag: null, aliases: ["紫金山天文台", "PMO"], otherNames: ["中国科学院紫金山天文台"] },
  shao: { name: "上海天文台", displayTag: null, aliases: ["上海天文台", "SHAO"], otherNames: ["中国科学院上海天文台", "上海天文台"] },
  eso: { name: "ESO", displayTag: null, aliases: ["ESO", "European Southern Observatory", "欧洲南方天文台"], otherNames: ["ESO Garching"] },
  esa: { name: "ESA", displayTag: null, aliases: ["ESA", "European Space Agency", "欧洲空间局"], otherNames: ["ESA/Hubble", "ESA Webb", "欧空局"] },
  noirlab: { name: "NOIRLab", displayTag: null, aliases: ["NOIRLab", "NSF NOIRLab"], otherNames: ["NSF's NOIRLab"] },
};

/**
 * 机构身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、去掉摘要（防护模型张冠李戴）。
 * 天文数字（天协单号、编号、天体名）不通过此词典判断机构，由结构与规则层处理。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "bao", name: "国家天文台", patterns: [/国家天文台/] },
  { id: "pmo", name: "紫金山天文台", patterns: [/紫金山天文台/] },
  { id: "shao", name: "上海天文台", patterns: [/上海天文台/] },
  { id: "eso", name: "ESO", patterns: [/\bESO\b/, /European\s+Southern\s+Observatory/i] },
  { id: "esa", name: "ESA", patterns: [/\bESA\b/, /European\s+Space\s+Agency/i] },
  { id: "noirlab", name: "NOIRLab", patterns: [/\bNOIRLab\b/] },
];

/** 这些域名上的文章，发布方就是对应的机构（托管平台如 arXiv 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "bao", domains: ["www.bao.ac.cn"] },
  { entityId: "pmo", domains: ["pmo.cas.cn"] },
  { entityId: "shao", domains: ["shao.cas.cn"] },
  { entityId: "eso", domains: ["eso.org"] },
  { entityId: "esa", domains: ["esa.int", "esahubble.org", "esawebb.org"] },
  { entityId: "noirlab", domains: ["noirlab.edu"] },
];

/** 原文里的这些写法也可以算提到了对应机构。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "bao", pattern: /NAOC\b/i },
  { entityId: "esa", pattern: /JWST\b|Webb\b/i },
];