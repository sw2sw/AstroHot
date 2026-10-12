import { sql,type Tx } from '../db.ts';
export const ARXIV_PROMPT_VERSION='arxiv-analysis-v2-evidence-index';
/** Same immutable raw version + metadata fingerprint across prompts. Changing model or protocol cannot reset the cap. */
export async function reconcileArxivRetryHistory(tx:Tx):Promise<void> {
  // Legacy attempts mix HTTP refusals with invalid answers; never infer validation counts.
  await tx`
    WITH history AS (
      SELECT p.arxiv_id,p.metadata_hash,
        bool_or(r.status='failed') AS failed,
        bool_or(r.status IN ('pending','unknown') OR EXISTS(
          SELECT 1 FROM receipt_attempts a WHERE a.receipt_id=r.id AND a.status IN ('pending','unknown'))) AS uncertain
      FROM arxiv_raw_papers p JOIN receipts r ON r.subject=p.arxiv_id AND r.purpose='arxiv-analysis'
        AND right(r.logical_key,length(':'||p.base_id||'@'||left(p.metadata_hash,12)))=':'||p.base_id||'@'||left(p.metadata_hash,12)
      WHERE p.analysis_status='pending'
        AND NOT EXISTS(SELECT 1 FROM arxiv_analysis_claims c WHERE c.arxiv_id=p.arxiv_id)
      GROUP BY p.arxiv_id,p.metadata_hash
    )
    INSERT INTO arxiv_analysis_retry(arxiv_id,metadata_hash,prompt_version,validation_failures,blocked_reason)
    SELECT arxiv_id,metadata_hash,${ARXIV_PROMPT_VERSION},0,
      CASE WHEN uncertain THEN 'receipt_uncertain' ELSE 'legacy_retry_review' END
    FROM history h WHERE uncertain OR (failed AND NOT EXISTS(
      SELECT 1 FROM arxiv_analysis_retry tracked WHERE tracked.arxiv_id=h.arxiv_id
        AND tracked.metadata_hash=h.metadata_hash))
    ON CONFLICT(arxiv_id,metadata_hash,prompt_version) DO UPDATE SET
      blocked_reason='receipt_uncertain',updated_at=clock_timestamp()
    WHERE excluded.blocked_reason='receipt_uncertain'`;
}
export async function noteArxivFailure(arxivId:string,hash:string,invalid:boolean,uncertain:boolean):Promise<void> {
  await sql`
    WITH prior AS (
      SELECT coalesce(sum(validation_failures),0)::integer AS failures,
        coalesce(bool_or(blocked_reason='receipt_uncertain'),false) AS uncertain
      FROM arxiv_analysis_retry WHERE arxiv_id=${arxivId} AND metadata_hash=${hash}
    )
    INSERT INTO arxiv_analysis_retry(arxiv_id,metadata_hash,prompt_version,validation_failures,next_attempt_at,blocked_reason)
    SELECT ${arxivId},${hash},${ARXIV_PROMPT_VERSION},${invalid?1:0},
      clock_timestamp()+CASE WHEN failures+${invalid?1:0}<=1 THEN interval '5 minutes' ELSE interval '20 minutes' END,
      CASE WHEN ${uncertain} OR prior.uncertain THEN 'receipt_uncertain'
        WHEN failures+${invalid?1:0}>=3 THEN 'validation_limit' ELSE NULL END FROM prior
    ON CONFLICT(arxiv_id,metadata_hash,prompt_version) DO UPDATE SET
      validation_failures=arxiv_analysis_retry.validation_failures+${invalid?1:0},
      next_attempt_at=excluded.next_attempt_at,
      blocked_reason=CASE WHEN arxiv_analysis_retry.blocked_reason='receipt_uncertain' THEN 'receipt_uncertain'
        ELSE coalesce(excluded.blocked_reason,arxiv_analysis_retry.blocked_reason) END,
      updated_at=clock_timestamp()`;
}
export async function arxivRetrySummary():Promise<{paused:number;uncertain:number;cooling:number}> {
  const row=(await sql`WITH state AS (
    SELECT p.arxiv_id,coalesce(sum(r.validation_failures),0)>=3 OR coalesce(bool_or(r.blocked_reason='validation_limit'),false) AS capped,
      coalesce(bool_or(r.blocked_reason='receipt_uncertain'),false) AS uncertain,
      coalesce(bool_or(r.next_attempt_at>clock_timestamp()),false) AS cooling,
      coalesce(bool_or(r.blocked_reason IS NOT NULL),false) AS blocked
    FROM arxiv_raw_papers p LEFT JOIN arxiv_analysis_retry r ON r.arxiv_id=p.arxiv_id AND r.metadata_hash=p.metadata_hash
    WHERE p.analysis_status='pending' AND p.version=(SELECT max(h.version) FROM arxiv_raw_papers h WHERE h.base_id=p.base_id)
    GROUP BY p.arxiv_id
  ) SELECT count(*) FILTER(WHERE capped)::integer AS paused,
    count(*) FILTER(WHERE uncertain)::integer AS uncertain,
    count(*) FILTER(WHERE cooling AND NOT blocked AND NOT capped)::integer AS cooling FROM state`)[0]!;
  return {paused:row.paused,uncertain:row.uncertain,cooling:row.cooling};
}
