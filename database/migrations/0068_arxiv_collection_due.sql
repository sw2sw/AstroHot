-- The durable due schedule of the arXiv collection channel.
--
-- The official feed is published once a day, and the retry that follows a day with nothing new has to
-- be measured on the instants the attempts were REALLY admitted. A fixed 01/07/13 UTC slot list
-- cannot express that: a first attempt admitted at 01:00:22 owns 07:00:22 as its earliest retry, so
-- the 07:00 tick is early, the whole slot is dropped, and the day then waits until 13:00 — six hours
-- of the day's budget thrown away, and an evening publication that a 15:00 retry would have caught is
-- missed entirely.
--
-- This table carries the one authoritative instant the channel may next be collected at. The worker
-- asks, once a minute, whether it has arrived; a tick that is not due only reads it, issues no source
-- request and leaves no run row. The attempt budget, the completed flag and the durable HTTP429 hold
-- are untouched and still live in arxiv_collection_day / arxiv_collection_state, so the two
-- mechanisms cannot disagree: the due instant decides WHEN a tick may try, the day row decides HOW
-- MANY tries the day has left, and the state row still decides whether the channel may touch the
-- network at all.
--
-- Purely additive, and deliberately without a backfill: a row that does not exist yet (or whose
-- next_due_at is NULL) is resolved from what the previous schedule already recorded — the day's
-- attempts, its last real admission and its completed flag — so an upgrade neither repeats the day's
-- successful batch nor drops an owed retry. The old columns (last_slot_at, and the whole day table)
-- are kept as they are: an older image rolling back still reads them, and no history is rewritten.
CREATE TABLE IF NOT EXISTS arxiv_collection_schedule (
  key text PRIMARY KEY,
  -- NULL means "not resolved yet": the first tick derives it from the day row and the UTC anchor.
  next_due_at timestamptz,
  -- The one-time identity of the attempt that currently owns the day's budget, and the due floor that
  -- was in force BEFORE it. A finish is fenced by `reservation`: a late finish from an execution whose
  -- successor has already begun (or a duplicate call) finds a different identity and settles nothing,
  -- so it can neither refund a shared attempt nor roll the due instant back to a stale floor. The
  -- floor is kept so the "nothing was really tried" path can restore the previous real admission's
  -- six hours instead of charging the day for a request that never happened.
  reservation text,
  reservation_floor timestamptz,
  -- The day row's own last real admission BEFORE the reservation overwrote it. The "nothing was really
  -- tried" path restores it, so a reservation that never made a request cannot leave a phantom admission
  -- instant behind for the next six-hour floor to be measured from.
  reservation_prior_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
