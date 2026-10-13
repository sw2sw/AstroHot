# Development TODO

[中文](TODO.md) | [English](TODO.en.md)

## P0: release gates

Recheck these privacy, licensing, and safety gates for each release. Documentation updates do not authorize repository-visibility changes or deployment. Each checked item needs a matching version and actual evidence; this is not an all-tests-pass claim.

- [x] Remove real credentials, private IPs/accounts/environments and operational records. Actual leaks require authorized revocation/rotation; fresh history is not remediation.
- [x] Review redistribution rights for software and bundled assets; retain MIT, NOTICE, font and applicable dependency licences. Exclude operational content and unauthorized third-party materials.
- [x] Verify safe defaults: collection, models, analysis/reports, imagery tasks and push disabled; separate strong passwords/signing secrets, no weak database fallback.
- [x] The main assistant independently accepts installation, migrations, safe startup and agreed key paths in this snapshot, with failures, exclusions and scope stated; do not claim an independent full-suite pass.
- [x] The initial sanitized source tree and subsequent incremental upload scopes have been reviewed; recheck each new release. Maintainers confirm repository visibility separately; this check does not make it public or deploy it automatically.
## Known verification gaps: not a pass list

The table distinguishes original author evidence from the coordinator's actual execution; see [validation scope](VALIDATION.en.md):

| Scope | Author result / boundary | Collaboration action |
| --- | --- | --- |
| Backend tests | 35 failed, 4 cancelled, 2 skipped | Preserve each category; cancellations/skips are not passes. Reproduce, classify, fix or explain impact |
| Type checking | 8 errors independently confirmed | Fix by location/error code; do not claim typecheck passed |
| Web tests | 180 independently passed, still excluding the `new-content-hook` test file | Only the included scope passed; test the excluded file, not a full Web pass |
| Independent acceptance of this snapshot | Scoped native Linux startup, empty-database migration, smoke and key browser paths passed; 3 icon-safety checks passed | Independent Docker build blocked by network; keep author and independent results separate |

Ordinary functional defects may be handled collaboratively with stated impact; not every TODO must be cleared for the first release. Credential, licensing, safe-default or data/paid-call safety defects remain P0. See [known issues](../KNOWN-ISSUES.en.md).

## Capacity-lock cleanup, APOD fairness and error visibility: pending

- **Capacity-lock cleanup**: reconcile receipt recovery, global permits and provider tokens per request with auditable cleanup. Do not automatically release locks or repeat paid calls while results/billing are unknown.
- **APOD fair scheduling**: prevent starvation from competing news/translation tasks; verify bounded backoff, deduplication and cross-task fairness. Ready media does not mean successful Chinese translation.
- **Error visibility**: distinguish local admission, endpoint capacity, cooldown, database failures and upstream 429s. Retain redacted APOD substep exceptions linked to real receipts, rather than only `translation_unavailable` or whole-job success.
- Verify with synthetic slow responses, low concurrency, 429s, uncertain outcomes and multiple instances. No fixed-status claim without evidence. See [capacity and backlogs](../KNOWN-ISSUES.en.md#model-capacity-and-processing-backlogs).

## Observing guides

This snapshot retains the guide entrance in the homepage sky-calendar card and a read-only guide page backed by a manually curated list of explicit article IDs. This release ships no guide article IDs (the list is empty and the page shows an empty state). Manual curation remains sufficient while article volume is low; automatic classification is not required. Check the release version for final availability.

Optional community contributions (not blockers for the initial release):
- Aggregate public guides by a dedicated tag, with pagination and sorting by original publication time.
- Assign tags to clearly identified recurring observing columns using source and column rules, avoiding broad keywords that misclassify news.
- Provide manual tagging, removal and correction controls; do not display withdrawn public articles.

No additional AI classification calls are planned for now. These features are not implemented commitments; contributors must first check existing tag read/write support and public API contracts.

## Other future directions

These are optional community contributions, not implemented features or substitutes for required release safety checks. See [known issues](../KNOWN-ISSUES.en.md) for current limitations.

- **Source expansion**: evaluate additional official RSS/Atom feeds or existing generic list adapters; distinguish not integrated, configured and verified states, and assess collection, AI input, full-text and image permissions separately.
- **Error-recording extensions**: a private status page, low-frequency alerts, scheduled read-only checks, historical error imports and diagnosis of complex stalls; checks must not rerun business tasks, invoke additional models or automatically release safety locks for uncertain requests.
- **Paper-version and announcement policies**: bounded handling of revisions to older submissions, cross-list announcements and missing versions; preserve official dates, version evidence, idempotency and paid-call limits, without inventing history.
- **Error and receipt history**: clearer links to real attempts and validation observations, with explicit gaps in historical record granularity.
- **Reading experience**: desktop/mobile formula rendering and less repetitive explanatory text; preserve scientific text and necessary source, date and AI notices.
- **Natural media-pipeline verification**: check extraction, identity, permissions, attribution, review and proxy loading for new articles; manually supplied images do not prove the automatic pipeline works.

Prefer narrow contributions with reproducible evidence. Outstanding privacy fixes, platform-permission checks and migration-compatibility acceptance are required gates, not optional TODOs that may be skipped.


## 🌙 Community extra: an observer’s health and field-survival guide

**May clouds interrupt your observing—not mosquitoes, stomach trouble or high beams.**

Night observing, long hours at a desk and fieldwork call for looking after the observer as well as the equipment. Fellow observers are welcome to share practical experience; healthcare, nutrition and outdoor-safety professionals are invited to contribute advice backed by reliable sources:

- **Looking after yourself**: sleep and recovery around irregular hours, caffeine and light exposure, portable meals and hydration, movement breaks, and physical preparation for handling equipment.
- **Field safety**: region-specific precautions for insects, ticks, snakes and wildlife; warmth, wind, rain and lightning protection; communications, working with a companion, weather monitoring and evacuation plans.
- **Defending the dark**: coordinate site lighting in advance, use red light appropriately, and reduce headlights and unexpected lighting; shields must not obstruct access routes or necessary safety lighting.
- **Knowing when to stop**: address driving fatigue, severe weather and illness first—observing can wait. Persistent insomnia, marked daytime sleepiness or recurring gastrointestinal symptoms warrant professional advice.

This is an optional community-documentation direction, not a first-release development commitment or a request for new AI features. Distinguish personal experience from professional advice. Health and emergency guidance should cite sources and identify regional and situational limits; it must not offer individualized diagnosis, treatment, hormone interventions or one-size-fits-all adventure prescriptions. On-site safety and local official guidance take priority over dark adaptation and observing performance.
