// When a notice's claim was stated — the one ordering key the projection and the public read share.
//
// Three times are close at hand and only one of them is evidence of when the claim was made:
//
//   · `n.updated_at` — when this projection last wrote the notice row. A replay, a retry or a re-judged
//     article refreshes it, so using it turns "discovered late" into "processed late" and lets an old
//     statement win by being handled again.
//   · `p.timeline_at` — the site's own ordering value, which is the discovery time for anything found
//     inside the 48-hour window. An old notice found a minute ago would outrank a newer one.
//   · the source's own publication time, and the moment a *revision* of the material was recorded: both
//     belong to the claim. The revision row is written once per (article, revision) and never refreshed,
//     so re-projecting the same revision cannot move it.
//
// So: a correction (revision > 1) is stated when that revision appeared — the source's own update time
// when it reports one for the revision the notice belongs to, otherwise the revision row's creation
// time. A first version is stated when the source published it, falling back to when we recorded the
// revision and then the article. Nothing here reads `n.updated_at` or `p.timeline_at`.
//
// The fragment expects the notice as `n`, its article as `a`, and `article_revisions` joined as `rev`
// on (rev.article_id = n.article_id, rev.revision = n.revision); `articleRevisionJoin` is that join.
import { sql } from "../db.ts";

/** The join `statedAt` needs. Add it after `JOIN articles a ON a.id = n.article_id`. */
export function articleRevisionJoin() {
  return sql`LEFT JOIN article_revisions rev ON rev.article_id = n.article_id AND rev.revision = n.revision`;
}

/** When the notice's claim was stated, in the sense explained above. */
export function statedAt() {
  return sql`coalesce(
    CASE WHEN n.revision > 1 AND n.revision = a.revision THEN coalesce(a.source_updated_at, rev.created_at)
         WHEN n.revision > 1 THEN rev.created_at
         ELSE a.published_at END,
    rev.created_at,
    a.created_at)`;
}
