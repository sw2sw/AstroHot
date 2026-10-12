import { createHash } from "node:crypto";
import type { Tx } from "../db.ts";

export interface ArxivDatabase {
  begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export async function importArxivReport(input: unknown, database?: ArxivDatabase): Promise<{ status: "imported" | "unchanged"; runId: string }> {
  const { validateArxivReport, arxivVersion, arxivBaseId } = await import("./report.ts");
  const report = validateArxivReport(input);
  const hash = reportDigest(report);
  const db = database ?? { begin: async <T>(fn: (tx: Tx) => Promise<T>) => {
    const { sql } = await import("../db.ts");
    return sql.begin(fn) as Promise<T>;
  } };
  return db.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO arxiv_reports (run_id, content_hash, generated_at, issue_date, report)
      VALUES (${report.run_id}, ${hash}, ${report.generated_at_utc}, ${report.issue_date}, ${JSON.stringify(report)}::text::jsonb)
      ON CONFLICT (run_id) DO NOTHING RETURNING run_id`;
    if (!inserted.length) {
      const rows = await tx`SELECT content_hash FROM arxiv_reports WHERE run_id = ${report.run_id}`;
      if (rows[0]?.content_hash !== hash) throw new Error("run_id content conflict");
      return { status: "unchanged", runId: report.run_id };
    }
    for (const paper of report.items) {
      await tx`
        INSERT INTO arxiv_papers (paper_key, base_id, version, generated_at, run_id, paper)
        VALUES (${paper.paper_key}, ${arxivBaseId(paper.arxiv_id)}, ${arxivVersion(paper.arxiv_id)},
          ${report.generated_at_utc}, ${report.run_id}, ${JSON.stringify(paper)}::text::jsonb)
        ON CONFLICT (paper_key) DO UPDATE SET
          base_id = EXCLUDED.base_id, version = EXCLUDED.version,
          generated_at = EXCLUDED.generated_at, run_id = EXCLUDED.run_id, paper = EXCLUDED.paper,
          -- The reader-side admission instant: when this row was last really written. Refreshed only
          -- when the guard below accepts the replacement, so an ignored re-import of an equal or
          -- older version cannot announce content the reader already has.
          admitted_at = now()
        WHERE EXCLUDED.version > arxiv_papers.version OR
          (EXCLUDED.version = arxiv_papers.version AND EXCLUDED.generated_at > arxiv_papers.generated_at)`;
    }
    return { status: "imported", runId: report.run_id };
  });
}

export function shouldReplacePaper(oldVersion: number, oldGenerated: string, version: number, generated: string): boolean {
  return version > oldVersion || (version === oldVersion && Date.parse(generated) > Date.parse(oldGenerated));
}

export function reportDigest(value: unknown): string {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
    return JSON.stringify(v);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
