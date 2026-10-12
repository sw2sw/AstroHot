# Contributing

[中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

Collaboration target: <https://github.com/sw2sw/AstroHot>, currently a private first-release snapshot, not publicly released. Chinese and English contributions are welcome. Upstream AIHOT maintenance, CI or branch-protection policies are not guarantees about this project.

## Issues and PRs

1. Collaborate through this repository's issues/PRs; private-repository access is limited to authorized members. Discussions, template generation and automated checks depend on actual configuration, not assumed availability.
2. Read [known issues](KNOWN-ISSUES.en.md), [TODO](docs/TODO.en.md) and [deployment](docs/DEPLOYMENT.en.md). State the version, expected/actual outcome and a minimal synthetic or redacted reproduction. Discuss broad architecture or product changes first.
3. Keep one issue per branch/PR. For documentation, check links, bilingual consistency and configuration blocks. For code, use a separate test database and local fake services with collection, models and push disabled; never use production or real paid services.
4. Record actual commands, versions, failures/cancellations/skips and excluded files. Do not turn author verification into an independent full-suite pass. Existing gaps must not be hidden or used to waive new regressions.
5. Changes to lock release, paid retries, source permissions or migrations must explain safety boundaries and rollback impact. Do not hide problems through wider retries, relaxed identity checks or bypassed budgets.

Prioritize P0 privacy, licensing and safe defaults. Ordinary functional defects may be handled collaboratively with stated impact; not every TODO needs clearing. Industry configuration is described in the [industry guide](industry/README.md) (Chinese); source integration is in [sources](docs/SOURCES.en.md).

## Content and security

Do not submit `.env`, secrets, cookies, private IPs/accounts, operational databases, real news/paper responses, raw model replies or unauthorized assets. Redact logs, fixtures and screenshots or use author-written synthetic data. Report vulnerabilities privately through [security reporting](SECURITY.en.md), not public issues.

Applicable software licensing follows [LICENSE](LICENSE), [NOTICE](NOTICE) and [licensing](docs/LICENSING.en.md), with no new CC grant. Third-party content is not automatically authorized by a code contribution. Maintainers decide merges through actual review; no fixed response time is promised.
