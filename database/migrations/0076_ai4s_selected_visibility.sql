-- Each column releases its own selection. `visible_after` is stamped when the astronomy column selects
-- a report, so an article that only the AI4S column selected has none — reading it there would mean
-- borrowing the other column's release moment. This column keeps its own stamp for its own selection.
--
-- Same policy as 0075: an article that is listed in the AI4S column without being selected in either
-- column has no stamp (null), which is exactly "not released here".
--
-- Rollback (same policy as 0071/0075): keep the column. Dropping it makes the AI4S selected
-- predicate invalid; reverting the code first returns the old read rule, and the column stays harmless.
ALTER TABLE publications ADD COLUMN IF NOT EXISTS ai4s_visible_after timestamptz;

UPDATE publications SET ai4s_visible_after = visible_after
  WHERE ai4s_selected AND ai4s_visible_after IS NULL AND visible_after IS NOT NULL;
