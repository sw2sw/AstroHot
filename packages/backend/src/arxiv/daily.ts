import { sql } from "../db.ts";
import { validateArxivReport } from "./report.ts";
import { reportDigest } from "./store.ts";
import type { ArxivReport, ArxivPaper } from "../../../contracts/src/arxiv.ts";

const MAX_CANDIDATE_POOL = 1000;

const COVERAGE_NOTE =
  "Analysis covers the candidate records analyzed on the issue date in Asia/Shanghai, screened from title and abstract only. It is not a complete arXiv daily census and may omit records.";

const NOTE_ZH =
  "本日报仅基于论文标题与摘要做候选筛选，未经人工复核，也不代表同行评审结论，请以论文原文和正式评审为准。";

function resolveDefaultIssueDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

function assertIssueDate(value: string): void {
  if (typeof value !== "string" || value.length !== 10) {
    throw new Error(`invalid issue date: ${String(value)}`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`invalid issue date: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) {
    throw new Error(`invalid issue date year: ${value}`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`invalid issue date month: ${value}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`invalid issue date day: ${value}`);
  }
}

type CandidateRow = {
  paper: unknown;
  source_report: unknown;
};

type StoredReportRow = {
  content_hash: unknown;
  report: unknown;
};

export async function composeArxivDailyReport(
  { issueDate }: { issueDate?: string } = {},
): Promise<{ status: "imported" | "unchanged"; runId: string; report: ArxivReport }> {
  const resolvedIssueDate = issueDate === undefined ? resolveDefaultIssueDate() : issueDate;
  assertIssueDate(resolvedIssueDate);

  return sql.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");

    const rows = (await tx`
      SELECT p.paper, r.report AS source_report
      FROM arxiv_papers p
      LEFT JOIN arxiv_reports r ON r.run_id = p.run_id
      WHERE (p.generated_at AT TIME ZONE 'Asia/Shanghai')::date = ${resolvedIssueDate}::date
        AND p.paper->>'publication_status' = 'candidate_only'
      ORDER BY p.base_id ASC
      LIMIT 1001
    `) as unknown as CandidateRow[];

    if (rows.length > MAX_CANDIDATE_POOL) {
      throw new Error(
        `arxiv daily candidate pool exceeds ${MAX_CANDIDATE_POOL} for ${resolvedIssueDate}`,
      );
    }

    const items = rows.map((row) => row.paper) as ArxivPaper[];

    let inputCollectedAtUtc: string | null = null;
    for (const row of rows) {
      const source = row.source_report;
      if (source === null || source === undefined) {
        throw new Error(`missing source arxiv report for candidate on ${resolvedIssueDate}`);
      }
      const sourceReport = validateArxivReport(source);
      const collected = sourceReport.input_collected_at_utc;
      if (typeof collected !== "string" || Number.isNaN(Date.parse(collected))) {
        throw new Error(`invalid source input_collected_at_utc for ${resolvedIssueDate}`);
      }
      const normalized = new Date(collected).toISOString();
      if (inputCollectedAtUtc === null || normalized < inputCollectedAtUtc) {
        inputCollectedAtUtc = normalized;
      }
    }

    const inputSha256 = reportDigest(items);
    const runId = `arxiv-daily-${resolvedIssueDate}-${inputSha256}`;

    const persistedRows = (await tx`
      SELECT content_hash, report FROM arxiv_reports WHERE run_id = ${runId}
    `) as unknown as StoredReportRow[];

    if (persistedRows.length > 0) {
      const record = persistedRows[0];
      const persisted = validateArxivReport(record.report);
      if (typeof record.content_hash !== "string" || reportDigest(persisted) !== record.content_hash) {
        throw new Error(`persisted arxiv report content hash mismatch for ${runId}`);
      }
      if (
        persisted.run_id !== runId ||
        persisted.report_type !== "arxiv_astronomy_screening" ||
        persisted.issue_date !== resolvedIssueDate ||
        persisted.input_sha256 !== inputSha256 ||
        reportDigest(persisted.items) !== inputSha256
      ) {
        throw new Error(`persisted arxiv report identity mismatch for ${runId}`);
      }
      return { status: "unchanged", runId, report: persisted };
    }

    const generatedAtUtc = new Date().toISOString();

    const counts = { SELECT: 0, REVIEW: 0, DEFER: 0 };
    for (const item of items) {
      if (item.verdict === "SELECT") {
        counts.SELECT += 1;
      } else if (item.verdict === "REVIEW") {
        counts.REVIEW += 1;
      } else if (item.verdict === "DEFER") {
        counts.DEFER += 1;
      } else {
        throw new Error(`unknown verdict ${String(item.verdict)} for ${runId}`);
      }
    }

    const rankedSelectedIds = items
      .filter((item) => item.verdict === "SELECT")
      .map((item) => item.arxiv_id);

    const report = validateArxivReport({
      schema_version: 1,
      report_type: "arxiv_astronomy_screening",
      timezone: "Asia/Shanghai",
      mode: "daily",
      issue_date: resolvedIssueDate,
      run_id: runId,
      generated_at_utc: generatedAtUtc,
      coverage: COVERAGE_NOTE,
      review_status: "model_screening_candidate_only_requires_human_review",
      input_sha256: inputSha256,
      input_collected_at_utc: inputCollectedAtUtc ?? generatedAtUtc,
      candidate_pool_count: items.length,
      paper_count: items.length,
      counts,
      ranked_selected_ids: rankedSelectedIds,
      items,
      note_zh: NOTE_ZH,
    });

    const inserted = (await tx`
      INSERT INTO arxiv_reports (run_id, content_hash, generated_at, issue_date, report)
      VALUES (
        ${report.run_id},
        ${reportDigest(report)},
        ${report.generated_at_utc},
        ${report.issue_date},
        ${JSON.stringify(report)}::text::jsonb
      )
      ON CONFLICT (run_id) DO NOTHING
      RETURNING run_id
    `) as unknown as Array<{ run_id: unknown }>;

    if (inserted.length > 0) {
      return { status: "imported", runId, report };
    }

    const rereadRows = (await tx`
      SELECT content_hash, report FROM arxiv_reports WHERE run_id = ${runId}
    `) as unknown as StoredReportRow[];

    if (rereadRows.length === 0) {
      throw new Error(`arxiv report ${runId} missing after conflict`);
    }
    const record = rereadRows[0];
    const persisted = validateArxivReport(record.report);
    if (typeof record.content_hash !== "string" || reportDigest(persisted) !== record.content_hash) {
      throw new Error(`persisted arxiv report content hash mismatch for ${runId}`);
    }
    if (
      persisted.run_id !== runId ||
      persisted.report_type !== "arxiv_astronomy_screening" ||
      persisted.issue_date !== resolvedIssueDate ||
      persisted.input_sha256 !== inputSha256 ||
      reportDigest(persisted.items) !== inputSha256
    ) {
      throw new Error(`persisted arxiv report identity mismatch for ${runId}`);
    }
    return { status: "unchanged", runId, report: persisted };
  }) as Promise<{ status: "imported" | "unchanged"; runId: string; report: ArxivReport }>;
}
