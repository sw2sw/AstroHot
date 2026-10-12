// Read-only assembly of the operational failures recorded in ops_error_events.
//
// This is the read side of the recorder: it never triggers collection, analysis, recovery, a digest or
// a paid request, and it never modifies a claim, retry counter, budget or pause. It also never prints a
// stored response body or a provider answer — only the redacted message and the evidence reference.
//
// Every number in a report answers ONE window: group aggregation, event expansion, run details and
// evidence state all use the same [since, until) and stage filters. Where the source state cannot be
// determined (a deleted exception row, a file- or rejection-based reference, missing run details) the
// field says "unknown" — never a clean zero.
import { sql } from "../db.ts";

export interface OpsErrorQuery {
  /** Inclusive lower bound, ISO-8601 UTC. */
  since: string;
  /** Exclusive upper bound, ISO-8601 UTC. */
  until: string;
  stage?: string | null;
  /** Paging is over groups, so `limit` counts kinds of failure, not rows. */
  limit: number;
  offset: number;
}

export interface OpsErrorEvidenceRef {
  ref: string;
  sha256: string | null;
  truncated: boolean;
}

export interface OpsErrorGroupReport {
  groupKey: string;
  stage: string;
  code: string;
  target: string | null;
  severity: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  /** job_runs ids still reachable for this group (a run cleaned up by retention is not listed here). */
  jobRuns: number[];
  /** The DURABLE execution identities this group points at — they survive a job_runs cleanup. */
  runKeys: string[];
  receipts: number[];
  /**
   * Paper versions the linked runs really INSERTED, summed over the runs whose detail carries the
   * count. `null` means unknown: no run identity, an execution whose row retention removed (or an
   * `exec:` scope that never had one), some linked run missing its detail, or a run whose detail
   * predates the dedicated inserted counter. Announcements are NEVER merged into this number.
   */
  savedCount: number | null;
  /** True when some linked run had no readable detail or no inserted count, so savedCount is not a complete sum. */
  savedCountIncomplete: boolean;
  /** Announcements the official feed carried for the linked runs — shown separately, never merged into savedCount. */
  announcementCount: number | null;
  /** Candidates the linked runs processed through analysis — a processing count, not a storage count. */
  analyzedCount: number | null;
  /**
   * Open hydration exceptions among the referenced evidence. `null` means unknown: nothing is
   * referenced, or any reference is NOT a hydration exception (a rejection row, a private file) whose
   * resolution state does not exist, or the referenced row has since been deleted.
   */
  openEvidence: number | null;
  /** True when openEvidence is unknown for any of the reasons above. */
  openEvidenceUnknown: boolean;
  /** Every hydration-exception id the group's events reference (evidence_ref + details). */
  exceptionRefs: number[];
  /** True when a producer stated its own exception-id list was cut (association is explicitly incomplete). */
  exceptionRefsIncomplete: boolean;
  /** The real affected targets named by the group's events (details.affected), for locating each failure. */
  targets: string[];
  /** True when more than the listed evidence references exist for the group. */
  evidenceTruncated: boolean;
  /**
   * Events in this group whose failure body could NOT be read out at all (the first read was
   * rejected, or the read timed out with no prefix): there is no kept file AND the body is not known
   * to be empty. Counted separately so "no evidence file" is never read as "the origin sent nothing".
   */
  bodiesUnread: number;
  messages: string[];
  evidence: OpsErrorEvidenceRef[];
}

export interface OpsErrorReport {
  since: string;
  until: string;
  stage: string | null;
  limit: number;
  offset: number;
  groupCount: number;
  hasMore: boolean;
  note: string;
  groups: OpsErrorGroupReport[];
}

interface GroupRow {
  group_key: string;
  stage: string;
  code: string;
  target: string | null;
  severity: string;
  first_seen: Date;
  last_seen: Date;
  occurrences: number;
}

/**
 * The durable execution identity of a row. `run_key` is written with the event and survives a
 * job_runs cleanup; the fallback derives the SAME identity for pre-0065 rows from the FK they still
 * have. The FK alone is not enough: after retention has cleaned a run, `job_run_id` is NULL, and the
 * parent/domain hiding rule (and the stored-content sum) would then treat one execution as none.
 */
