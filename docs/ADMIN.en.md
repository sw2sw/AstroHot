# Administration Settings and Day-to-Day Management

[中文](ADMIN.md) | [English](ADMIN.en.md)

> Compiled from the administration interface and APIs in the reference source code. The final release must check page names, feature switches, and fields individually. This document does not claim that browser acceptance testing of the public edition has been completed; the new error-recording interface will still be updated according to actual acceptance results.

## 1. Login and Permissions

The administration entry point is `/admin`. Set `ADMIN_PASSWORD` and a separate `SESSION_SECRET` in the server-side `.env`, and obtain a session through the normal login flow; do not use the `DEV_AUTH_ROLE` development bypass in production. Enable optional Feishu identity login only if the final package actually includes it and the corresponding application and administrator list are configured.

After changing the password, administrator list, or session secret, restart all API processes to load the same configuration, then verify new logins and revocation of old sessions. Do not put secrets in the Web client or feedback screenshots.

## 2. What to Change in Administration and What to Change in Files

| Setting | Interface or configuration | How to apply/verify |
|---|---|---|
| Adding sources, enabling/disabling them, collection intervals, tiers, and participation modes | Administration: “Sources” | Reopen the source after saving to read it back; then check actual execution results |
| Paid request limits | “Settings → Paid Request Limits” | Set per-minute/hour/day limits for each service and read them back; in the reference implementation, 0 immediately disables that service |
| Model usage and supported model switching | “Models and Evaluation” | Check receipts and tokens for each step; the scope of switching is limited to what this page actually supports |
| Model provider URL, key, and default model | `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` in the server-side `.env` | Reload the relevant processes; confirm with bounded verification, which may incur charges |
| Content visibility, field corrections, reprocessing, and grouping | “Content” | Verify the record and public page after each operation; reprocessing may incur charges |
| Scheduled task results, failed queues, and receipt diagnostics | “Runs” | Check both task status and article status; queue completion does not replace publication completion |
| Contact QR code and switches for existing notification targets | “Settings” | Use your own assets and verify saving and actual display; notification-target credentials remain in server-side configuration |
| Site name, description, categories, topics, and scoring strategy | `industry/site.ts`, `taxonomy.ts`, `topics.json`, `selection.ts`, `prompts/` | Update according to the build/loading method and verify the pages and actual analysis path |
| Public site address, database, and safety gates | `.env` and container environment | Reload according to the [deployment instructions](DEPLOYMENT.en.md); merely editing the files is not enough |

Do not misrepresent the server-side file settings in this table as “all parameters can be edited in administration.” This document cannot be used to promise features that have not been released or accepted.

## 3. Adding or Adjusting Sources

1. Create a source in “Sources” and select an actually supported RSS, web-page list, JSON list, or external import type; third-party paid collection adapters are not free features by default.
2. Enter the source name, stable ID, entry point, and necessary selectors, and set its tier and participation mode. `editorial` participates in reading, `hot_signal` serves only as evidence of attention, and `isolated` does not appear on public pages; verify the specific available options against the release.
3. Set the collection interval and a finite initial item count, and leave the source disabled by default. See the [source directory](SOURCES.en.md) and [cadence](CADENCE.en.md).
4. Use the existing preview feature before saving/in the source details. Preview actually accesses the source: it is not a purely local action and cannot replace complete analysis and display acceptance testing.
5. Consider full text, images, or redistribution only after checking permissions; `site_fulltext` controls only public display of full text, not collection or AI input as a whole.
6. Run a bounded trial and check the original title/date/URL, deduplication, material scope, receipts, and public display. Enable scheduling only after confirming healthy operation.

`industry/sources.json` is an initialization seed, not the live source database: the reference seed only adds missing sources and does not overwrite existing records; deleting a source from the file does not delete it from the database either. Make operational adjustments in administration and read them back after saving.

## 4. Models, Scoring, and Budget

Configure the provider and budget before allowing `MODEL_CALLS_ENABLED`; connecting an OpenAI-compatible API does not guarantee that every provider is compatible with the actual requests/responses. Preserve original receipts and lock boundaries; do not simply release unknown requests for retry to meet a deadline.

Concurrency caps, request spacing and provider quotas together bound throughput, so configure conservatively against your actual service limits. Backlogs, `no model slot free within ...ms`, 429s and quarantined tokens are covered in [Model Capacity and Processing Backlogs](../KNOWN-ISSUES.en.md#model-capacity-and-processing-backlogs).

Check changes to scoring prompts and thresholds together; see the [scoring explanation](SCORING.en.md). Switching models or changing prompts should not automatically reanalyze all historical content; if calibration is needed, define the sample, number of runs, and budget before proceeding.

## 5. Troubleshooting and Manual Operations

First check individual source health in “Sources” and task results in “Runs,” then the article's processing chain in “Content,” and finally manual changes in “Audit.” Normal runs with no new items, a relevance BLOCK, or exclusion from curated selections are not system failures.

“Fetch Now,” requeuing failed articles, reanalysis, regrouping, receipt release, and notification redelivery all have side effects and must not be treated as viewing buttons. First confirm the failure cause, locks/receipts, and budget, then act on an explicit scope; unknown paid calls must not automatically be classified as failures.

## 6. Feedback and Private Materials

The existing “Feedback” section manages reader feedback; feedback screenshots, failed source responses, and original model responses are private evidence and must not be publicly exposed through static directories. When exporting an issue, provide only synthetic/redacted reproductions, preserve necessary state and version information, and do not paste real keys, personal information, or database connection strings.

Automatic error recording remains subject to the actual implementation/acceptance status in the [error-recording explanation](ERROR-RECORDING.en.md); do not portray it as an already available automatic repair system.
