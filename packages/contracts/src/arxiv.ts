export type ArxivVerdict = "SELECT" | "REVIEW" | "DEFER";
export type ArxivStudyType = "observation" | "simulation" | "theory" | "method" | "mixed";

export interface ArxivPaper {
  paper_key: string;
  arxiv_id: string;
  title_original: string;
  title_zh: string;
  authors: string[];
  categories: string[];
  /**
   * The API's submission/update instants, or null when the record was read out of the official RSS
   * announcement feed, which states neither. Null is a real answer here and is rendered as "unknown";
   * it is never filled in from the announcement day, the ID's month or the collection timestamp.
   */
  submitted_at: string | null;
  updated_at: string | null;
  /**
   * The announcement day the source stated (arxiv:announce_type/pubDate), present whenever the record
   * has announcement evidence. For an RSS-sourced record this is the ONLY honest day there is.
   */
  announced_on?: string | null;
  url: string;
  verdict: ArxivVerdict;
  study_type: ArxivStudyType;
  summary_zh: string;
  reason_zh: string;
  evidence_abstract_quote: string;
  fulltext_review_question: string;
  peer_review_status: "unverified";
  analysis_scope: "title_and_abstract_only";
  publication_status: "candidate_only";
}

export interface ArxivReport {
  schema_version: 1;
  report_type: "arxiv_astronomy_screening";
  run_id: string;
  issue_date: string;
  timezone: "Asia/Shanghai";
  generated_at_utc: string;
  mode: "pilot" | "daily";
  coverage: string;
  review_status: string;
  input_sha256: string;
  input_collected_at_utc: string;
  candidate_pool_count: number;
  paper_count: number;
  counts: Record<ArxivVerdict, number>;
  ranked_selected_ids: string[];
  items: ArxivPaper[];
  note_zh: string;
}

export interface ArxivFeedPaper extends ArxivPaper {
  /** Official arXiv first-announcement batch date, not a measured first-visible instant. */
  announced_on?: string;
}

export interface ArxivFeed {
  items: ArxivFeedPaper[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * A fingerprint of the filtered candidate set's identity (base id + version). It changes exactly
   * when a candidate enters or leaves the scope — an empty scope has a stable, non-empty fingerprint
   * of its own, so "really empty" is never confused with "the response carried no signal". Read-only,
   * computed server-side from the rows the query already reads.
   */
  contentTag: string;
  /**
   * The newest WRITE instant among the filtered candidates (`max(arxiv_papers.admitted_at)`: when the
   * most recently admitted paper — or regenerated version — was really stored), or `null` for a
   * legitimately empty scope. Deliberately not `generated_at`, which is the reporting run's own date:
   * a report imported late carries an older one, so a new candidate could leave that maximum
   * untouched while the scope shrank. A write instant is stamped when the row enters the archive, so
   * any arrival raises it and a removal cannot. The archive is ordered by announcement/submission
   * date, so new content is NOT guaranteed at the head; this is what detects it wherever it lands.
   */
  admittedAt: string | null;
  /**
   * The filtered candidate set's identity map, one entry per candidate, in base-id order
   * (REVIEW-SHEEP-ROUND6 R6-2, ROUND7 R7-2). The archive is a flat list, so every candidate is its
   * own group: `key` is the stable base id, while `rep` and `memberIds` carry the VERSIONED
   * arxiv_id. That distinction is what R7-2 needs: a v1->v2 replacement the version guard accepted
   * keeps its key but changes its identity, so the reader diffs it as news instead of letting a
   * simultaneously shrinking scope absorb it. Comparable rather than hashed, so the reader can tell
   * a candidate that ARRIVED (a key the baseline lacked — however old its write instant ranks
   * against a concurrently committed one, and however much the scope otherwise shrank) from one
   * that LEFT.
   */
  groups: import("./site.ts").ScopeGroup[];
  latestBatch: {
    paperCount: number;
    selectedCount: number;
    outcome: "selected" | "no_new_papers" | "no_selected_papers";
  } | null;
  lastSyncedAt: string | null;
  issueDate: string | null;
  mode: "pilot" | "daily" | null;
  coverage: string | null;
  note: string;
}
