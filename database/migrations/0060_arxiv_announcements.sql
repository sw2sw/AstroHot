-- Official announcement evidence is independent of immutable API submission metadata.
CREATE TABLE arxiv_announcement_batches (
  content_hash text PRIMARY KEY,
  raw_rss text NOT NULL,
  collected_at timestamptz NOT NULL,
  paper_count integer NOT NULL CHECK (paper_count >= 0)
);
CREATE TABLE arxiv_announcements (
  arxiv_id text NOT NULL,
  base_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  announce_type text NOT NULL CHECK (announce_type IN ('new', 'cross', 'replace', 'replace-cross')),
  announced_on date NOT NULL,
  first_batch_hash text NOT NULL REFERENCES arxiv_announcement_batches(content_hash),
  PRIMARY KEY (arxiv_id, announce_type)
);
CREATE INDEX arxiv_first_announcement_idx ON arxiv_announcements(base_id, announced_on) WHERE announce_type = 'new';
