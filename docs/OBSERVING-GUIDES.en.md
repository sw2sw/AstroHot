# Observing guides: configuration and use

[中文](OBSERVING-GUIDES.md) | [English](OBSERVING-GUIDES.en.md)

Observing guides merge curated entries with two fixed weekly sky columns, newest source publication first. They reuse articles already public on your instance: the guide reader does not collect sources or call models, and an article need not be selected for the news feed. An empty first-run list is not necessarily a failure.

## 1. Defaults and scope

- An empty `OBSERVING_GUIDES_AUTO_START_AT` disables automatic inclusion; only configured curated entries are shown.
- The public GitHub edition has an empty curated list. It contains no operational articles or private article IDs. Private instances may have their own lists; do not copy another instance's IDs.
- Automatic inclusion matches the following source identities and columns using original titles, official URLs, and, for S&T, RSS category evidence. Full-width parenthetical source-management notes are stripped; S&T category comparisons are case-insensitive.

| Source, excluding management notes | Automatic column | Bundled source ID |
| --- | --- | --- |
| Astronomy Magazine · News | The Sky This Week | `rss-journal-astronomy-magazine` |
| Sky & Telescope · 天文新闻 | This Week's Sky at a Glance | `rss-journal-sky-telescope` |

The separate `rss-journal-astronomy-sky-this-week` source is not covered by this automatic rule. Enabling it alone does not replace Astronomy Magazine's News source above. Generic Observing entries and other outreach articles do not qualify solely because of translated title keywords.

## 2. Enable automatic inclusion

Set one **fixed UTC activation instant** in the environment actually loaded by the API process:

```dotenv
OBSERVING_GUIDES_AUTO_START_AT=2026-10-23T10:00:00Z
```

This is a format example; replace it with your own activation instant. Current validation requires UTC `Z` format, either `YYYY-MM-DDTHH:mm:ssZ` or with three fractional digits. Do not use local time, a `+08:00` offset, a date alone, or `now`. Do not regenerate the instant on every restart: that continually moves the inclusion boundary forward.

The boundary applies to the instance's article `discovered_at`, not its source publication date. Automatic entries must have been discovered at or after the boundary and must not be backfill entries. An earlier boundary can include existing qualifying records, but does not trigger historical source collection. Curated entries are not subject to this automatic activation boundary.

Then configure the instance in this order:

1. Keep collection, model calls, and push disabled during first-run checks, following the [deployment guide](DEPLOYMENT.en.md). Do not assume every distribution template or private deployment has identical defaults.
2. Review and enable the two sources above in source administration. Retain their source identities and column evidence, and assess [rights and permissions](CONTENT-RIGHTS.en.md) for the intended uses first.
3. Configure models, budgets, and capacity before authorizing ordinary news collection and processing. Normal collection generally needs `COLLECT_ENABLED=true`; model processing needs `MODEL_CALLS_ENABLED=true`. **Opening the collection valve affects every enabled source, not just these two columns.**
4. After environment changes, recreate the affected application containers or restart native processes that load that environment. The API must receive the activation instant; collection/analysis flags must also reach the worker. Editing `.env` alone, restarting only Web, or using `docker compose restart`, which does not refresh container environment, is insufficient. Drain in-flight paid requests through the upgrade procedure on an existing service.

The guide reader itself does not depend on `MODEL_CALLS_ENABLED`; that valve controls upstream news processing. Already public qualifying articles need no new model analysis to enter the guide list.

## 3. Reading, ordering, and curated entries

Use the observing-guides link in the home sky-calendar card, or visit `/observing-guides` directly.

- Curated and automatic entries are deduplicated by article identity and ordered together: newest source publication first, unknown publication dates last, with a stable identity tie-breaker.
- A page contains at most 30 entries. A next-page link appears when needed. Its cursor is a pagination-position marker; do not edit it manually or put it in configuration.
- Click a card to open the local detail page, then follow the original-source link. The source may require login or a subscription. Foreign weekly date ranges are not computed local observing windows; consider location, timezone, weather, and star charts.
- A low AI score, non-selection for the news feed, or an outreach category does not itself exclude an otherwise qualifying public weekly article.

To curate another guide, first verify that the article is publicly readable on **your own instance**. Add its public-detail ID to `OBSERVING_GUIDE_IDS` in `apps/web/app/features/observing-guides/guides.ts`, then rebuild and deploy Web. At most 20 curated IDs are accepted. This source-level list is not an environment or admin switch: editing `.env` does not change it. Keep instance-specific article IDs out of the general public distribution.

## 4. Avoid replacing the feature with an older build

Source updates, compiled artifacts, and running containers are separate stages. Updated source does not prove the live Web service is using it.

- Build from a pinned commit. The reference Dockerfile runs `npm run build -w @aihot/web`; do not overwrite its result with an older `apps/web/build` directory.
- Native deployments also need a Web build from the intended source and a restart of the process actually serving requests.
- Replacing the whole Web build affects every page. Verify automatic guide inclusion, newest-first ordering, and existing pagination features, not just the route named in the change.
- Keep the previous version and check the actual running image as described in [deployment](DEPLOYMENT.en.md). Do not clear the database, rerun seed, or repeat article analysis merely to update presentation.

## 5. Minimal verification and troubleshooting

1. Read `/api/site/observing-guides`: without `ids`, it returns automatic entries only.
2. Compare `/observing-guides`: the page also merges configured curated IDs, so its count may exceed that automatic-only response. For an exact comparison, pass the same curated IDs to the API, for example `?ids=YOUR_ARTICLE_ID`.
3. Check a qualifying weekly article discovered after activation: normal news processing must have produced a public publication, the source must participate in editorial mode, and release timing must permit display. Queued processing, uncertain receipts, or a completed queue job alone does not prove a public article exists.
4. Compare identities and publication ordering between the page and API, verify no duplicates, and open a detail page. Verify real next-page behavior once more than 30 entries exist.

| Symptom | Check first |
| --- | --- |
| Empty first deployment | Empty curated list, unset activation, disabled sources, or no public qualifying articles yet |
| Collected article missing | Processing/publication state, source identity, column evidence, discovery boundary, and backfill flag; do not immediately rerun the model |
| API has new guides but Web keeps the old list/order | Actual deployed Web build and image, not only the Git branch |
| Articles keep waiting | Model capacity, timeouts, and uncertain-request safeguards in [known issues](../KNOWN-ISSUES.en.md); do not release every uncertain request or expand retries unconditionally |
| An edited pagination URL fails | Remove `cursor` to return to page one. The API rejects invalid cursors with 400; the Web error path can still display 500, a separate known limitation |

This guide describes the current read layer and build configuration, not a completed installation acceptance for every new environment. Enabling sources and models can make external requests and incur costs. Reading the guide list itself does not start new guide collection or model analysis.
