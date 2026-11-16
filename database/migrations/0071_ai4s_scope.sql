-- The AI4S column (AI for Science) beside the astronomy site: a source declares which column its
-- material belongs to (articles.content_scope), and the public projection carries the column, the
-- material's science domain and whether it is an astronomy application (AI4A). Astronomy rows keep
-- the default 'astro' and behave exactly as before; only the new column's read layer queries 'ai4s'.
-- astro_cross_listed is an audited editorial decision (override fields.crossListed) that lets one
-- ai4s article also appear in the astronomy lists without a second analysis or a second identity.
-- Rollback (see docs/AI4S.md, rollback section): do NOT drop these columns. Dropping them loses the domain/AI4A/
--   cross-list metadata and, with already-public ai4s rows still selected/seated, would expose them as
--   ordinary astronomy content once the old read rules return. Instead withdraw the ai4s publications
--   first (editorial_overrides.visibility='withdrawn' + republish → ledger remove, seats released), keep
--   the additive columns and all content, and only then optionally revert code. Restore by republishing.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_scope text NOT NULL DEFAULT 'astro' CHECK (content_scope IN ('astro', 'ai4s'));
ALTER TABLE publications ADD COLUMN IF NOT EXISTS content_scope text NOT NULL DEFAULT 'astro' CHECK (content_scope IN ('astro', 'ai4s'));
ALTER TABLE publications ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS ai4a boolean;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS astro_cross_listed boolean NOT NULL DEFAULT false;