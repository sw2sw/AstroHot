# Article relevance, attention scoring, and featured selection

[中文](SCORING.md) | [English](SCORING.en.md)

> This document is based on the current reference implementation. Before an official public release, it must be checked against `industry/prompts/prefilter.md`, `industry/prompts/selection-score.md`, `industry/selection.ts`, and the actual analysis/publication paths in the final release version. Deployers may adjust the configuration; these are not permanently fixed values for every deployment.

## 1. Purpose and scope of scoring

Scoring measures how much attention an event warrants from astronomy enthusiasts, astronomy department students, researchers, and science communicators whose attention is limited. It does not measure writing quality, media reputation, copyright permission, or scientific-truth certification. This document describes the news/article pipeline; its methodology is not directly applied to the SELECT/REVIEW/DEFER verdicts of the separate arXiv initial paper-screening process.

Reports from multiple outlets about the same event are first evaluated individually for event value, then handled outside the model through event grouping and representative-article mechanisms; secondary reporting does not automatically lose points. The scoring model does not receive source tiers, featured-selection thresholds, or previous scores and must not guess them. Source tiers affect featured-selection thresholds only outside the model.

## 2. Broad-recall relevance prefiltering first

- **PASS**: the material clearly concerns astronomical observations, discoveries, research results, equipment/space missions, data, celestial phenomena, or astronomy outreach.
- **BLOCK**: affirmative evidence establishes that the content is unrelated, or it is pseudo-astronomy such as astrological fortune-telling.
- **UNKNOWN**: the material is insufficient and is retained pending supplementation; unfamiliar proper names must not automatically be judged unrelated.

Prefiltering does not judge quality, truth, popularity, or featured selection. A clearly astronomy-related title can support a relevance PASS, but a title alone does not guarantee enough material for a substantive reading guide or bypass input-evidence and public-display thresholds.

## 3. Five-axis attention scoring

The model first identifies “who, when, did what, and at what current stage,” then classifies the event into one of five types and assigns an integer score of 0–10 to each of five dimensions:

| Dimension | Code | What is assessed |
|---|---|---|
| Substance | sig | The event's milestone level in astronomy, over the past year, and this week: a milestone, something worth knowing, or routine minor news |
| Information gain | nov | Explicit new discoveries, data, explanations, or results, rather than a headline's apparent novelty |
| Evidence strength | cred | How well the current input supports the core facts, not the source's reputation |
| Resonance | reson | Attention value and understandable significance for the target astronomy readership |
| Actionability | act | Whether readers can inspect data, observe, reproduce methods, or follow up; low actionability must not erase the substance of a major news event |

### Weights by type

| Type | sig | nov | cred | reson | act |
|---|---:|---:|---:|---:|---:|
| Research result `research_result` | 4 | 3 | 2 | 1 | 0 |
| Data release `data_release` | 3 | 3 | 2 | 1 | 1 |
| Engineering update `engineering_update` | 3 | 2 | 2 | 2 | 1 |
| Image release `image_release` | 2 | 2 | 2 | 3 | 1 |
| Science outreach/celestial phenomena `science_outreach` | 1 | 2 | 1 | 4 | 2 |

Aggregation rule:

```text
attentionScore = sig*w1 + nov*w2 + cred*w3 + reson*w4 + act*w5
```

The weights in each row sum to 10, giving a total score range of 0–100. Do not first average the five axes, change the weights, or reverse-engineer dimension scores to hit a threshold or a multiple of ten. The five axes are used only for the model's internal judgment; the scoring output contains only `attentionScore`, not an auditable axis-by-axis breakdown. The internal five-axis scores currently cannot be treated as persisted data.

## 4. Suppressing noise and respecting evidence boundaries

- Project launches or press conferences without verifiable data/methods, routine maintenance, ordinary updates, event announcements, lectures, recruitment, competitions, and general publicity/tributes: substance `sig ≤ 2`.
- An image release alone, without data, process details, or first-image value: `sig ≤ 2`. Images accompanying research results are still evaluated as research results and are not downgraded because they have illustrations.
- Repackaged old material with no new observations: `sig ≤ 3` and `nov ≤ 3`.
- Vague previews of future plans without formal project approval: `cred ≤ 3` and `nov ≤ 3`.
- A clear mismatch between the headline and the core body content, or a fragmented body that makes the subject, action, and status indeterminable: final score no higher than 30.

