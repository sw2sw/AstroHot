-- Automatic operational-error recording: one appended row per REAL failure observation, plus a
-- private offline copy of the failure response when no existing table already keeps one.
--
-- Evidence and retrieval only. Nothing here decides whether a run retries: the collection budget,
-- the receipt/attempt ledger, the analysis retry counter and the durable pause keep their own
-- meanings, and an event never rewrites a report, a raw batch or a receipt. Recording a failure must
-- also never turn a failed business operation into a successful one.
--
-- observation_key is the stable identity of one real observation (run / attempt / exception row id
-- + stage + target + code): capturing the same observation twice — a restart, a duplicate delivery,
-- a pg-boss retry — inserts nothing, while two genuinely different attempts are two rows.
-- group_key aggregates one kind of failure so a report counts what actually happened instead of how
-- often an operator looked. Rows are appended; the first version has no "resolved" state machine —
-- whether something is still affected is read from the source records that own it, never inferred
-- from a later success somewhere else.
CREATE TABLE ops_error_events (
  id                 bigserial PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The subsystem that observed the failure ("arxiv.collect", "arxiv.analyze", "job", …).
  stage              text NOT NULL,
  -- A stable, machine-readable failure code; the allow-list is the documented set in docs/ops-errors.md.
  code               text NOT NULL,
  -- warning: a business branch that is not a system fault (missing batch, rate-limit hold, manual
  -- pause, copyright rejection). error: something an operator has to look at.
  severity           text NOT NULL DEFAULT 'error' CHECK (severity IN ('error','warning')),
  -- Already redacted when it is written; see sanitizeOpsMessage.
  sanitized_message  text NOT NULL DEFAULT '',
  observation_key    text NOT NULL UNIQUE,
  group_key          text NOT NULL,
  job_run_id         bigint REFERENCES job_runs (id) ON DELETE SET NULL,
  -- The object the failure is about (an arXiv ID, a source id, the source host); NULL when unknown.
  target_id          text,
  -- ON DELETE SET NULL, not NO ACTION: an event is history and must survive a receipt or run that is
  -- later cleaned up, and the reference must never block that cleanup either.
  receipt_id         bigint REFERENCES receipts (id) ON DELETE SET NULL,
  receipt_attempt_id bigint REFERENCES receipt_attempts (id) ON DELETE SET NULL,
  -- Strict allow-list: only statistics and business links that were actually observed.
  details            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where the failure evidence lives: a file under the private evidence directory, or an existing
  -- row such as "arxiv_hydration_exceptions:123". The response body itself is never copied here,
  -- and the model's own answer is only ever referenced through its receipt.
  evidence_ref       text,
  evidence_sha256    text,
  evidence_truncated boolean NOT NULL DEFAULT false
);

CREATE INDEX ops_error_events_occurred_idx ON ops_error_events (occurred_at DESC);
CREATE INDEX ops_error_events_group_idx ON ops_error_events (group_key, occurred_at DESC);
CREATE INDEX ops_error_events_stage_idx ON ops_error_events (stage, occurred_at DESC);
