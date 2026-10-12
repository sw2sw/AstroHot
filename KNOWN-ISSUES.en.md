# Known Issues and Collaboration TODOs

[中文](KNOWN-ISSUES.md) | [English](KNOWN-ISSUES.en.md)

Preparation draft of the public issue list. Confirm status against the final commit at release time; do not attach real operational data or internal deployment evidence. Ordinary functional limitations may ship with the initial release; security, privacy, and licensing issues are not eligible for release with known defects.

## Current validation status

- Independent acceptance passed for locked installation, Web build, an empty database with 64 migrations/18 initialized sources, smoke and key browser paths on desktop/mobile.
- Web: **180 independently passed**, including 6 new date regressions. `apps/web/tests/new-content-hook.test.ts` remains excluded; this is not a full Web-suite pass.
- Source icons: **3 new safety regressions passed**. Collection-off prevents registration/execution of automatic icon fetching; disabled sources are not checked.
- Typecheck: **8 errors independently confirmed**.
- Full backend: the author's original result was **1035 passed, 35 failed, 4 cancelled, 2 skipped**. No full rerun or claim that those failures were fixed.
- Docker: author evidence is retained. The independent build was blocked by a Docker Hub connection reset; runtime acceptance used native Linux Node and an isolated database instead.

See [initial validation scope](docs/VALIDATION.en.md) for exact boundaries.
## Data Sources and Screening

### Individual Upstream Versions May Be Missing
The upstream may not return a particular requested paper version. Save normal items and preserve separate evidence for missing ones; do not turn a single partial omission into unlimited refetching of the entire batch.
**Future contributions**: improve redacted error classification and manual diagnostic guidance without adding unauthorized requests.

### New Revisions or Cross-Announcements of Older Submissions Do Not Enter Initial Screening
The original version may already be in the database, but the current submission-date/first `new` announcement threshold excludes it.
**Impact**: not all recent revisions are guaranteed to enter the candidate pool automatically.
**Future contributions**: define revision-screening rules or a bounded approved list; preserve the latest version, content hash, paid receipts, validation counts, and cooldown constraints. Fabricating source dates or `new` announcements is prohibited.

### Duplicate Announcements and Conflicting Evidence
Official revision/cross-announcements may reappear on different days; legitimate repetition must be distinguished from identity/first-announcement conflicts.
**Status**: a small patch candidate for repeated `cross` announcements has completed targeted verification; inclusion in the initial release depends on the final `main`, and the candidate must not be treated as released.
**Future contributions**: preserve initial source evidence and idempotent duplicate replay; do not indiscriminately relax identifier, version, or content checks.

## Operational Error Recording

### Limited Initial Coverage
This snapshot includes the minimal automatic error-recording implementation and migrations; independent coverage of every failure path remains pending. The initial goal is evidence retention for collection, initial screening, and task failures, plus read-only inspection—not exhaustive monitoring of the entire system.
**Future TODOs**: private status page, low-frequency notifications, scheduled read-only error checks, complex missed-slot/stuck-state diagnostics, and historical error imports. Error checks must not trigger model or application reruns.

### Granularity of Old Receipt History
The current final state of a receipt does not necessarily preserve every historical validation failure in full, especially when subsequent retries overwrite results.
**Future contributions**: associate new events with real attempts and validation observations, and explicitly identify historical gaps; do not guess or fabricate old call results.

### Unknown Model Requests Retain Safety Locks
When provider results/billing are uncertain, the corresponding safety locks may remain and require maintainers to act on evidence.
This is protective behavior; do not automatically release locks or issue duplicate paid requests to clear a backlog.

## Model Capacity and Processing Backlogs

### Fast Providers Still Require Operational Care
Higher concurrency and faster responses generally help drain backlogs, but throughput remains bounded by application-wide admission, per-provider/origin limits, request spacing and provider quotas. Fast providers can still time out or produce uncertain outcomes and retained safety locks. This description refers to the pinned source baseline; update it if the release candidate changes the implementation.

