// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import { syncArxivReport } from "@aihot/backend/arxiv/sync";
import { collectScheduledArxiv } from "@aihot/backend/arxiv/collection-budget";
import { analyzePendingArxiv } from "@aihot/backend/arxiv/analyze";
import { composeArxivDailyReport } from "@aihot/backend/arxiv/daily";
import { imageryDailyEnabled, runImageryDaily } from "@aihot/backend/imagery/daily";
import type { PgBoss } from "pg-boss";
import { FEATURES } from "@aihot/industry/features";
import { CODEX_RESET_SCAN_MINUTES } from "@aihot/contracts/monitor";
import { credential } from "@aihot/backend/config";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { linkRelatedStories } from "@aihot/backend/events/consolidate";
import { composeDueReports } from "@aihot/backend/reports/compose";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { monitorTick } from "@aihot/backend/monitor/scan";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { recoverStaleWork } from "@aihot/backend/operations/recover";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";

interface Scheduled {
  name: string;
  cron: string;
  // The job_runs row id is handed to every entry so a failure event can name the run it belongs to;
  // an entry that has nothing to record simply ignores it.
  run: (runId: number) => Promise<unknown>;
  missed?: "skip" | "once";
  // Evaluation time zone of the cron expression; every entry but the arXiv collection schedule runs
  // on Shanghai time.
  tz?: string;
  // pg-boss retries a failed job inside its own queue. That is right for most entries, but a retry of
  // the arXiv collection would run seconds after the failed attempt instead of at the next six-hour
  // slot, so that entry turns it off and relies on the durable daily budget instead.
  retryLimit?: number;
}

const collecting = process.env.COLLECT_ENABLED === "true";
const DEFAULT_TZ = "Asia/Shanghai";

/** The queue of a cron entry. policy is fixed at creation; the rest is corrected when it drifted. */
export function scheduleQueueOptions(schedule: Pick<Scheduled, "retryLimit">) {
  return { policy: "singleton" as const, retryLimit: schedule.retryLimit ?? 1, expireInSeconds: 3600 };
}

export const SCHEDULES: Scheduled[] = [
  // Retry today only each hour; missed startup slots coalesce into one run, not historical backfill.
  ...(imageryDailyEnabled()
    ? [{ name: "imagery.daily", cron: "23 * * * *", missed: "once" as const, run: () => runImageryDaily() }]
    : []),
  ...(process.env.ARXIV_REPORT_URL ? [{ name: "arxiv.sync", cron: "*/30 * * * *", run: () => syncArxivReport() }] : []),
  ...(process.env.ARXIV_ANALYSIS_ENABLED === "true" && process.env.MODEL_CALLS_ENABLED === "true"
    ? [{ name: "arxiv.analyze", cron: "*/30 * * * *", run: (runId: number) => analyzePendingArxiv({ limit: 20, jobRunId: runId }) }]
    : []),
  ...(process.env.ARXIV_DAILY_REPORT_ENABLED === "true"
    ? [{ name: "arxiv.daily-report", cron: "7,37 * * * *", run: () => composeArxivDailyReport() }]
    : []),
  // arXiv publishes the official feed once a day. The scheduled entry is the day's first attempt at
  // 01:00 UTC, then a retry every six hours while nothing new came in — at most three attempts a day,
  // counted durably, and closed as soon as an attempt actually collected something. The time zone is
  // UTC on purpose: the budget is a UTC-day budget, so the slots must not slide with local time.
  // retryLimit 0: a pg-boss retry would run seconds after the failure, outside the six-hour spacing
  // and outside the daily budget, so the queue must not retry — the durable slot guard is the retry.
  ...(collecting && process.env.ARXIV_NATIVE_COLLECT_ENABLED === "true"
    ? [{ name: "arxiv.collect", cron: "0 1,7,13 * * *", tz: "UTC", retryLimit: 0, run: (runId: number) => collectScheduledArxiv({ jobRunId: runId }) }]
    : []),
  { name: "content.sweep", cron: "*/5 * * * *", run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "*/5 * * * *", run: () => translatePending() },
  { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
  { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
  { name: "stories.links", cron: "12 * * * *", run: linkRelatedStories },
  // Every issue that is due and not written yet: a daily from 08:00, a weekly from Monday 10:00, a monthly
  // from the 1st 10:30, each on the half hour it falls due; a missed or failed one at the next run.
  { name: "reports.compose", cron: "0,30 * * * *", missed: "once", run: () => composeDueReports() },
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  ...(collecting
    ? [{ name: "sources.icons", cron: "40 4 * * *", missed: "once" as const, run: () => refreshSourceIcons() }]
    : []),
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release; ops.alerts runs in parallel and sees the result by its next run at the latest.
  { name: "ops.recover", cron: "*/10 * * * *", run: () => recoverStaleWork() },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with other follow-ups and their actual impact (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  // Four upstream checks a day; a new run is published only when the evidence changed. With collection
  // off only the computation runs, over the snapshots already stored.
  ...(FEATURES.leaderboard
    ? [{ name: "leaderboard.round", cron: "5 2,8,14,20 * * *", missed: "once" as const, run: () => (collecting ? refreshLeaderboard() : runLeaderboardRound()) }]
    : []),
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
      ]
    : []),
  // Codex reset monitor: every ten minutes as the pages state, and the last 48 hours read again once a day;
  // the 04:40 runs of both take turns (monitorTick). It reads X through SocialData, so without that key
  // there is nothing to run.
  ...(collecting && FEATURES.codexResetMonitor && credential("collectors", "SOCIALDATA_API_KEY")
    ? [
        { name: "monitor.tick", cron: `*/${CODEX_RESET_SCAN_MINUTES} * * * *`, run: () => monitorTick() },
        { name: "monitor.lookback", cron: "40 4 * * *", run: () => monitorTick({ lookbackHours: 48 }) },
      ]
    : []),
];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, scheduleQueueOptions(s));
    await boss.schedule(queue, s.cron, {}, { tz: s.tz ?? DEFAULT_TZ, missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // pg-boss keys a schedule by its expression and time zone, so editing a schedule's cron leaves the
  // old key queued forever. Drop every cron entry that is gone from this list OR whose expression or
  // time zone no longer matches, otherwise a retired slot keeps firing (and would, for example, spend
  // the arXiv collection's daily attempt budget).
  const current = new Map(SCHEDULES.map((s) => [`cron.${s.name}`, { cron: s.cron, tz: s.tz ?? DEFAULT_TZ }]));
  for (const old of await boss.getSchedules()) {
    if (!old.name.startsWith("cron.")) continue;
    const wanted = current.get(old.name);
    if (!wanted || wanted.cron !== old.cron || wanted.tz !== old.timezone) await boss.unschedule(old.name, old.key);
  }
}
