-- RSS-primary collection.
--
-- The official announcement feed already carries the title, abstract, authors and categories of every
-- announcement, so a normal paper no longer has to be fetched from the export API to be storable. What
-- the feed does NOT carry is a submission/update instant, and the rule is that an unknown date stays
-- unknown rather than being filled in.
--
-- A raw paper row therefore has to be able to say WHICH document it came from. The Atom archive is
-- untouched; an RSS-sourced row records the announcement batch it was read out of instead, so no
-- evidence foreign key ever points at a batch that does not exist.

ALTER TABLE arxiv_raw_papers ALTER COLUMN first_batch_hash DROP NOT NULL;

ALTER TABLE arxiv_raw_papers ADD COLUMN source text NOT NULL DEFAULT 'atom';
ALTER TABLE arxiv_raw_papers ADD CONSTRAINT arxiv_raw_papers_source_check CHECK (source IN ('atom', 'rss'));
ALTER TABLE arxiv_raw_papers ADD COLUMN first_rss_batch_hash text
  REFERENCES arxiv_announcement_batches(content_hash);

-- Exactly one document is the origin of a raw paper row, and it is the one the source column names:
-- the other source's column must be empty, so a row can never cite two origins or cite a document of
-- the wrong kind.
ALTER TABLE arxiv_raw_papers ADD CONSTRAINT arxiv_raw_papers_evidence_check CHECK (
  (source = 'atom' AND first_batch_hash IS NOT NULL AND first_rss_batch_hash IS NULL)
  OR (source = 'rss' AND first_rss_batch_hash IS NOT NULL AND first_batch_hash IS NULL));

CREATE INDEX arxiv_raw_papers_rss_batch_idx ON arxiv_raw_papers (first_rss_batch_hash);

-- Per-item isolation of one announcement that cannot be stored as a normal paper (no title, no
-- abstract section, no creator). The batch itself still commits and every other item is stored: the
-- row keeps the item text and the concrete reason, so an operator can see exactly what was skipped
-- and why instead of reading a whole failed feed. Identity and version conflicts are NOT isolations —
-- those still roll the whole batch back.
CREATE TABLE arxiv_rss_item_isolations (
  id bigserial PRIMARY KEY,
  -- An isolation is an annotation OF one batch: without the document it describes it cannot be
  -- located or read, so it goes with it. A raw paper is different (below): it is a derived artifact
  -- with its own life, and its evidence is never allowed to disappear under it.
  batch_hash text NOT NULL REFERENCES arxiv_announcement_batches(content_hash) ON DELETE CASCADE,
  -- The raw <item> as it was read, so the same item is isolated once per batch however often it is
  -- re-ingested.
  item_sha256 text NOT NULL CHECK (item_sha256 ~ '^[0-9a-f]{64}$'),
  -- The announcement this item is about, when the item got far enough to name one.
  arxiv_id text,
  reason text NOT NULL CHECK (reason IN ('title_missing', 'abstract_missing', 'creator_missing')),
  raw_item_excerpt text NOT NULL DEFAULT '',
  raw_item_truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_hash, item_sha256, reason)
);

CREATE INDEX arxiv_rss_item_isolations_batch_idx ON arxiv_rss_item_isolations (batch_hash);
