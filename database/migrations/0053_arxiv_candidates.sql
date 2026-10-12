-- Independent abstract-screening archive; never feeds the news processing pipeline.
CREATE TABLE arxiv_reports (
  run_id text PRIMARY KEY,
  content_hash text NOT NULL,
  generated_at timestamptz NOT NULL,
  issue_date date NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  report jsonb NOT NULL
);
CREATE TABLE arxiv_papers (
  paper_key text PRIMARY KEY,
  base_id text NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version >= 1),
  generated_at timestamptz NOT NULL,
  run_id text NOT NULL REFERENCES arxiv_reports(run_id),
  paper jsonb NOT NULL,
  CHECK (paper->>'publication_status' = 'candidate_only'),
  CHECK (paper->>'peer_review_status' = 'unverified'),
  CHECK (paper->>'analysis_scope' = 'title_and_abstract_only')
);
CREATE INDEX arxiv_reports_generated_idx ON arxiv_reports (generated_at DESC, run_id);