const RUN_IDENTITY = sql`coalesce(run_key, case when job_run_id is not null then 'run:' || job_run_id::text end)`;
/** A generic `task_failed` row that exists only as the parent of a domain event. */
const PARENT_ROW = sql`coalesce(details->>'parent','false') = 'true'`;

/** The job_runs id a durable identity points at, when it is a run (an `exec:` scope has no row). */
function runIdOfIdentity(identity: string): number | null {
  const match = /^run:(\d+)$/.exec(identity);
  return match ? Number(match[1]) : null;
}

/** The durable identity a read row carries. */
function identityOfEvent(row: { run_key: string | null; job_run_id: number | null }): string | null {
  if (row.run_key !== null && row.run_key !== "") return row.run_key;
  return row.job_run_id !== null ? `run:${row.job_run_id}` : null;
}

interface EventRow {
  group_key: string;
  occurred_at: Date;
  sanitized_message: string;
  job_run_id: number | null;
  run_key: string | null;
  receipt_id: number | null;
  evidence_ref: string | null;
  evidence_sha256: string | null;
  evidence_truncated: boolean;
  details: unknown;
}

/** The event filter shared by the group aggregation and the per-group expansion. */
function windowClause(since: string, until: string, stage: string | null) {
  return sql`occurred_at >= ${since}::timestamptz AND occurred_at < ${until}::timestamptz
    AND (${stage}::text IS NULL OR stage = ${stage})`;
}

/**
 * New-content detail a run actually stored, read from the run detail the business code already
 * writes. Three INDEPENDENT counters, never merged:
 * - `insertedPaperCount` is the number of paper versions the run really INSERTED (window pages and
 *   hydration batches). This is the only "saved" number.
 * - `rssPaperCount` is how many announcements the official feed carried — an announcement is not a
 *   stored paper: it can correspond to an already-stored version, and re-published feeds repeat it.
 * - `analyzed` is how many candidates the run processed through analysis — a processing count, not a
 *   storage count and not a count of new model requests.
 * `null` per field means unknown: no run detail, or the field is absent (older runs).
 */
interface RunContentDetail { inserted: number | null; announcements: number | null; analyzed: number | null; }
function contentFromDetail(detail: unknown): RunContentDetail {
  // The driver hands jsonb back as text here, so both forms are accepted.
  let parsed: unknown = detail;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { inserted: null, announcements: null, analyzed: null };
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { inserted: null, announcements: null, analyzed: null };
  }
  const d = parsed as Record<string, unknown>;
  const num = (key: string): number | null => typeof d[key] === "number" ? d[key] : null;
  return { inserted: num("insertedPaperCount"), announcements: num("rssPaperCount"), analyzed: num("analyzed") };
}

const isHydrationExceptionRef = (ref: string | null): number | null => {
  const match = ref === null ? null : /^arxiv_hydration_exceptions:(\d+)$/.exec(ref);
  return match ? Number(match[1]) : null;
};

/** Exception ids referenced through details.exceptionIds, the full multi-exception link. */
function exceptionIdsOf(details: unknown): number[] {
  let parsed: unknown = details;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const ids = (parsed as Record<string, unknown>).exceptionIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id));
}

/** True when the producer explicitly stated its stored exception-id list was CUT (not complete). */
function exceptionIdsIncompleteOf(details: unknown): boolean {
  let parsed: unknown = details;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return (parsed as Record<string, unknown>).exceptionIdsIncomplete === true;
}

