# Initial validation scope

[中文](VALIDATION.md) | [English](VALIDATION.en.md)

Checked on 2026-10-12 against an independently extracted sanitized snapshot and its final scoped changes, not a production deployment. Coordinator execution, author-reported results and pending work are separate; this is not an all-tests-pass claim.

## Independently exercised

- Linux / Node.js 24.13.0: locked `npm ci` and client/server Web build passed.
- Web tests: **180 passed, 0 failed** (the original 174 plus 6 date-boundary regressions). `apps/web/tests/new-content-hook.test.ts` remains explicitly excluded, not counted as passing.
- Test-first date corrections cover invalid/missing empty states, date-only precision, matching month/day in different years, the Beijing year boundary and leap days. These are display changes, not migrations or operational data rewrites.
- Source-icon safety regressions: **3 passed**. Collection-off excludes the icon cron and returns before database access; enabled collection still excludes disabled sources. The third check used a dedicated empty test database and a synthetic source with no external URL.
- A fresh isolated PostgreSQL 17 database applied 64 migrations and initialized 18 sources. API, worker and Web started; standard smoke passed for pages, RSS, public APIs, media resources and MCP initialization.
- Real browser checks at 1440×900 / 390×844 confirmed distinct cross-year labels without horizontal overflow, article-detail navigation, the homepage topic entrance, demo dialog open/close and the synthetic imagery card.
- With external collection and models disabled, model receipts, fetch runs and occupied permits were all 0. No production data or real paid model was used.
- Sensitive patterns and upload exclusions were reviewed; the final staged Git file set must be checked again before upload. Full OFL 1.1 accompanies the fonts; MIT and upstream NOTICE are retained.

## Failed or not independently completed

- Independent `npm run typecheck` still reports **8 errors**, not a pass.
- The author's full backend run reported **1035 passed, 35 failed, 4 cancelled, 2 skipped**. The coordinator did not repeat the entire backend suite for this first snapshot; new safety regressions do not fix those failures.
- The coordinator's Docker build was blocked by a Docker Hub connection reset. Startup acceptance instead used installed Node and an isolated database. Author-reported Docker/Compose checks remain author evidence, not an independent rerun.
- The empty-database worker records daily/weekly/monthly composition failures when no selected items or daily entries exist. These are not external model calls or installation failures; do not claim that all scheduled tasks succeeded.
- The GitHub CI template is not a green guarantee: known type errors block later steps; its database parameters and excluded-test policy need collaborator review. An initial push does not complete CI acceptance.
- Fonts include their licence. Distributing built images/front-end bundles still requires applicable dependency copyrights, NOTICE and source-provision obligations for the actual artifacts. This source snapshot is not a legal conclusion about every binary dependency.

See [TODO](TODO.en.md) for priorities and [known issues](../KNOWN-ISSUES.en.md) for defects and capacity boundaries. Internal logs, credentials and operational evidence are not published in the software repository.
