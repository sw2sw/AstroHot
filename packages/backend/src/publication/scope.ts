// Public scope at read time. Every query that decides whether a report is public now,
// listed, selected, or evidence of its fact uses these predicates over `publications p` (and, for
// evidence, `fact_articles fa`); no other module spells visibility, the release time or the composite
// rule in SQL, and grouping takes the composite rule from here too. What a publication holds is
// derived once, at publish time, by publish.ts and rules.ts.
import { sql } from "../db.ts";

/**
 * Only confirmed news enters p.selected (publish.ts). The release timestamp also supports
 * historical imports and ensures every outlet uses the same actual publication time.
 */
export function releasedCondition(now: Date) {
  return sql`(NOT p.selected OR p.visible_after <= ${now})`;
}

/**
 * Astronomy surfaces list astronomy material, plus any AI4S row an editor explicitly cross-listed.
 * The AI4S column has its own predicates below; each column's predicates name their own column and
 * may admit the other column's row only through an explicit cross-list flag.
 */
export function astroScopeCondition() {
  return sql`(p.content_scope = 'astro' OR p.astro_cross_listed)`;
}

/**
 * Heat/signal evidence is astronomy material too. Signals can exist before a publication does, so the
 * scope is keyed on the article (always present, default astro); an AI4S article counts only once an
 * editor cross-listed it. `a` is articles, `p` the left-joined publication.
 */
export function astroSignalScopeCondition() {
  return sql`(a.content_scope = 'astro' OR coalesce(p.astro_cross_listed, false))`;
}

/** Listed on public surfaces at `now`: public, pool eligible, and released by then. */
export function listedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)} AND ${astroScopeCondition()}`;
}

/** Story reports include older editorial material outside the pool, but never withdrawn or not yet released content. */
export function storyReportCondition(now: Date) {
  return sql`p.visibility = 'public' AND s.participation_mode = 'editorial' AND ${releasedCondition(now)} AND ${astroScopeCondition()}`;
}

/** Selected set as the website shows it (home timeline, reading groups, topics): every selected report. */
export function selectedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.visible_after <= ${now} AND ${astroScopeCondition()}`;
}

/**
 * The selected set as machines receive it (v1, RSS, the sync ledger): one seat per fact, held by its
 * representative (publish.ts settleSeats).
 */
export function seatedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.seat AND p.visible_after <= ${now} AND ${astroScopeCondition()}`;
}

/**
 * The AI4S column's own listed set: its own rows plus any astronomy article whose own AI4S
 * dimension passed in its latest judgement (ai4s_cross_listed). Public, eligible and released.
 * A cross-listed row keeps its astronomy content_scope, so the astronomy read layer above never
 * loses it.
 */
export function ai4sListedCondition(now: Date) {
  return sql`(p.content_scope = 'ai4s' OR p.ai4s_cross_listed) AND p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)}`;
}

/**
 * The AI4S column's own selected set. Each column selects for itself: a native AI4S row uses
 * `selected`, a cross-listed astronomy row uses `ai4s_selected`, and neither reads the other's
 * state — an article can be selected in one column and only listed in the other. Each also keeps its
 * own release moment: a row only the AI4S column selected has no astronomy `visible_after` to borrow,
 * so its release is `ai4s_visible_after` (stamped at publish time beside its own selection).
 */
export function ai4sSelectedCondition(now: Date) {
  return sql`((p.content_scope = 'ai4s' AND p.selected AND p.visible_after <= ${now})
    OR (p.ai4s_cross_listed AND p.ai4s_selected AND p.ai4s_visible_after <= ${now}))
    AND p.visibility = 'public'`;
}

/** The report was published from a composite (multi-topic) analysis: it only mentions facts. */
export function compositeCondition() {
  return sql`EXISTS (SELECT 1 FROM analyses evidence_an WHERE evidence_an.id = p.analysis_id AND evidence_an.output->>'scope' = 'composite')`;
}

/**
 * The same rule over the latest analysis of report `article`, for grouping (recall, story roots,
 * consolidation) and for publish.ts when it picks a publication's fact. They decide from the newest
 * analysis, which `p.analysis_id` only points to once the publication is rebuilt from it, and recall
 * also meets reports without a publication. Missing scope is unknown, never composite.
 */
export function latestCompositeCondition(article: ReturnType<typeof sql>) {
  return sql`(SELECT x.output->>'scope' = 'composite' FROM analyses x WHERE x.article_id = ${article}
    ORDER BY x.input_revision DESC, x.id DESC LIMIT 1) IS TRUE`;
}

/** `fa` links report `p` to a fact as evidence: a primary or report membership, never a composite. */
export function evidenceCondition() {
  return sql`fa.role <> 'mention' AND NOT ${compositeCondition()}`;
}

/**
 * Report `p` is still evidence of its own fact (`publications.fact_id`, written at publish time): a
 * membership removed or turned into a mention since then no longer counts.
 */
export function ownFactEvidenceCondition() {
  return sql`EXISTS (SELECT 1 FROM fact_articles fa WHERE fa.fact_id = p.fact_id AND fa.article_id = p.article_id AND ${evidenceCondition()})`;
}
