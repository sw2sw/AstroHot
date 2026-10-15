// The persisted attempt budget and due-driven entry of the arXiv collection schedule.
//
// The official feed is published once a day, so the schedule runs a first attempt at 01:00 UTC and
// then retries six hours apart while nothing new has been collected. Two retries a day is the cap, and
// every attempt is counted in the database rather than in the process, so a restart neither loses nor
// repeats a retry. Once an attempt actually collected something new — or handled its window with some
// versions left as recorded exceptions — the day is closed and the remaining attempts do nothing.
//
// The retry is NOT driven by fixed slots. A first attempt admitted at 01:00:22 owns 07:00:22 as its
// earliest retry, so a fixed 07:00 tick would be early, the whole slot would be dropped and the day
// would then wait until 13:00 — throwing away six hours of the budget and missing an evening
// publication a 15:00 retry would have caught. Instead the channel carries one persisted due instant
// (collection-due.ts, `arxiv_collection_schedule`), the worker asks once a minute whether it has
// arrived, and an attempt is admitted only when it really has. The budget itself is still the durable
// UTC-day row this file owns, so a duplicate delivery, a concurrent process, a restart re-delivery and
// the queue's own retry all land on the same two rows and cannot start a second attempt.
//
// The channel lease is taken by the SAME transaction that spends the attempt, so a channel that is
// really busy is refused before anything is spent. Every exit leaves a structured fact behind: a
// success carries day/attempt/retry/nextDueAt on its result, and a failure records the same facts as a
// durable ops event while keeping BOTH the source error and a failed schedule write.
import { assertArxivCollectionOptions, collectAndStoreArxiv } from './collect-job.ts';
import { releaseCollection, type CollectionState } from './collection-state.ts';
import { recordOpsError, type OpsErrorRecordResult } from '../operations/error-events.ts';
import {
  ARXIV_COLLECT_ATTEMPTS_PER_DAY, ARXIV_COLLECT_MIN_INTERVAL_HOURS, utcDayKey,
  beginDueCollectionAttempt, finishDueCollectionAttempt, type CollectionDayOutcome,
  type CollectionDueAdmission,
} from './collection-due.ts';

export { ARXIV_COLLECT_ATTEMPTS_PER_DAY, ARXIV_COLLECT_MIN_INTERVAL_HOURS, utcDayKey };
export type { CollectionDayOutcome };

export interface CollectionDayAdmission {
  allowed: boolean;
  // Attempts already recorded for this day before the current call.
  attempt: number;
  // The current attempt is a retry rather than the day's first try.
  retry: boolean;
  reason?: 'completed' | 'budget' | 'rate_limited' | 'busy' | 'not_due';
  // The authoritative instant the channel may next be collected at.
  nextDueAt?: string;
}

export type ScheduledCollectionOptions = Parameters<typeof collectAndStoreArxiv>[0];
/** The test-only clock seam the collector and the schedule share. */
type ScheduledClock = NonNullable<ScheduledCollectionOptions>['now'];

export interface ScheduledCollectionSkip {
  status: 'skipped';
  complete: false;
  // 'completed'/'budget' are the daily budget turning a tick away, 'not_due' is the durable due
  // instant not having arrived yet (the ordinary case for a per-minute tick), 'rate_limited' is the
  // durable HTTP429 hold (or an operator pause) freezing the channel before the attempt could run,
  // 'busy' is another process (or the explicit recovery entry) really holding the channel, and
  // 'interval' is the real six-hour spacing refusing a call that arrived early.
  reason: 'completed' | 'budget' | 'interval' | 'not_due' | 'rate_limited' | 'busy';
  day: string;
  attempts: number;
  // The authoritative instant the channel may next be collected at.
  nextEligibleAt?: string;
  paperCount: 0;
  rawBatchCount: 0;
  rssPaperCount: 0;
  windowTotal: 0;
  rssCacheHit: false;
  newContentCount: 0;
  // The ordinary API window stored nothing: this result describes a slot that never ran.
  windowIngested: 0;
  partial: false;
  hydrationFailure: undefined;
  /**
   * Set when a tick that never entered the collector could not hand the channel back. The tick still
   * reports what really happened — nothing ran — and states the failed cleanup beside it, instead of
   * reporting a clean hand-back that did not happen (the collector states its own `cleanupFailure` the
   * same way when a run that really ran could not release the lease).
   */
  cleanupFailure?: string;
}

