-- Raw arXiv collection archive. Preserves the exact collected Atom bytes per batch and every
-- paper version verbatim. Ingestion never overwrites stored raw metadata or analysis status.
CREATE TABLE arxiv_raw_batches (
  content_hash text PRIMARY KEY CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  raw_atom text NOT NULL,
  collected_at timestamptz NOT NULL,
  paper_count integer NOT NULL CHECK (paper_count >= 0)
);

CREATE TABLE arxiv_raw_papers (
  arxiv_id text PRIMARY KEY,
  base_id text NOT NULL CHECK (base_id <> ''),
  version integer NOT NULL CHECK (version >= 1),
  metadata jsonb NOT NULL,
  metadata_hash text NOT NULL CHECK (metadata_hash ~ '^[0-9a-f]{64}$'),
  first_batch_hash text NOT NULL REFERENCES arxiv_raw_batches(content_hash),
  first_collected_at timestamptz NOT NULL,
  analysis_status text NOT NULL DEFAULT 'pending'
);

CREATE INDEX arxiv_raw_batches_collected_idx ON arxiv_raw_batches (collected_at DESC, content_hash);
CREATE INDEX arxiv_raw_papers_base_version_idx ON arxiv_raw_papers (base_id, version DESC);
CREATE INDEX arxiv_raw_papers_pending_idx ON arxiv_raw_papers (base_id, version DESC)
  WHERE analysis_status = 'pending';
CREATE INDEX arxiv_raw_papers_first_batch_idx ON arxiv_raw_papers (first_batch_hash);
