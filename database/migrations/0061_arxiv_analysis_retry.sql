CREATE TABLE arxiv_analysis_retry (
  arxiv_id text NOT NULL REFERENCES arxiv_raw_papers(arxiv_id) ON DELETE CASCADE,
  metadata_hash text NOT NULL,
  prompt_version text NOT NULL,
  validation_failures integer NOT NULL DEFAULT 0 CHECK(validation_failures >= 0),
  next_attempt_at timestamptz,
  blocked_reason text CHECK(blocked_reason IN ('validation_limit','receipt_uncertain','legacy_retry_review')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(arxiv_id,metadata_hash,prompt_version)
);
CREATE INDEX arxiv_analysis_receipt_subject_idx ON receipts(subject) WHERE purpose='arxiv-analysis';
