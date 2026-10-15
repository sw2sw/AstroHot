// The arXiv collection state machine. One row per channel carries the resumable window cursor, the
// durable HTTP429 admission hold and the owner lease that makes ordinary collection mutually
// exclusive. The lease is deliberately shared: the explicit hydration recovery entry claims the
// same row, so a refetch can never run next to a collection (or next to another refetch), and a
// request spacing watermark is stored here too because the in-process channel only spaces the
// requests of one process.
import { randomUUID } from 'node:crypto';
import { sql } from '../db.ts';
import type { Tx } from '../db.ts';
import type { RawArxivDatabase } from './raw-store.ts';

export const ARXIV_COLLECTION_KEY = 'astro-ph';
export const ARXIV_MIN_REQUEST_INTERVAL_MS = 3000;
// The lease a holder is given, and how often it is renewed while one request is in flight. The lease
// is deliberately longer than the request transport's own 90 s abort deadline (`fetchArxivXml`), and
// the heartbeat makes the mutex independent of that: a request that legitimately outlives one term
// keeps the lease instead of losing it to the next entry.
export const ARXIV_LEASE_SECONDS = 120;
export const ARXIV_LEASE_HEARTBEAT_MS = 40_000;
// A renewal is a bounded question. Past this long without an answer the run can no longer show it still
// holds the channel, so it fails closed instead of waiting on a database round trip that may never
// come back. It is well under the heartbeat interval and the term, so a single slow round trip is
// tolerated while a genuinely stuck one is not.
export const ARXIV_RENEWAL_TIMEOUT_MS = 30_000;
// The dispatch boundary re-validates the lease. That check sits on the request's critical path, so it
// gets a much shorter bound than a background renewal: a request that cannot be shown to be owned
// within this long is not sent at all.
export const ARXIV_DISPATCH_CHECK_TIMEOUT_MS = 5_000;
// The durable HTTP429 hold. arXiv rate-limits by client, so a 429 is a shared fact rather than one
// request's bad luck: every entry point freezes for at least this long from the moment the 429 was
// really handled, and a valid Retry-After can only ever lengthen it.
export const ARXIV_RATE_LIMIT_HOLD_SECONDS = 6 * 60 * 60;
/**
 * How much a valid Retry-After adds on top of the floor. A valid value is honoured IN FULL, however
 * long the source asks for: capping it would mean the collector resumes ahead of a deadline the source
 * really set, which is exactly what the hold exists to prevent. Only a missing, non-integer or
 * non-positive value collapses to the floor. An unreasonable value is not silently discarded here —
 * it is durably visible as the row's `lease_until`, so an operator can see and clear it.
 */
function rateLimitExtensionSeconds(retryAfterSeconds?:number):number {
  return typeof retryAfterSeconds==='number'&&Number.isSafeInteger(retryAfterSeconds)&&retryAfterSeconds>0
    ? retryAfterSeconds : 0;
}

/**
 * What every entry point reports when a real 429 could not be turned into a durable hold. It is shared
 * so the two entries cannot drift into different wording for the same operator action.
 *
 * There is a limit to what code can do here and the message says so rather than pretending otherwise:
 * a database that cannot be written to cannot hold a six-hour pause, so no entry point can promise one
 * that was never persisted. The run therefore stops, keeps its lease instead of releasing it, and
 * dispatches nothing else — and the pause becomes an explicit OPERATIONS duty. The realistic failure
 * modes are already closed without that duty: while the state row is unreachable neither entry can
 * claim the lease at all (the claim is a write), so nothing is dispatched; and when the row is owned by
 * a successor it is the successor's own 429 to handle. The duty covers what is left: a hold that failed
 * once while the rest of the database stayed healthy, where the 120 s lease would otherwise expire
 * before anybody looked.
 */
export const ARXIV_HOLD_UNCONFIRMED_NOTICE =
  'the run has stopped, kept its collection lease and dispatched nothing further, but a durable pause was NOT persisted. Set a durable pause as an operator before collection resumes, and do not rely on a restart to clear this';

