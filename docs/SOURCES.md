[中文](SOURCES.md) | [English](SOURCES.en.md)

# 内置信息源与备选接入

> 本目录依据参考版本的`industry/sources.json`整理。内置配置不等于自动启用、版权已确认或长期可达；最终发行须核对对应文件。公开版采集默认关闭，使用者先选择来源、核对用途与预算，再自行启用。

## 1. 已提供配置的机构新闻源

这些来源已在工程中提供网页列表或RSS配置。以下地址是源入口，不是允许转载全文或图片的声明。

| 来源 | 稳定ID | 接入方式 | 入口 |
|---|---|---|---|
| 国家天文台 · 科研动态 | `web-bao-research` | `web_list` | https://www.bao.ac.cn/news/ky/ |
| 紫金山天文台 · 科研进展 | `web-pmo-research` | `web_list` | https://pmo.cas.cn/xwdt2019/kyjz2019/ |
| 上海天文台 · 科研进展 | `web-shao-research` | `web_list` | https://shao.cas.cn/2020Ver/xwdt/kyjz/ |
| ESO · 科学新闻 | `rss-eso-news` | `rss` | https://www.eso.org/public/news/feed/ |
| ESA Space Science | `rss-esa-science` | `rss` | https://www.esa.int/rssfeed/ESC |
| ESA Hubble · 新闻 | `rss-esa-hubble` | `rss` | https://esahubble.org/news/feed/ |
| ESA Webb · 新闻 | `rss-esa-webb` | `rss` | https://esawebb.org/news/feed/ |
| NOIRLab · 新闻 | `rss-noirlab` | `rss` | https://noirlab.edu/public/news/feed/ |

## 2. 杂志/出版物候选源

下列均已有RSS配置，参考配置默认`enabled:false`、T2、1440分钟，并关闭全文公开/再分发与杂志图片展示。综合刊仍需天文相关性过滤；无需为填满页面强行接收非天文条目。

APS Physics与Nature Astronomy在较早配置备注中曾列“首版不接入”，后续已经纳入可选接入范围；本文不沿用该旧备注作为永久禁用。最终公开配置仍应由使用者按用途选择启用，不能把私有站点的试运行状态写成发行版的默认启用状态。

| 来源 | 稳定ID | RSS入口 |
|---|---|---|
| Science · Space | `rss-journal-science-space` | https://www.science.org/action/showFeed?ui=0&mi=sfug99&type=search&feed=rss&query=%2526ConceptID%253D502894%2526target%253Dtopic |
| Sky & Telescope · 天文新闻 | `rss-journal-sky-telescope` | https://skyandtelescope.org/astronomy-news/feed/ |
| Astronomy Magazine · News | `rss-journal-astronomy-magazine` | https://www.astronomy.com/tags/news/feed/ |
| Nature · 综合 | `rss-journal-nature` | https://www.nature.com/nature.rss |
| Scientific American | `rss-journal-scientific-american` | https://www.scientificamerican.com/platform/syndication/rss/ |
| Quanta Magazine · Astronomy | `rss-journal-quanta-astronomy` | https://www.quantamagazine.org/tag/astronomy/feed/ |
| New Scientist · Space | `rss-journal-new-scientist-space` | https://www.newscientist.com/subject/space/feed/ |
| Astronomy Magazine · The Sky This Week | `rss-journal-astronomy-sky-this-week` | https://www.astronomy.com/tags/sky-this-week/feed/ |
| APS Physics | `rss-journal-aps-physics` | https://feeds.aps.org/rss/recent/physics.xml |
| Nature Astronomy | `rss-journal-nature-astronomy` | https://www.nature.com/natastron.rss |

Astronomy News和Sky This Week可能重复出现同一文章，按规范URL/材料身份去重，不把两个feed计为两篇新文章。Nature、Scientific American、APS等综合内容源的feed条数不等于天文有效条数。

## 3. 与普通新闻源分开的模块

- **arXiv astro-ph论文**：有独立元数据/版本/初筛与报告路径，不把论文候选与普通新闻评分混为一谈。以最终发行的专用配置及日期策略为准；是否纳入首版须复核。
- **APOD影像**：参考源码包含可选的双语影像与日期档案；来源许可、第三方署名与影像功能开关独立核对。源码存在不等于首版默认启用。
- **已有外部导入能力**：可用于接入符合实际接口契约的独立生产者；不随公开包提供私有站点的运营来源、连接地址或认证。

## 4. 尚未提供现成配置的备选来源

项目不提供“已全面验证”的额外名单。开发者可自行接入其他官方机构、期刊或媒体：优先其正式RSS/Atom；没有feed时再评估已支持的网页列表或JSON列表。不要为每家另写一套爬虫，也不要从来源名推断已有适配。

新增来源时先核对来源条款和内容范围，使用后台预览检查标题/URL/日期，配置不支持的字段不能硬塞；只在小批量真实流程、去重、公开页面及预算验证后开启定时。遇403/429、空feed或解析失败保留单源诊断，不显示空占位卡，不用旧内容制造“成功新增”。

## 5. 使用前核对

1. 入口仍为官方地址，feed是否覆盖目标栏目及历史窗口。
2. 原发布日期、时区和日期精度是否正确；不能用抓取时间替代原发布日期。
3. RSS公开材料是否足够支撑导读；订阅墙/登录墙不绕过。
4. 全文、图片、AI输入和再分发用途是否分别有依据。
5. 采集频率、首采条数与模型预算是否适合自己的部署。

详见[运行节奏](CADENCE.md)、[后台设置](ADMIN.md)和[版权核查方法](CONTENT-RIGHTS.md)。
