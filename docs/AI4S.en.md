# AI4S column

[中文](AI4S.md) | [English](AI4S.en.md)

## Safe startup and configuration

AI4S is an AI-for-Science reading column isolated from the astronomy site. Apply the normal migration process when upgrading (`0071_ai4s_scope.sql`); see [deployment](DEPLOYMENT.en.md). Existing material retains the `astro` default, without recollection or automatic reanalysis.

Keep `COLLECT_ENABLED=false`, `MODEL_CALLS_ENABLED=false`, and push disabled at first startup. The new public `rss-ai4s-synthetic` source is **disabled by default**. It is an authored `example.invalid` configuration, not a working source. No private operational source list, onboarding date, or initial article identities are supplied. Independently assess collection, storage, model input, and public-display rights before replacing the feed address, categories, initial URL allowlist, and UTC date floor. `first_party` and T1 are example metadata, not proof of third-party authorization.

A source's `config.contentScope="ai4s"` routes new material to AI4S; omitting it or using `astro` retains astronomy routing. The example accepts only `Science`, does not treat summaries as full text, and disables images, site full text, and syndicated full text. `_aihot.initialUrlAllowlist` restricts initial-import identities; `initialNotBefore` persists an original-publication date floor for later new identities. Initial imports are backfill; later new identities without a valid date are held. These are not public-display switches. Seeding does not overwrite existing sources, so editing the file does not update an existing database source.

`ai4sAutoSelection` in `industry/selection.ts` remains **false**: scoring does not imply automatic selection; editors can select manually. Enabling a source and opening the global collection valve are separate actions. Opening that valve also admits other enabled sources. Model analysis requires separate provider and budget configuration; this local port did not run real models or collection services.

## Reading and evidence

Home, sidebar, and the phone's More page link to `/ai4s`. Nobel remains accessible from navigation and More; its original synthetic demo remains bundled without real award content. AI4S reads stored public projections; reader requests trigger neither collection nor model calls.

The column provides all items, selected items, discipline filters, and an AI4A astronomy-application subset. Selected items put astronomy applications first and then sort by time; other items sort by time. Pages contain 40 items, up to 50 pages. Cards open entry details, where original links live; returning restores the opened card's focus. Content changes produce an update prompt; failed updates can be retried and are not treated as successful refreshes.

Limited abstracts must disclose that full text was not read. Only sufficiently substantive material is scored; insufficient material remains pending. Scores do not verify scientific truth. AI4A requires consistency between a structured discipline, an astronomy referent, and verbatim evidence; this is not scientific verification either. Editors explicitly control cross-listing without creating a second material identity or reanalysis.

The API is `/api/site/ai4s`, with `tab=all|selected`, a discipline `domain` (`astro` means the AI4A subset), and `page` starting at 1. An empty page does not diagnose database or worker failure: distinguish an empty filter, unconfigured sources, uncollected material, and missing public projections. API success does not establish acceptance of real sources or paid models.

## Synthetic examples and validation limits

`industry/ai4s-gold.example.jsonl`, `tests/fixtures/ai4s/synthetic-science-rss.xml`, and short abstracts in related tests are authored synthetic data, not real institutional publications or feed excerpts. They retain the meaning of tests for insufficient abstracts, research versus marketing, disciplines, and astronomy evidence. `scripts/eval-selection.ts --scope ai4s` can call models and is not a zero-cost command. Read [scoring](SCORING.en.md) first; use a separate test database and local fake models, or obtain explicit budget authorization.

The local candidate completed an offline Web build, Web tests, and type checking. No services, database integration tests, browser acceptance, or GitHub Actions were run. Before release, independently validate migrations, collection boundaries, queues, cross-listing, and rollback on an isolated database. Existing [known issues](../KNOWN-ISSUES.en.md) still apply.

## Rollback

Do not simply drop added columns or revert only the read code: that loses column isolation or lets old code treat AI4S projections as ordinary astronomy content. First disable relevant sources and tasks; editors must withdraw AI4S publications and republish projections. Verify public outlets, report seats, and removal records before considering a code rollback. Retain additive columns and original material; republish to restore. This describes the safety boundary; no database rollback was performed here.
