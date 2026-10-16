[中文](CADENCE.md) | [English](CADENCE.en.md)

# Collection, Initial Fetch, and Analysis Frequency

## Set by Users First, Not Copied from an Operational Site

The public edition requires collection, model calls, and push delivery to be disabled by default at release. Reference frequencies help explain costs; they do not mean these tasks are already enabled. Users should choose settings based on source update rates, terms, network conditions, model capacity, and budget.

## Recommended approach: low concurrency, steady queue processing

Prefer low concurrency, bounded initial collection, and reasonable intervals to process the queue steadily rather than issuing bursts. Temporary capacity shortages should use existing backoff and recovery paths without discarding ordinary pending items or repeatedly requeuing them manually. Deployers should choose intervals, concurrency, and budgets for their own server resources, model throughput, and provider limits rather than copying another site's settings.

Continuity does not mean bypassing safety limits: exhausted budgets, provider-required pauses, manual pauses, and unknown paid-call outcomes must still respect their boundaries. Continue through normal recovery when its conditions are met; do not promise that every pause automatically clears. Assess progress using article state, actual model receipts, and recovery jobs, not merely whether the worker is running.

## Do Not Confuse These Four Timing / Quantity Concepts

1. **Scheduler check cycle**: The worker periodically checks which sources or articles are due. This is an internal scheduling cadence, not a fetch of every source on each cycle.
2. **Source collection interval**: `interval_minutes` determines a source's base fetch interval. The actual execution time also depends on `next_fetch_at`, the cursor, health status, and adaptive backoff.
3. **Initial fetch / historical window**: An item-count limit is not a date window. `initialBackfillLimit:3` means an initial limit of three items, not the most recent three days. RSS contains only the items retained by the feed and does not guarantee complete coverage for arbitrary dates.
4. **Content analysis**: New, valid material enters preliminary screening / scoring / structuring / writing and other steps through the actual queue. Historical articles are not reanalyzed once every day. Page visits do not trigger model analysis.

## Reference Values in the Current Source Configuration

The following values come from the reference `industry/sources.json`. They are neither the live state of a private production database nor mandatory recommendations:

| Source category | Example base interval | Notes |
|---|---:|---|
| Web lists from the three Chinese observatories | 240 minutes | Reduce collection frequency according to actual update rates to avoid frequent requests |
| ESO, ESA-series, and NOIRLab RSS | 120 minutes | Record whether RSS has new items separately from the actual number analyzed |
| Candidate magazine / publication RSS | 1440 minutes | Disabled by default; verify in small batches before enabling |

Initial item-count settings can differ across these sources. Read `config._aihot.initialBackfillLimit` for each source; do not overwrite every source with one global number. Per-source failures and responses such as 429 should follow the existing bounded retry / backoff behavior. Do not fetch repeatedly merely to claim “daily updates.”

arXiv collection, analysis, and daily reports have independent configurations. The final public edition must document the actual variables, time zone, and task expressions. This document does not make the private site's specific cron times universal defaults. Existing content awaiting analysis is advanced through the worker's content-sweep recovery path. The internal sweep cadence is determined by the release source code; it must not be interpreted as paying for all model requests again.

## Model-call Counts and Costs

News material typically involves relevance screening, two scoring calls, structuring, and title / summary generation or an interpretive reading guide. It may also involve grouping, content extraction, image-related processing, and reporting steps. Do not treat a fixed “five calls” as the total cost ceiling per article. Costs differ for material blocked by preliminary screening, reuse of responses already received, different writing routes, and insufficient material.

Set per-minute / hourly / daily limits and account for provider capacity in service settings. Start with a small number of sources and a limited initial fetch, then inspect actual response receipts, tokens, and charges. A request whose response has been received but whose business processing is incomplete does not necessarily require paying again; an unknown receipt status must not be treated directly as a failed request and retried. Waiting for a model slot may cause a queue task to end while the article remains pending. Check both article status and subsequent recovery tasks.

## Order for Enabling and Adjusting

1. Keep safety gates closed; select sources and check terms and public-use permissions.
2. Set a limited initial fetch, intervals, and budget, and complete the preview.
3. Allow one bounded fetch and necessary model analysis, and observe the actual results.
4. Check deduplication, dates, analysis status, and public lists / detail pages; distinguish zero new items from failure.
5. Enable existing scheduled tasks only for healthy sources. Retain evidence for problematic sources separately rather than stopping the whole batch.
6. Before increasing frequency, compare recent new-item counts and budget consumption. Do not overwrite source cursors or reset history.

Manual “Fetch now” is an active network action, and reanalysis may incur additional charges; neither should be used as a read-only check. Changes to environment variables must be reloaded by the relevant processes; editing a file does not mean the changes have taken effect. Saving settings in the admin interface and file-based initialization seeds are also different mechanisms.

## arXiv daily first-attempt anchor

The source anchors the first attempt at **05:30 UTC (13:30 Beijing)**. Each minute only polls durable `next_due_at`; a not-due poll makes no source request. The budget remains three attempts per UTC day with strictly at least six elapsed hours between actual admissions. Empty/failed rounds can therefore retry at 19:30 Beijing and 01:30 the next local day; these are not fixed slots. Productive/partial day closure, operator pauses, HTTP429/Retry-After, leases and paid-receipt protections are unchanged.

An upgrade neither resets spent attempts nor advances an existing retry or later due instant. An admission at 09:00:19 Beijing still owns a floor of 15:00:19 that day; the new first-attempt anchor applies on subsequent days. Source changes are not proof of a production deployment; the operator decides when to run them.