export interface CollectionState {
  key: string; completed_through: Date|null; window_from:string|null; window_through:string|null;
  next_start:number; expected_total:number|null; seen_ids:string[]; owner:string;
}
export function queryMinute(date:Date):string { return date.toISOString().replace(/[-:T]/g,'').slice(0,12); }
function minuteInstant(value:string):string { return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:00Z`; }
export interface CollectionCooldown { status:'skipped'; complete:false; nextEligibleAt:string; }

/** What every lease holder (collection or recovery) needs to renew, hand over or release it. */
export interface CollectionClaim { key:string; owner:string; }
/** A live owner is already working: nobody else may touch the network. */
export interface CollectionBusy { status:'busy'; owner:string; nextEligibleAt:string|null; }
export interface CollectionLease extends CollectionClaim { leaseUntil:string; }
export type CollectionAdmission = CollectionLease | CollectionCooldown | CollectionBusy;

/**
 * A failure of the CONTROL PLANE — the durable state and the lease that guards it — as opposed to a
 * failure of the upstream arXiv request. Nothing a run observed about arXiv may be counted when the
 * control plane could not confirm that the run still owned the channel: the answer belongs to whoever
 * holds the lease now, and spending a retry or recording a transport failure would move shared state on
 * behalf of a run that is no longer entitled to move it. Callers branch on this type, never on a
 * message, so the two paths cannot drift apart.
 */
export class ArxivControlPlaneError extends Error {
  constructor(message:string, options?:{cause?:unknown}) {
    super(message, options);
    this.name=new.target.name;
  }
}

/**
 * The channel was CONFIRMED lost: the state row says another owner holds it, or the term this process
 * was granted has run out. A stale owner may still be in flight, but nothing it sees is trustworthy.
 */
export class ArxivLeaseLostError extends ArxivControlPlaneError {
  constructor(message='arXiv collection lease lost', options?:{cause?:unknown}) {
    super(message, options);
  }
}

/**
 * The channel could NOT BE CONFIRMED: the renewal never answered, or the durable state could not be
 * read or written. This is deliberately NOT the same fact as a confirmed takeover — the ownership may
 * well still be ours and the database may simply be unreachable — but the run is treated the same way,
 * because dispatching on a lease nobody verified is exactly what the mutex exists to prevent. Keeping
 * the two apart is what stops a database hiccup from being logged as an upstream arXiv failure.
 */
export class ArxivLeaseUnconfirmedError extends ArxivControlPlaneError {
  constructor(message='arXiv collection lease could not be confirmed', options?:{cause?:unknown}) {
    super(message, options);
  }
}

/**
 * Everything that is not an already-classified control-plane error came out of the database, so it is
 * an UNCONFIRMED control-plane failure rather than a confirmed loss. Classifying here keeps every
 * caller from having to know which wrapping path a renewal happened to take.
 */
function asControlPlaneError(error:unknown, message:string):ArxivControlPlaneError {
  return error instanceof ArxivControlPlaneError
    ? error
    : new ArxivLeaseUnconfirmedError(`${message} (${String(error instanceof Error?error.message:error).slice(0,300)})`,{cause:error});
}

/**
 * Awaits `work` under a bound. A renewal is a question with a deadline: if the answer never comes the
 * caller must fail closed rather than wait on it, and the losing promise is detached so it can never
 * surface later as an unhandled rejection.
 */
async function boundedControlPlane<T>(
  work:Promise<T>,
  timeoutMs:number,
  onTimeout:()=>ArxivControlPlaneError,
):Promise<T> {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1) throw new Error('timeoutMs must be a positive integer');
  work.catch(()=>{});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const expiry=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(onTimeout()),timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([work,expiry]); }
  finally { if(timer!==undefined) clearTimeout(timer); }
}

/**
 * Claims the channel lease inside an ALREADY OPEN transaction. The scheduled entry calls this from the
 * SAME transaction that spends the day's attempt, so a channel that is really busy — another worker, or
 * the explicit hydration recovery entry — is refused BEFORE an attempt is spent, and there is no window
 * between the budget admission and the lease claim for a second process to slip in.
 *
 * `at` is the authoritative instant the durable hold and the live term are compared against, and
 * `windowNow` the instant the window bounds are computed from. The scheduled entry passes the SAME
 * instant for both, so its budget and its lease share one clock; the legacy `claimCollection` keeps the
 * database clock for the comparison and the caller's instant for the window, exactly as before.
 *
 * Unlike `claimCollection`, a live owner is RETURNED as `busy` rather than thrown: the caller is a
 * transaction that must decide whether the day's attempt may be spent, and an exception would force it
 * to guess.
 */
export async function claimCollectionWithin(
  tx:Tx,
  instant:{at:Date;windowNow:Date},
):Promise<CollectionState|CollectionCooldown|CollectionBusy> {
  const owner=randomUUID();
  await tx`INSERT INTO arxiv_collection_state(key) VALUES(${ARXIV_COLLECTION_KEY}) ON CONFLICT(key) DO NOTHING`;
  const row=(await tx<{owner:string|null;lease_until:Date|null;active:boolean|null;completed_through:Date|null;
      window_from:string|null;window_through:string|null}[]>`
    SELECT owner,lease_until,completed_through,window_from,window_through,
      lease_until > ${instant.at.toISOString()}::timestamptz AS active
    FROM arxiv_collection_state WHERE key=${ARXIV_COLLECTION_KEY} FOR UPDATE`)[0]!;
  // An ownerless future lease is the durable HTTP429 admission hold (or an operator's pause).
  if(row.active && row.owner===null) {
    return {status:'skipped' as const,complete:false as const,nextEligibleAt:new Date(row.lease_until!).toISOString()};
  }
  // A live owner is really working the channel: nobody else may take it, and no attempt may be spent.
  if(row.active) {
    return {status:'busy' as const,owner:row.owner!,nextEligibleAt:row.lease_until ? new Date(row.lease_until).toISOString() : null};
  }
  const now=instant.windowNow;
  const todayUtc=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  // A missed schedule cannot silently initiate an unbounded historical backfill.
  const from=row.window_from ?? queryMinute(new Date(row.completed_through
    ? Math.max(new Date(row.completed_through).getTime()-86400000,todayUtc) : todayUtc));
  const through=row.window_through ?? queryMinute(now);
  if(from>through) throw new Error('arXiv collection clock moved backwards');
  const claimed=await tx<CollectionState[]>`UPDATE arxiv_collection_state SET owner=${owner},lease_until=clock_timestamp()+make_interval(secs=>${ARXIV_LEASE_SECONDS}),
    window_from=${from},window_through=${through} WHERE key=${ARXIV_COLLECTION_KEY} RETURNING *`;
  return claimed[0]!;
}

export async function claimCollection(now:Date):Promise<CollectionState|CollectionCooldown> {
  // The comparison instant is the DATABASE clock, as it always was for this entry point; the window
  // still uses the caller's instant. A live owner keeps its historical contract: an exception, not a
  // returned status, because every existing caller branches on the throw.
  const claimed=await sql.begin(async tx=>{
    const at=(await tx<{at:Date}[]>`SELECT clock_timestamp() AS at`)[0]!.at;
    return claimCollectionWithin(tx,{at:new Date(at),windowNow:now});
  });
  if('status' in claimed && claimed.status==='busy') throw new Error('arXiv collection is busy in another process');
  return claimed;
}

/**
 * Claims the same lease ordinary collection uses, WITHOUT touching the frozen window, cursor or
 * watermark. The explicit recovery entry goes through here so a refetch shares one durable gate with
 * collection: two refetches, or a refetch and a collection, can never overlap, and neither runs while
 * the durable HTTP429 hold is active. The caller must release the lease (or hand it to the hold) when
 * it is done.
 */
export async function claimCollectionLease(key:string=ARXIV_COLLECTION_KEY):Promise<CollectionAdmission> {
  const owner=randomUUID();
  return sql.begin(async tx=>{
    await tx`INSERT INTO arxiv_collection_state(key) VALUES(${key}) ON CONFLICT(key) DO NOTHING`;
    const row=(await tx<{owner:string|null;active:boolean|null;lease_until:Date|null}[]>`
      SELECT owner,lease_until,lease_until > clock_timestamp() AS active FROM arxiv_collection_state WHERE key=${key} FOR UPDATE`)[0]!;
    if(row.active && row.owner===null) {
      return {status:'skipped' as const,complete:false as const,nextEligibleAt:new Date(row.lease_until!).toISOString()};
    }
    if(row.active) {
      return {status:'busy' as const,owner:row.owner!,nextEligibleAt:row.lease_until ? new Date(row.lease_until).toISOString() : null};
    }
    const claimed=await tx<{lease_until:Date}[]>`UPDATE arxiv_collection_state
      SET owner=${owner},lease_until=clock_timestamp()+make_interval(secs=>${ARXIV_LEASE_SECONDS})
      WHERE key=${key} RETURNING lease_until`;
    return {key,owner,leaseUntil:new Date(claimed[0]!.lease_until).toISOString()};
  });
}

/**
 * Atomically hands the owned lease over to a durable admission hold without touching the frozen window,
 * cursor or watermark. The hold is measured from the moment the 429 was really handled — never from a
 * nominal slot, never rounded — and is never shorter than `ARXIV_RATE_LIMIT_HOLD_SECONDS`: arXiv
 * rate-limits by client, so one 429 is a shared fact and every entry point must wait the full six hours
 * out. A valid Retry-After may only ever LENGTHEN it, and is honoured in full with no ceiling of our
 * own; a missing, invalid, past or shorter one leaves the floor untouched, and an existing longer hold
 * — an operator's manual pause, say — is preserved by the GREATEST rather than being replaced. An
 * expired or taken-over lease cannot overwrite a successor.
 */
export async function deferRateLimitedCollection(state:CollectionClaim, retryAfterSeconds?:number):Promise<void> {
  const extension=rateLimitExtensionSeconds(retryAfterSeconds);
  // The hold already in the row joins the GREATEST, so a 429 can never CUT SHORT a longer pause that is
  // already in place — an operator's manual pause of a day, say — while still never coming out below the
  // six-hour floor.
  const rows=await sql`UPDATE arxiv_collection_state
    SET owner=NULL,lease_until=GREATEST(COALESCE(lease_until,clock_timestamp()),
      clock_timestamp()+make_interval(secs=>${ARXIV_RATE_LIMIT_HOLD_SECONDS}::double precision),
      clock_timestamp()+make_interval(secs=>${extension}::double precision))
    WHERE key=${state.key} AND owner=${state.owner} RETURNING key`;
  if(!rows.length) throw new ArxivLeaseLostError('arXiv collection lease lost before HTTP429 cooldown commit');
}

/**
 * The fallback the caller uses when the owner-conditioned hold above could not be written. It never
 * steals a successor's lease — the WHERE keeps the row when somebody else owns it — and it only ever
 * EXTENDS the hold, so it can neither shorten a pause nor clear one. Its purpose is that a 429 whose
 * first persistence attempt failed must not end up as no pause at all.
 *
 * It carries the SAME deadline the primary write would have used. A fallback that only ever held the
 * six-hour floor would report success while quietly cutting a longer Retry-After back to six hours
 * exactly when the row was already misbehaving, so `retryAfterSeconds` is honoured here too, and the
 * GREATEST keeps both the requested deadline and any longer pause that was already in the row.
 * `true` means the conservative floor is now durable.
 */
export async function holdCollectionConservatively(state:CollectionClaim, retryAfterSeconds?:number):Promise<boolean> {
  const extension=rateLimitExtensionSeconds(retryAfterSeconds);
  const rows=await sql`UPDATE arxiv_collection_state
    SET owner=NULL,lease_until=GREATEST(COALESCE(lease_until,clock_timestamp()),
      clock_timestamp()+make_interval(secs=>${ARXIV_RATE_LIMIT_HOLD_SECONDS}::double precision),
      clock_timestamp()+make_interval(secs=>${extension}::double precision))
    WHERE key=${state.key} AND (owner IS NULL OR owner=${state.owner}) RETURNING key`;
  return rows.length>0;
}

/** Extends the holder's term. Returns the new term so the caller can bound its own local deadline. */
export async function renewCollection(state:CollectionClaim):Promise<string> {
  const row=await sql<{lease_until:Date}[]>`UPDATE arxiv_collection_state SET lease_until=clock_timestamp()+make_interval(secs=>${ARXIV_LEASE_SECONDS})
    WHERE key=${state.key} AND owner=${state.owner} AND lease_until > clock_timestamp() RETURNING lease_until`;
  if(!row.length) throw new ArxivLeaseLostError();
  return new Date(row[0]!.lease_until).toISOString();
}

/**
 * Confirms the run still owns the channel and extends the term, under a bound. This is the same durable
 * question renewCollection asks, but it is asked where a run cannot afford to wait for an answer: the
 * dispatch boundary of a request, and each heartbeat tick. A refused renewal is a CONFIRMED loss; a
 * database error or a renewal that never answered is an UNCONFIRMED one. Both fail closed, and both are
 * control-plane failures rather than upstream ones, so neither moves the retry budget.
 */
export async function confirmCollectionLease(
  state:CollectionClaim,
  options:{timeoutMs?:number;context?:string}={},
):Promise<void> {
  const timeoutMs=options.timeoutMs ?? ARXIV_DISPATCH_CHECK_TIMEOUT_MS;
  const context=options.context ?? 'while the run was running';
  await boundedControlPlane(
    renewCollection(state).then(()=>undefined,error=>{throw asControlPlaneError(error,`the lease renewal failed ${context}`);}),
    timeoutMs,
    ()=>new ArxivLeaseUnconfirmedError(`arXiv collection lease could not be confirmed within ${timeoutMs} ms ${context}: the renewal did not answer, so the run cannot show it still owns the channel`),
  );
}

/**
 * Runs one official request under a live lease: the lease is renewed first — the initial renewal is
 * itself bounded, so a database that never answers cannot hold the run open — and a heartbeat keeps
 * renewing it while the request is in flight, so a slow answer can never let another entry take the
 * connection over in the middle.
 *
 * A lost lease fails the run closed AND stops it. The renewal that was refused aborts the signal
 * handed to `task`, so a request that is still in flight is cancelled instead of being left to finish
 * on a connection this process no longer owns; the caller threads that signal into the transport (see
 * `ArxivChannel.run`). That is what makes one connection hold at the dispatch boundary and not merely
 * at the commit boundary. The signal also covers a lease that is already lost before the request is
 * dispatched — the initial renewal is refused — so a stale owner never reaches the network at all.
 *
 * The heartbeat never runs two renewals at once, and it FAILS CLOSED on a renewal that never comes
 * back: `renewalTimeoutMs` bounds how long one may be outstanding, and `leaseSeconds` bounds how long
 * the local view of the term may go unrefreshed. Without those bounds a hung database round trip or a
 * process that was paused past the whole term would leave the run dispatching on an unverified lease,
 * because a signal that was never aborted proves nothing about the row it belongs to.
 *
 * The heartbeat also never abandons its own renewal unobserved: the one it has started is awaited
 * before the result is handed back, and if it cannot be awaited within `renewalTimeoutMs` the run fails
 * closed instead of returning a result it cannot vouch for. When a loss is observed it is what the
 * caller sees: the abort error it caused must never hide it.
 */
export async function withLeaseHeartbeat<T>(
  state:CollectionClaim,
  task:(signal:AbortSignal)=>Promise<T>,
  options:{intervalMs?:number;renewalTimeoutMs?:number;leaseSeconds?:number}={},
):Promise<T> {
  const intervalMs=options.intervalMs ?? ARXIV_LEASE_HEARTBEAT_MS;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1) throw new Error('intervalMs must be a positive integer');
  const renewalTimeoutMs=options.renewalTimeoutMs ?? ARXIV_RENEWAL_TIMEOUT_MS;
  const leaseSeconds=options.leaseSeconds ?? ARXIV_LEASE_SECONDS;
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<1) throw new Error('leaseSeconds must be a positive integer');
  const controller=new AbortController();
  let lost:ArxivControlPlaneError|undefined;
  let renewing=false;
  let renewalStartedMs:number|undefined;
  let confirmedMs=Date.now();
  let inFlight:Promise<void>=Promise.resolve();
  const fail=async(error:ArxivControlPlaneError):Promise<void>=>{
    if(lost===undefined){lost=error;controller.abort(error);}
  };
  const tick=async():Promise<void>=>{
    if(lost!==undefined) return;
    const nowMs=Date.now();
    if(renewing) {
      // The renewal in flight must not hold the run open forever: a term is bounded, so the wait for
      // its confirmation is bounded too.
      if(renewalStartedMs!==undefined&&nowMs-renewalStartedMs>renewalTimeoutMs) {
        await fail(new ArxivLeaseUnconfirmedError(`arXiv collection lease could not be confirmed: the renewal started ${nowMs-renewalStartedMs} ms ago never answered (bound ${renewalTimeoutMs} ms)`));
      }
      return;
    }
    if(nowMs-confirmedMs>leaseSeconds*1000) {
      // The term this process was granted has certainly run out — a paused process, a sleeping host, a
      // database that stopped answering. Nobody told us, so the local clock has to.
      await fail(new ArxivLeaseUnconfirmedError(`arXiv collection lease could not be confirmed: the ${leaseSeconds} s term was last extended ${nowMs-confirmedMs} ms ago and no renewal has succeeded since`));
      return;
    }
    renewing=true;
    renewalStartedMs=nowMs;
    inFlight=renewCollection(state)
      .then(()=>{confirmedMs=Date.now();})
      .catch((error:unknown)=>{void fail(asControlPlaneError(error,'the lease renewal failed while the run was running'));})
      .finally(()=>{renewing=false;renewalStartedMs=undefined;});
  };
  // The initial renewal is bounded and classified like any other: a database that never answers must
  // fail the run closed instead of holding it open before the task has even started.
  try { await confirmCollectionLease(state,{timeoutMs:renewalTimeoutMs,context:'before the run started'}); }
  catch(error) {
    if(error instanceof ArxivControlPlaneError) throw error;
    throw asControlPlaneError(error,'the initial lease renewal failed before the run started');
  }
  confirmedMs=Date.now();
  const timer:ReturnType<typeof setInterval>=setInterval(()=>{void tick();},intervalMs);
  timer.unref();
  // Idempotent: the timer is stopped first, so no further renewal can be started, and the one that may
  // already be in flight is awaited — but only within its own bound, because a renewal that never
  // answers must not hold the run open either.
  let stopping:Promise<void>|undefined;
  const stop=():Promise<void>=>stopping ??= (async()=>{
    clearInterval(timer);
    if(!renewing){await inFlight;return;}
    const settled=await boundedControlPlane(
      inFlight.then(()=>true,()=>true),
      renewalTimeoutMs,
      ()=>new ArxivLeaseUnconfirmedError('arXiv collection lease could not be confirmed: a renewal was still unanswered when the run ended'),
    ).catch(()=>false);
    if(!settled) await fail(new ArxivLeaseUnconfirmedError('arXiv collection lease could not be confirmed: a renewal was still unanswered when the run ended'));
  })();
  try {
    const result=await task(controller.signal);
    await stop();
    if(lost!==undefined) throw lost;
    return result;
  } catch(error) {
    await stop();
    // The refused renewal that aborted the request is the cause, not the transport error it produced.
    // Whatever the cancelled request happened to report is kept as the loss's cause: it is evidence and
    // must not disappear, but no caller may act on it either — the run no longer owns the channel.
    if(lost!==undefined&&error!==lost) throw carryCause(lost,error);
    throw error;
  } finally { await stop(); }
}

/**
 * Keeps BOTH facts when a run both lost its channel and produced an error: the control-plane failure
 * stays the error the caller branches on — its class is preserved, so a confirmed takeover is still
 * reported as one — and what the cancelled run itself reported is attached as the cause instead of
 * being dropped.
 */
function carryCause(lost:ArxivControlPlaneError, cause:unknown):ArxivControlPlaneError {
  const message=`${lost.message} (the run it stopped reported: ${String(cause instanceof Error?cause.message:cause).slice(0,400)})`;
  return lost instanceof ArxivLeaseLostError
    ? new ArxivLeaseLostError(message,{cause})
    : new ArxivLeaseUnconfirmedError(message,{cause});
}

/**
 * Wraps a persist transaction so that a batch is only ever written by the process that still holds the
 * lease. The ownership check runs INSIDE the transaction and holds the state row until the transaction
 * ends, which is what makes it a guarantee rather than a best-effort probe: a takeover either commits
 * before the check — and is then seen, so the batch is refused and rolled back — or blocks behind the
 * lock until the batch is stored. Without it a run that had been taken over could still commit its
 * announcement, hydration and window rows; only the watermark was protected.
 */
export function ownerGuardedDatabase(state:CollectionClaim, database?:RawArxivDatabase):RawArxivDatabase {
  const base:RawArxivDatabase=database ?? {
    begin: async <T>(fn:(tx:Tx)=>Promise<T>):Promise<T> => sql.begin(fn) as Promise<T>,
  };
  return {
    begin: <T>(fn:(tx:Tx)=>Promise<T>):Promise<T> => base.begin(async tx=>{
      const owned=await tx`SELECT 1 FROM arxiv_collection_state
        WHERE key=${state.key} AND owner=${state.owner} AND lease_until > clock_timestamp() FOR UPDATE`;
      if(!owned.length) throw new ArxivLeaseLostError('arXiv collection lease lost before the batch could be written');
      return fn(tx);
    }),
  };
}

/**
 * Adapts an ALREADY OPEN transaction to the batch-write interface, so several writes can join one
 * transaction — and therefore one ownership check — instead of committing separately. Two writes that
 * must agree (a feed's evidence batch and the cache row pointing at it, say) belong in the same
 * transaction: committed one after the other, a run that is taken over in between can stamp the second
 * with state that the first no longer describes.
 */
export function ambientTransaction(tx:Tx):RawArxivDatabase {
  return { begin: <T>(fn:(tx:Tx)=>Promise<T>):Promise<T> => fn(tx) };
}
export async function saveCollectionProgress(state:CollectionState, complete=false):Promise<void> {
  const row=await sql`UPDATE arxiv_collection_state SET next_start=${complete?0:state.next_start},expected_total=${complete?null:state.expected_total},
    seen_ids=${complete?[]:state.seen_ids},window_from=${complete?null:state.window_from},window_through=${complete?null:state.window_through},
    completed_through=CASE WHEN ${complete} THEN GREATEST(completed_through,${minuteInstant(state.window_through!)}::timestamptz) ELSE completed_through END,
    lease_until=clock_timestamp()+make_interval(secs=>${ARXIV_LEASE_SECONDS})
    WHERE key=${state.key} AND owner=${state.owner} AND lease_until > clock_timestamp() RETURNING key`;
  if(!row.length) throw new ArxivLeaseLostError('arXiv collection lease lost before progress commit');
}
export async function invalidateCollectionWindow(state:CollectionClaim):Promise<void> {
  await sql`UPDATE arxiv_collection_state SET next_start=0,expected_total=NULL,seen_ids='{}'
    WHERE key=${state.key} AND owner=${state.owner}`;
}
export async function releaseCollection(state:CollectionClaim):Promise<void> {
  await sql`UPDATE arxiv_collection_state SET owner=NULL,lease_until=NULL WHERE key=${state.key} AND owner=${state.owner}`;
}

/**
 * A request spacing gate shared across processes and across callers. The in-process channel keeps
 * consecutive requests of one run three seconds apart, but a fresh process (or the recovery entry
 * right after a collection) would start with no memory of the previous request, so the moment of the
 * last official request is stored durably and read back before the next one. A missing row means no
 * request has been recorded yet.
 */
export interface CollectionThrottle {
  before():Promise<void>;
  after(at:Date):Promise<void>;
}
export function collectionThrottle(options:{
  key?:string; minIntervalMs?:number; sleep?:(ms:number)=>Promise<void>; now?:()=>Date;
} = {}):CollectionThrottle {
  const key=options.key ?? ARXIV_COLLECTION_KEY;
  const minIntervalMs=options.minIntervalMs ?? ARXIV_MIN_REQUEST_INTERVAL_MS;
  if(!Number.isSafeInteger(minIntervalMs)||minIntervalMs<0) throw new Error('minIntervalMs must be a nonnegative integer');
  const sleep=options.sleep ?? ((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const now=options.now ?? (()=>new Date());
  return {
    async before() {
      if(minIntervalMs===0) return;
      const rows=await sql<{last_request_at:Date|null}[]>`
        SELECT last_request_at FROM arxiv_collection_state WHERE key=${key}`;
      const last=rows[0]?.last_request_at;
      if(!last) return;
      const wait=minIntervalMs-(now().getTime()-new Date(last).getTime());
      if(wait>0) await sleep(wait);
    },
    async after(at:Date) {
      await sql`UPDATE arxiv_collection_state SET last_request_at=${at.toISOString()}::timestamptz WHERE key=${key}`;
    },
  };
}
