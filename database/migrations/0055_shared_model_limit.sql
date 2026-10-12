-- Shared model limit: at most six paid model calls (chat, embeddings) may be in flight at once, across
-- every process of one deployment. Six fixed slots; a slot is occupied while token IS NOT NULL.
--
-- No expiry and no reaper: a permit whose upstream outcome is unknown stays occupied until an operator
-- releases that exact token, and only after the provider call is independently known to have finished
-- (docs/shared-model-limit.md). This is a candidate primitive, not a queue.
--
-- NOTE: 0055 is a placeholder number. Existing migrations are four-digit (0001..); this file must be
-- renumbered to the next free number when the candidate is integrated.
CREATE TABLE model_permits (
  slot        integer PRIMARY KEY CHECK (slot BETWEEN 1 AND 6),
  token       uuid,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'quarantined')),
  purpose     text,
  subject     text,
  acquired_at timestamptz
);

INSERT INTO model_permits (slot) VALUES (1), (2), (3), (4), (5), (6);
