import { collectArxivMetadata,parseArxivPageInfo } from './collect.ts';
import { ingestRawArxivCollection,persistRssArxivBatch } from './raw-store.ts';
import { ingestArxivAnnouncements } from './announcements.ts';
import { fetchArxivXml,findArxivHttpError,isArxivRateLimited } from './http.ts';
import { createArxivChannel,retryAfterSeconds } from './channel.ts';
import { recordOpsError,sanitizeOpsMessage,type OpsErrorSeverity } from '../operations/error-events.ts';
import {
  RSS_CHANNEL,RSS_FEED_URL,classifyHydrationPage,hydrationPagination,hydrationVersionMismatchError,
  ingestHydratedArxivBatch,readArxivRssCache,recordHydrationRejection,writeArxivRssCache,
} from './hydration.ts';
import { randomUUID } from 'node:crypto';

type Options = Parameters<typeof collectArxivMetadata>[0] & {
  pageSize?:number; maxPages?:number; sleep?:(ms:number)=>Promise<void>; now?:()=>Date;
  // 'refresh' re-reads the official feed even when today's successful fetch is cached. Only the
  // scheduled retry uses it, so the extra fetches are bounded by the daily attempt budget.
  rssCache?:'reuse'|'refresh';
  // How often the collection lease is renewed while one request is in flight. The default keeps a
  // request that legitimately runs for a minute from losing the channel to the next entry.
  leaseHeartbeatMs?:number;
  // The job_runs row this collection belongs to, handed down by recordRun, so every failure event
  // points at the run that observed it instead of at "the latest one".
  jobRunId?:number;
  // A channel lease the caller ALREADY holds. The scheduled entry claims the lease and spends the day's
  // attempt in ONE transaction, so a channel that is really busy is refused before an attempt is spent;
  // the collector then runs under that lease instead of claiming the channel a second time.
  claimedState?:import('./collection-state.ts').CollectionState;
  /**
   * Whether this run may ask the export API about the gaps the feed left. The ordinary path is
   * RSS-PRIMARY: the official announcement feed already carries the title, abstract, creators,
   * categories and versioned identity of every announcement, so normal papers are stored from the feed
   * alone and the round issues ZERO API requests. The supplement is explicit and default-off
   * (`ARXIV_API_SUPPLEMENT_ENABLED`), and it asks ONLY about announced versions that still have no raw
   * paper at all — never about a version the feed already stored.
   */
  apiSupplement?:boolean;
  /**
   * Whether this run may walk the LEGACY ordinary submission-date window (the export API's
   * `search_query` pagination with its resumable cursor and watermark).
   *
   * It is a SEPARATE switch from the supplement and default-off (`ARXIV_API_WINDOW_ENABLED`): turning
   * the supplement on must never bring the window back, because "fill the gaps the feed left" and "walk
   * every version submitted in a date range" are different amounts of traffic against a source that
   * rate-limits by client. While it is off the window's own state — its cursor, its fixed bounds and
   * its watermark — is left exactly as it was, so an explicitly enabled run resumes the same window it
   * would have resumed before, and nothing is rewritten in the meantime.
   */
  apiWindow?:boolean;
  /**
   * How many gap ids ONE supplement request may ask for, and how many supplement requests ONE round may
   * issue in total. Both are bounded and both have conservative defaults; see
   * `assertArxivCollectionOptions` for the ceilings a caller may not exceed. Together they are the
   * round's whole API budget: `supplementBatchIds * supplementMaxRequests` is the most a single round
   * can ever touch, so a switch cannot clear a large backlog in one burst.
   */
  supplementBatchIds?:number;
  supplementMaxRequests?:number;
};

/**
 * Stable code for a failed official feed. A rate limit and a missing batch stay business branches
 * (warning); a feed that could not be read is an error an operator has to look at. The classification
 * follows the documented allow-list in docs/ops-errors.md.
 */
function classifyFeedFailure(error:unknown):{code:string;severity:OpsErrorSeverity} {
  const text=String(error);
  if(/announcement evidence conflict|Conflicting announcement dates/i.test(text))
    return {code:'announcement_conflict',severity:'error'};
  if(/timed out|HTTP \d|exceeds maxBytes limit|response body is empty|Unsupported official arXiv endpoint|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket/i.test(text))
    return {code:'source_timeout',severity:'error'};
  return {code:'rss_parse_failed',severity:'error'};
}
// Verifiable hydration counters. hydrationFailed is the number of versions that could not be stored
// and are now waiting in arxiv_hydration_exceptions; it never counts a channel-level feed failure.
const noHydrationWork=()=>({hydrationCandidates:0,hydrationRequested:0,hydrationIngested:0,hydrationMissing:0,hydrationUnexpected:0,hydrationFailed:0});
// newContentCount counts articles this run really stored for the first time: new announcements of a
// newly stored feed, versions inserted by hydration, and raw papers inserted by the window pages. It
// is what the collection schedule reads to decide whether the UTC day still has anything to collect.
// windowIngested narrows that to the ordinary API window alone, and hydrationIngested to the hydration
// sub-batches alone, so the schedule can tell "the window really stored papers" from "the feed was
// read" instead of letting the announcement evidence stand in for real ingest.
// partial marks a round that handled its window and stored everything storable while ordinary
// missing/unexpected versions stayed recorded as exceptions: the caller can close the day on it
// instead of running the whole window again, and hydrationFailure names what stayed behind.
// cleanupFailure is set when a round that SUCCEEDED could not hand its lease back: the round keeps
// the outcome it earned and states the failed cleanup beside it, instead of the two being flattened
// into one or the cleanup quietly disappearing (see the finally at the end of the run).
//
// The RSS-primary counters keep the feed's own facts apart from the paper facts, because "the feed
// carried 326 announcements" and "326 new papers were stored" are different statements: rssItemCount
// is what the channel really listed, rssPaperCount the announcement evidence accepted, isolatedCount
// the items that could not become papers (with their own rows), duplicateCount the versions that were
// already stored, and insertedPaperCount the versions really stored for the first time. The API side
// is separate again: apiSupplementAttempted/apiSupplementFailed say whether the optional supplement
// ran and what it left behind, and a failed supplement never rewrites the RSS result.
const noWork=()=>({paperCount:0,rawBatchCount:0,rssPaperCount:0,windowTotal:0,rssCacheHit:false,newContentCount:0,
  insertedPaperCount:0,windowIngested:0,partial:false,hydrationFailure:undefined as string|undefined,cleanupFailure:undefined as string|undefined,
  rssItemCount:0,isolatedCount:0,duplicateCount:0,announcementCount:0,
  apiSupplementAttempted:false,apiSupplementFailed:undefined as string|undefined,
  apiSupplementBatchRejected:undefined as string|undefined,
  apiSupplementCommitted:undefined as {responses:number;ingested:number;inserted:number}|undefined,
  recordingGaps:undefined as string[]|undefined,...noHydrationWork()});
