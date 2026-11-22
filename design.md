# 综合科学源：天文 / AI4S 共用初筛与栏目分流 — 设计

基线：`main`（本仓库当前 main，`package-lock.json` sha256 与本次移植的增量一致）。

## 1. 现有调用链（实读本基线）

```
collectSource → store(contentScope = source.config.contentScope ?? "astro")
  → upsertMaterial(articles.content_scope)
  → queueProcessing → route() → extract(取正文) → analyzeArticle
      → runAnalysis
          prefilter: contentScope==="ai4s" ? ai4s-prefilter : prefilter   ← 单维，且先于一切判断
          BLOCK → 停；PASS/UNKNOWN → structure(与 score 并行) + score×2 + writing
      → normalizeAnalysis(run, contentScope)
      → 事务写 analyses + 回执 complete + articles.processing_state
  → publishArticle：publications.content_scope 直接取 articles.content_scope；
                    astro_cross_listed = f.crossListed && eligible && (ai4a===true || 人工 astroApproved+理由)
  → 读层：天文 astroScopeCondition = (content_scope='astro' OR astro_cross_listed)
          AI4S ai4sListedCondition = content_scope='ai4s'
```

问题点即任务书 §3.1：综合源入库固定 `astro`，天文预筛 BLOCK 后文章再无机会进入 AI4S 分析。

## 2. 改法：一次共享初筛，按双维结果路由

新增 `industry/prompts/shared-prefilter.md`，一次调用返回：

```json
{ "astronomy": "PASS|BLOCK|UNKNOWN", "ai4s": "PASS|BLOCK|UNKNOWN", "reason": "20 字内可核对依据" }
```

- **适用范围显式**：`source.config.sharedPrefilter === true`。只给 `rss-journal-scientific-american`、
  `rss-journal-nature`、新增 `anthropic-science` 三个源配置。不按名称模糊匹配。
- **不串行付费**：仍是一次 `chatJson`，`purpose="prefilter_article"`；不再为 AI4S 追加第二次预筛。
- **解析失败不伪造 BLOCK**：schema 用 `z.enum` 无 `catch`，非法枚举值抛 `ModelOutputError`，走既有重试/失败路径。
- **材料不足**：沿用 `missingEvidence` 规则——任一维判 BLOCK 但材料不足时该维降为 UNKNOWN。
- 初筛结果**只**决定路由，不写 `ai4a` / `selected` / `crossListed`。

### 2.1 路由与主归属

记 `A` = astronomy、`S` = ai4s，`effectiveScope` 为本轮分析实际使用的栏目。

| A | S | 路由 | effectiveScope | 后续调用 |
|---|---|---|---|---|
| PASS | BLOCK | 天文链（现状） | astro | astro score×2 + astro structure + writing |
| BLOCK | PASS | AI4S 链 | **ai4s** | ai4s score×2 + ai4s structure + writing |
| PASS | PASS | 天文为主 + 补一次 AI4S structure | astro | astro score×2 + astro structure + **ai4s structure** + writing |
| BLOCK | BLOCK | 排除 | — | 无 |
| 任一 UNKNOWN | 任意 | 不转否：不进入付费分析，`relevance="unknown"` 待判，记录两维与原因 | — | 无 |

**双 PASS 为什么主归属选 astro**：
1. 基线只有一个 `publications.content_scope`，AI4S 读层只读 `content_scope='ai4s'`；astro→ai4s 方向**没有**
   跨列通道，反向的 `astro_cross_listed` 只服务 ai4s→astro。若把双 PASS 改成 ai4s，天文展示会静默丢失，
   违反任务书 §4.2-2。
2. 选 astro 则天文资格原样保留；AI4S 侧用**额外一次 `ai4s structure`** 拿到 `domain` / `ai4a` 证据，
   两维资格都落在同一条 `analyses.output` 上（`sharedPrefilter` + `domain` + `ai4a`），不复制文章。
3. AI4S 展示资格由**本 revision 的 AI4S 维度结果**给出（`ai4s_cross_listed`），不搬主归属、不由 `ai4a` 推导；
   两栏各自精选，见 §7。

**主归属改写**：只有 A=BLOCK、S=PASS 时，在 `analyzeArticle` 的既有事务里
`UPDATE articles SET content_scope='ai4s' WHERE id=… AND revision=…`，与 `analyses` 同事务、绑定 revision；
迟到的旧 revision 结果不写（既有 `stale` 判定不变）。

