CREATE TABLE IF NOT EXISTS imagery_archive (
  source TEXT NOT NULL
    CHECK (source <> '' AND char_length(source) <= 100 AND source ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  source_date DATE NOT NULL,
  metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  title_zh TEXT,
  explanation_zh TEXT,
  local_path TEXT
    CHECK (local_path IS NULL OR (char_length(local_path) <= 200 AND local_path ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$' AND local_path NOT LIKE '%..%')),
  content_type TEXT,
  translation_status TEXT NOT NULL DEFAULT 'pending' CHECK (translation_status IN ('pending', 'ready', 'failed')),
  media_status TEXT NOT NULL DEFAULT 'pending' CHECK (media_status IN ('pending', 'ready', 'failed', 'not_applicable')),
  media_error_code TEXT,
  translation_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_date)
);

CREATE INDEX IF NOT EXISTS imagery_archive_date_idx ON imagery_archive (source_date DESC, source DESC);
