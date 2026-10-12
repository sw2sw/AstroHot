import { collectArxivMetadata,parseArxivPageInfo } from './collect.ts';
import { ingestRawArxivCollection } from './raw-store.ts';
import { parseArxivAnnouncements,ingestArxivAnnouncements } from './announcements.ts';
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
};

/**
 * Stable code for a failed official feed. A rate limit and a missing batch stay business branches
 * (warning); a feed that could not be read is an error an operator has to look at. The classification
 * follows the documented allow-list in docs/ERROR-RECORDING.md.
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
const noWork=()=>({paperCount:0,rawBatchCount:0,rssPaperCount:0,windowTotal:0,rssCacheHit:false,newContentCount:0,
  insertedPaperCount:0,windowIngested:0,partial:false,hydrationFailure:undefined as string|undefined,cleanupFailure:undefined as string|undefined,
  recordingGaps:undefined as string[]|undefined,...noHydrationWork()});
export async function collectAndStoreArxiv(options:Options = {}) {
  if(process.env.COLLECT_ENABLED!=='true' || process.env.ARXIV_NATIVE_COLLECT_ENABLED!=='true') return undefined;
  const pageSize=options.pageSize ?? options.maxResults ?? 100;
  const maxPages=options.maxPages ?? 10;
  for(const [name,value,max] of [['pageSize',pageSize,100],['maxPages',maxPages,100]] as const) {
    if(!Number.isSafeInteger(value)||value<1||value>max) throw new Error(`Invalid arXiv ${name}`);
  }
  const now=options.now?.() ?? new Date();
  if(!Number.isFinite(now.getTime())) throw new Error('Invalid collection clock');
  const stateApi=await import('./collection-state.ts');
  const state=await stateApi.claimCollection(now);
  if('status' in state) return {...state,...noWork()};
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
      // Same channel and same UTC day: the feed was already ingested, so this run reuses it instead
      // of asking arXiv again. Only a successfully ingested feed is ever cached, so a failed or
      // unparsable response can never be replayed as a success here.
      result.rssPaperCount=cached.itemCount;
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
        const announcements=parseArxivAnnouncements(rss);
        // The feed's evidence batch and the cache row that points at it commit in the SAME transaction
        // under the same ownership check. Written separately, a run that was taken over between the two
        // could finish by stamping the cache with the feed it read before handing over, and every later
        // run of that day would replay the stale feed instead of asking arXiv again.
        const evidence=await stateApi.ownerGuardedDatabase(state).begin(async tx=>{
          const ambient=stateApi.ambientTransaction(tx);
          const stored=await ingestArxivAnnouncements(rss,now.toISOString(),ambient);
          await writeArxivRssCache({channel:RSS_CHANNEL,cacheDay,contentHash:stored.batchHash,itemCount:announcements.length,
            fetchedAt:new Date(),httpStatus:response?.status ?? null,headers:response?.headers ?? {},durationMs:Date.now()-startedMs},ambient);
          return stored;
        });
        result.rssPaperCount=announcements.length;
        // A newly stored feed with entries is new content; a re-published identical feed is
        // 'unchanged' and contributes nothing, and an empty feed contributes nothing either.
        if(evidence.status==='imported' && announcements.length>0) result.newContentCount+=announcements.length;
        if(evidence.status==='imported') result.status='imported';
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
    {
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
      const {sql}=await import('../db.ts');
      const candidates=await sql<{arxiv_id:string;base_id:string;version:number}[]>
        `SELECT a.arxiv_id,a.base_id,a.version FROM arxiv_announcements a
         JOIN arxiv_announcement_batches b ON b.content_hash=a.first_batch_hash
         WHERE a.announced_on BETWEEN (b.collected_at AT TIME ZONE 'UTC')::date - 1
                                  AND (b.collected_at AT TIME ZONE 'UTC')::date
           AND a.announced_on<=${now.toISOString().slice(0,10)}::date
           AND NOT EXISTS(SELECT 1 FROM arxiv_raw_papers r WHERE r.arxiv_id=a.arxiv_id)
           AND NOT EXISTS(SELECT 1 FROM arxiv_hydration_exceptions e
                          WHERE e.arxiv_id=a.arxiv_id AND e.resolved_at IS NULL)
         ORDER BY a.first_batch_hash,a.arxiv_id LIMIT 1000`;
      const ids=[...new Set(candidates.map(p=>p.arxiv_id))];
      result.hydrationCandidates=ids.length;
      let batchIndex=0;
      for(let i=0;i<ids.length;i+=pageSize) {
        const requested=ids.slice(i,i+pageSize);
        if(!requested.length) break;
        const startedMs=Date.now();
        lastEndpoint={host:'export.arxiv.org',path:'/api/query'};
        const page=await stateApi.withLeaseHeartbeat(state,signal=>channel.run(signal,fetchImpl=>collectArxivMetadata({idList:requested,fetch:fetchImpl,maxResults:pageSize,
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
              pagination:hydrationPagination(page.raw_atom,requested.length,page.papers.length,batchIndex,pageSize),durationMs},
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
          // round records it and keeps going, so only the remaining sub-batches and the ordinary window
          // pages decide whether the window was handled at all.
          hydrationFailure??=`arXiv RSS hydration returned missing or unexpected versions (requested ${requested.length}, returned ${page.papers.length})`;
        }
      }
      result.hydrationFailed=result.hydrationMissing+result.hydrationUnexpected;
    }
    // The watermark only advances when both channels worked; a dead feed must stay visibly red.
    if(rssFetchFailed) throw new Error(`arXiv announcement feed failed: ${String(rssFailure).slice(0,800)}`);
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
      if(holdError!==undefined) {
        // Fail closed, and keep BOTH facts: the real 429 and the failure to persist the pause. The run
        // stops here, so nothing further is dispatched on an unverified pause. `holdUnconfirmed` already
        // made the finally keep the lease, so the row cannot be read as "no pause was needed".
        reported=new AggregateError([error,holdError],
          `arXiv HTTP 429: durable cooldown commit failed — ${stateApi.ARXIV_HOLD_UNCONFIRMED_NOTICE}`);
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
