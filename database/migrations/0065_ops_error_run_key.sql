-- A durable execution association for recorded failures, independent of the job_runs row.
--
-- 0064 ties an event to job_runs(id) with ON DELETE SET NULL so an event survives a normal retention
-- cleanup. That is correct — history must not block housekeeping — but it also means a cleaned run
-- leaves NOTHING behind: the parent/domain hiding rule (which reads job_run_id) stops recognising the
-- two rows as the same execution, and a group's "how much was really stored" sum silently drops the
-- cleaned run's contribution as if it had never existed.
--
-- run_key is that execution identity in body text form: "run:<job_runs.id>" when the run row was
-- known, or an execution-scoped identity such as "exec:<uuid>" when the caller deliberately did not
-- create a run row. It is written with the event and is never rewritten by a FK cleanup, so the read
-- side can always tell WHICH execution observed a failure, and can honestly say "this run's stored
-- count is unknown" when its detail is no longer reachable.
ALTER TABLE ops_error_events ADD COLUMN run_key text;

-- Old rows carry no run_key; the read side derives the same identity from job_run_id so pre-0065
-- history is not silently reinterpreted as "no run".
CREATE INDEX ops_error_events_run_key_idx ON ops_error_events (run_key, occurred_at DESC);
