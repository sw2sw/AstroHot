-- Hydration fault tolerance: one row per unresolved versioned-ID exception, the daily RSS fetch
-- cache, the offline evidence of a safety-rejected batch, the durable request throttle and the
-- per-UTC-day attempt budget of the collection schedule. All of these are evidence/coordination
-- only: no report, raw metadata or receipt is rewritten.

CREATE TABLE arxiv_hydration_exceptions (
  id bigserial PRIMARY KEY,
  -- The format-validated versioned arXiv ID this exception is about.
  arxiv_id text NOT NULL,
  base_id text NOT NULL CHECK (base_id <> ''),
  version integer NOT NULL CHECK (version >= 1),
  -- missing: requested but not returned. unexpected: returned but never requested.
  kind text NOT NULL CHECK (kind IN ('missing','unexpected')),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- How often this exception was observed (initial hydration plus every explicit recovery try).
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  -- The complete request set of the batch and every ID that batch returned.
  request_ids text[] NOT NULL DEFAULT '{}',
  returned_ids text[] NOT NULL DEFAULT '{}',
  http_status integer,
  -- Allow-listed response headers only; credentials, cookies and auth headers are never stored.
  response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  pagination jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  -- Locates the complete raw response offline:
  --   SELECT b.raw_atom FROM arxiv_hydration_exceptions e
  --   JOIN arxiv_raw_batches b ON b.content_hash = e.raw_batch_hash WHERE e.id = ...;
  raw_batch_hash text REFERENCES arxiv_raw_batches(content_hash),
  raw_response_excerpt text NOT NULL DEFAULT '',
  raw_response_truncated boolean NOT NULL DEFAULT false,
  -- The last recovery attempt that never produced a usable document (rate limit, timeout, HTTP 5xx,
  -- transport failure). It is counted in attempts like every other observation and keeps the
  -- transport reason readable offline; an empty string means "no failed attempt recorded".
  last_attempt_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  resolved_at timestamptz
);

-- At most one open exception per (versioned ID, kind); resolved rows stay as history.
CREATE UNIQUE INDEX arxiv_hydration_exceptions_open_idx
  ON arxiv_hydration_exceptions (arxiv_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX arxiv_hydration_exceptions_open_seen_idx
  ON arxiv_hydration_exceptions (last_seen_at) WHERE resolved_at IS NULL;

-- One successfully ingested feed per channel and UTC collection day. A failed fetch writes no row,
-- so the next run refetches; a new UTC day is a new key and therefore a new fetch.
CREATE TABLE arxiv_rss_cache (
  channel text NOT NULL,
  cache_day date NOT NULL,
  content_hash text NOT NULL REFERENCES arxiv_announcement_batches(content_hash),
  fetched_at timestamptz NOT NULL,
  -- How many announcements the cached feed carried. A scheduled retry reads it to decide whether the
  -- cached feed is worth reusing before it refetches; the row never stores a payload by itself.
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  http_status integer,
  response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  PRIMARY KEY (channel, cache_day)
);

-- Offline evidence for a batch that was rejected for a correctness reason (a version mismatch, or a
-- same-version metadata conflict). Such a batch is never persisted as papers or raw batches, so
-- without this table the only trace would be a generic error string. The excerpt is truncated and
-- explicitly marked, and the hash locates the identical document if it is ever produced again.
CREATE TABLE arxiv_hydration_rejections (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('version_mismatch','content_conflict','transport')),
  -- The requested versioned IDs of the rejected batch, in request order.
  arxiv_ids text[] NOT NULL DEFAULT '{}',
  -- Human-readable, versioned detail (e.g. "2610.04500: requested v1, received v2").
  detail text NOT NULL,
  -- Structured form of the same finding, so an operator does not have to parse the text.
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  http_status integer,
  response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  raw_response_sha256 text,
  raw_response_excerpt text NOT NULL DEFAULT '',
  raw_response_truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX arxiv_hydration_rejections_created_idx ON arxiv_hydration_rejections (created_at DESC);

-- Durable inter-process request spacing. arXiv rate-limits by client, and the in-process channel
-- only spaces requests of one process, so the moment of the last official request is kept here and
-- shared by ordinary collection and the explicit recovery entry.
ALTER TABLE arxiv_collection_state ADD COLUMN last_request_at timestamptz;

-- The per-UTC-day attempt budget of the collection schedule: first attempt at 01:00 UTC, retries six
-- hours apart, at most three attempts a day, stopping early once a run actually collected something
-- new. One row per day; completed_at is the durable "stop retrying today" marker; last_slot_at is the
-- nominal instant of the scheduled slot the last attempt was admitted for, which is what makes the
-- six-hour spacing and the one-attempt-per-slot rule survive a restart, a duplicate delivery and a
-- pg-boss internal retry instead of only describing the cron expression.
CREATE TABLE arxiv_collection_day (
  day date PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The outcome of the last attempt: collected (stored something new), partial (the window was
  -- handled and everything storable was stored, some versions stayed recorded as exceptions), empty
  -- (ran clean, nothing new) or failed (raised). NULL until the first attempt finishes.
  last_outcome text CHECK (last_outcome IN ('collected','partial','empty','failed')),
  last_attempt_at timestamptz,
  last_slot_at timestamptz,
  completed_at timestamptz
);