/**
 * The result of an attempt that really ran, carrying the schedule facts the operator report needs
 * beside the collection counters: which UTC day it belonged to, whether it was the day's first try or
 * a retry, and the instant the channel is next allowed to collect.
 */
export type ScheduledCollectionRun = NonNullable<Awaited<ReturnType<typeof collectAndStoreArxiv>>> & {
  day: string;
  attempt: number;
  retry: boolean;
  nextDueAt: string;
};

export type ScheduledCollectionResult = ScheduledCollectionRun | ScheduledCollectionSkip | undefined;

/** Narrows a scheduled result to the tick that was refused and therefore ran no collection. */
export function isScheduledSkip(value: ScheduledCollectionResult): value is ScheduledCollectionSkip {
  return value !== undefined && 'reason' in value && 'day' in value;
}

/**
 * How the day is closed. The decision is made on what was REALLY persisted as a normal paper —
 * `insertedPaperCount`, the raw papers the independent API window and the hydration sub-batches
 * actually stored — never on a mixed count that can include RSS announcement evidence. A newly stored
 * feed with entries proves the RSS channel was read, not that the day's window was handled: a feed that
 * only re-announces versions already stored as raw papers leaves that count at zero, and the day stays
 * open for its retry budget instead of being closed on evidence alone.
 *
 * A partial round that really stored something closes the day: the rest stayed recorded as open
 * exceptions and the remaining attempts stop asking. A partial round that stored nothing anywhere is
 * left open instead, because that looks systemic, and the daily budget exists for exactly that. The
 * result stays visible either way: the caller still sees partial, hydrationFailure and the open
 * exception rows. The RSS evidence is NOT thrown away — it stays in `rssPaperCount` /
 * `newContentCount` for the operator view; it is only kept out of the closing decision.
 */
function dayOutcome(result: {
  partial: boolean; insertedPaperCount: number;
}): CollectionDayOutcome {
  if (result.partial) return result.insertedPaperCount > 0 ? 'partial' : 'failed';
  return result.insertedPaperCount > 0 ? 'collected' : 'empty';
}

/** A refused tick: it ran no collection, spent no attempt and left no run row of its own. */
function skip(
  day: string, reason: ScheduledCollectionSkip['reason'], attempts: number, nextEligibleAt: string | undefined,
): ScheduledCollectionSkip {
  return {
    status: 'skipped', complete: false, reason, day, attempts, nextEligibleAt,
    paperCount: 0, rawBatchCount: 0, rssPaperCount: 0, windowTotal: 0, rssCacheHit: false, newContentCount: 0,
    windowIngested: 0, partial: false, hydrationFailure: undefined,
  };
}

/**
 * Records the schedule facts of an attempt that could not be settled as a durable ops event, tied to
 * the run.
 *
 * A failure is exactly when an operator needs to know which UTC day, which attempt ordinal, which
 * reservation and which next-eligible instant the run belonged to — the same facts a success carries on
 * its result. The outcome the run really earned and the papers it really stored travel with them, so a
 * settle that failed after a run that COLLECTED something cannot be read as "nothing was collected".
 * They are recorded through the existing evidence system (never a new one), keyed on the reservation so
 * capturing the same real failure again inserts nothing. Best effort by design: the caller keeps the
 * original error whatever this returns.
 */
async function recordScheduledFailure(input: {
  day: string; attempt: number; retry: boolean; admittedAt: string;
  reservation: string | undefined; nextDueAt: string | undefined; error: unknown; jobRunId?: number;
  outcome: CollectionDayOutcome; insertedPaperCount?: number; cleanupFailure?: string;
}): Promise<OpsErrorRecordResult> {
  return recordOpsError({
    stage: 'arxiv.collect', code: 'schedule_failed', severity: 'error',
    message: input.outcome === 'failed'
      ? `arXiv scheduled attempt failed: ${String(input.error)}`
      : `arXiv scheduled attempt (${input.outcome}) could not be settled: ${String(input.error)}`,
    observationKey: `arxiv.collect:schedule:${input.reservation ?? input.admittedAt}`,
    groupKey: `arxiv.collect:schedule_failed:${input.day}`,
    jobRunId: input.jobRunId ?? null,
    runKey: input.reservation ? `reservation:${input.reservation}` : null,
    targetId: 'arxiv.org',
    details: {
      day: input.day, attempt: input.attempt, retry: input.retry, admittedAt: input.admittedAt,
      reservation: input.reservation ?? null, nextDueAt: input.nextDueAt ?? null,
      scheduleSettled: input.nextDueAt !== undefined,
      outcome: input.outcome,
      insertedPaperCount: input.insertedPaperCount ?? null,
      // A cleanup that failed alongside the settle is its own fact: the lease it could not hand back
      // is what makes every later tick read "busy", and the settle failure alone would hide it.
      cleanupFailure: input.cleanupFailure ?? null,
    },
  });
}

