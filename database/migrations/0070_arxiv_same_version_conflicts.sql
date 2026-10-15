-- Same-version content that does NOT match, kept as evidence instead of being absorbed.
--
-- Two documents about one versioned identity can disagree about the science. The feed states the
-- abstract as published and the API states its summary, so a purely presentational difference
-- (line wrapping, indentation) is not a disagreement; a different title or a different abstract IS
-- one, and so is a field that cannot be read at all.
--
-- The rule this table exists for: never overwrite the document a paid analysis already ran on, and
-- never let a disagreement pass as an ordinary duplicate. A disagreement is recorded here, the row
-- that is already stored keeps its exact content and hash, and the version is held back from starting
-- a NEW analysis until a human has looked at the two documents. Resolution is an operator decision
-- (`UPDATE ... SET resolved_at = clock_timestamp()`), deliberately not an automatic rule: the whole
-- point is that the machine could not tell which document is right.
CREATE TABLE arxiv_same_version_conflicts (
  id bigserial PRIMARY KEY,
  arxiv_id text NOT NULL,
  base_id text NOT NULL,
  -- Why the two documents were not treated as the same paper.
  --   same_source_drift        two documents of the SAME source disagree about the science: the
  --                            incoming batch is refused as a whole (the existing red line).
  --   cross_source_difference  an Atom document and a feed document disagree, or cannot be compared
  --                            at all: both originals are kept and the version is deferred.
  --   author_correction_deferred  the science is identical and only the creator list changed, while a
  --                            paid-analysis claim was live, so the correction was not adopted yet.
  kind text NOT NULL CHECK (kind IN ('same_source_drift', 'cross_source_difference', 'author_correction_deferred')),
  stored_source text NOT NULL CHECK (stored_source IN ('atom', 'rss')),
  arriving_source text NOT NULL CHECK (arriving_source IN ('atom', 'rss')),
  -- The identity of both sides: the hash of the stored metadata (the exact document a paid analysis
  -- would key on) and the hash of the arriving document.
  stored_metadata_sha256 text NOT NULL CHECK (stored_metadata_sha256 ~ '^[0-9a-f]{64}$'),
  arriving_document_sha256 text NOT NULL CHECK (arriving_document_sha256 ~ '^[0-9a-f]{64}$'),
  -- The comparison itself: the verdict, and the two scientific values (bounded) so the disagreement
  -- can be judged without the documents being reachable.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Whether an open conflict of this kind holds the version back from starting a NEW analysis. Only a
  -- genuine doubt about the science does; a pending creator correction must never stall a paper whose
  -- science is not in question.
  defers_analysis boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  -- Replaying the same arriving document records the same conflict once.
  UNIQUE (arxiv_id, arriving_document_sha256),
  CONSTRAINT arxiv_same_version_conflicts_defers_check
    CHECK (defers_analysis = (kind <> 'author_correction_deferred'))
);

CREATE INDEX arxiv_same_version_conflicts_arxiv_idx ON arxiv_same_version_conflicts (arxiv_id);
CREATE INDEX arxiv_same_version_conflicts_open_idx
  ON arxiv_same_version_conflicts (arxiv_id) WHERE resolved_at IS NULL;
