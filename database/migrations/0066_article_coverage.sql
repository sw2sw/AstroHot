-- How much of an article's text the site actually holds, and what a bounded read of the original page
-- found it to allow. Both are evidence beside the material, so a summary can be introduced without
-- ever being presented as the article:
--   coverage: full_text | official_abstract | public_excerpt | metadata_only
--   access:   open | login | subscribe | maybe | challenge
-- Nullable and untouched for sources that never record one: existing behaviour and existing rows keep
-- their meaning (a title-only listing is judged exactly as before).
-- Rollback: ALTER TABLE articles DROP COLUMN coverage, DROP COLUMN access;  -- no data is derived from
-- them anywhere else, and no reader-facing field is stored, so dropping them restores the old state.
-- IF NOT EXISTS, like the other additive migrations here: the ledger keys on the file name, so a file
-- renamed before it was ever deployed must still apply to a database that had the old name.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS coverage text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS access text;

-- The reader-facing note is derived at read time and never stored, so the two columns above are the
-- only durable trace and the only object this migration adds.