/** What the collector returned, when it returned at all. */
type CollectorResult = Awaited<ReturnType<typeof collectAndStoreArxiv>>;

/**
 * The outcome a run really EARNED, decided from what it did rather than from whether a bookkeeping
 * write later succeeded. A run that was turned away before it entered the collector — its enable gate
 * off, or the durable hold blocking it — earned `untouched`; anything else is `dayOutcome`'s decision
 * on the papers it really stored.
 */
function dayOutcomeOf(result: NonNullable<CollectorResult>): CollectionDayOutcome {
  return result.status === 'skipped' ? 'untouched' : dayOutcome(result);
}

/**
 * Hands a channel back for a tick that never entered the collector. The failure is RETURNED rather than
 * swallowed: a lease that could not be handed back leaves the channel owned until its term expires and
 * makes every tick until then read "busy", so the tick that failed to release it has to say so.
 */
async function handBackAdoptedLease(state: CollectionState | undefined): Promise<unknown | undefined> {
  if (state === undefined) return undefined;
  try { await releaseCollection(state); return undefined; }
  catch (error) { return error; }
}

/** The same wording the collector uses for a release it could not complete. */
function describeReleaseFailure(error: unknown): string {
  return `the collection lease could not be released: ${String(error).slice(0, 300)}`;
}

/**
 * Settles an attempt with the outcome it really earned, retrying ONCE with the SAME reservation and the
 * SAME outcome.
 *
 * The retry is what keeps a transient write failure from rewriting the outcome: a run that collected
 * something — or one that never ran at all — must not be recorded as 'failed' just because its first
 * bookkeeping write happened to fail. Retrying is safe precisely because the finish is FENCED on the
 * reservation: if the first call actually committed and only its answer was lost, the retry finds the
 * reservation closed and returns the due instant the row already carries, instead of settling twice.
 */
async function settleDueAttempt(input: {
  day: string; outcome: CollectionDayOutcome; admittedAt: Date; reservation: string | undefined;
  holdUntil?: string | null; clock: ScheduledClock;
}): Promise<string> {
  const options = {
    admittedAt: input.admittedAt, reservation: input.reservation, clock: input.clock,
    ...(input.holdUntil === undefined ? {} : { holdUntil: input.holdUntil }),
  };
  try {
    return await finishDueCollectionAttempt(input.day, input.outcome, options);
  } catch (first) {
    try {
      return await finishDueCollectionAttempt(input.day, input.outcome, options);
    } catch (second) {
      // Both facts, and the outcome that was being settled: the caller must be able to tell a settle
      // that failed for a successful run from one that failed for a failed run.
      throw new AggregateError([first, second],
        `the arXiv ${input.outcome} outcome could not be settled with reservation ${input.reservation ?? '(none)'}: ${String(first)} | ${String(second)}`);
    }
  }
}

/**
 * Settles a run that really FAILED — a source error, a lost control plane — and then records the known
 * schedule facts and re-throws.
 *
 * Settling is bookkeeping BESIDE the failure, never instead of it: a schedule write that fails keeps
 * both facts, and the original source error is never replaced by it. The known schedule facts are
 * recorded durably so a read-only operator view can tie the failure to its day, attempt and next
 * eligible instant.
 */
async function settleFailedRun(input: {
  day: string; admission: CollectionDueAdmission; admittedAt: Date;
  clock: ScheduledClock; error: unknown; jobRunId?: number;
}): Promise<never> {
  let nextDueAt: string | undefined;
  let settleFailure: unknown;
  try {
    nextDueAt = await finishDueCollectionAttempt(input.day, 'failed', {
      admittedAt: input.admittedAt, reservation: input.admission.reservation, clock: input.clock,
    });
  } catch (finishError) {
    settleFailure = finishError;
  }
  let record: OpsErrorRecordResult;
  try {
    record = await recordScheduledFailure({
      day: input.day, attempt: input.admission.attempt, retry: input.admission.retry,
      admittedAt: input.admission.admittedAt, reservation: input.admission.reservation,
      nextDueAt, error: input.error, jobRunId: input.jobRunId, outcome: 'failed',
    });
  } catch (recordError) {
    record = { recorded: false, error: recordError };
  }
  const reported = settleFailure === undefined
    ? input.error
    : new AggregateError(
      [input.error, settleFailure],
      `the arXiv run failed and its collection schedule could not be settled: ${String(settleFailure)}`,
    );
  if (!record.recorded) {
    throw new AggregateError(
      [reported, record.error],
      `${String(reported)} (the schedule facts could not be recorded in ops_error_events: ${String(record.error)})`,
    );
  }
  throw reported;
}

