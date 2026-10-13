# 部署、升级与备份

[中文](DEPLOYMENT.md) | [English](DEPLOYMENT.en.md)

> 项目部署参考：下列命令尚不构成当前快照的独立安装验收。已有作者验证结果；本轮独立 Linux 原生启动、空库迁移与关键路径已完成，Docker 独立复验受网络阻塞，详见[验证范围](VALIDATION.md)。不宣称全量通过。已知测试/类型缺口见[已知问题](../KNOWN-ISSUES.md)，P0 见[TODO](TODO.md)。不提供一键成功保证。

## 1. 前提与安全默认

参考源码使用Node.js >=24.11、npm workspaces、PostgreSQL，容器配置使用PostgreSQL 17。Docker方式需要Docker Engine与Compose；原生方式需要分别守护API、worker、Web三个进程。构建资源需求随版本而变，先在隔离环境检查，不宣称固定最低机器配置。

从项目仓库 <https://github.com/sw2sw/AstroHot> 获取源码，或选择已提供的发布包/标签；需要复现时记录完整提交号。公开仓库可匿名克隆，私有仓库或私有 fork 须按其访问权限认证。本文不把上游AIHOT仓库地址当成AstroHot发行地址。阅读LICENSE、NOTICE及[内容版权说明](CONTENT-RIGHTS.md)。

从最终安全模板建立`.env`，不要复制私有部署配置。生成独立管理员密码（参考要求至少12位）与会话、图片签名、数据库密钥，例如使用`openssl rand -hex 32`生成随机值。不得把生成结果写进公开仓库或日志附件。

初始化器可能选择不同默认值；首次启动前必须核对：

```dotenv
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
ARXIV_NATIVE_COLLECT_ENABLED=false
ARXIV_ANALYSIS_ENABLED=false
ARXIV_DAILY_REPORT_ENABLED=false
IMAGERY_ENABLED=false
IMAGERY_DAILY_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false
```

推送、影像定时任务同样保持关闭，具体变量以最终发行模板为准。没有key不是唯一安全控制；有key也不代表已批准调用。设置自有`ADMIN_PASSWORD`、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`及必要数据库连接；`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`仅在准备启用模型时填自己的配置。

## 2. Docker参考路径

在发行包根目录核对Compose的服务、挂载、端口和环境，不直接复制别人整套容器配置：

```sh
# 先核对安全.env、持久卷及公开端口，再启动
# 此命令待最终公开包安装验证
docker compose up -d --build
```

参考Compose有`db`、`setup`、`api`、`worker`、`web`；`setup`执行迁移和种子初始化后退出。迁移失败不可继续启动业务。先看日志及容器状态，不因首页返回200就判业务完整通过。

```sh
docker compose ps
docker compose logs --tail 100 setup api worker web
```

Web参考入口为3000端口，后台`/admin`。验证正式登录、未登录后台拒绝、普通页面可用、安全阀关闭与持久卷存在；不要触发真实采集/付费调用来代替基础启动检查。

## 3. 域名、HTTPS与网络

`SITE_URL`必须是读者实际访问的站点根地址，用于RSS、分享链接及站点地图；它不会自动跟随访问时使用的浏览器地址。

参考配置提供可选HTTPS profile，也可接入已有反向代理。已有业务服务器优先复用网络管理，不覆盖系统DNS、路由或已有代理：

```dotenv
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000
# 仅在信任的反向代理已正确配置时启用
TRUST_PROXY=true
```

使用参考Caddy profile前确认端口和证书卷无冲突：

```sh
# 待最终发行包验证该profile
docker compose --profile https up -d --build
```

不公开数据库、私有数据目录或非必要API管理端口。`EGRESS_PROXY_URL`用于参考实现中部分采集出口，不能据此保证模型请求也走同一代理；核对各请求路径。MCP额外允许主机配置只影响相应Host校验，不代替浏览器Origin、安全认证或防火墙。依法完成部署地区要求的备案和隐私说明。

## 4. 原生进程参考路径

须先准备独立PostgreSQL数据库、安全`.env`、可写私有数据目录，并核对`DATABASE_URL`与`API_BASE_URL`。

```sh
npm ci
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web
```

迁移和种子成功后，用独立服务管理配置启动各进程；不要在同一个阻塞终端依次执行并认为三个都已启动：

```sh
# 进程1：API
node --env-file=.env apps/api/src/main.ts
# 进程2：worker
node --env-file=.env apps/worker/src/main.ts
# 进程3：在apps/web目录执行
NODE_ENV=production node --env-file=../../.env server.ts
```

为进程设置重启后自启、日志、环境加载和优雅停止。参考部署文档要求worker至少210秒停止宽限，避免中途杀掉付费调用；最终值以发行实现为准。不要在生产设置开发认证旁路。

## 5. 配置与启用

基础启动通过后，按[后台设置](ADMIN.md)选源、配预算及模型，以小批量验证再开定时。不要把初始化seed、后台库设置和运行中环境变量混为一谈。文章频度与模型恢复节拍见[运行节奏](CADENCE.md)。

模型服务的并发上限、请求间隔和供应商限额共同决定吞吐，按实际服务限额保守设置，多实例共享同一额度。低并发或慢响应下的积压表现、`no model slot free within ...ms`、429、隔离令牌和诊断边界见[模型服务容量与处理积压](../KNOWN-ISSUES.md#模型服务容量与处理积压)；该节是限制与 TODO，不代表问题已修复。

## 6. 备份与恢复

升级前备份数据库、必要私有文件、部署配置及旧镜像/代码版本。数据库dump单独存在不等于完整备份；参考实现还有本地上传/反馈附件。图片缓存是否需要备份按实际用途决定。

参考对象存储备份支持`DB_BACKUP_STORE_*`配置，实际计划和可选功能须按发行版核对；不承诺未配置存储也自动得到备份。恢复时将同一次备份的数据库与对应文件恢复到隔离目标，检查权限、路径和引用后再切换。恢复演练需单独批准，不能覆盖正在运行的生产库。

`docker compose down -v`会删除卷，不是普通停止或安全回滚命令。密钥配置备份加密并限制访问，永不随源码发布。

## 7. 升级与回滚

1. 固定目标版本与变更范围，准备已验证的备份和回滚步骤。
2. 构建候选，保留旧镜像和有效Compose配置；依赖未变不反复重装。
3. 若迁移要求停旧服务，先让worker在途请求收尾，再停止API/worker/Web，数据库不随意重启。
4. 迁移成功才启动新服务；冲突或失败即停，不手工伪造迁移台账。
5. 读回运行版本、schema、登录、页面和业务设置，核对更新的日期/数字/状态展示。
6. 回滚须同时考虑代码与数据库兼容性；只换回旧镜像不能自动撤销迁移。停用来源也不能保证已排队或在途模型调用已停止，应核对闸门、队列与回执。

不通过扩大付费重试、放宽校验或绕过锁来解决升级失败。公开文档不提供私有运营站点地址、密钥、内部SSH或远程部署脚本。
