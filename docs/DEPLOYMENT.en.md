# Deployment, Upgrades, and Backups

[中文](DEPLOYMENT.md) | [English](DEPLOYMENT.en.md)

> Project deployment reference: these commands do not establish independent installation acceptance of this snapshot. Author evidence is retained; scoped native Linux startup, empty-database migration and key-path acceptance passed independently. Independent Docker validation was blocked by network access; see [validation scope](VALIDATION.en.md). No full-suite pass is claimed. See [known issues](../KNOWN-ISSUES.en.md) for test/type-check gaps and [TODO](TODO.en.md) for P0 gates. No one-click success guarantee is provided.

## 1. Prerequisites and Safe Defaults

The reference source code uses Node.js >=24.11, npm workspaces, and PostgreSQL; the container configuration uses PostgreSQL 17. The Docker approach requires Docker Engine and Compose; the native approach requires separately supervising the API, worker, and Web processes. Build resource requirements vary by version: check them in an isolated environment first rather than claiming fixed minimum machine specifications.

Obtain source from <https://github.com/sw2sw/AstroHot>, or choose a release package/tag if provided; record the full commit for reproducibility. Public repositories can be cloned anonymously, while private repositories or private forks require appropriate access. This document does not treat the upstream AIHOT repository address as the AstroHot release address. Read LICENSE, NOTICE, and the [content-rights explanation](CONTENT-RIGHTS.en.md).

Create `.env` from the final safe template; do not copy private deployment configuration. Generate a separate administrator password (the reference requirement is at least 12 characters) and session, image-signing, and database secrets, for example using `openssl rand -hex 32` to generate random values. Do not put generated values in the public repository or log attachments.

Initializers may choose different defaults; before the first startup, you must check:

```dotenv
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
ARXIV_NATIVE_COLLECT_ENABLED=false
ARXIV_ANALYSIS_ENABLED=false
ARXIV_DAILY_REPORT_ENABLED=false
IMAGERY_ENABLED=false
IMAGERY_DAILY_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false
```

Keep push and imagery scheduled tasks disabled as well; the exact variables are governed by the final release template. Having no key is not the only safety control; having a key does not mean calls have been approved. Set your own `ADMIN_PASSWORD`, `SESSION_SECRET`, `IMG_PROXY_SIGN_SECRET`, `POSTGRES_PASSWORD`, and necessary database connections; fill in your own `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` configuration only when preparing to enable the model.

## 2. Reference Docker Procedure

Check the Compose services, mounts, ports, and environment in the release package root directory; do not directly copy someone else's entire container configuration:

```sh
# Check the safe .env, persistent volumes, and public ports before starting
# This command awaits installation verification in the final public package
docker compose up -d --build
```

The reference Compose configuration has `db`, `setup`, `api`, `worker`, and `web`; `setup` exits after running migrations and seed initialization. Do not continue starting application services if migrations fail. Check logs and container status first; a 200 response from the homepage does not establish that the full application has passed.

```sh
docker compose ps
docker compose logs --tail 100 setup api worker web
```

The reference Web entry point is port 3000, with administration at `/admin`. Verify normal login, denial of unauthenticated administration access, availability of ordinary pages, disabled safety gates, and the presence of persistent volumes; do not trigger real collection/paid calls as a substitute for basic startup checks.

## 3. Domain, HTTPS, and Networking

`SITE_URL` must be the site root address that readers actually visit, and is used for RSS, share links, and the sitemap; it does not automatically follow the browser address used to access the site.

The reference configuration provides an optional HTTPS profile, and can also use an existing reverse proxy. On servers with existing applications, prioritize reusing network management rather than overwriting system DNS, routes, or existing proxies:

```dotenv
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000
# Enable only when a trusted reverse proxy has been configured correctly
TRUST_PROXY=true
```

Before using the reference Caddy profile, confirm that ports and certificate volumes do not conflict:

```sh
# This profile awaits verification in the final release package
docker compose --profile https up -d --build
```

Do not expose the database, private data directories, or unnecessary API administration ports publicly. `EGRESS_PROXY_URL` is used for some collection egress paths in the reference implementation; this does not guarantee that model requests use the same proxy, so check each request path. MCP additional allowed-host configuration only affects the corresponding Host checks and does not replace browser Origin checks, security authentication, or a firewall. Complete the filings and privacy disclosures required by law in the deployment region.

## 4. Reference Native-Process Procedure

First prepare a separate PostgreSQL database, a safe `.env`, and a writable private data directory, and check `DATABASE_URL` and `API_BASE_URL`.

```sh
npm ci
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web
```

After migrations and seeding succeed, start each process using separate service-management configurations; do not execute them sequentially in the same blocking terminal and assume all three have started:

```sh
# Process 1: API
node --env-file=.env apps/api/src/main.ts
# Process 2: worker
node --env-file=.env apps/worker/src/main.ts
# Process 3: run in the apps/web directory
NODE_ENV=production node --env-file=../../.env server.ts
```

Configure automatic startup after a restart, logging, environment loading, and graceful shutdown for the processes. The reference deployment documentation requires a worker shutdown grace period of at least 210 seconds to avoid killing paid calls midway; the final value is governed by the release implementation. Do not set a development authentication bypass in production.

## 5. Configuration and Enablement

After basic startup passes, select sources and configure budgets and models according to the [administration settings](ADMIN.en.md), validate with small batches, and only then enable scheduling. Do not confuse initialization seeds, administration database settings, and live environment variables. See [operating cadence](CADENCE.en.md) for article cadence and model recovery pacing.

Model throughput is bounded by concurrency caps, request spacing and provider quotas together, so configure conservatively against your actual service limits; multiple instances share one quota. Backlog behavior under low concurrency or slow responses, `no model slot free within ...ms`, 429s, quarantined tokens and diagnostic boundaries are described in [Model Capacity and Processing Backlogs](../KNOWN-ISSUES.en.md#model-capacity-and-processing-backlogs); that section documents limits and TODOs, not implemented fixes.

## 6. Backup and Recovery

Before upgrading, back up the database, necessary private files, deployment configuration, and old image/code versions. A database dump alone is not a complete backup; the reference implementation also has local uploads/feedback attachments. Decide whether to back up image caches according to their actual use.

The reference object-storage backup supports `DB_BACKUP_STORE_*` configuration; the actual schedule and optional features must be checked against the release, and automatic backups are not promised when storage is unconfigured. During recovery, restore the database and corresponding files from the same backup to an isolated target, check permissions, paths, and references, and only then switch over. Recovery drills require separate approval and must not overwrite the running production database.

`docker compose down -v` deletes volumes; it is not an ordinary stop or safe rollback command. Encrypt backups of secret configuration and restrict access; never release them with the source code.

## 7. Upgrades and Rollbacks

1. Pin the target version and change scope, and prepare verified backups and rollback steps.
2. Build the candidate, retaining the old images and valid Compose configuration; do not repeatedly reinstall unchanged dependencies.
3. If a migration requires stopping old services, first let the worker finish in-flight requests, then stop the API/worker/Web; do not restart the database arbitrarily.
4. Start new services only after migrations succeed; stop on conflicts or failures, and do not manually fabricate migration records.
5. Read back the running version, schema, login, pages, and application settings, and check updated date/number/status displays.
6. Rollback must account for both code and database compatibility; merely switching back to an old image does not automatically undo migrations. Disabling sources also does not guarantee that queued or in-flight model calls have stopped: check gates, queues, and receipts.

Do not resolve upgrade failures by increasing paid retries, relaxing validation, or bypassing locks. Public documentation does not provide private operational site addresses, keys, internal SSH details, or remote deployment scripts.