/**
 * A run that really happened could not have its schedule settled. Both facts are kept and neither is
 * dressed up as the other: the outcome the run earned — with the counters it really produced — is
 * recorded durably, and the settle failures are what the caller sees.
 *
 * A cleanup that failed in the same tick is kept BESIDE the settle failure rather than under it. The
 * two are independent: a settle that failed leaves the reservation and the outcome exactly as the
 * attempt left them, while a release that failed leaves the channel owned until its term expires. If
 * only the settle were reported, the lease nobody gave back would be invisible — and it is precisely
 * the fact that makes every later tick read "busy". Both are carried on the thrown error and stated in
 * the ops event; the outcome itself is never rewritten.
 *
 * The day is deliberately NOT rewritten to 'failed'. Doing that would re-run a collection that already
 * stored its papers six hours later (and lose the `insertedPaperCount` the operator report reads), and
 * for an attempt that never ran it would keep the attempt spent, leave `last_attempt_at` a phantom
 * admission and clear the reservation that was the only identity able to refund it.
 */
async function reportUnsettledAttempt(input: {
  day: string; attempt: number; retry: boolean; admittedAt: string; reservation: string | undefined;
  outcome: CollectionDayOutcome; result: CollectorResult; settleError: unknown;
  cleanupFailure?: unknown; jobRunId?: number;
}): Promise<unknown> {
  let insertedPaperCount: number | undefined;
  if (input.result !== undefined && input.result.status !== 'skipped') {
    insertedPaperCount = input.result.insertedPaperCount;
  }
  const cleanupFailure = input.cleanupFailure === undefined
    ? undefined
    : describeReleaseFailure(input.cleanupFailure);
  const reported = cleanupFailure === undefined
    ? input.settleError
    : new AggregateError([input.settleError, input.cleanupFailure],
      `${String(input.settleError)} (and ${cleanupFailure})`);
  let record: OpsErrorRecordResult;
  try {
    record = await recordScheduledFailure({
      day: input.day, attempt: input.attempt, retry: input.retry, admittedAt: input.admittedAt,
      reservation: input.reservation, nextDueAt: undefined, error: reported,
      jobRunId: input.jobRunId, outcome: input.outcome, insertedPaperCount, cleanupFailure,
    });
  } catch (recordError) {
    record = { recorded: false, error: recordError };
  }
  if (!record.recorded) {
    return new AggregateError(
      [reported, record.error],
      `${String(reported)} (the schedule facts could not be recorded in ops_error_events: ${String(record.error)})`,
    );
  }
  return reported;
}

/**
 * The scheduled entry: asks the durable due instant whether the channel may be tried, reserves the
 * attempt and takes the channel lease atomically when it may, then runs ordinary collection. A retry
 * reads the feed again even though the earlier attempt cached it (`rssCache: 'refresh'`), because the
 * first attempt found nothing new and the feed may have been republished since — that refresh is
 * bounded by the fact that a retry only exists while the budget lasts.
 *
 * Every exit writes the due instant the attempt really earned, so the next tick never has to guess: a
 * day that was closed or exhausted moves to the next UTC day's anchor, a day with budget left moves to
 * this attempt's real instant plus six hours, and a tick that was refused by a live hold or a busy
 * channel gives its attempt back and waits for the real blocker.
 *
 * `options.now`, when present, is the test-only clock seam: the WHOLE scheduled run — the admission,
 * the due floors and the collector — then shares one simulated timeline. Production leaves it unset and
 * the admission reads the database's own clock after its locks.
 */