/**
 * The deterministic parameters of a collection run, validated WITHOUT touching the channel, the day
 * budget or the network.
 *
 * It is exported so the scheduled entry can refuse an invalid configuration BEFORE it reserves an
 * attempt. A page size that is not a positive safe integer is a configuration fault, not a collection
 * attempt: discovered inside the collector, the throw happened after the reservation had been committed
 * and before the collector's own try/finally, so a rejection that issued no source request still left
 * the channel owned, spent the day's attempt and cost a six-hour retry.
 */
/**
 * The bounded budget of the optional API supplement.
 *
 * One request may carry `ARXIV_SUPPLEMENT_DEFAULT_BATCH_IDS` ids and one round may issue
 * `ARXIV_SUPPLEMENT_DEFAULT_REQUESTS` of them, so a round's whole supplement traffic is at most 60 ids
 * — a small, deliberate amount against a source that rate-limits by client. The ceilings exist for the
 * same reason the defaults are small: a configuration cannot turn one switch into a backlog-clearing
 * burst. Anything the round did not reach stays a candidate in the database and is picked up by a
 * later round at the schedule's own cadence; nothing is probed, queued for retry or re-sent early.
 */
export const ARXIV_SUPPLEMENT_DEFAULT_BATCH_IDS = 20;
export const ARXIV_SUPPLEMENT_MAX_BATCH_IDS = 100;
export const ARXIV_SUPPLEMENT_DEFAULT_REQUESTS = 3;
export const ARXIV_SUPPLEMENT_MAX_REQUESTS = 10;