/** The real affected targets a producer named in details.affected (bounded by the producer). */
function affectedOf(details: unknown): string[] {
  let parsed: unknown = details;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const affected = (parsed as Record<string, unknown>).affected;
  if (!Array.isArray(affected)) return [];
  return affected.filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * One page of failure groups over the given window, with the business state they point at.
 * A `task_failed` parent event is hidden when the SAME run already has a domain event in the window
 * — the domain group is the record of that failure. Parent-only runs keep their generic row, so the
 * fallback stays visible; nothing is ever counted twice.
 */
export async function queryOpsErrors(query: OpsErrorQuery): Promise<OpsErrorReport> {
  if (Date.parse(query.since) > Date.parse(query.until)) throw new Error("--since must not be after --until");
  const stage = query.stage ?? null;
  const where = windowClause(query.since, query.until, stage);

  // limit + 1 answers hasMore honestly: exactly one page is NOT "more".
  const grouped = await sql<GroupRow[]>`
    WITH windowed AS (
      SELECT * FROM ops_error_events WHERE ${where}
    ),
    domain_runs AS (
      SELECT DISTINCT ${RUN_IDENTITY} AS rid FROM windowed
      WHERE ${RUN_IDENTITY} IS NOT NULL AND NOT (${PARENT_ROW})
    )
    SELECT group_key, min(stage) AS stage, min(code) AS code, min(target_id) AS target,
           min(severity) AS severity, min(occurred_at) AS first_seen, max(occurred_at) AS last_seen,
           count(*)::int AS occurrences
    FROM windowed
    WHERE NOT (${PARENT_ROW}
               AND ${RUN_IDENTITY} IS NOT NULL
               AND ${RUN_IDENTITY} IN (SELECT rid FROM domain_runs))
    GROUP BY group_key ORDER BY max(occurred_at) DESC, max(id) DESC
    LIMIT ${query.limit + 1} OFFSET ${query.offset}`;
  const hasMore = grouped.length > query.limit;
  const groups = grouped.slice(0, query.limit);

  const keys = groups.map((g) => g.group_key);
  // The expansion applies the SAME window and stage filter AND the SAME parent-hiding rule as the
  // aggregation above: a run whose domain event already stands for the failure (anywhere in the
  // window, not only on this page) never has its generic parent re-expanded into a group's
  // messages, runs or saved counts. domain_runs is computed over the whole window exactly as in
  // the grouping query, so both queries always see ONE effective event set. The comparison is on the
  // DURABLE execution identity, so a run cleaned up by retention still hides its own parent.
  const events = keys.length === 0 ? [] : await sql<EventRow[]>`
    WITH windowed AS (
      SELECT * FROM ops_error_events WHERE ${where}
    ),
    domain_runs AS (
      SELECT DISTINCT ${RUN_IDENTITY} AS rid FROM windowed
      WHERE ${RUN_IDENTITY} IS NOT NULL AND NOT (${PARENT_ROW})
    )
    SELECT group_key, occurred_at, sanitized_message, job_run_id, run_key, receipt_id, evidence_ref,
           evidence_sha256, evidence_truncated, details
    FROM ops_error_events
    WHERE group_key = ANY(${keys}) AND ${where}
      AND NOT (${PARENT_ROW}
               AND ${RUN_IDENTITY} IS NOT NULL
               AND ${RUN_IDENTITY} IN (SELECT rid FROM domain_runs))
    ORDER BY occurred_at DESC, id DESC`;

  const identities = [...new Set(events.map(identityOfEvent).filter((k): k is string => k !== null))];
  const runIds = [...new Set(identities.map(runIdOfIdentity).filter((id): id is number => id !== null))];
  const runs = runIds.length === 0 ? [] : await sql<{ id: number; detail: unknown }[]>`
    SELECT id, detail FROM job_runs WHERE id = ANY(${runIds})`;
  const contentByRun = new Map(runs.map((r) => [r.id, contentFromDetail(r.detail)]));

  // All exception references — through evidence_ref AND through details.exceptionIds, so a batch
  // with several missing versions exposes every one of them, not only the first.
  const exceptionIds = [...new Set(events.flatMap((e) => [
    isHydrationExceptionRef(e.evidence_ref),
    ...exceptionIdsOf(e.details),
  ]).filter((id): id is number => id !== null))];
  const exceptionRows = exceptionIds.length === 0 ? [] : await sql<{ id: number; resolved_at: Date | null }[]>`
    SELECT id, resolved_at FROM arxiv_hydration_exceptions WHERE id = ANY(${exceptionIds})`;
  const exceptionState = new Map(exceptionRows.map((r) => [r.id, r.resolved_at === null]));

  const report = groups.map((group) => {
    const rows = events.filter((e) => e.group_key === group.group_key);
    // EXECUTION identities, not surviving FK rows: a run retention has already cleaned keeps its
    // identity here, so it can never be silently dropped from the sum below (which is exactly how a
    // partial total used to be reported as a whole).
    const runIdentities = [...new Set(rows.map(identityOfEvent).filter((k): k is string => k !== null))];
    const runIdsOfGroup = [...new Set(runIdentities.map(runIdOfIdentity).filter((id): id is number => id !== null))];
    const contentValues = runIdentities.map((rid) => {
      const id = runIdOfIdentity(rid);
      // An `exec:` scope never had a job_runs row, and a cleaned run's row is gone: both are a run
      // whose stored content is UNKNOWN, never zero.
      return id === null ? undefined : contentByRun.get(id);
    });
    const haveContent = contentValues.filter((v): v is RunContentDetail => v !== undefined);
    // A sum is only stated when EVERY execution this group points at said how much it stored; a
    // missing detail — including one whose run row retention removed — is incompleteness, not zero.
    const missingContent = runIdentities.length > 0 && haveContent.length < runIdentities.length;
    const sumOf = (pick: (d: RunContentDetail) => number | null): number | null => {
      if (runIdentities.length === 0 || missingContent) return null;
      const values = haveContent.map(pick);
      return values.some((v) => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);
    };
    const savedCount = sumOf((d) => d.inserted);
    const savedIncomplete = runIdentities.length > 0 && (missingContent || haveContent.some((d) => d.inserted === null));
    const refs = rows.map((e) => e.evidence_ref).filter((ref): ref is string => ref !== null);
    const allIds = [...new Set(rows.flatMap((e) => [isHydrationExceptionRef(e.evidence_ref), ...exceptionIdsOf(e.details)])
      .filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const open = allIds.filter((id) => exceptionState.get(id) === true).length;
    const missing = allIds.filter((id) => !exceptionState.has(id)).length;
    const nonExceptionRef = refs.some((ref) => isHydrationExceptionRef(ref) === null);
    // A producer that stated its own exception-id list was CUT has an incomplete association: the
    // listed exceptions resolving cleanly says nothing about the ones that were never listed, so the
    // group's open count is UNKNOWN — never a confident zero built from a partial list.
    const exceptionIncomplete = rows.some((e) => exceptionIdsIncompleteOf(e.details));
    // Zero is only stated when every referenced exception was checked and none is open. A reference
    // of a kind with no resolution state, an exception row that no longer exists, or a truncated
    // association is unknown.
    const openEvidenceUnknown = refs.length === 0 || nonExceptionRef || missing > 0 || exceptionIncomplete;
    const evidenceRefs = [...new Set(refs)];
    return {
      groupKey: group.group_key,
      stage: group.stage,
      code: group.code,
      target: group.target,
      severity: group.severity,
      firstSeen: group.first_seen.toISOString(),
      lastSeen: group.last_seen.toISOString(),
      occurrences: group.occurrences,
      jobRuns: runIdsOfGroup,
      runKeys: runIdentities,
      receipts: [...new Set(rows.map((e) => e.receipt_id).filter((id): id is number => id !== null))],
      savedCount,
      savedCountIncomplete: savedIncomplete,
      announcementCount: sumOf((d) => d.announcements),
      analyzedCount: sumOf((d) => d.analyzed),
      openEvidence: openEvidenceUnknown ? null : open,
      openEvidenceUnknown,
      exceptionRefs: allIds,
      exceptionRefsIncomplete: exceptionIncomplete,
      targets: [...new Set(rows.flatMap((e) => affectedOf(e.details)))].slice(0, 100),
      messages: [...new Set(rows.map((e) => e.sanitized_message))].slice(0, 5),
      // A bounded list is a CONTRACT, not a silence: when more evidence references exist, the
      // flag says so instead of pretending twenty is all there is.
      evidenceTruncated: evidenceRefs.length > 20,
      // An event that declared its failure body unreadable has no evidence_ref but is NOT evidence of
      // an empty body: it is counted so the report can say the body is unknown.
      bodiesUnread: rows.filter((e) => e.evidence_ref === null
        && (e.evidence_truncated || (e.details as Record<string, unknown> | null)?.bodyUnavailable === true)).length,
      evidence: evidenceRefs.slice(0, 20).map((ref) => {
        const row = rows.find((e) => e.evidence_ref === ref)!;
        return { ref, sha256: row.evidence_sha256, truncated: row.evidence_truncated };
      }),
    };
  });

  return {
    since: query.since,
    until: query.until,
    stage,
    limit: query.limit,
    offset: query.offset,
    groupCount: groups.length,
    hasMore,
    // The record chain has a fallback this query does NOT read (stderr, ops/error-evidence/
    // fallback.jsonl, run-detail recordingGaps). An empty window here is "nothing was recorded in
    // the database", never proof that nothing happened.
    note: "只读查询：只反映 ops_error_events 已入库事件，不读取 stderr / fallback.jsonl / 运行明细缺口；空窗口不等于全系统无错误，也不等于记录链路完整。",
    groups: report,
  };
}

/** Markdown form of a report; keeps every field the JSON form carries. */
export function renderOpsErrorReport(report: OpsErrorReport): string {
  const lines = [
    `# 运行错误记录 ${report.since} — ${report.until}`,
    "",
    `共 ${report.groupCount} 组。${report.note}`,
    `分页：offset=${report.offset} limit=${report.limit} hasMore=${report.hasMore}`,
    "",
  ];
  if (report.groups.length === 0) {
    lines.push("此窗口无已记录事件（注意：fallback 与运行明细缺口不在本查询范围内）。", "");
    return lines.join("\n");
  }
  for (const g of report.groups) {
    lines.push(
      `## ${g.code}（${g.stage}${g.target ? ` · ${g.target}` : ""}）`,
      `- 级别：${g.severity}`,
      `- 首次：${g.firstSeen}　最近：${g.lastSeen}　发生次数：${g.occurrences}`,
      `- 关联运行：${g.jobRuns.join(", ") || "—"}${g.savedCountIncomplete ? "（部分运行的成果明细不可达，非完整合计）" : ""}　回执：${g.receipts.join(", ") || "—"}`,
      `- 执行身份：${g.runKeys.join(", ") || "—"}（随事件持久保存，运行的库行被清理后仍可识别）`,
      `- 论文新增保存数：${g.savedCount === null ? "unknown" : g.savedCount}${g.savedCountIncomplete ? "（部分关联运行缺少明细，非完整合计）" : ""}`,
      `- 公告数：${g.announcementCount === null ? "unknown" : g.announcementCount}（公告不等于入库）　分析处理数：${g.analyzedCount === null ? "unknown" : g.analyzedCount}`,
      `- 未解决证据：${g.openEvidenceUnknown ? "unknown" : g.openEvidence}`,
      `- 异常引用：${g.exceptionRefs.join(", ") || "—"}${g.exceptionRefsIncomplete ? "（生产方已声明关联被截断，非完整清单）" : ""}`,
      ...(g.targets.length ? [`- 受影响目标：${g.targets.join(", ")}`] : []),
      ...g.evidence.map((e) => `  - 证据：${e.ref}　SHA256：${e.sha256 ?? "—"}${e.truncated ? "（已截断）" : ""}`),
      ...(g.evidenceTruncated ? ["  - （证据引用超过 20 条，仅列出前 20 条）"] : []),
      ...(g.bodiesUnread ? [`  - （${g.bodiesUnread} 条事件的失败正文未能读取，已标不完整且未落文件——正文未知，不等于上游返回空正文）`] : []),
      ...g.messages.map((m) => `  - ${m}`),
      "",
    );
  }
  return lines.join("\n");
}
