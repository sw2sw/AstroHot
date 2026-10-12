// The persisted attempt budget of the arXiv collection schedule.
//
// The official feed is published once a day, so the schedule runs a first attempt at 01:00 UTC and
// then retries six hours apart while nothing new has been collected. Two retries a day is the cap, and
// every attempt is counted in the database rather than in the process, so a restart neither loses nor
// repeats a retry. Once an attempt actually collected something new — or handled its window with some
// versions left as recorded exceptions — the day is closed and the remaining slots do nothing.
//
// The cron expression only offers the slots; it does not enforce them. A duplicate delivery, a
// concurrent process, a restart re-delivery and the queue's own retry all reach the same row, so the
// slot an attempt belongs to, the moment it was admitted and the outcome of the day are all stored
// here and checked before an attempt is admitted: the six hours hold even when the queue or the
// scheduler misbehaves, and a tick that ran hours late cannot shorten them either.
import { sql } from '../db.ts';
import { collectAndStoreArxiv } from './collect-job.ts';

export const ARXIV_COLLECT_ATTEMPT_HOURS_UTC = [1, 7, 13] as const;
export const ARXIV_COLLECT_ATTEMPTS_PER_DAY = ARXIV_COLLECT_ATTEMPT_HOURS_UTC.length;
// The spacing the slots promise, enforced durably rather than by the cron expression: an attempt is
// admitted for a scheduled slot, and the next one must be a whole interval later — measured on the
// instants the attempts were really admitted, not only on the slots they were nominally for.
export const ARXIV_COLLECT_MIN_INTERVAL_HOURS = 6;
const MIN_INTERVAL_MS = ARXIV_COLLECT_MIN_INTERVAL_HOURS * 60 * 60 * 1000;

export type CollectionDayOutcome = 'collected' | 'partial' | 'empty' | 'failed' | 'untouched';

export interface CollectionDayAdmission {
  allowed: boolean;
  // Attempts already recorded for this day before the current call.
  attempt: number;
  // The current attempt is a retry rather than the day's first try.
  retry: boolean;
  // The nominal instant of the scheduled slot this call belongs to.
  slot: string;
  reason?: 'completed' | 'budget' | 'interval';
  // Set when reason is 'interval': the earliest slot the next attempt may be admitted for.
  nextEligibleAt?: string;
}

export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The scheduled slot a call at `at` belongs to, as its nominal instant. The cron offers the configured
 * UTC hours, so a tick that is polled late, a duplicate delivery, a restart re-delivery and a pg-boss
 * internal retry all belong to the most recent configured hour instead of opening a new slot: asking
 * for one hour twice can never start two attempts. The slot is only the *intent* of the spacing
 * though — how much time really passed is judged on the admission instants, see
 * beginCollectionDayAttempt.
 */
export function collectionSlot(at: Date): Date {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  for (let index = ARXIV_COLLECT_ATTEMPT_HOURS_UTC.length - 1; index >= 0; index--) {
    const hour = ARXIV_COLLECT_ATTEMPT_HOURS_UTC[index]!;
    if (hour <= at.getUTCHours()) return new Date(day + hour * 60 * 60 * 1000);
  }
  // Before the day's first slot the most recent slot is yesterday's last one.
  const last = ARXIV_COLLECT_ATTEMPT_HOURS_UTC[ARXIV_COLLECT_ATTEMPT_HOURS_UTC.length - 1]!;
  return new Date(day - 86_400_000 + last * 60 * 60 * 1000);
}

/**
 * Reserves the next attempt of `day` for `slotAt`, or reports why no attempt may run. A day that
 * already collected something new or handled its window partially (`completed_at`) and a day whose
 * budget is spent both stay untouched. Two durable rules decide otherwise, and a refusal spends no
 * attempt and reaches no network:
 *
 *  - the slot must be a whole interval after the previous one, so a duplicate delivery, a concurrent
 *    process, a restart re-delivery or the queue's own retry cannot open a second attempt for a slot
 *    that was already spent — even hours later, when a pure time check would no longer catch it;
 *  - the previous attempt must really be a whole interval old, measured on `last_attempt_at`, the real
 *    instant it was admitted at. The bound is strict: the interval may be longer, never shorter, and
 *    nothing is subtracted from the real instant — not even the sub-second lateness an ordinary tick
 *    always adds between the hour and the moment the attempt is recorded. The nominal slot only
 *    decides which attempt a tick belongs to; it never decides how much time has passed. So an attempt
 *    admitted at 01:01 refuses 07:00 and leaves 07:01 as the earliest possible admission, and an
 *    attempt admitted at 08:05 for the 07:00 slot refuses 13:00 and opens at 14:05 — a run that is
 *    genuinely late owns its real instant and starts its six hours when it really ran. The instant is
 *    stored from the caller's clock, the same clock the next call is measured with; the durable
 *    request throttle reads the caller's clock for the same reason, so no two clock domains are ever
 *    compared.
 *
 * The previous attempt may live in the previous UTC day, so that day's row is consulted too: a slot
 * that ran very late records its real instant in its own day's row and the next day's first slot must
 * still see it. Both rows are locked, so two processes cannot take the same slot or the last attempt.
 */