**UNKNOWN 不放行也不丢弃**：写 `relevance="unknown"` + `unknownReason="shared-prefilter"`，
不调用 score/structure/writing，避免无界反复付费；材料补足（revision 变化）后重新走本流程。

## 3. 回执身份

- 共享初筛：`promptVersion = shared-prefilter@<hash>`（`promptVersion()` 内容哈希），`subject = article:<id>@<rev>`，
  `purpose = prefilter_article`。旧单维回执的 `promptVersion` 是 `prefilter@…` / `ai4s-prefilter@…`，
  `logicalKeyFor` 含 `promptVersion` 的 identity 哈希，**不会**被误当双维输出。
- 后续分析沿用各自既有版本：`ai4s-*` 用于 AI4S 链，`selection-score`/`structure` 用于天文链；一次响应不被算作两次评分。
- `SELECTION_PROMPT_VERSION` / `AI4S_ANALYZE_PROMPT_VERSION` 不变；共享初筛版本单独记入
  `analyses.output.detail.sharedPrefilter.version`。

## 4. 幂等与并发

沿用既有边界：`claim`（receipts 行锁 + `pending` 10 分钟）、`budget`、`attemptTag`、`revision`。
- 同一文章同 revision 重复入队 → 同一 logicalKey → 复用回执，不再付费。
- 并发 worker → `paidRequest` 的 `pg_advisory_xact_lock` + 行锁，只有一个发请求，另一个 `ReceiptBusyError` 等 60s。
- 材料修订 → `revision+1`，`subject` 变化，旧回执不复用；旧结果 `stale=true` 不写库。

## 5. 付费次数（假模型计数，相对现状）

| 路径 | 现状 | 改后 | 增量 |
|---|---|---|---|
| 天文单命中 | 1 prefilter + 2 score + 1 structure + 1 writing = 5 | 1 shared + 2 + 1 + 1 = 5 | 0 |
| AI4S 单命中（原被天文 BLOCK） | 1 prefilter（然后停） | 1 shared + 2 score + 1 structure + 1 writing = 5 | **+4** |
| 双命中 | 不成立（原被 BLOCK） | 1 shared + 2 score + 1 astro structure + 1 ai4s structure + 1 writing = 6 | **+5** |
| 双 BLOCK / UNKNOWN | 1 prefilter | 1 shared | 0 |

"不加一轮初筛"≠ 总费用不变：新增合格 AI4S 内容必然带来正常后续分析成本，上表按路径列出。

## 6. Anthropic 官方科学源

- **来源身份**：`anthropic-science`（新 id，`kind="web_list"`，`tier="T1"`，`contentScope` 不预设，
  `sharedPrefilter=true`，`enabled` 缺省不启用，`interval_minutes=1440`，`_aihot.initialBackfillLimit=3`）。
  `contentScope` 不写死，由共享初筛决定，避免新源重蹈"固定 astro"。
- **入口**：主 `https://www.anthropic.com/science` + 补 `https://www.anthropic.com/search?topic=discovery`，
  **同一 source 身份**。实现：`config.url` 指主入口，`config.supplementaryUrl` 指补漏入口，采集器内追加一轮，
  两入口候选合并后按 canonical URL 去重（`supplementaryUrl` / `supplementaryItemSelector` 为新增受控键）。
- **页面结构（2026-11-21 实网确认，非猜测）**：
  - `/science`：文章卡片是 `article`，标题在 `h3`，日期在 `time` 的文本（无 `datetime` 属性）；
    另有轮播卡片的 `<a>` 只包图片、无文字，且同一篇会重复出现——因此按 URL 归并、
    后到的日期/更长标题用于补全先前条目，**不得让无日期的轮播链接先占位**。
  - `/search?topic=discovery`：每条命中是一个 `<details>`，`summary` 里依次是分类、纯文本日期、
    标题三段 `<p>`；文章链接是 "View article" 按钮。因此日期取"能解析成日期的行"，
    标题取剩余行里最长的一条；CTA 文案（View article / Read more）永不作为标题。
  - 该列表无分页控件，单页即全量（覆盖限制：两入口各一页）。
- **日期**：列表页自身日期优先，缺日期不伪造，详情页 JSON-LD 只在列表缺日期时补
  （`detail.publishedAtUtcOffset="+00:00"`，不采 `lastmod`）。