export async function collectScheduledArxiv(
  options: ScheduledCollectionOptions = {},
): Promise<ScheduledCollectionResult> {
  if (process.env.COLLECT_ENABLED !== 'true' || process.env.ARXIV_NATIVE_COLLECT_ENABLED !== 'true') return undefined;
  const clock = options.now;
  // The deterministic parameters are refused BEFORE the attempt is reserved. A configuration fault is
  // not a collection attempt: the collector discovered it after the reservation had been committed and
  // before its own try/finally, so a rejection that issued no source request still left the channel
  // owned, spent the day's attempt and cost a six-hour retry.
  assertArxivCollectionOptions(options);
  const admission = await beginDueCollectionAttempt({ clock });
  const day = utcDayKey(new Date(admission.admittedAt));
  if (!admission.allowed) {
    return skip(day, admission.reason!, admission.attempt, admission.nextDueAt);
  }
  const admittedAt = new Date(admission.admittedAt);

  // Phase 1 — the run. A throw here is a SOURCE failure, and only a source failure: the settle below is
  // deliberately OUTSIDE this try, so a settle that fails can never masquerade as a run that failed.
  let result: CollectorResult;
  try {
    result = await collectAndStoreArxiv({
      ...options, rssCache: admission.retry ? 'refresh' : 'reuse', claimedState: admission.state,
    });
  } catch (error) {
    return await settleFailedRun({ day, admission, admittedAt, clock, error, jobRunId: options.jobRunId });
  }

  // Phase 2 — the outcome the run EARNED, fixed BEFORE anything is settled. It is what the retry below
  // carries, so a transient write failure can never turn a collected or untouched attempt into 'failed'.
  let outcome: CollectionDayOutcome;
  let holdUntil: string | undefined;
  if (result === undefined) {
    outcome = 'untouched';
  } else if (result.status === 'skipped') {
    // The durable HTTP429 hold (or an operator pause) blocked the run before it touched the network:
    // nothing was tried, so the attempt goes back.
    outcome = 'untouched';
    holdUntil = result.nextEligibleAt;
  } else {
    outcome = dayOutcomeOf(result);
  }
  const untouched = outcome === 'untouched';

  // Phase 3 — a tick that never entered the collector cannot have handed the channel back: the lease was
  // taken by the admission, not by the collector. It is handed back here, and a release that fails is
  // stated rather than swallowed.
  const releaseFailure = untouched ? await handBackAdoptedLease(admission.state) : undefined;

  // Phase 4 — settle with the SAME reservation and the SAME outcome.
  let nextDueAt: string;
  try {
    nextDueAt = await settleDueAttempt({ day, outcome, admittedAt, reservation: admission.reservation, holdUntil, clock });
  } catch (settleError) {
    // The run really happened (or really did not). Its outcome and its counters survive the failed
    // bookkeeping, and the day is NOT rewritten to 'failed'. A hand-back that failed in the same tick
    // is carried along rather than dropped: it is the only record that the channel is still owned, and
    // the settle failure would otherwise be the only thing an operator ever sees.
    throw await reportUnsettledAttempt({
      day, attempt: admission.attempt, retry: admission.retry, admittedAt: admission.admittedAt,
      reservation: admission.reservation, outcome, result, settleError,
      cleanupFailure: releaseFailure, jobRunId: options.jobRunId,
    });
  }

  if (result === undefined) {
    // Nothing ran and nothing was stored, so there is no run object to carry the cleanup failure: it is
    // raised, because a lease that was never handed back makes every tick until its term expires read
    // "busy" and an operator has to be able to see why.
    if (releaseFailure !== undefined) {
      throw new AggregateError([releaseFailure],
        `the arXiv tick was turned away before it ran, but ${describeReleaseFailure(releaseFailure)}`);
    }
    return undefined;
  }
  if (result.status === 'skipped') {
    // The durable HTTP429 hold (or an operator pause) blocked the run before it touched the network. The
    // reserved attempt is given back and the tick is reported as a schedule-level skip, so a consumer
    // cannot mistake a frozen channel for a collection that actually ran.
    return {
      ...skip(day, 'rate_limited', admission.attempt - 1, holdUntil ?? nextDueAt),
      ...(releaseFailure === undefined ? {} : { cleanupFailure: describeReleaseFailure(releaseFailure) }),
    };
  }
  // A round that handled its window with some versions left as recorded exceptions is a partial result;
  // whether that closes the day is decided by dayOutcome, so the whole window is not run again just
  // because one sub-batch stored nothing.
  return { ...result, day, attempt: admission.attempt, retry: admission.retry, nextDueAt };
}
