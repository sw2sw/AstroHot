// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "天文资讯",
  /**
   * 行业词：拼进默认说法里，比如“天文日报”“天文动态”。
   * 改成本行业的名词，页面上就会变成“天文日报”“天文动态”。
   */
  subject: "天文",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "天文资讯 — 天文资讯与科研成果 · 每日精选与日报",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "自动盯住国内外天文台、空间科学机构与研究团队的科研成果与一手消息，用模型摘要、打分、精选，把同一项发现的多篇报道归到一起，信源可溯源，论文与照片有据可查。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "值得关注的天文动态",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 astro_get_latest、astro_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "astro",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: null as string | null,
  /** 页脚的一行小字（选填）。 */
  footerNote: "由 AIHOT 开源框架驱动",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "天文资讯",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: null as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "AstroHotBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["宇宙每天都有新发现，", "值得看的，只有几条。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 替你盯着 {sources} 个信源：抓取、归并、精选，每天早上 8 点出一份日报。优先整理科研成果与一手机构消息，论文与图片有据可查。免费，不用注册。`,
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "国家天文台、紫金山天文台、上海天文台、ESO、ESA、NOIRLab 等机构的研究动态与订阅源都在看。",
    store: "抓到的都存下来，同一项发现的多个机构报道归到一起；不按转载数量抬高科研重要性。",
    select: "模型先判断是不是天文科研成果、有没有实际信息，再写中文标题、摘要与推荐理由；区分优先级：亲戚机构消息不等于同行评议结果。",
    publish: "每天 08:00 出日报，周一出周报，每月 1 日出月报；保留原文链接与论文标识，不默认全文转载。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatSourceId：一个社交账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   */
  maker: null as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要与阅读索引，原文版权归各来源所有。图片来源与论文引用会标注出处。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “天文日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}

/** “按主题看天文”“往期天文日报”这类：行业词接在中文后面，英文词前加空格，中文词不加；noun 照 withSubject 接上。 */
export function subjectAfter(text: string, noun?: string): string {
  const gap = /^[A-Za-z0-9]/.test(SITE.subject) ? " " : "";
  return `${text}${gap}${noun ? withSubject(noun) : SITE.subject}`;
}