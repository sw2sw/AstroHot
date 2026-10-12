-- Five-minute leases so only one worker generates imagery for a (source, date) pair.
CREATE TABLE IF NOT EXISTS imagery_claims (
  source text NOT NULL,
  source_date date NOT NULL,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (source, source_date)
);