export async function beginCollectionDayAttempt(
  day: string,
  slotAt: Date,
  attemptedAt: Date = slotAt,
): Promise<CollectionDayAdmission> {
  const slot = slotAt.toISOString();
  return sql.begin(async (tx) => {
    await tx`INSERT INTO arxiv_collection_day(day) VALUES(${day}::date) ON CONFLICT(day) DO NOTHING`;
    const row = (await tx<{ attempts: number; completed_at: Date | null; last_slot_at: Date | null }[]>`
      SELECT attempts, completed_at, last_slot_at FROM arxiv_collection_day WHERE day=${day}::date FOR UPDATE`)[0]!;
    if (row.completed_at) return { allowed: false, attempt: row.attempts, retry: false, slot, reason: 'completed' as const };
    if (row.attempts >= ARXIV_COLLECT_ATTEMPTS_PER_DAY) {
      return { allowed: false, attempt: row.attempts, retry: false, slot, reason: 'budget' as const };
    }
    if (row.last_slot_at) {
      const previousSlot = new Date(row.last_slot_at);
      if (slotAt.getTime() - previousSlot.getTime() < MIN_INTERVAL_MS) {
        return {
          allowed: false, attempt: row.attempts, retry: false, slot, reason: 'interval' as const,
          nextEligibleAt: new Date(previousSlot.getTime() + MIN_INTERVAL_MS).toISOString(),
        };
      }
    }
    const recent = (await tx<{ last_attempt_at: Date; last_slot_at: Date | null }[]>`
      SELECT last_attempt_at, last_slot_at FROM arxiv_collection_day
      WHERE day BETWEEN ${day}::date - 1 AND ${day}::date AND last_attempt_at IS NOT NULL
      ORDER BY last_attempt_at DESC LIMIT 1 FOR UPDATE`)[0];
    if (recent) {
      const admittedAt = new Date(recent.last_attempt_at);
      // Strict lower bound on the REAL admission instant. No tolerance is subtracted from it: rounding a
      // punctual run back to its slot, or subtracting a fixed grace window from a late one, hands back
      // exactly that much of the interval the rule exists to enforce, and the interval may only ever be
      // longer than six hours, never shorter.
      if (attemptedAt.getTime() - admittedAt.getTime() < MIN_INTERVAL_MS) {
        return {
          allowed: false, attempt: row.attempts, retry: false, slot, reason: 'interval' as const,
          nextEligibleAt: new Date(admittedAt.getTime() + MIN_INTERVAL_MS).toISOString(),
        };
      }
    }
    const next = (await tx<{ attempts: number }[]>`
      UPDATE arxiv_collection_day SET attempts=attempts+1, last_attempt_at=${attemptedAt.toISOString()}::timestamptz,
        last_slot_at=${slot}::timestamptz
      WHERE day=${day}::date RETURNING attempts`)[0]!.attempts;
    return { allowed: true, attempt: next, retry: next > 1, slot };
  });
}

/**
 * Records how an attempt ended. `collected` (stored something new) and `partial` (handled the window,
 * some versions stayed recorded as open exceptions) close the day so the remaining slots stop asking;
 * `empty` and `failed` leave it open for the next retry; `untouched` gives the reserved attempt back
 * because nothing was actually tried (the durable 429 hold or another owner was in the way).
 */
export async function finishCollectionDayAttempt(day: string, outcome: CollectionDayOutcome): Promise<void> {
  if (outcome === 'untouched') {
    await sql`UPDATE arxiv_collection_day SET attempts=GREATEST(attempts-1,0) WHERE day=${day}::date`;
    return;
  }
  await sql`UPDATE arxiv_collection_day SET last_outcome=${outcome},
    completed_at=CASE WHEN ${outcome} IN ('collected','partial') THEN clock_timestamp() ELSE completed_at END
    WHERE day=${day}::date`;
}

export type ScheduledCollectionOptions = Parameters<typeof collectAndStoreArxiv>[0];