- **范围**：`allowUrlPrefixes=["…/research/","…/news/"]` 加 `allowUrlRegex` 限定文章形状，
  排除 `/research/team/*` 这类导航页（实网会混进列表，标题如 "Alignment"）。
- **未启用**：候选只带配置与解析器，不创建 cron、不触发生产采集/付费。

## 7. 双栏展示（一篇文章，两个栏目入口）

反馈确认方向后落地为「一篇文章、两个栏目入口、各按本栏标准独立精选」。

**资格来源**（`publications.ai4s_cross_listed`）：
- 只由**分析管线**写入：`content_scope='astro'` 且本 revision 的 `analyses.output.sharedPrefilter.ai4s === "PASS"`
  且 `eligible`。UNKNOWN / BLOCK 不给资格。
- **不由 `ai4a` 推导**：AI4A 是「AI 被用于科研」的证据，不是栏目资格。两者可以同时存在，但互不推导。
- **不搬主归属**：`articles.content_scope` 与 `publications.content_scope` 都保持 `astro`，天文主链、天文精选、
  天文日报/周报完全不受影响。
- 历史文章不重析：旧 revision 的分析没有 `sharedPrefilter`，自然拿不到资格；发布重建（republish）从已有分析读，
  不新增付费调用。

**精选各自独立**（`publications.ai4s_selected`）：
- AI4S 栏的精选只认它自己的判定。双 PASS 行走的是天文链，没有 AI4S 专属评分，因此
  `ai4s_selected=false` —— 该文在 AI4S 栏「只进全部动态、不进精选」，这是合法且预期的状态。
- 反过来，天文栏的 `selected` 也不受 AI4S 栏影响。
- 字段单独存储（而非复用 `selected`），使将来若给双栏行补 AI4S 评分，只需写 `output.ai4sSelection=true`，
  两栏精选可以各自成立。
- **`output.ai4sSelection` 是预留键：当前没有任何生产写入路径。** `normalizeAnalysis` 写出的 `output` 只有
  `sharedPrefilter / ai4sStructure / conference` 等；双 PASS 分支跑的是天文评分加一次 AI4S structure，
  **不跑 AI4S 评分**。所以：
  - `ai4s_selected` 对跨栏行在生产链路上不可达，恒为 `false`；
  - 「AI4S 拦精选、天文不选」这个反向组合目前只有**字段与谓词就位**，生产不可达；测试里用夹具手写该键才复现得出来。
  - 让它真正可达需要一次额外的付费 AI4S 评分，按既定边界**本轮不安排**；届时由那次评分写入该键即可，无需改读层。

**读层**（`publication/scope.ts`）：
- `ai4sListedCondition` = `(content_scope='ai4s' OR ai4s_cross_listed) AND public AND eligible AND released`
- `ai4sSelectedCondition` = `(content_scope='ai4s' AND selected) OR (ai4s_cross_listed AND ai4s_selected)`
- **两栏的时间门槛不对称，这是有意的**：`released` 是天文侧的 `releasedCondition`（读 `selected` 与 `visible_after`），
  所以「AI4S 全部动态」**不受** `ai4s_visible_after` 约束 —— 只有「AI4S 精选」才按本栏自己的时间戳判上线。
  对「天文未选、仅 AI4S 精选」的跨栏行，`selected=false` 使其在全部动态里视为已上线；这是有意的（全部动态允许列
  尚未到发布时刻的候选），不是遗漏。若将来要两栏都受各自时间戳约束，需改 `ai4sListedCondition`，属另一处变更。
- 天文侧不改：`astroScopeCondition` 仍是 `content_scope='astro' OR astro_cross_listed`。

**去重**：一篇文章只有一条 `publications` 行，两栏用各自的谓词读同一行。栏内各出现一次，
不存在第二身份或第二条投影，因此「跨栏汇总重复」在结构上不会发生（`ai4s-dual-column` D8 断言）。

**未做**：详情页的「原文摘要」面板仍按文章主归属（`astro`）判断，双栏行从 AI4S 栏打开时不显示该面板。
要显示需给详情接口加栏目语境，属另一处变更，本次不并入。

## 8. 迁移

`0075_ai4s_cross_listed.sql`：`publications` 增 `ai4s_cross_listed`、`ai4s_selected` 两个 boolean（默认 false，additive）。
共享初筛结果仍存于既有 `analyses.output`，主归属仍用既有 `articles.content_scope`。