export function assertArxivCollectionOptions(options:{pageSize?:number;maxResults?:number;maxPages?:number;
  supplementBatchIds?:number;supplementMaxRequests?:number}):void {
  const pageSize=options.pageSize ?? options.maxResults ?? 100;
  const maxPages=options.maxPages ?? 10;
  for(const [name,value,max] of [['pageSize',pageSize,100],['maxPages',maxPages,100]] as const) {
    if(!Number.isSafeInteger(value)||value<1||value>max) throw new Error(`Invalid arXiv ${name}`);
  }
  const batchIds=options.supplementBatchIds ?? ARXIV_SUPPLEMENT_DEFAULT_BATCH_IDS;
  const requests=options.supplementMaxRequests ?? ARXIV_SUPPLEMENT_DEFAULT_REQUESTS;
  for(const [name,value,max] of [['supplementBatchIds',batchIds,ARXIV_SUPPLEMENT_MAX_BATCH_IDS],
    ['supplementMaxRequests',requests,ARXIV_SUPPLEMENT_MAX_REQUESTS]] as const) {
    if(!Number.isSafeInteger(value)||value<1||value>max) throw new Error(`Invalid arXiv ${name}`);
  }
}
export async function collectAndStoreArxiv(options:Options = {}) {
  if(process.env.COLLECT_ENABLED!=='true' || process.env.ARXIV_NATIVE_COLLECT_ENABLED!=='true') return undefined;
  assertArxivCollectionOptions(options);
  const pageSize=options.pageSize ?? options.maxResults ?? 100;
  const maxPages=options.maxPages ?? 10;
  // RSS-primary is the default. The export API is only touched when the caller (or the deployment
  // switch) explicitly asks for the supplement; nothing about the ordinary round depends on it.
  const apiSupplement=options.apiSupplement ?? process.env.ARXIV_API_SUPPLEMENT_ENABLED==='true';
  // The legacy ordinary submission-date window is a SEPARATE, default-off switch. Enabling the
  // supplement must not re-enable it (see the Options doc): the two are different amounts of traffic
  // and the round has to be able to add a bounded gap-fill without restoring the window scan.
  const apiWindow=options.apiWindow ?? process.env.ARXIV_API_WINDOW_ENABLED==='true';
  const supplementBatchIds=options.supplementBatchIds ?? ARXIV_SUPPLEMENT_DEFAULT_BATCH_IDS;
  const supplementMaxRequests=options.supplementMaxRequests ?? ARXIV_SUPPLEMENT_DEFAULT_REQUESTS;
  const now=options.now?.() ?? new Date();
  if(!Number.isFinite(now.getTime())) throw new Error('Invalid collection clock');
  const stateApi=await import('./collection-state.ts');
  // A lease claimed by the caller (the scheduled entry) is used as-is: claiming again would be a second,
  // non-atomic decision about a channel this run already owns. Otherwise the channel is claimed here,
  // exactly as the manual and recovery entries have always done.
  let state:import('./collection-state.ts').CollectionState;
  if(options.claimedState) {
    state=options.claimedState;
  } else {
    const claimed=await stateApi.claimCollection(now);
    if('status' in claimed) return {...claimed,...noWork()};
    state=claimed;
  }
  const result={status:'unchanged' as 'imported'|'unchanged',complete:false,...noWork()};
  // One channel for both official endpoints: RSS and every metadata request are serialized and kept
  // at least three seconds apart, which now covers the RSS -> first metadata request as well. The
  // durable throttle extends that same spacing across processes and across the recovery entry.
  //
  // The guard is the dispatch boundary's real question: the channel's own cancellation only fires once
  // a renewal has been SEEN to fail, so a takeover that happened while a request waited — and that the
  // 40 s heartbeat has not reached yet — would otherwise still dispatch. The guard renews the shared
  // lease in the database with nothing left between it and the network call, and fails closed when the
  // answer is that the channel is no longer ours, or when no answer comes at all.
  const channel=createArxivChannel({fetch:options.fetch,sleep:options.sleep,now:options.now,
    throttle:stateApi.collectionThrottle({sleep:options.sleep,now:options.now}),
    guard:signal=>{
      signal.throwIfAborted();
      return stateApi.confirmCollectionLease(state,{context:'before the request was dispatched'});
    }});
  // Whether the run has to leave the row alone on the way out: a 429 whose hold could not be confirmed
  // means releasing the lease would leave the row looking exactly like "no pause was ever needed".
  let holdUnconfirmed=false;
  /**
   * Turns a real HTTP429 into the shared durable hold. The owner-conditioned write goes first; if it
   * fails — the row could not be reached, or the lease CAS no longer matched — a conservative ownerless
   * floor is attempted, which never steals a successor's lease and only ever EXTENDS the pause. BOTH
   * writes carry the source's own Retry-After, so the fallback cannot report success while quietly
   * cutting a longer deadline back to six hours. Only when both fail is the hold unconfirmed, and the
   * caller then keeps the lease instead of releasing it. `undefined` means the hold is durable.
   */
  const establishRateLimitHold=async(retryAfter?:number):Promise<unknown|undefined>=>{
    try {
      await stateApi.deferRateLimitedCollection(state,retryAfter);
      return undefined;
    } catch(holdError) {
      try {
        if(await stateApi.holdCollectionConservatively(state,retryAfter)) return undefined;
      } catch(fallbackError) {
        holdUnconfirmed=true;
        return new AggregateError([holdError,fallbackError],
          'the durable 429 hold could not be written, and neither could a conservative ownerless floor');
      }
      holdUnconfirmed=true;
      return holdError;
    }
  };
  let rssFailure:unknown;
  // The raw feed behind a failed RSS step, kept so the failure stays reviewable offline. It is held
  // across the catch below because a document only becomes unreadable AFTER the parse failed.
  let rssDocument:string|undefined;
  // Observation scope of THIS execution: the run id when recordRun handed one down, otherwise a
  // fresh per-invocation identity. A real execution reuses its scope (capturing the same failure
  // again inserts nothing); the next execution — scheduled retry or manual rerun — gets a new one,
  // so two real attempts are two rows. There is deliberately NO UTC-day fallback: one row per day
  // would report two real 429s as one.
  const runKey=options.jobRunId===undefined ? `exec:${randomUUID()}` : `run:${options.jobRunId}`;
  // The official endpoint the CURRENT request talks to. Failure evidence names where the document
  // actually came from — a 429 can come from the export API just as well as from the RSS feed, so
  // the source is never hardcoded to one host.
  let lastEndpoint:{host:string;path:string}={host:'rss.arxiv.org',path:'/rss/astro-ph'};
  // Recording-chain failures of this run: an association query or the event insert could not
  // complete. They ride on the structured result (and, for a failed run, on the error that leaves
  // the run) so the read side can state the record is incomplete.
  const recordingGaps:string[]=[];
  /**
   * Records one failure of this run. Best effort by design: the result says whether the record is
   * complete, and a failure to record is never allowed to replace the failure it is about.
   */
  /**
   * Records one failure of this run. Best effort by design: the result says whether the record is
   * complete, and a failure to record is never allowed to replace the failure it is about. A record
   * that could not be written is added to the run's gap list, so "again later" can show the hole.
   */
  const recordCollectFailure=async(input:{code:string;severity:OpsErrorSeverity;message:string;
      observationKey:string;targetId?:string|null;details?:Record<string,unknown>;
      evidence?:{content:string,bytes?:Uint8Array|null,truncated?:boolean}|undefined;evidenceRef?:string|null})=>{
    const response=channel.lastResponse();
    const record=await recordOpsError({
      stage:'arxiv.collect',code:input.code,severity:input.severity,
      message:sanitizeOpsMessage(input.message),observationKey:input.observationKey,
      groupKey:`arxiv.collect:${input.code}:${input.targetId ?? '-'}`,
      // The durable execution identity travels with every event, so a later job_runs cleanup cannot
      // make two rows of this same run look like two different executions.
      jobRunId:options.jobRunId ?? null,runKey,targetId:input.targetId ?? null,details:input.details ?? {},
      // Only the feed document is copied offline; credentials, cookies and query parameters never
      // enter the metadata kept beside it. The source names the endpoint THIS request used (see
      // lastEndpoint), so an export-API 429 is never dressed up as an RSS failure.
      evidence:input.evidence===undefined ? null : {content:input.evidence.content,bytes:input.evidence.bytes ?? null,
        truncated:input.evidence.truncated===true,
        source:{host:lastEndpoint.host,path:lastEndpoint.path,httpStatus:response?.status ?? null,
          headers:null,durationMs:response?.durationMs ?? null}},
      evidenceRef:input.evidenceRef ?? null,
    });
    if(!record.recorded) {
      recordingGaps.push(`arxiv.collect:${input.code}:${input.observationKey}:event not recorded: ${sanitizeOpsMessage(String(record.error)).slice(0,160)}`);
    }
    return record;
  };
  /**
   * Turns one real HTTP429 into the shared durable hold and records it durably. Returns `undefined`
   * when the pause is durable, and the error that prevented it otherwise — the caller then stops and
   * fails closed rather than pretending it held.
   *
   * It is shared by the main path and by the supplement so the two cannot drift into different
   * semantics for the same upstream condition, and so a supplement 429 is recorded exactly like any
   * other: one warning, one row per run.
   */
  const reportRateLimit=async(error:unknown):Promise<unknown|undefined>=>{
    // A valid Retry-After can only LENGTHEN the hold; anything invalid, shorter or missing keeps the
    // six-hour floor. See deferRateLimitedCollection.
    const retryAfter=retryAfterSeconds(channel.lastResponse()?.headers['retry-after'],now);
    const holdError=await establishRateLimitHold(retryAfter);
    // A rate limit is a shared business condition, not a system fault, so it is a warning — and the
    // record is best-effort: a failure to write it must never hide the 429 itself. The origin's own
    // 429 body travels as evidence when the transport carried one.
    const rateLimitedError=findArxivHttpError(error,429);
    // A 429 whose failure document could not be read still reports HOW that read ended: the body is
    // marked incomplete whether or not a prefix survived (ROUND4 D8).
    const rateLimitedBody=rateLimitedError===undefined ? undefined
      : {content:rateLimitedError.bodyText,bytes:rateLimitedError.bodyBytes,truncated:rateLimitedError.bodyTruncated};
    await recordCollectFailure({
      code:'rate_limited',severity:'warning',
      message:`arXiv returned HTTP 429; shared durable hold ${holdError===undefined?'confirmed':'NOT confirmed'}`,
      observationKey:`arxiv.collect:rate_limit:${runKey}`,targetId:'arxiv.org',
      details:{retryAfterSeconds:retryAfter ?? null,holdConfirmed:holdError===undefined,
        httpStatus:429,failedBodyBytes:rateLimitedError?.bodyBytes.byteLength ?? 0,
        failedBodyTruncated:rateLimitedError?.bodyTruncated===true},
      evidence:rateLimitedBody,
    });
    return holdError;
  };
  // A hydration sub-batch that stored nothing leaves its exceptions committed and this round reports a
  // structured partial result at the end; it must not stop the remaining sub-batches or the ordinary
  // window pages.
  let hydrationFailure:string|undefined;
  // Held across the catch and the finally: what the run really reported must survive the cleanup below,
  // and a cleanup error must never be able to replace it (see the finally at the end of the run).
  let pendingError:unknown;
  const persist=async (page:Awaited<ReturnType<typeof collectArxivMetadata>>)=>{
    // The window page is written under the same lease check as everything else: a run that has been
    // taken over must not commit this batch either, not just its watermark.
    const saved=await ingestRawArxivCollection(page,stateApi.ownerGuardedDatabase(state));
    result.paperCount+=page.papers.length;result.rawBatchCount++;
    result.newContentCount+=saved.insertedPaperCount;
    result.insertedPaperCount+=saved.insertedPaperCount;
    result.windowIngested+=saved.insertedPaperCount;
    if(saved.status==='imported') result.status='imported';
  };
  try {
    // RSS covers old-submission first releases and updates whose submission-date window is old.
    // Failure is not confused with an empty channel; still try the independent API catch-up window.
    let rssFetchFailed=false;
    const cacheDay=now.toISOString().slice(0,10);
    const cached=await readArxivRssCache(RSS_CHANNEL,cacheDay);
    // A scheduled retry (rssCache 'refresh') re-reads the feed even when today's successful fetch is
    // cached, because the earlier attempt found nothing new and the feed may have been published
    // again since. It is bounded: at most as many refreshes as the daily attempt budget allows.
    if(cached && options.rssCache!=='refresh') {
      // Same channel and same UTC day: the feed was already ingested — its papers included — so this
      // run reuses it instead of asking arXiv again. Only a successfully ingested feed is ever cached,
      // so a failed or unparsable response can never be replayed as a success here. No item and no
      // paper is read by this round, which is why the item/paper counters stay at zero while the
      // announcement count is reported from the cache row.
      result.rssPaperCount=cached.itemCount;
      result.announcementCount=cached.itemCount;
      result.rssCacheHit=true;
    } else {
      try {
        const startedMs=Date.now();
        lastEndpoint={host:'rss.arxiv.org',path:'/rss/astro-ph'};
        // The lease is renewed before the request and kept alive while it runs: a slow RSS answer must
        // not let the next entry take the channel over before the window requests have had their turn.
        // The signal it hands back is the run's cancellation, so a lease lost mid-answer aborts the
        // request instead of letting it finish on a connection this process no longer owns.
        const rss=await stateApi.withLeaseHeartbeat(state,signal=>channel.run(signal,fetchImpl=>fetchArxivXml(RSS_FEED_URL,{fetch:fetchImpl,timeoutMs:options.timeoutMs,maxBytes:options.maxBytes})),{intervalMs:options.leaseHeartbeatMs});
        rssDocument=rss;
        const response=channel.lastResponse();
        // The feed's evidence batch, the announcement rows, the normal papers the feed itself carries
        // and the cache row that points at them commit in the SAME transaction under the same
        // ownership check. Written separately, a run that was taken over between them could finish by
        // stamping the cache with the feed it read before handing over, and every later run of that
        // day would replay the stale feed instead of asking arXiv again; and a paper that was stored
        // without its evidence batch would be unreadable offline.
        const evidence=await stateApi.ownerGuardedDatabase(state).begin(async tx=>{
          const ambient=stateApi.ambientTransaction(tx);
          const stored=await ingestArxivAnnouncements(rss,now.toISOString(),ambient);
          // The RSS papers are read out of the RAW document here, not taken from the caller: nothing
          // synthesized can reach the table, and `submitted_at`/`updated_at` stay null because the
          // feed states neither. An already stored version is left exactly as it is; a content
          // deficiency is isolated with its own raw text while the rest of the batch is stored.
          const papers=stored.status==='imported'
            ? await persistRssArxivBatch(tx,rss,stored.batchHash,now.toISOString())
            : undefined;
          // The cache keeps the ANNOUNCEMENT count it always kept (it documents "how many
          // announcements the cached feed carried"), so a later run of the same day reports the same
          // thing it always did; the feed-item and paper counters below describe what was really read
          // and really stored by THIS round.
          await writeArxivRssCache({channel:RSS_CHANNEL,cacheDay,contentHash:stored.batchHash,itemCount:stored.paperCount,
            fetchedAt:new Date(),httpStatus:response?.status ?? null,headers:response?.headers ?? {},durationMs:Date.now()-startedMs},ambient);
          return {...stored,papers};
        });
        const papers=evidence.papers;
        result.rssPaperCount=evidence.paperCount;
        result.announcementCount=evidence.paperCount;
        result.rssItemCount=papers?.itemCount ?? 0;
        result.isolatedCount=papers?.isolated.length ?? 0;
        result.duplicateCount=papers?.duplicateIds.length ?? 0;
        result.paperCount+=papers?.insertedIds.length ?? 0;
        result.insertedPaperCount+=papers?.insertedIds.length ?? 0;
        // A newly stored feed with entries is new content; a re-published identical feed is
        // 'unchanged' and contributes nothing, and an empty feed contributes nothing either.
        //
        // An RSS announcement and the paper it yields are ONE piece of new content, not two, so the
        // papers stored from the feed are not added again on top of their own evidence; only what the
        // optional supplement really stored is counted beside it. `insertedPaperCount` remains the
        // counter the schedule closes the day on, and it counts real inserts either way.
        if(evidence.status==='imported' && evidence.paperCount>0) result.newContentCount+=evidence.paperCount;
        if(evidence.status==='imported') result.status='imported';
        // An isolated item is a real, bounded anomaly of this round: the batch around it committed and
        // the item did not, and the reason and its raw text are on its own row. It is a warning, never
        // a reason to fail a round whose papers were stored.
        if(papers!==undefined && papers.isolated.length>0) {
          await recordCollectFailure({
            code:'rss_item_isolated',severity:'warning',
            message:`official RSS carried ${papers.isolated.length} item(s) that could not be stored as papers`,
            observationKey:`arxiv.collect:rss_isolation:${evidence.batchHash}`,
            targetId:papers.isolated[0]?.arxivId ?? 'rss.arxiv.org',
            details:{batchHash:evidence.batchHash,isolated:papers.isolated.length,
              reasons:[...new Set(papers.isolated.map(item=>item.reason))]},
          });
        }
      } catch(error) {
        // A rate limit is shared across endpoints: do not probe metadata after RSS429. The check looks
        // through any wrapper, so a 429 stays a 429 even when a cleanup failure travelled with it.
        if(isArxivRateLimited(error)) throw error;
        // A lease that was taken over is not a feed failure: the run no longer owns the channel, so
        // what it saw is discarded and reported as the takeover it was instead of being wrapped in an
        // announcement-feed error that would hide the real cause.
        if(error instanceof stateApi.ArxivControlPlaneError) throw error;
        rssFailure=error;rssFetchFailed=true;
        // Recorded here, where the failing response is still in reach, and NOT inside the business
        // transaction above: an RSS rollback must not take the evidence of what failed down with it.
        // The evidence is either the document that failed to parse, or — for a plain HTTP failure
        // (500s, and a 429 that is rethrown below) — the origin's own error body carried by the
        // transport, already cut to the request's byte budget.
        const classified=classifyFeedFailure(error);
        const httpError=findArxivHttpError(error);
        // The READ's completeness travels with the failure even when not one byte arrived: a first
        // read that was rejected, or a timeout with no prefix at all, is incomplete evidence — it is
        // never the same thing as a complete empty body. The status/endpoint metadata does not depend
        // on a copy being kept either.
        const failedBody=httpError===undefined ? undefined
          : {content:httpError.bodyText,bytes:httpError.bodyBytes,truncated:httpError.bodyTruncated};
        await recordCollectFailure({
          code:classified.code,severity:classified.severity,message:String(error),
          observationKey:`arxiv.collect:feed:${runKey}:${classified.code}`,
          targetId:'rss.arxiv.org',
          details:{cacheDay,rssCacheHit:false,
            httpStatus:httpError?.status ?? null,failedBodyBytes:httpError?.bodyBytes.byteLength ?? 0,
            failedBodyTruncated:httpError?.bodyTruncated===true},
          evidence:rssDocument!==undefined ? {content:rssDocument} : failedBody,
        });
      }
    }
  /**
   * The optional API supplement.
   *
   * It is NOT the ordinary path and never pretends to be: the round has already stored everything the
   * official announcement feed carried, and this only asks the export API for what the feed alone
   * cannot answer — the announced versions that still have no raw paper at all. It is default-off, so
   * a production round issues zero API requests, and it can never manufacture a second daily budget:
   * it runs under the SAME lease, the SAME durable throttle and the SAME shared 429 hold as the feed.
   *
   * It walks a BOUNDED amount of the backlog and only that: at most `supplementMaxRequests` requests
   * of at most `supplementBatchIds` ids each, so one switch can never clear a large backlog in a burst.
   * What it did not reach stays a candidate in the database and is picked up by a later round at the
   * schedule's own cadence — nothing is probed, queued for retry or re-sent early.
   *
   * It never walks the ordinary submission-date window: that is a different amount of traffic and it
   * has its own default-off switch (`apiWindow`). A supplement failure is the supplement's OWN, and it
   * is reported beside the main result rather than instead of it.
   */
  const runApiSupplement=async():Promise<void>=>{
    // Every persisted announcement still missing its raw version is retried across runs;
    // today's batch alone cannot recover IDs that already rolled out of the current feed.
    // The source uses its own calendar day (RSS pubDate carries -0400/-0500), which can
    // precede the first UTC observation day. Admit that day or one day earlier only;
    // this supports bounded outage recovery without changing the API's todayUTC bound.
    // Once admitted from their immutable first batch they stay eligible on later days
    // (durable day-N missing retries on day N+1), but future-dated rows and historical
    // newly observed feed rows never become backfill retries. Raw RSS evidence is not
    // touched; no submission-date filter, so new announcements with old submission dates
    // still hydrate.
    // An open hydration exception is skipped: refetchHydrationExceptions is the explicit entry
    // that retries it, so a known-absent version is never re-requested by ordinary collection and
    // this run still processes every other pending announcement.
    //
    // The read is bounded to what this round could actually send, so a large backlog never becomes a
    // large answer: the ids the round did not reach are simply not selected, and stay candidates.
    const {sql}=await import('../db.ts');
    // What the supplement has ALREADY committed travels on the result as it grows, so any later
    // failure of the same supplement (or of the feed beside it) can state exactly what was stored
    // before it — the committed work is evidence, never a hidden side effect.
    let supplementInserted=0;
    result.apiSupplementCommitted={responses:0,ingested:0,inserted:0};
    const candidates=await sql<{arxiv_id:string;base_id:string;version:number}[]>
      `SELECT a.arxiv_id,a.base_id,a.version FROM arxiv_announcements a
       JOIN arxiv_announcement_batches b ON b.content_hash=a.first_batch_hash
       WHERE a.announced_on BETWEEN (b.collected_at AT TIME ZONE 'UTC')::date - 1
                                AND (b.collected_at AT TIME ZONE 'UTC')::date
         AND a.announced_on<=${now.toISOString().slice(0,10)}::date
         AND NOT EXISTS(SELECT 1 FROM arxiv_raw_papers r WHERE r.arxiv_id=a.arxiv_id)
         AND NOT EXISTS(SELECT 1 FROM arxiv_hydration_exceptions e
                        WHERE e.arxiv_id=a.arxiv_id AND e.resolved_at IS NULL)
       ORDER BY a.first_batch_hash,a.arxiv_id LIMIT ${supplementBatchIds*supplementMaxRequests}`;
    const ids=[...new Set(candidates.map(p=>p.arxiv_id))];
    result.hydrationCandidates=ids.length;
    let batchIndex=0;
    for(let i=0;i<ids.length&&batchIndex<supplementMaxRequests;i+=supplementBatchIds) {
      const requested=ids.slice(i,i+supplementBatchIds);
      if(!requested.length) break;
      const startedMs=Date.now();
      lastEndpoint={host:'export.arxiv.org',path:'/api/query'};
      const page=await stateApi.withLeaseHeartbeat(state,signal=>channel.run(signal,fetchImpl=>collectArxivMetadata({idList:requested,fetch:fetchImpl,maxResults:supplementBatchIds,
        timeoutMs:options.timeoutMs,maxBytes:options.maxBytes})),{intervalMs:options.leaseHeartbeatMs});
      const durationMs=Date.now()-startedMs;
      const classified=classifyHydrationPage(page.papers,requested);
      const response=channel.lastResponse();
      if(classified.versionMismatch.length) {
        // The correctness red line is not relaxed: a same-base different-version answer rejects the
        // batch immediately and stores nothing. The rejection itself is kept as offline evidence.
        const error=hydrationVersionMismatchError(classified.versionMismatch);
        const rejectionId=await recordHydrationRejection({kind:'version_mismatch',requestedIds:requested,detail:error.message,
          findings:classified.versionMismatch,httpStatus:response?.status ?? null,headers:response?.headers ?? {},
          durationMs,rawAtom:page.raw_atom});
        // The rejection row already keeps the response; the event only references it. The target is
        // the version that ACTUALLY conflicted, not the first requested id.
        const conflictedId=classified.versionMismatch[0]?.arxivId ?? requested[0] ?? null;
        await recordCollectFailure({
          code:'batch_rejected',severity:'error',message:error.message,
          observationKey:`arxiv.hydration_rejection:${rejectionId}`,
          targetId:conflictedId,
          details:{kind:'version_mismatch',requested:requested.length,findings:classified.versionMismatch.length,
            affected:classified.versionMismatch.map(finding=>finding.arxivId)},
          evidenceRef:`arxiv_hydration_rejections:${rejectionId}`,
        });
        throw error;
      }
      // Accepted versions and the exception rows for this batch commit together: a stored paper can
      // never exist without its batch evidence, and a recorded exception can never outlive a
      // rollback that left the batch unwritten.
      let saved:Awaited<ReturnType<typeof ingestHydratedArxivBatch>>;
      try {
        saved=await ingestHydratedArxivBatch({
          page,requestedIds:requested,
          acceptedIds:classified.accepted.map(paper=>paper.arxiv_id),
          exceptions:[...classified.missing,...classified.unexpected],
          meta:{httpStatus:response?.status ?? null,headers:response?.headers ?? {},
            pagination:hydrationPagination(page.raw_atom,requested.length,page.papers.length,batchIndex,supplementBatchIds),durationMs},
        },stateApi.ownerGuardedDatabase(state));
      } catch(error) {
        // A same-version content conflict is the other correctness red line; it rolls the batch back
        // and keeps its evidence offline instead of only as an error string.
        if(/raw feed conflict/.test(String(error))) {
          const rejectionId=await recordHydrationRejection({kind:'content_conflict',requestedIds:requested,detail:String(error).slice(0,4000),
            findings:[],httpStatus:response?.status ?? null,headers:response?.headers ?? {},durationMs,rawAtom:page.raw_atom});
          // The conflict message names the arxiv_id that ACTUALLY collided (raw-store throws it);
          // when it can be parsed the target is that id, otherwise NULL — "the first requested id"
          // may well be one that succeeded, and a guessed target is a wrong target.
          const conflictId=/raw feed conflict: arxiv_id (\S+) is already stored/.exec(String(error))?.[1] ?? null;
          await recordCollectFailure({
            code:'batch_rejected',severity:'error',message:String(error),
            observationKey:`arxiv.hydration_rejection:${rejectionId}`,
            targetId:conflictId,
            details:{kind:'content_conflict',requested:requested.length,targetDetermined:conflictId!==null},
            evidenceRef:`arxiv_hydration_rejections:${rejectionId}`,
          });
        }
        throw error;
      }
      batchIndex+=1;
      result.paperCount+=classified.accepted.length;
      result.rawBatchCount+=1;
      result.hydrationRequested+=requested.length;
      result.hydrationIngested+=classified.accepted.length;
      result.hydrationMissing+=classified.missing.length;
      result.hydrationUnexpected+=classified.unexpected.length;
      result.newContentCount+=saved.insertedPaperCount;
      result.insertedPaperCount+=saved.insertedPaperCount;
      // The snapshot is taken AFTER the batch's own counters, so it never lags a batch behind.
      supplementInserted+=saved.insertedPaperCount;
      result.apiSupplementCommitted={responses:batchIndex,ingested:result.hydrationIngested,inserted:supplementInserted};
      if(saved.status==='imported') result.status='imported';
      if(classified.missing.length||classified.unexpected.length) {
        // The exception rows were committed by ingestHydratedArxivBatch in the batch's own
        // transaction; the event references them instead of copying anything, and a missing version
        // is a business branch the recovery entry owns — hence a warning, not a system fault.
        // The affected targets are the REAL failed versions, never "the first requested id", which
        // may well be the one that succeeded.
        const affected=[...classified.missing,...classified.unexpected].map(paper=>paper.arxivId);
        // Reading the open exception ids is recording support, not business logic: if this query
        // fails the event is still written — with the gap made visible — and the batch continues.
        let exceptionIds:number[]=[];
        try {
          exceptionIds=affected.length===0 ? [] : (await sql<{id:number}[]>`SELECT id FROM arxiv_hydration_exceptions
            WHERE arxiv_id=ANY(${affected}) AND resolved_at IS NULL ORDER BY id`).map(row=>row.id);
        } catch(gapError) {
          recordingGaps.push(`arxiv.collect:hydration_missing:${runKey}:association failed: ${sanitizeOpsMessage(String(gapError)).slice(0,160)}`);
        }
        await recordCollectFailure({
          code:'hydration_missing',severity:'warning',
          message:`arXiv hydration left ${classified.missing.length} missing and ${classified.unexpected.length} unexpected versions`,
          observationKey:exceptionIds.length>0
            ? `arxiv.hydration_exception:${exceptionIds.join('+')}`
            : `arxiv.collect:hydration:${runKey}:${batchIndex}`,
          targetId:affected[0] ?? null,
          // The stored id list is bounded; when MORE exceptions existed than were stored, the
          // incompleteness is STATED beside the list instead of the list pretending to be all.
          details:{requested:requested.length,missing:classified.missing.length,
            unexpected:classified.unexpected.length,affected,exceptionIds:exceptionIds.slice(0,100),
            exceptionIdsIncomplete:exceptionIds.length>100},
          evidenceRef:exceptionIds.length>0 ? `arxiv_hydration_exceptions:${exceptionIds[0]}` : null,
        });
      }
      if(classified.accepted.length===0) {
        // Nothing in this batch could be stored. The exceptions are already committed, so the next
        // run skips exactly these versions and the explicit recovery entry is what retries them; the
        // round records it and keeps going with the batches its own budget allows, so a single empty
        // answer never stops the supplement or re-requests the same ids in a burst.
        hydrationFailure??=`arXiv RSS hydration returned missing or unexpected versions (requested ${requested.length}, returned ${page.papers.length})`;
      }
    }
    result.hydrationFailed=result.hydrationMissing+result.hydrationUnexpected;
  };
    // The optional supplement is an AUXILIARY step: it runs beside the round, and its own outcome is
    // never allowed to stand in front of a main-source failure. It still runs BESIDE a failed feed,
    // because recovering yesterday's gap is exactly what it is for — but the failure check below is
    // what the round reports, so an auxiliary exit can never turn a dead feed into a clean result.
    // A dead feed is THE failure of the round — never rewritten into a productive partial. But when
    // the auxiliary supplement ran beside it, what the supplement already committed is part of the
    // failure's evidence, not a hidden side effect: the thrown error names the committed responses,
    // ingested versions and inserts (and carries them as a structured field), so the recorded failure
    // shows both facts — the main source is down AND this much auxiliary work really was stored.
    // The committed counts are supplement-only by construction: a failed feed commits nothing of its
    // own (its evidence and papers roll back together), so nothing here double-counts the feed.
    const feedFailureWithCommittedSupplement=():Error=>{
      const committed=result.apiSupplementCommitted;
      const error=new Error(`arXiv announcement feed failed: ${String(rssFailure).slice(0,800)}`
        + (apiSupplement && committed ? ` (the auxiliary supplement committed beside this failure: ${committed.responses} response(s), ${committed.ingested} ingested, ${committed.inserted} inserted)` : '')
      ) as Error & {supplementCommittedBesideTheFailure?:{responses:number;ingested:number;inserted:number}};
      if(apiSupplement) error.supplementCommittedBesideTheFailure=committed;
      return error;
    };
    if(apiSupplement) {
      result.apiSupplementAttempted=true;
      let supplementFailed=false;
      try { await runApiSupplement(); }
      catch(supplementError) {
        // A lost channel is a control-plane fact, not a supplement fault: this run no longer owns
        // anything it could dispatch, so nothing may be concluded about arXiv from what it saw.
        if(supplementError instanceof stateApi.ArxivControlPlaneError) throw supplementError;
        if(isArxivRateLimited(supplementError)) {
          // A 429 is shared across every endpoint, so the durable hold is established FIRST — that is
          // what stops the source — and only then is the outcome decided. The feed's papers are
          // already committed, and a rate limit may never erase a productive result: the round keeps
          // its real counters and closes as the productive partial it was.
          const holdError=await reportRateLimit(supplementError);
          if(holdError!==undefined) {
            // Fail closed, exactly like the main path: the pause could not be persisted, so the run
            // stops, keeps its lease (holdUnconfirmed) and dispatches nothing further rather than
            // reporting a clean finish on a hold nobody could vouch for.
            throw new AggregateError([supplementError,holdError],
              `arXiv HTTP 429 during the API supplement: durable cooldown commit failed — ${stateApi.ARXIV_HOLD_UNCONFIRMED_NOTICE}`);
          }
          result.partial=true;
          supplementFailed=true;
        } else {
          // Two DIFFERENT kinds of supplement failure leave here, and they are not the same event.
          //
          // A batch REJECTION is a correctness red line, not a transport fault: the version red line
          // ("whole batch rejected") and the same-version content red line ("raw feed conflict") have
          // already refused the supplement's batch atomically and recorded their own `batch_rejected`
          // error event with the response kept offline. Flattening that into the ordinary auxiliary
          // warning would read like a 503 — a retryable hiccup — when in fact the batch was JUDGED and
          // refused. The classification stays distinct, and the settlement states explicitly what it
          // keeps: the ordinary RSS papers and counters of this round are never rolled back by a
          // supplement batch rejection, and the rejected batch stores nothing of its own.
          const supplementMessage=String(supplementError);
          result.partial=true;
          supplementFailed=true;
          // The committed counts travel as SCALAR detail fields: the ops event deliberately records
          // objects as "[omitted]" (a small allow-list beats a permissive serializer), so a nested
          // counter object would arrive unreadable. Scalars are queryable and honest.
          const committedBeside=result.apiSupplementCommitted ?? {responses:0,ingested:0,inserted:0};
          const committedFields={supplementResponses:committedBeside.responses,
            supplementIngested:committedBeside.ingested,supplementInserted:committedBeside.inserted};
          if(/whole batch rejected|raw feed conflict/.test(supplementMessage)) {
            result.apiSupplementBatchRejected=supplementMessage.slice(0,800);
            await recordCollectFailure({
              code:'api_supplement_batch_rejected',severity:'warning',
              message:`the optional arXiv API supplement had its batch rejected as a whole (its own batch_rejected error event and offline evidence already exist; the ordinary RSS papers of this round are kept): ${supplementMessage}`,
              observationKey:`arxiv.collect:api_supplement_rejected:${runKey}`,
              targetId:'export.arxiv.org',
              details:{cacheDay,apiSupplementAttempted:true,hydrationCandidates:result.hydrationCandidates,
                ...committedFields,ordinaryRssPapersKept:true},
            });
          } else {
            // An ordinary supplement failure (HTTP status, timeout, a body that is not Atom) is its
            // own warning — and it now carries the response evidence the transport captured, so the
            // event can be judged without the connection: the HTTP status, how many bytes of the
            // origin's error body were really kept and whether that body was cut to the byte budget.
            // A timeout has no origin response at all, so it honestly reports none.
            const httpError=findArxivHttpError(supplementError);
            result.apiSupplementFailed=supplementMessage.slice(0,800);
            await recordCollectFailure({
              code:'api_supplement_failed',severity:'warning',
              message:`the optional arXiv API supplement failed: ${supplementMessage}`,
              observationKey:`arxiv.collect:api_supplement:${runKey}`,
              targetId:'export.arxiv.org',
              details:{cacheDay,apiSupplementAttempted:true,hydrationCandidates:result.hydrationCandidates,
                ...committedFields,
                httpStatus:httpError?.status ?? null,
                failedBodyBytes:httpError?.bodyBytes.byteLength ?? 0,
                failedBodyTruncated:httpError?.bodyTruncated===true},
              // The bytes are not only counted, they are KEPT: the origin's own failure document
              // travels through the SAME evidence channel every other collect failure uses (the
              // endpoint that answered and its status go with it), so the record is the evidence, not
              // a number claiming a body once existed. A timeout has no response, so it passes no
              // evidence at all — nothing is invented for a body that never arrived.
              evidence:httpError===undefined ? undefined
                : {content:httpError.bodyText,bytes:httpError.bodyBytes,truncated:httpError.bodyTruncated===true},
            });
          }
        }
      }
      if(supplementFailed) {
        // The API has just been shown to be unusable, so this round does NOT go on to ask the same
        // source for anything else — the same principle the shared 429 hold follows: committed content
        // may keep being analysed, but nothing keeps issuing source requests. What this round really
        // earned is what it reports: the papers the feed carried, as a partial result.
        //
        // A main-source failure is checked BEFORE this return, so the auxiliary exit can never step
        // over it: a dead feed stays a dead feed however the supplement ended.
        if(rssFetchFailed) throw feedFailureWithCommittedSupplement();
        if(recordingGaps.length>0) result.recordingGaps=recordingGaps;
        return result;
      }
    }
    // The watermark only advances when the main source worked; a dead feed must stay visibly red.
    if(rssFetchFailed) throw feedFailureWithCommittedSupplement();
    if(!apiWindow) {
      // RSS-PRIMARY, the ordinary round — with an optional, already-finished bounded supplement beside
      // it. The official announcement feed was read, its evidence and its normal papers were committed
      // together, and there is nothing else the round is waiting for: the content the schedule cares
      // about IS the feed. Completing here is exactly what keeps the round off the legacy window — no
      // routine submission-date scan, and no request a rate limit could turn into a reason not to store
      // what the feed already carried. The window itself is not consumed or reset while it is off, so an
      // explicitly enabled run still walks the same fixed window from the same cursor.
      //
      // A supplement that left versions behind keeps that fact: the round reports the structured partial
      // it earned instead of claiming a clean complete. Nothing downstream is skipped either way — a
      // paper stored here is a normal pending raw paper, so the same analysis job picks it up, and a day
      // that really stored something closes on `insertedPaperCount` exactly as an API-collected day does.
      if(hydrationFailure!==undefined) {
        result.partial=true;result.hydrationFailure=hydrationFailure;
        if(recordingGaps.length>0) result.recordingGaps=recordingGaps;
        return result;
      }
      result.complete=true;
      if(recordingGaps.length>0) result.recordingGaps=recordingGaps;
      return result;
    }
    // The LEGACY ordinary submission-date window, restored only by its own explicit switch. Turning the
    // supplement on never reaches this: the window is a far larger amount of traffic against a source
    // that rate-limits by client, so it is never a side effect of asking for a bounded gap-fill.
    const seen=new Set(state.seen_ids);
    for(let pageNumber=0;pageNumber<maxPages;pageNumber++) {
      lastEndpoint={host:'export.arxiv.org',path:'/api/query'};
      const page=await stateApi.withLeaseHeartbeat(state,signal=>channel.run(signal,fetchImpl=>collectArxivMetadata({start:state.next_start,submittedFrom:state.window_from!,
        submittedThrough:state.window_through!,fetch:fetchImpl,maxResults:pageSize,timeoutMs:options.timeoutMs,maxBytes:options.maxBytes})),{intervalMs:options.leaseHeartbeatMs});
      const info=parseArxivPageInfo(page.raw_atom);
      const expected=Math.min(info.itemsPerPage,Math.max(0,info.totalResults-state.next_start));
      if(info.startIndex!==state.next_start || info.itemsPerPage>pageSize || (info.totalResults>0 && info.itemsPerPage===0) ||
          info.totalResults<state.next_start || (state.expected_total!==null && info.totalResults!==state.expected_total) ||
          page.papers.length!==expected || page.papers.some(p=>seen.has(p.arxiv_id))) {
        // Restart the SAME fixed window from its first page: a window recomputed from "now" would
        // slide forward and permanently exclude the not-yet-collected older slice of this window.
        await stateApi.invalidateCollectionWindow(state);
        throw new Error('arXiv pagination coverage changed or was truncated; window restarts from its fixed start');
      }
      await persist(page);
      for(const paper of page.papers) seen.add(paper.arxiv_id);
      state.next_start+=page.papers.length;state.expected_total=info.totalResults;state.seen_ids=[...seen];
      result.windowTotal=info.totalResults;
      const complete=state.next_start===info.totalResults && seen.size===info.totalResults;
      // The window slice is finished either way, but a round that stored nothing for some requested
      // version must not let the watermark claim the day was fully handled.
      await stateApi.saveCollectionProgress(state,complete && hydrationFailure===undefined);
      if(complete) {
        if(hydrationFailure!==undefined) {
          // The window was handled and everything storable is stored; the versions that came back
          // missing or unexpected stay recorded as open exceptions with their own evidence, and the
          // explicit recovery entry is what retries them. That is a structured partial result, not a
          // failed round, so the schedule does not run the whole window again because of it. The
          // watermark still does not advance.
          result.partial=true;result.hydrationFailure=hydrationFailure;
          if(recordingGaps.length>0) result.recordingGaps=recordingGaps;
          return result;
        }
        result.complete=true;
        if(recordingGaps.length>0) result.recordingGaps=recordingGaps;
        return result;
      }
    }
    throw new Error(hydrationFailure!==undefined
      ? `${hydrationFailure}; the window is still incomplete, so the next scheduled run resumes it`
      : 'arXiv collection incomplete: bounded page budget reached; next scheduled run resumes persisted window');
  } catch(error) {
    // The status is read through whatever wrappers the failure collected on its way here, so a 429
    // still establishes the shared hold when the request watermark could not be written alongside it.
    let reported=error;
    if(isArxivRateLimited(error)) {
      // This branch exists to make the FIRST decision about the upstream 429. A 429 that already went
      // through that decision must not go through it twice: by then `holdUnconfirmed` is the memory of
      // a pause that could not be persisted, so re-running it here would attempt the same impossible
      // write again and replace the error being carried — which names WHICH step met the 429, e.g. the
      // auxiliary supplement — with a context-free copy of itself. The facts are already complete.
      if(!holdUnconfirmed) {
        // The shared hold and its record are the same ones the supplement uses, so the two paths cannot
        // drift into different semantics for the same upstream condition.
        const holdError=await reportRateLimit(error);
        if(holdError!==undefined) {
          // Fail closed, and keep BOTH facts: the real 429 and the failure to persist the pause. The run
          // stops here, so nothing further is dispatched on an unverified pause. `holdUnconfirmed` already
          // made the finally keep the lease, so the row cannot be read as "no pause was needed".
          reported=new AggregateError([error,holdError],
            `arXiv HTTP 429: durable cooldown commit failed — ${stateApi.ARXIV_HOLD_UNCONFIRMED_NOTICE}`);
        }
      }
    } else if(findArxivHttpError(error)!==undefined && !(error instanceof stateApi.ArxivControlPlaneError)) {
      // A metadata request failed at the HTTP level (5xx, unexpected redirects, oversized bodies...).
      // The RSS catch keeps its own classified record, so this branch is only reached for the API
      // side; the origin's own failure body travels as evidence when the transport carried one, and
      // the source names the endpoint the request actually used (never hardcoded to the RSS feed).
      const httpError=findArxivHttpError(error)!;
      await recordCollectFailure({
        code:'source_http_failed',severity:'error',message:String(error).slice(0,2000),
        observationKey:`arxiv.collect:http:${runKey}:${httpError.status}`,
        targetId:lastEndpoint.host,
        details:{httpStatus:httpError.status,endpoint:`${lastEndpoint.host}${lastEndpoint.path}`,
          failedBodyBytes:httpError.bodyBytes.byteLength,failedBodyTruncated:httpError.bodyTruncated},
        // Handed over regardless of length: the recorder keeps the completeness of the read even when
        // there is nothing to write to a file.
        evidence:{content:httpError.bodyText,bytes:httpError.bodyBytes,truncated:httpError.bodyTruncated},
      });
    }
    // Handed to the finally rather than thrown here, so the release cleanup below cannot overwrite it.
    pendingError=reported;
  } finally {
    // Releasing is a no-op once the lease was handed to the hold, so it only matters when the run still
    // owns the lease. It is skipped when the hold could NOT be confirmed: clearing the row then would
    // erase the only trace of the pause and let the next entry read "no hold" from a state nobody
    // could vouch for. The lease is left to expire on its own instead, which is the conservative side.
    if(!holdUnconfirmed) {
      try { await stateApi.releaseCollection(state); }
      catch(releaseError) {
        if(pendingError===undefined) {
          // The round itself SUCCEEDED, so its result is already on its way out: throwing here would
          // replace that result with a cleanup error, and swallowing the failure would announce a clean
          // finish while the lease was never handed back. Both facts fit because the result object
          // travels by reference — the round keeps the outcome it earned and carries the failed cleanup
          // with it, so a caller reading "complete" also learns the release did not happen.
          result.cleanupFailure=`the collection lease could not be released: ${String(releaseError).slice(0,300)}`;
        } else {
          // The round already failed, and an exception thrown from a finally block WINS over the one in
          // flight — so a release that failed after a real 429 would have erased the 429. Both facts are
          // kept instead and the pair is what the caller sees.
          pendingError=new AggregateError([pendingError,releaseError],'the arXiv run failed and its collection lease could not be released');
        }
      }
    }
  }
  // Only reached when the run ended in the catch above: a successful run returns from inside the try,
  // which skips this line entirely. Known recording gaps ride ON the failure — both facts, never one
  // dressed up as the other.
  if(pendingError!==undefined) {
    throw recordingGaps.length===0 ? pendingError : new AggregateError(
      [pendingError], `${String(pendingError)} (recording gaps in this run: ${recordingGaps.length})`);
  }
}
