-- Resumable AI-free metadata windows; no report, raw metadata or receipt rewrites.
CREATE TABLE arxiv_collection_state (
  key text PRIMARY KEY,
  completed_through timestamptz,
  -- Persist the rollout floor: today's first releases and future papers, never old pending backlog.
  analysis_start_on date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  window_from text,
  window_through text,
  next_start integer NOT NULL DEFAULT 0 CHECK(next_start >= 0),
  expected_total integer CHECK(expected_total >= 0),
  seen_ids text[] NOT NULL DEFAULT '{}',
  owner uuid,
  lease_until timestamptz,
  CHECK ((window_from IS NULL) = (window_through IS NULL))
);
