# AstroHot

[中文](README.md) | [English](README.en.md)

An astronomy-news and initial paper-screening tool: collect metadata, retain original links, use configurable models for screening, summaries and translation, and provide reading through an API and Web UI. Reading pages do not trigger model calls; AI screening is not full-text reading, peer review or scientific fact verification.

> **Private first-release collaboration snapshot, not publicly released.** Repository: <https://github.com/sw2sw/AstroHot>. Scoped independent installation, empty-database startup and key-path acceptance are complete; typecheck and some backend tests still fail. See [validation scope](docs/VALIDATION.en.md) and [known issues](KNOWN-ISSUES.en.md). No full-suite pass or production-deployment acceptance is claimed.

## Read these first

- [Licensing guide](docs/LICENSING.en.md), [LICENSE](LICENSE), [NOTICE](NOTICE): retain MIT, upstream attribution and third-party licences.
- [Copyright and usage](docs/COPYRIGHT.en.md), [disclaimer](docs/DISCLAIMER.en.md): software and operational content are separate; AI output is reference-only; independent deployers assess compliance.
- [Known issues](KNOWN-ISSUES.en.md), [collaboration TODO](docs/TODO.en.md): P0 gates, author-test limitations and follow-up tasks.
- [Contributing](CONTRIBUTING.en.md), [security reporting](SECURITY.en.md): narrow PRs and redacted reproductions; no public sensitive details.

## Safe startup

The reference project requires Node.js **>=24.11**, npm workspaces and PostgreSQL (PostgreSQL 17 in Compose). Installation, migrations, separately supervised processes and container commands are in [deployment](docs/DEPLOYMENT.en.md); they do not guarantee successful installation of this snapshot.

Create a local `.env` from `.env.example` and configure separate strong passwords and signing secrets. **Collection, model calls, arXiv analysis/reports, imagery tasks and push are disabled by default.** Do not use a production database, private configuration or real paid services to verify initial startup. Before enabling anything, check source permissions, providers, budgets and capacity separately. No runtime credentials are supplied.

The software distribution excludes the operational content collection and grants no copyright in third-party news, papers, images or other materials. It retains only software assets and explicitly labelled author-written synthetic demonstrations. Attribution, links, accessible RSS or AI rewriting do not establish permission. A disclaimer is not a guarantee of immunity from liability.

## Feature documentation

- [Sources](docs/SOURCES.en.md) · [Collection and analysis cadence](docs/CADENCE.en.md) · [Administration](docs/ADMIN.en.md)
- [Scoring](docs/SCORING.en.md) · [Content-rights review](docs/CONTENT-RIGHTS.en.md) · [Error recording](docs/ERROR-RECORDING.en.md)
- [Nobel Prize topic](docs/NOBEL.en.md) · [Synthetic demo data](database/demo/README.en.md)

Availability follows this snapshot's code and acceptance scope. Candidate implementation, author verification and independent acceptance are distinct states.

## Synthetic interface previews

These synthetic-demo screenshots are not real collected output; see [validation scope](docs/VALIDATION.en.md) for independently exercised behavior.

| Home (desktop) | Entry detail (desktop) |
| --- | --- |
| ![Synthetic desktop home preview](docs/images/home-desktop.png) | ![Synthetic entry-detail preview](docs/images/item-detail-desktop.png) |

| Home (mobile) | Nobel Prize topic (synthetic, not real award information) |
| --- | --- |
| ![Synthetic mobile home preview](docs/images/home-mobile.png) | ![Synthetic topic preview](docs/images/nobel-topic-desktop.png) |

## Upstream

Adapted from [AIHOT](https://github.com/KKKKhazix/AIHOT); retain `Copyright (c) 2026 数字生命卡兹克` and the original MIT LICENSE/NOTICE. The AIHOT name and logo are not granted under the code's MIT licence. AstroHot does not inherit upstream maintenance commitments.
