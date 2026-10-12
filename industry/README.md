# 天文资讯（AstroHot）行业包

这个文件夹承载天文资讯（AstroHot）这个站与“天文行业”有关的一切：信源、分类、机构主题、更新日志、品牌与页面文案。换一个行业，主要就是改这个文件夹。

## 这是什么

AstroHot 是由 AIHOT 开源框架驱动的中文天文资讯平台：自动盯住国内外天文台、空间科学机构与研究团队的一手动态，抓取后用模型写中文摘要、打分精选、把同一项发现的多篇报道归到一起，每天早上 8 点出一份日报，周一出周报，每月 1 日出月报。优先整理科研成果与机构一手消息，论文与图片有据可查。站名「天文资讯」，英文品牌「AstroHot」。

## 目录怎么组织

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、首页文案、关于页、页脚与备案号 |
| `taxonomy.ts` | 分类、标签词表、机构（主体）名录、防止张冠李戴的机构身份词典，以及本行业的发布主对象（`RELEASE`，天文设 `null`） |
| `topics.json` | 主题目录（`/topics`），站点启动时读取；分“机构与任务”“学科方向”“内容形态”三组 |
| `chronicle.ts` | 主题页“大事记”的规则：节点类型、门槛与名额、一篇报道算哪类节点、事件名写法 |
| `chronicles/` | 可选，默认没有：机构编年史的人工历史，一家机构一个 JSON |
| `sources.json` | 首次启动时导入的示范信源（当前 8 个） |
| `prompts/` | 每一步的提示词：预筛、评分、写作、结构化、归组、事件综述、周报月报、翻译、安全 |
| `selection.ts` | 入选门槛 |
| `features.ts` | 模型榜等功能的开关 |
| `brand/` | 图标、Logo、日报周报月报的报头字 |
| `pages/` | 使用规则、隐私说明（上线前按实际情况改写） |
| `changelog.json` | 更新日志 |
| `gold.example.jsonl` | 精选评测样本的格式示例 |
| `relation-gold.example.jsonl` | 事件关系评测样本的格式示例 |

## 怎么加信源

在 `sources.json` 的 `sources` 数组里加一项，两种类型：

- `rss`：给 `feedUrl`，框架订阅 RSS/Atom。当前较多机构类信源。
- `web_list`：给列表页 `url`。中文网页选择器（`itemSelector` / `linkSelector` / `titleSelector`）在抓真实页面后填写，正式上线前在后台“预览抓取”人工复核一遍。

每项建议填写：`id`（唯一，不要用空格）、`name`、`kind`、`config`、`tier`、`owner_entity_id`（归属机构，按 `taxonomy.ts` 里的 `ENTITY` 填）、`interval_minutes`（抓取间隔）、`tags`、以及是否需要 `site_fulltext`（是否取原文全文）。`$comment` 里有更细的说明。首次启动时它会作为示范信源被导入（`scripts/seed.ts`）；已存在的不会被覆盖，只加不改旧的。

## 怎么改分类与机构主题

- 改分类：编辑 `taxonomy.ts` 里的 `CATEGORIES`。注意 `key` 会出现在网址里（`/all?category=…`），上线后不要改；`section` 是日报的分节标题，`guide` 告诉模型这一类收什么、和相邻类的边界在哪。
- 改/加标签：`CATEGORY_TAGS`（每篇必选一个）、`TOPIC_TAGS`（可选主题标签）、`ENTITY_TAGS`（机构标签）都可直接增删。
- 改机构主题：`taxonomy.ts` 的 `ENTITIES` 和 `topics.json` 的 `topics`（机构按 `entityId` 关联）。机构别名、`IDENTITY_LEXICON`、`PUBLISHER_DOMAINS` 一起改，避免模型“张冠李戴”。
- 日报分节顺序按 `CATEGORIES` 里的顺序；`RELEASE` 天文没有统一的“发布统计”主对象，故为 `null`，日报报头不显示该数字。

## 怎么换品牌

先改 `site.ts`：`name`（显示名，当前“天文资讯”）、`subject`（行业词，当前“天文”）、首页标题、`description`、`tagline`、`mcpPrefix`（工具名前缀，目前 `astro_`，已接入就不能再改）、`contactEmail`（对外邮箱）、`footerNote`、`icp`（备案号）、`crawlerName`。图标与 Logo 放在 `brand/`。改完重新构建即可生效。

## 怎么改使用规则与隐私

`pages/terms.md`（使用规则）和 `pages/privacy.md`（隐私说明）已写成中文初稿。上线前改成实际的：运营主体、生效日期、联系方式、允许/不允许的用途、是否接统计服务，必要时请专业人士审阅。

## 改完怎么验证

1. json 合法：`python3 -m json.tool pages/sources.json topics.json changelog.json` 每份能解析。
2. TS 编译：`npx tsc --noEmit`（`tsconfig.json` 在仓库根目录），确保 `site.ts`、`taxonomy.ts`、`chronicle.ts` 等类型无误。
3. 通读一遍：`site.ts` 的 `name`/`subject` 对不对，`CATEGORIES` 类别齐全、措辞准确。
4. 重建看效果：`docker compose up --build`，首页看信源数，导航看“天文日报”，打开“分类筛选”“主题页”看归类是否符合预期。
5. 上线前务必把 `pages/*` 改成实际信息，不要在站上挂“模板”字样，必要时请专业人士审阅。

其他说明：`gold.example.jsonl` 与 `relation-gold.example.jsonl` 是评测样本格式示例，生产评估时装成脚本用。