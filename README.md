# AstroHot

[中文](README.md) | [English](README.en.md)

天文资讯与论文初筛工具：采集元数据、保留原文入口，使用可配置模型辅助筛选、摘要与翻译，通过 API 和 Web 提供阅读。阅读页面不触发模型调用；AI 初筛不等于阅读全文、同行评议或科学事实核验。

> **私密首版协作快照，尚未公开发布。** 协作仓库：<https://github.com/sw2sw/AstroHot>。已完成限定范围的独立安装、空库启动与关键路径验收；类型检查及部分后端测试仍未通过。详见[验证范围](docs/VALIDATION.md)和[已知问题](KNOWN-ISSUES.md)，不宣称全量通过或生产部署验收。

## 先读这些

- [许可说明](docs/LICENSING.md)、[LICENSE](LICENSE)、[NOTICE](NOTICE)：保留 MIT、上游归属及第三方许可。
- [版权与使用声明](docs/COPYRIGHT.md)、[免责声明](docs/DISCLAIMER.md)：软件与运营内容分离，AI 结果仅供参考，独立部署自行合规。
- [已知问题](KNOWN-ISSUES.md)、[协作 TODO](docs/TODO.md)：P0 硬门槛、作者测试边界及后续任务。
- [贡献流程](CONTRIBUTING.md)、[安全报告](SECURITY.md)：小范围 PR、脱敏复现，不公开敏感信息。

## 安全启动

参考工程要求 Node.js **>=24.11**、npm workspaces 与 PostgreSQL（Compose 使用 PostgreSQL 17）。安装、迁移、独立进程及容器命令集中在[部署文档](docs/DEPLOYMENT.md)，尚不构成当前快照安装成功保证。

从 `.env.example` 建立本地 `.env`，配置独立强密码及签名密钥；**采集、模型调用、arXiv 分析/日报、影像任务与推送默认关闭**。不要使用生产库、私有配置或真实付费服务来验证初次启动。启用前逐项核查来源权限、供应商、预算和容量。仓库不提供运行凭据。

软件分发不携带运营内容库，也不授予新闻、论文、图片或其他第三方内容版权。只保留软件所需资产及明确标注的自编合成演示；署名、链接、RSS 可访问或 AI 改写均不自动代表许可。免责声明不是免责保证。

## 功能文档

- [来源](docs/SOURCES.md) · [采集与分析频度](docs/CADENCE.md) · [后台设置](docs/ADMIN.md)
- [评分方法](docs/SCORING.md) · [内容版权核查](docs/CONTENT-RIGHTS.md) · [错误记录](docs/ERROR-RECORDING.md)
- [诺贝尔奖专题](docs/NOBEL.md) · [合成演示数据](database/demo/README.md)

功能可用状态以当前快照代码和验收范围为准；候选实现、作者验证与独立验收不是同一状态。

## 合成界面预览

以下为合成演示截图，不是真实采集结果；独立功能验收范围见[验证说明](docs/VALIDATION.md)。

| 首页（桌面） | 条目详情（桌面） |
| --- | --- |
| ![合成首页桌面预览](docs/images/home-desktop.png) | ![合成条目详情预览](docs/images/item-detail-desktop.png) |

| 首页（手机） | 诺贝尔奖专题（合成演示，非真实获奖信息） |
| --- | --- |
| ![合成首页手机预览](docs/images/home-mobile.png) | ![合成专题预览](docs/images/nobel-topic-desktop.png) |

## 上游

基于 [AIHOT](https://github.com/KKKKhazix/AIHOT) 改造；保留 `Copyright (c) 2026 数字生命卡兹克` 及原 MIT LICENSE/NOTICE。AIHOT 名称与 Logo 不随代码 MIT 授权。AstroHot 不继承上游的维护承诺。
