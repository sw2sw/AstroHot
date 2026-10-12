// 可选模块——只对 AI 行业有意义：做天文行业时两项都设为 false。
// 关掉以后：导航里不再出现入口，对应的定时任务不再运行，页面与接口返回 404。

export const FEATURES = {
  /** 模型榜：AI 行业专用，天文本站关闭。 */
  leaderboard: false,
  /** Codex 重置监控：AI 行业专用，天文本站关闭。 */
  codexResetMonitor: false,
} as const;