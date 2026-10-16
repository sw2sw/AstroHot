# Small-batch continuous arXiv analysis (candidate, not deployed)

[中文](arxiv-continuous-analysis.md) | [English](arxiv-continuous-analysis.en.md)

- Registration requires both `ARXIV_ANALYSIS_ENABLED=true` and `MODEL_CALLS_ENABLED=true`. Check each minute, processing at most 20 papers sequentially per batch without increasing model concurrency.
- Use the new `cron.arxiv.analyze.continuous` queue with pg-boss `exclusive` policy (at most one created/retry/active job for the same empty singleton key) and `retryLimit=0`. Ticks during a busy batch are dropped rather than accumulated. The next minute checks again after failure; existing per-paper backoff remains authoritative.
- Do not reuse `cron.arxiv.analyze`: pg-boss 12.34.0 `singleton` restricts active jobs only, not queued ticks. `updateQueue` cannot change an existing queue's policy.
- Continuation waits for the next minute tick plus pickup latency (registered polling interval: 15 seconds). This is not immediate second-level draining or a fixed latency guarantee. Idle ticks retain pending/retry checks and run recording; no eligible papers means no model calls or source fetching. Idle minutes can still create `job_runs` rows and are not zero database overhead.
- Keep the collection six-hour interval, daily reports, news, APOD, observing guides, model selection, provider caps, six physical slots/four occupied soft cap, claims, unknown receipts, `validation_limit=3` and cooldowns unchanged. Do not unlock protected exceptions. Keep the existing 3600-second queue expiry; it does not establish cancellation of callbacks that continue beyond expiry.

## Later deployment gates (not performed here)

1. Deployment needs separate approval. Start from the latest reviewed main branch and deploy only reviewed changes. This change performs no deployment and does not modify observing-guide tasks.
2. Read runtime hashes, schedules, both analysis queues' nonterminal jobs, unfinished `receipt_attempts` and occupied permits. Existing cohort/unknown-receipt gates remain. Never clear locks, reset history or replay paid exceptions to facilitate deployment. Let a normal active batch finish naturally; do not interrupt it by restarting.
3. The new queue must be absent or already `exclusive`. The old queue must have zero created/retry/active jobs. Fully stop the old worker before starting the new one; never run both generations in parallel. Startup unscheduling removes the old cron, not its already queued jobs.
4. Switch only the reviewed worker `schedules.ts`, preserving all configuration and other runtime code. Do not change business data or collector hold/due state.
5. Independently read back removal of the old cron, minute cadence of the new cron, `exclusive`/`retryLimit=0` and a single nonterminal job. Observe natural analysis and committed receipts, with no duplicate calls or queue growth and no model calls while idle.
6. Rollback also requires natural draining of the new queue before stopping the new worker and restoring the prior worker source/image. Ensure the new cron is removed and the old cron restored. Never let both queue generations drive analysis.

## Isolated verification

A dedicated local PostgreSQL container/test database and loopback fake model were used with a non-loopback network guard and hard timeouts. The real `analyzePendingArxiv`, receipts, model permits and pg-boss 12.34.0 path processed 45 synthetic papers in batches of 20/20/5/0. The first fake response was held for 65 seconds across a minute boundary; all 80 extra sends were rejected and active/queued jobs stayed at one. The following real cron tick continued the next batch. Total fake model calls were 45, with none added by the idle batch. No production source, model or database writes were performed. This is focused acceptance, not full-repository or frontend regression.
