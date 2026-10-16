# arXiv 小批持续分析（候选，未部署）

[中文](arxiv-continuous-analysis.md) | [English](arxiv-continuous-analysis.en.md)

- `ARXIV_ANALYSIS_ENABLED=true` 且 `MODEL_CALLS_ENABLED=true` 才注册；每分钟检查一次，仍每批最多 20 篇、逐篇处理，不增加模型并发。
- 使用新队列 `cron.arxiv.analyze.continuous`，pg-boss `exclusive`（同一空 singleton key 的 created/retry/active 合计至多一个），`retryLimit=0`。跨分钟批次会丢弃中间 tick，不堆积待运行批次；失败由下一个分钟 tick 再检查，既有论文级退避仍生效。
- 不能直接沿用旧 `cron.arxiv.analyze`：pg-boss 12.34.0 的 `singleton` 只限制 active，不能防止分钟 tick 积压；已建队列的 policy 不能由 updateQueue 更改。
- 接续是下一个分钟 tick 加队列取件延迟（注册配置 polling 15 秒），不是秒级立即接续，也不保证固定时延上限。空闲 tick 只走现有 pending/retry 检查及运行记录，无合格论文则无模型调用、无源抓取。空闲分钟仍可能记录 `job_runs`，并非零数据库开销。
- 不改 collection 六小时间隔、日报、新闻、APOD、观测指南、模型选型、provider cap、6 槽/最多 4 占用、claims、未知回执、validation_limit=3 与冷却；不解锁旧受保护异常。现有 3600 秒 queue expire 保持不变，本候选不声称能终止超时仍在执行的回调。

## 后续发布门禁（本任务没有执行）

1. 发布需单独批准；以最新已审核主分支为底，只部署已审核增量。本改动不包含发布操作，也不修改观测指南任务。
2. 再读生产 runtime hash、schedule、两个分析队列的真实非终态 job 与 unfinished receipt_attempts、occupied permits；既有 cohort/未知回执门禁不因本候选解除。不得为部署清锁、重置历史或重跑付费异常。当前有正常批次时等待它自然结束，不能重启打断。
3. 确保新队列不存在或 policy 确为 exclusive；旧队列的 created/retry/active 全为零；旧 worker 完全退出后才让新 worker 启动。不得旧新并行 rollout。startup unschedule 只移除旧 cron，不取消旧已排队 jobs。
4. 仅切换 worker 的 reviewed schedules.ts，保留全部生产配置和其它 runtime；不改 DB 业务状态、不更改 collector hold/due。
5. 独立读回旧 cron 消失、新 cron 每分钟、exclusive/retryLimit=0、唯一非终态 job；观察自然分析及 receipts 成功落库，确认无重复调用和队列增长，空闲无模型请求。
6. 回滚也先自然排空新队列，再停新 worker、还原上一 worker 源码/镜像；确保新 cron 已撤销且旧 cron 恢复。不得让两代队列同时驱动分析。

## 隔离验证

使用独立本机 PostgreSQL 容器/唯一测试库与回环假模型，网络 guard 拒绝非 loopback；硬超时。真实 analyzePendingArxiv、receipts、model_permits、pg-boss 12.34.0 路径验证 45 篇按 20/20/5/0 处理，第一条假请求保持 65 秒跨分钟，80 次额外 send 全拒绝，保持一个 active/queued，总 45 次假模型调用，空轮零新增调用；下一次真实 cron 自然续批。生产采集/模型/DB 均未写入。此为专项验收，不是全库/前端回归。
