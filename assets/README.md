# 资产

站点直接从这里提供这些文件。随文件的 NOTICE 和 LICENSE 一起保留。

| 目录 | 内容 | 注意 |
|---|---|---|
| `og-fonts/` | Noto Sans SC 400/700（SIL OFL 1.1，见目录里的 LICENSE） | 只用于服务端生成分享图；网页用系统字体，不发字体请求 |

站点自己的图标、Logo、报头字在 `industry/brand/`，换行业时换那里的文件。

## 本发行包不含的第三方标志

上游工程在 `assets/model-providers/`（模型厂商与模型系标志）和 `assets/leaderboard-sources/`
（评测来源官方标志）下放了各所有者的商标，仅用于标识。这些标志是第三方品牌素材，不随本发行包
分发，已从发行树中移除。因此模型榜与来源页默认只显示首字母/首字（monogram），不会出现破图。

部署者如已获得相应授权，可以自行把标志放进这两个目录并重新启用映射：
`packages/backend/src/leaderboard/registry.ts` 里的 `MARKS_BUNDLED`、`FAMILY_MARKS`、
`PROVIDER_MARKS` 与 `source-registry.json` 中的 `logo` 字段。站点自身品牌位于
`industry/brand/`：本包只附中性占位图标（`logo.svg`、`icon*.png`、`favicon.ico`），
上线前请换成你自己的品牌文件，并确认其许可。
