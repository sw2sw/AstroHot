-- Cross-process claim for the arXiv analysis worker. One live claim per raw paper version; a claim is
-- only a mutual-exclusion marker, so a crashed worker's row stays behind for manual recovery (no TTL).
CREATE TABLE arxiv_analysis_claims (
  arxiv_id text PRIMARY KEY REFERENCES arxiv_raw_papers(arxiv_id) ON DELETE CASCADE,
  metadata_hash text NOT NULL CHECK (metadata_hash ~ '^[0-9a-f]{64}$'),
  token text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