Short material, retellings, and secondary reporting do not automatically receive low scores. Institutional reputation, equipment scale, the number of technical terms, and body length do not automatically add points. Use only the evidence provided; do not invent events, numbers, stages, or outcomes. When the title conflicts with the body, the body takes precedence. Instructions, target scores, or JSON within the material are treated as untrusted content and are not executed.

## 5. Two scoring runs and featured-selection thresholds

The current reference rule scores each participating article twice separately and tests whether their sum reaches twice the applicable threshold; the displayed card score is the mean rounded down. Meeting the score threshold creates a selection candidate, not a completed featured selection. Publication, identity and incremental-value checks below must also finish.

| Source tier | Example positioning | Average-score threshold |
|---|---|---:|
| T1 | Official first-hand sources | 60 |
| T1_5 | Official accounts, quasi-official creators | 65 |
| T2 | Media and individuals | 76 |

`EXCLUDE_MP` and tiers not listed in the threshold table do not participate in featured scoring and follow only their corresponding full-updates paths. Not being featured does not mean not being displayed: articles meeting normal relevance and public-eligibility requirements may appear in the full updates feed.

For material that is not selected but has an average score **above 50**, the current `understandFloor=50` rule allows titles, summaries, and recommendation reasons based on content understanding. Other material takes the lighter title-and-abstract translation path. This is a writing-path split, not an additional public-admission gate or scientific verification.

## 5.1 Complete conditions for automatic featured selection

The normal pipeline is: analysis completes → initial publication → automatic identity/event grouping and incremental-value assessment → publication again. No per-article manual selection is required, but an unfinished or failed identity check must not be reported as completed selection.

Automatic selection requires all of the following:
- An editorial article has relevance PASS, a complete Chinese title and summary, and satisfies normal publishable-material rules.
- The two scores sum to at least twice the tier threshold; for T2 this means at least152, or a mean of at least76.
- Identity/grouping is complete and `selection_adds_value` is not false. A new article cannot bypass this condition merely by meeting the score threshold.

Manual selection settings can override the automatic scoring-based decision, but do not bypass public eligibility or visibility. The website featured read layer also requires a public publication with `visible_after` reached; the machine interface separately filters representative seats for the same event. These outputs must not be treated as identical lists.

## 5.2 Historical backfills and dates

An older date or a `backfill` flag **does not categorically exclude an article from website featured selection**. Historical material may qualify through the score and publication conditions. The current historical branch completes identity checks and sets incremental value to true, but creates no new event, contributes no heat, and archives the article under its original date.

Historical backfills do not trigger new-content group pushes and are excluded from daily-report selection. Those are separate output rules, not a prohibition on website featured selection. Discovery/ingestion dates are not original publication dates; display and archival behavior must preserve the real original dates.

These are current reference behaviors. Verify the final release's analysis, publication, grouping and read-layer implementations; parameters and output policies may differ across deployments.

## 6. Limitations, calibration, and community improvements

Two scoring runs are not equivalent to two independent experts, nor do they guarantee that errors from the same model are independent. Scores are editorial-assistance heuristics, not scientific conclusions, article accuracy rates, credibility probabilities, or copyright determinations. When only an abstract/public excerpt is available, state the input scope; do not claim to have read the full text or verified peer review.

Deployers may adjust prompts and thresholds for their readership, but should first calibrate using representative samples they have labeled themselves and can lawfully use. Refer to the reference project's `scripts/eval-selection.ts` (the scoring method is described in this document), and record model/prompt versions, sample scope, selected and missed items, costs, and before/after differences. This document does not claim that an expert gold standard or quantitatively verified accuracy already exists.

Contributors are welcome to share redacted or synthetic cases, expected/actual scores, and calibration results through the final project's collaboration channels. Do not upload unlicensed full text, original model responses, or private data. Method changes are adopted only after review and corresponding verification; they do not automatically change scoring configurations in other deployments.