export interface ScheduledCollectionSkip {
  status: 'skipped';
  complete: false;
  // 'completed'/'budget' are the daily budget turning a slot away, 'interval' is the durable slot
  // spacing (a duplicate delivery, a concurrent process, a restart or the queue's own retry), and
  // 'rate_limited' is the durable HTTP429 hold freezing the channel before the slot could run.
  reason: 'completed' | 'budget' | 'interval' | 'rate_limited';
  day: string;
  attempts: number;
  // Set for 'rate_limited' (when the durable hold expires) and 'interval' (the next eligible slot).
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
}

export type ScheduledCollectionResult = NonNullable<Awaited<ReturnType<typeof collectAndStoreArxiv>>> | ScheduledCollectionSkip | undefined;

/** Narrows a scheduled result to the slot that was skipped and therefore ran no collection. */
export function isScheduledSkip(value: ScheduledCollectionResult): value is ScheduledCollectionSkip {
  return value !== undefined && 'reason' in value && 'day' in value;
}

/**
 * How the day is closed. A partial round that really stored something — a version it asked for, or an
 * ordinary paper from the independent API window — did the day's work: the rest stayed recorded as
 * open exceptions and the remaining slots stop asking. The two counts are deliberately separate from
 * the announcement evidence, which only says the feed was read: a freshly stored feed with entries
 * proves the RSS channel worked, not that the day's window was handled. A partial round that stored no
 * new paper anywhere is left open for the retry budget instead, because that looks systemic, and the
 * daily budget exists for exactly that. The result stays visible either way: the caller still sees
 * partial, hydrationFailure and the open exception rows.
 */
function dayOutcome(result: {
  partial: boolean; hydrationIngested: number; windowIngested: number; newContentCount: number;
}): CollectionDayOutcome {
  if (result.partial) return result.hydrationIngested > 0 || result.windowIngested > 0 ? 'partial' : 'failed';
  return result.newContentCount > 0 ? 'collected' : 'empty';
}

/**
 * The scheduled entry: applies the daily budget first, then runs ordinary collection. A retry reads
 * the feed again even though the earlier attempt cached it (`rssCache: 'refresh'`), because the first
 * attempt found nothing new and the feed may have been republished since — that refresh is bounded by
 * the fact that a retry only exists while the budget lasts.
 */
export async function collectScheduledArxiv(
  options: ScheduledCollectionOptions = {},
): Promise<ScheduledCollectionResult> {
  if (process.env.COLLECT_ENABLED !== 'true' || process.env.ARXIV_NATIVE_COLLECT_ENABLED !== 'true') return undefined;
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection clock');
  const day = utcDayKey(now);
  const admission = await beginCollectionDayAttempt(day, collectionSlot(now), now);
  if (!admission.allowed) {
    return {
      status: 'skipped', complete: false, reason: admission.reason!, day, attempts: admission.attempt,
      nextEligibleAt: admission.nextEligibleAt,
      paperCount: 0, rawBatchCount: 0, rssPaperCount: 0, windowTotal: 0, rssCacheHit: false, newContentCount: 0,
      windowIngested: 0, partial: false, hydrationFailure: undefined,
    };
  }
  try {
    const result = await collectAndStoreArxiv({ ...options, rssCache: admission.retry ? 'refresh' : 'reuse' });
    if (result === undefined) {
      await finishCollectionDayAttempt(day, 'untouched');
      return result;
    }
    if (result.status === 'skipped') {
      // The durable HTTP429 hold (or another owner) blocked the run before it touched the network.
      // The reserved attempt is given back and the slot is reported as a schedule-level skip, so a
      // consumer cannot mistake a frozen slot for a collection that actually ran.
      await finishCollectionDayAttempt(day, 'untouched');
      return {
        status: 'skipped', complete: false, reason: 'rate_limited', day, attempts: admission.attempt - 1,
        nextEligibleAt: 'nextEligibleAt' in result ? result.nextEligibleAt : undefined,
        paperCount: 0, rawBatchCount: 0, rssPaperCount: 0, windowTotal: 0, rssCacheHit: false, newContentCount: 0,
        windowIngested: 0, partial: false, hydrationFailure: undefined,
      };
    }
    // A round that handled its window with some versions left as recorded exceptions is a partial
    // result; whether that closes the day is decided by dayOutcome, so the whole window is not run
    // again just because one sub-batch stored nothing.
    await finishCollectionDayAttempt(day, dayOutcome(result));
    return result;
  } catch (error) {
    await finishCollectionDayAttempt(day, 'failed');
    throw error;
  }
}