### What Low Concurrency or Slow Responses Can Cause
- A bounded local admission wait may end with `no model slot free within ...ms`. A global permit or provider allocation was unavailable; the request normally has not been dispatched upstream. This is not an editorial rejection and does not necessarily mean every physical slot is occupied.
- Providers may return HTTP 429 for concurrency or request-rate limits, or requests may time out. Model-provider 429s and content-source 429s, such as arXiv rate limits, are separate problems.
- Prefiltering, summaries, scoring or translation may queue up. Collected articles may remain unanalyzed and absent from selections; reports may lack content. APOD media and English text can be ready while Chinese translation is unavailable.
- If a dispatched request's outcome is uncertain, the application may retain a quarantined token to prevent duplicate calls with uncertain billing/results. Retention does not prove the provider is still computing. A few quarantined tokens can exhaust a small provider pool even when global slots remain free.

### Current Limits and Diagnostic Boundaries
The reference baseline uses a normal global soft cap of 4 and 6 physical permit rows. Individual endpoints have independent, potentially smaller caps. `AGNES_MAX_CONCURRENT`, `SILICONFLOW_MAX_CONCURRENT` and `MODEL_ORIGIN_MAX_CONCURRENT` control their respective paths, with baseline defaults of 1, 1 and 2. These are version-specific implementation values, not promises about provider plans. Request spacing/RPM also constrains throughput; changing concurrency alone is insufficient.

Quarantined tokens count against capacity and do not automatically expire after a fixed period. An admission error alone cannot distinguish global capacity, provider capacity, spacing or cooldown; inspect tokens, provider state and receipts together. A receipt becoming failed does not establish that its capacity token has been released or that the provider did not bill it.

The current APOD failure path may record only `translation_unavailable`, losing the original exception. The daily imagery job can report success when media is available despite failed translation. Initial error recording does not guarantee coverage of every admission failure or failed substep. The admin Runs page (`/admin/runs`) and Content Diagnostics (`/admin/content`) help inspect receipts, jobs and article states; check imagery translation status separately. Verify the actual final-release UI rather than promising an unimplemented capacity dashboard.

### Operating Guidance and Future Work
1. Use conservative concurrency and spacing based on actual provider limits. Instances and tasks share the same quota; each must not independently consume its maximum. Distinguish collection, admission, analysis and display before rerunning a backlog.
2. For uncertain/quarantined requests, reconcile the original provider outcome and billing first. With authorization, act on exact tokens and verify provider/global capacity consistency. Do not clear all locks, shorten retention or raise limits to hide the issue.
3. TODO: distinguish global saturation, provider saturation, cooldown and database failures; show the blocking layer and a safe next step. Preserve redacted APOD/substep exceptions linked to real receipts.
4. TODO: read-only backlog/capacity diagnosis, per-request reconciliation and auditable repair; test consistency between receipt recovery and quarantined-token cleanup. Never infer unbilled status from an unknown outcome.
5. TODO: bounded backoff, deduplication and fair scheduling. Fallback models require explicit configuration, budgets and recorded provenance, and may be used only when the original call was not dispatched or safely ended. Do not submit a duplicate to another service while the original outcome remains unknown, or silently change model/output quality.
6. Validate changes with synthetic slow responses, low concurrency, 429s, uncertain outcomes and multiple instances. These improvements are TODOs, not capabilities already implemented or fixed in the initial release.

## Reading and Media

### Formula Display
Some subscripts, fonts, and baselines require actual desktop/mobile testing.
**Future contributions**: change only the rendering layer, not the original scientific text, and do not rerun analysis; first submit a synthetic reproduction of the same formula.

### Observing the Natural Automatic Illustration Pipeline
Image extraction, identity, licensing/attribution, review, public retrieval, and proxy loading are separate steps. Manually adding an image to an individual article cannot prove that the fully automatic pipeline has undergone comprehensive acceptance testing.
**Future contributions**: verify natural processing records for new articles; honor fail-closed copyright behavior, and do not guess image extensions or bypass review.

### Tidying Page Explanations
Repetitive development-style explanations may be shortened, but retain necessary notices about AI candidates, sources, and date definitions.

## How to Contribute

Prioritize single-issue, narrowly scoped PRs and real, relevant verification output. Use synthetic fixtures; do not bundle real news, paper responses, model replies, or user screenshots. For changes involving paid retries, lock releases, screening scope, or source permissions, discuss product and safety boundaries first.
