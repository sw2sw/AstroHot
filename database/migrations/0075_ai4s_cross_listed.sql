-- One article, two column entries: a shared-prefilter judgement can pass both dimensions, and the
-- article then keeps its astronomy row (content_scope='astro', the astronomy chain and its selection
-- untouched) while ALSO holding a display right in the AI4S column. The right is derived from that
-- article's own AI4S dimension result in its latest judgement — not from moving the row between
-- columns, and not from ai4a (an AI4A finding is evidence about science use, not a column right).
--
-- ai4s_selected is the AI4S column's OWN selection for that row. The columns select independently:
-- one may be selected while the other only lists the article, and nothing here turns a both-PASS
-- article into a double selection by itself.
--
-- Historical rows are never re-analysed for this: a row whose judgement predates the shared
-- prefilter has no AI4S dimension, so it gets no right. Rebuilding a publication from an existing
-- judgement (the normal republish path) is enough to pick the right up.
--
-- Rollback (same policy as 0071): keep the columns. Dropping them makes the AI4S read layer's SQL
-- invalid; reverting the code first returns the old read rules, and the columns stay harmless.
ALTER TABLE publications ADD COLUMN IF NOT EXISTS ai4s_cross_listed boolean NOT NULL DEFAULT false;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS ai4s_selected boolean NOT NULL DEFAULT false;
