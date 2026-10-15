// The durable due schedule of the arXiv collection channel.
//
// The official feed is published once a day, but the six-hour retry has to be measured on the instants
// the attempts were REALLY admitted. A fixed 01/07/13 UTC slot list cannot express that: a first
// attempt admitted at 01:00:22 owns 07:00:22 as its earliest retry, so the 07:00 tick is early, the
// whole slot is dropped, and the day then waits until 13:00 — six hours of the day's budget thrown
// away, and an evening publication that a 15:00 retry would have caught is missed entirely.
//
// So the channel carries ONE persisted due instant (`arxiv_collection_schedule.next_due_at`) and the
// worker asks, once a minute, whether it has arrived. A tick that is not due only READS: it issues no
// source request and leaves no run row. The UTC-day attempt budget, the completed flag and the durable
// HTTP429 hold are unchanged and still live in arxiv_collection_day / arxiv_collection_state, so the
// two mechanisms cannot disagree: the due instant decides WHEN a tick may try, the day row decides HOW
// MANY tries the day has left, and the state row still decides whether the channel may touch the
// network at all.
//
// ONE clock, and it is the database's. The admission and the finish read `clock_timestamp()` INSIDE
// their transaction and AFTER every lock they need is held — the schedule row, the day row AND, for the
// admission, the channel state row — so the recorded admission instant is the moment the budget was
// really consumed, not the instant a worker's wall clock showed before it waited on a lock, and not a
// value another worker's skewed clock could disagree with. The admission reads it one FINAL time after
// the channel lease is taken, and re-derives the UTC day from it, because the lease claim can wait
// behind another transaction that holds the state row: an instant sampled before that wait would
// charge the attempt to a day that has already ended, stamp a `last_attempt_at` earlier than the run
// really started and shorten the successor's six hours. The durable hold is compared against that SAME
// instant, so budget and lease share one time semantics. Tests inject a clock through `DueClockOptions`;
// production never passes one.
//
// The admission and the channel lease are claimed in the SAME transaction. A channel that is really
// busy — another worker, or the explicit hydration recovery entry — is therefore refused BEFORE an
// attempt is spent, and there is no window between the budget admission and the lease claim for a
// second process to slip in. The reservation is one-time: the schedule row carries its identity, and a
// late or duplicate finish can neither refund a successor's attempt nor roll its due instant back.
import { randomUUID } from 'node:crypto';
import { sql } from '../db.ts';
import type { Tx } from '../db.ts';
import { ARXIV_COLLECTION_KEY, claimCollectionWithin, type CollectionState } from './collection-state.ts';

export { ARXIV_COLLECTION_KEY };

/** The UTC hour the day's first attempt is anchored to. */
export const ARXIV_COLLECT_FIRST_HOUR_UTC = 1;
/** The day's real admission cap: the first attempt plus at most two retries. */
export const ARXIV_COLLECT_ATTEMPTS_PER_DAY = 3;
/** The spacing between two real admissions of one day. Strictly a lower bound. */
export const ARXIV_COLLECT_MIN_INTERVAL_HOURS = 6;
export const ARXIV_COLLECT_MIN_INTERVAL_MS = ARXIV_COLLECT_MIN_INTERVAL_HOURS * 60 * 60 * 1000;

export type CollectionDayOutcome = 'collected' | 'partial' | 'empty' | 'failed' | 'untouched';

/**
 * The authoritative clock of the schedule. Production leaves `clock` UNSET, so the transaction reads the
 * database's own `clock_timestamp()` after its locks are held (see the file header). Tests inject a
 * deterministic clock so a simulated timeline is never mixed with the machine clock.
 */
export interface DueClockOptions { clock?: () => Date }

/** Reads the authoritative instant of the CURRENT transaction: the injected seam, or the database clock. */
async function readClock(tx: Tx, clock?: () => Date): Promise<Date> {
  if (clock) {
    const at = new Date(clock());
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid collection clock');
    return at;
  }
  const row = (await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`)[0]!;
  return new Date(row.at);
}

export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The day's first-attempt anchor: 01:00 UTC of the UTC day `at` falls in. */
export function utcDayAnchor(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), ARXIV_COLLECT_FIRST_HOUR_UTC));
}

/**
 * The next 01:00 UTC anchor strictly after `at`. Used to push a closed or exhausted day to the next
 * day's first attempt instead of letting it slide within the current day.
 */
export function nextUtcDayAnchor(at: Date): Date {
  const anchor = utcDayAnchor(at);
  return anchor.getTime() > at.getTime() ? anchor : new Date(anchor.getTime() + 86_400_000);
}

/** The latest of the given instants; `null`/`undefined` entries are ignored. */
function laterOf(...instants: (Date | null | undefined)[]): Date {
  let latest = Number.NEGATIVE_INFINITY;
  for (const at of instants) if (at !== null && at !== undefined && at.getTime() > latest) latest = at.getTime();
  if (latest === Number.NEGATIVE_INFINITY) throw new Error('laterOf needs at least one instant');
  return new Date(latest);
}

/**
 * The floor the most recent REAL admission owns: the whole six hours after it, measured on the instant
 * the attempt was really admitted. `null` when the channel has never really been collected.
 */
function admissionFloor(recentAdmissionAt: Date | null): Date | null {
  return recentAdmissionAt === null ? null : new Date(recentAdmissionAt.getTime() + ARXIV_COLLECT_MIN_INTERVAL_MS);
}

/** The rows the decision needs. Read under the admission transaction's lock, or read-only by a tick. */
interface DueInputs {
  now: Date;
  nextDueAt: Date | null;
  attempts: number;
  completedAt: Date | null;
  /**
   * The most recent REAL admission at or before `now`, taken from TODAY'S and YESTERDAY'S day rows. A
   * day boundary must not hide the six-hour floor: a real admission at 23:30 yesterday owns 05:30 today
   * even when today's day row is brand new (the upgrade path, and the day after a very late run).
   */
  recentAdmissionAt: Date | null;
  /** TODAY'S day row's own last real admission, so a reservation that never ran can restore it. */
  todayAttemptAt: Date | null;
  holdUntil: Date | null;
  /** A live owner that is NOT the durable hold: another process (or the recovery entry) really works. */
  busy: boolean;
}

export type DueReason = 'completed' | 'budget' | 'rate_limited' | 'busy' | 'not_due';
export type DueVerdict =
  | { due: true; nextDueAt: Date }
  | { due: false; reason: DueReason; nextDueAt: Date };

/**
 * The single rule, shared by the read-only tick and by the admission so the two can never drift. It
 * decides only whether the channel may be tried NOW and which instant the schedule should carry
 * afterwards; the attempt itself is consumed by the admission, not here.
 */
export function resolveDue(inputs: DueInputs): DueVerdict {
  const { now } = inputs;
  const anchor = utcDayAnchor(now);
  const floor = admissionFloor(inputs.recentAdmissionAt);
  // A day that collected something new or handled its window (completed_at), and a day whose budget is
  // spent, both stop asking. The due instant moves to the next UTC day's anchor — never earlier than the
  // most recent real admission's six hours, and never earlier than a live hold.
  if (inputs.completedAt !== null || inputs.attempts >= ARXIV_COLLECT_ATTEMPTS_PER_DAY) {
    return {
      due: false,
      reason: inputs.completedAt !== null ? 'completed' : 'budget',
      nextDueAt: laterOf(nextUtcDayAnchor(now), floor, inputs.holdUntil),
    };
  }
  // A live ownerless hold is the durable 429 admission hold, or an operator's manual pause. It is not
  // an attempt: nothing is spent and no request is made. The six-hour floor of the last REAL admission
  // still bounds it, so a pause that lifts early cannot let the channel run before its own spacing.
  if (inputs.holdUntil !== null && inputs.holdUntil.getTime() > now.getTime()) {
    return { due: false, reason: 'rate_limited', nextDueAt: laterOf(inputs.holdUntil, floor) };
  }
  const due = laterOf(
    inputs.nextDueAt ?? anchor,
    // The most recent real admission's six hours, so a too-early persisted due instant (an upgrade, or a
    // rollback that left a stale value behind) can never let the channel run early.
    floor,
    // Midnight to 01:00 UTC never starts the next day early: the day's first attempt is anchored.
    anchor,
  );
  // Not due yet: the tick is refused on the clock alone, whatever the channel happens to be doing. A
  // restart seconds after an admitted attempt must read "not due", not "busy".
  if (now.getTime() < due.getTime()) return { due: false, reason: 'not_due', nextDueAt: due };
  // Due, but another process really holds the channel: nothing may be spent on a run that cannot start.
  if (inputs.busy) return { due: false, reason: 'busy', nextDueAt: due };
  return { due: true, nextDueAt: due };
}

/** Moves the schedule row's due instant forward, never backward. */
async function advanceDue(tx: Tx, nextDueAt: Date, at: Date): Promise<void> {
  await tx`UPDATE arxiv_collection_schedule
    SET next_due_at=GREATEST(COALESCE(next_due_at,${nextDueAt.toISOString()}::timestamptz),${nextDueAt.toISOString()}::timestamptz),
      updated_at=${at.toISOString()}::timestamptz
    WHERE key=${ARXIV_COLLECTION_KEY}`;
}

/**
 * Sets the schedule row's due instant outright. Only the "nothing was really tried" path uses this: the
 * reservation it settles is fenced (see finishDueCollectionAttempt), so it can only ever move the due
 * instant of ITS OWN reservation, never a successor's.
 */
async function setDue(tx: Tx, nextDueAt: Date, at: Date): Promise<void> {
  await tx`UPDATE arxiv_collection_schedule SET next_due_at=${nextDueAt.toISOString()}::timestamptz,
    updated_at=${at.toISOString()}::timestamptz WHERE key=${ARXIV_COLLECTION_KEY}`;
}

/** Closes the open reservation, so a duplicate or late finish finds nothing to settle. */
async function clearReservation(tx: Tx, at: Date): Promise<void> {
  await tx`UPDATE arxiv_collection_schedule SET reservation=NULL, reservation_floor=NULL,
    reservation_prior_attempt_at=NULL, updated_at=${at.toISOString()}::timestamptz
    WHERE key=${ARXIV_COLLECTION_KEY}`;
}

interface ScheduleRow {
  next_due_at: Date | null;
  reservation: string | null;
  reservation_floor: Date | null;
  reservation_prior_attempt_at: Date | null;
}

/**
 * Reads the rows the decision needs at the authoritative instant `at`. Pure SELECTs: the caller owns
 * every write (the admission transaction, or nothing at all for a read-only tick).
 */
async function readDueInputs(tx: Tx, at: Date, day: string, yesterday: string): Promise<DueInputs> {
  const dayRow = (await tx<{ attempts: number; completed_at: Date | null; last_attempt_at: Date | null }[]>`
    SELECT attempts, completed_at, last_attempt_at FROM arxiv_collection_day WHERE day=${day}::date`)[0];
  // The previous UTC day is read WITHOUT a lock: it is historical, no longer written, and it is exactly
  // what carries a very late admission's six-hour floor across the day boundary.
  const previousRow = (await tx<{ last_attempt_at: Date | null }[]>`
    SELECT last_attempt_at FROM arxiv_collection_day WHERE day=${yesterday}::date`)[0];
  const scheduleRow = (await tx<ScheduleRow[]>`
    SELECT next_due_at, reservation, reservation_floor, reservation_prior_attempt_at
    FROM arxiv_collection_schedule WHERE key=${ARXIV_COLLECTION_KEY}`)[0];
  // The durable hold and the live term are recognised with the AUTHORITATIVE instant, so budget and
  // lease cannot disagree about the time.
  const state = (await tx<{ owner: string | null; lease_until: Date | null; active: boolean | null }[]>`
    SELECT owner, lease_until, lease_until > ${at.toISOString()}::timestamptz AS active
    FROM arxiv_collection_state WHERE key=${ARXIV_COLLECTION_KEY}`)[0];
  const admissions = [dayRow?.last_attempt_at, previousRow?.last_attempt_at]
    .filter((value): value is Date => value !== null && value !== undefined)
    .map((value) => new Date(value));
  return {
    now: at,
    nextDueAt: scheduleRow?.next_due_at ? new Date(scheduleRow.next_due_at) : null,
    attempts: dayRow?.attempts ?? 0,
    completedAt: dayRow?.completed_at ? new Date(dayRow.completed_at) : null,
    recentAdmissionAt: admissions.length === 0 ? null : laterOf(...admissions),
    todayAttemptAt: dayRow?.last_attempt_at ? new Date(dayRow.last_attempt_at) : null,
    holdUntil: state?.active && state.owner === null && state.lease_until ? new Date(state.lease_until) : null,
    busy: state?.active === true && state.owner !== null,
  };
}

/**
 * Read-only: may the channel be tried now? This is the per-minute tick's gate. It never writes, never
 * takes a lock and never reaches the source; its only job is to keep idle minutes out of `job_runs`,
 * where a per-minute "ok" row would read like a successful collection. The admission below remains the
 * authority — this asks the SAME rule of the same rows, at the same (database) clock.
 */
export async function collectionIsDue(options: DueClockOptions = {}): Promise<boolean> {
  return sql.begin(async (tx) => {
    const at = await readClock(tx, options.clock);
    const inputs = await readDueInputs(tx, at, utcDayKey(at), utcDayKey(new Date(at.getTime() - 86_400_000)));
    return resolveDue(inputs).due;
  });
}

export interface CollectionDueAdmission {
  allowed: boolean;
  reason?: DueReason;
  /** Attempts recorded for this UTC day AFTER this call — the reserved one included when allowed. */
  attempt: number;
  retry: boolean;
  /** The authoritative instant this call was really admitted at (the database clock in production). */
  admittedAt: string;
  /** The authoritative instant the channel may next be collected at, after this call. */
  nextDueAt: string;
  /** The channel lease this admission took. Only present when `allowed`; the run MUST use it. */
  state?: CollectionState;
  /** The one-time identity of the reservation, to be handed back to finishDueCollectionAttempt. */
  reservation?: string;
}

/**
 * The authoritative instant fell in a DIFFERENT UTC day than the one this transaction charged, so the
 * whole admission has to be re-decided against the day it really reached.
 *
 * It is THROWN, never returned: a `return` from the transaction callback COMMITS — and by then the
 * transaction may already hold the channel lease, so returning would leave the channel owned by an
 * attempt that was never admitted and never spent. Throwing is what makes the rollback real.
 */
class MidnightRollError extends Error {
  constructor() {
    super('the arXiv collection admission crossed a UTC midnight');
    this.name = 'MidnightRollError';
  }
}

/**
 * Reserves the next attempt of the UTC day, atomically, and only when the schedule is really due.
 *
 * The schedule row, the day row and the channel lease are all decided in ONE transaction, so a duplicate
 * delivery, a restart re-delivery, a pg-boss retry, a second worker and the explicit recovery entry all
 * meet the same rows: exactly one of them is admitted, and the others read the due instant the winner
 * just moved forward. A refusal — not due, completed, budget spent, frozen by the durable hold, or the
 * channel really busy — spends NO attempt, makes NO source request, and only moves the due instant.
 *
 * An admitted call consumes its attempt and moves the due instant to the provisional `admittedAt +
 * interval` BEFORE the run starts. That is what makes a crash after admission conservative: the consumed
 * attempt and the next floor both survive, so a restart cannot re-request the source, and the day's real
 * outcome (written by finishDueCollectionAttempt) can only ever push the floor further out.
 *
 * The instant the budget is charged to, and the instant the due floor is measured from, is read from the
 * database AFTER the locks are held — and one final time after the CHANNEL LEASE is taken, which is the
 * last lock this transaction needs. A lock wait — on the schedule row, on the day row, or on the state
 * row the lease claim blocks behind — therefore cannot make the recorded admission time a lie: the day
 * row that is finally charged is the one the final authoritative instant falls in, and a crossing
 * re-selects it (the transaction rolls back, the lease claim with it, and the whole admission retries).
 */
export async function beginDueCollectionAttempt(options: DueClockOptions = {}): Promise<CollectionDueAdmission> {
  for (let guard = 0; guard < 4; guard += 1) {
    try {
      return await sql.begin(async (tx) => {
        await tx`INSERT INTO arxiv_collection_schedule(key) VALUES(${ARXIV_COLLECTION_KEY}) ON CONFLICT(key) DO NOTHING`;
        // The schedule row is the admission mutex: every attempt of every worker serializes here, BEFORE
        // the authoritative instant is sampled.
        await tx`SELECT next_due_at FROM arxiv_collection_schedule WHERE key=${ARXIV_COLLECTION_KEY} FOR UPDATE`;
        // A provisional instant only picks which day row to lock. The authoritative instant is read AGAIN
        // once that row is held, so waiting on its lock cannot freeze the recorded admission time.
        const provisional = await readClock(tx, options.clock);
        const day = utcDayKey(provisional);
        await tx`INSERT INTO arxiv_collection_day(day) VALUES(${day}::date) ON CONFLICT(day) DO NOTHING`;
        await tx`SELECT attempts FROM arxiv_collection_day WHERE day=${day}::date FOR UPDATE`;
        const at = await readClock(tx, options.clock);
        // A midnight crossing while the day row's lock was waited on: the authoritative instant is no
        // longer in the day this transaction charged, so the day row is re-selected from scratch.
        if (utcDayKey(at) !== day) throw new MidnightRollError();
        const inputs = await readDueInputs(tx, at, day, utcDayKey(new Date(at.getTime() - 86_400_000)));
        const verdict = resolveDue(inputs);
        if (!verdict.due) {
          await advanceDue(tx, verdict.nextDueAt, at);
          return {
            allowed: false, reason: verdict.reason, attempt: inputs.attempts, retry: false,
            admittedAt: at.toISOString(), nextDueAt: verdict.nextDueAt.toISOString(),
          } satisfies CollectionDueAdmission;
        }
        // The channel lease is taken in the SAME transaction, so a busy channel is discovered BEFORE the
        // attempt is spent rather than after it.
        const claimed = await claimCollectionWithin(tx, { at, windowNow: at });
        if ('status' in claimed) {
          const nextDueAt = claimed.status === 'skipped' && claimed.nextEligibleAt
            ? laterOf(new Date(claimed.nextEligibleAt), verdict.nextDueAt)
            : verdict.nextDueAt;
          await advanceDue(tx, nextDueAt, at);
          return {
            allowed: false, reason: claimed.status === 'busy' ? 'busy' : 'rate_limited',
            attempt: inputs.attempts, retry: false,
            admittedAt: at.toISOString(), nextDueAt: nextDueAt.toISOString(),
          } satisfies CollectionDueAdmission;
        }
        // EVERY lock this admission needs is now held — the schedule row, the day row and the channel
        // state row — so the authoritative instant is read one last time. The lease claim above can block
        // behind another transaction that holds the state row (a release, a hold, a renewal), and the
        // instant sampled before that wait is NOT the instant this attempt was really admitted at:
        // charging the day, stamping `last_attempt_at` and measuring the six hours from it would record an
        // admission earlier than it happened, shorten the successor's floor, and — across midnight —
        // charge the attempt to a day that has already ended.
        const admittedAt = await readClock(tx, options.clock);
        // A midnight crossing during the state-row wait: the whole admission — the lease claim included —
        // is rolled back and re-decided against the day the attempt really belongs to.
        if (utcDayKey(admittedAt) !== day) throw new MidnightRollError();
        const attempt = inputs.attempts + 1;
        const reservation = randomUUID();
        await tx`UPDATE arxiv_collection_day SET attempts=${attempt}, last_attempt_at=${admittedAt.toISOString()}::timestamptz
          WHERE day=${day}::date`;
        const provisionalDue = new Date(admittedAt.getTime() + ARXIV_COLLECT_MIN_INTERVAL_MS);
        // The reservation, the floor that was in force BEFORE it, and the provisional floor are written
        // together, so a finish can tell whether it still owns the attempt it is settling. The floor
        // itself (`verdict.nextDueAt`) was resolved under the day row's lock, and the state-row wait
        // cannot move it: every input it is built from — the persisted due instant, the day rows' last
        // admissions and the day anchor — is either locked or historical, and the day did not roll.
        await tx`UPDATE arxiv_collection_schedule
          SET next_due_at=GREATEST(COALESCE(next_due_at,${provisionalDue.toISOString()}::timestamptz),${provisionalDue.toISOString()}::timestamptz),
            reservation=${reservation}, reservation_floor=${verdict.nextDueAt.toISOString()}::timestamptz,
            reservation_prior_attempt_at=${inputs.todayAttemptAt ? inputs.todayAttemptAt.toISOString() : null}::timestamptz,
            updated_at=${admittedAt.toISOString()}::timestamptz
          WHERE key=${ARXIV_COLLECTION_KEY}`;
        return {
          allowed: true, attempt, retry: attempt > 1, admittedAt: admittedAt.toISOString(),
          nextDueAt: provisionalDue.toISOString(), reservation, state: claimed,
        } satisfies CollectionDueAdmission;
      });
    } catch (error) {
      if (error instanceof MidnightRollError) continue;
      throw error;
    }
  }
  throw new Error('the arXiv collection admission could not settle on a UTC day');
}

/**
 * Records how an admitted attempt ended and moves the due instant to its real successor:
 *
 *  - `collected` / `partial` close the day: the next due instant is the next UTC day's anchor, never
 *    earlier than the admission plus the interval and never earlier than a live hold;
 *  - `empty` / `failed` keep the day open for its remaining budget: the next due instant is the REAL
 *    admission plus the whole interval — so a run that started late starts its six hours when it really
 *    ran — unless that was the day's last attempt, which moves to the next day's anchor;
 *  - `untouched` gives the reserved attempt back, because nothing was really tried; the due instant
 *    returns to the floor that was in force BEFORE the reservation (the day anchor and a live hold still
 *    bound it), so a short pause that has already lifted does not cost the day six hours.
 *
 * The call is FENCED by the reservation identity: a finish that no longer owns the open reservation —
 * a late finish from an execution whose successor has already begun, or a duplicate call — is a NO-OP.
 * It cannot refund a shared attempt or roll the due instant back to a floor that is no longer current.
 * The durable hold is re-read HERE, so the instant this call reports is the one the row really carries:
 * a 429 hold established after the attempt started cannot be left out of the answer. The authoritative
 * instant is read after the schedule AND day row locks are held, for the same reason the admission reads
 * it after its own: waiting on a lock must not let the settle stamp `completed_at` or measure a
 * successor's floor from an instant that predates the wait.
 */
export async function finishDueCollectionAttempt(
  day: string,
  outcome: CollectionDayOutcome,
  options: { admittedAt: Date; reservation?: string; holdUntil?: string | null } & DueClockOptions,
): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`INSERT INTO arxiv_collection_schedule(key) VALUES(${ARXIV_COLLECTION_KEY}) ON CONFLICT(key) DO NOTHING`;
    const row = (await tx<ScheduleRow[]>`
      SELECT next_due_at, reservation, reservation_floor, reservation_prior_attempt_at
      FROM arxiv_collection_schedule WHERE key=${ARXIV_COLLECTION_KEY} FOR UPDATE`)[0]!;
    // The day row's lock is taken BEFORE the authoritative instant as well, so the settle cannot stamp
    // `completed_at`/`updated_at` or measure a successor's floor from an instant it sampled before it
    // waited. Both rows are locked in the admission's own order (schedule, then day), so the two
    // transactions cannot deadlock against each other.
    const dayRow = (await tx<{ attempts: number }[]>`
      SELECT attempts FROM arxiv_collection_day WHERE day=${day}::date FOR UPDATE`)[0];
    const at = await readClock(tx, options.clock);
    // The fence. `undefined` keeps the historical contract for a direct caller that has no reservation;
    // a caller that HAS one only ever settles its own, and only once.
    if (options.reservation !== undefined && row.reservation !== options.reservation) {
      return row.next_due_at ? new Date(row.next_due_at).toISOString() : utcDayAnchor(at).toISOString();
    }
    const hold = (await tx<{ lease_until: Date }[]>`
      SELECT lease_until FROM arxiv_collection_state
      WHERE key=${ARXIV_COLLECTION_KEY} AND owner IS NULL AND lease_until > ${at.toISOString()}::timestamptz`)[0];
    const holdUntil = hold ? new Date(hold.lease_until) : options.holdUntil ? new Date(options.holdUntil) : null;
    const intervalFloor = new Date(options.admittedAt.getTime() + ARXIV_COLLECT_MIN_INTERVAL_MS);
    if (outcome === 'untouched') {
      // Nothing was really tried, so the reserved attempt goes back, its PHANTOM admission instant is
      // removed with it, and the budget is untouched. The floor the admission wrote for this attempt is
      // replaced by the floor that was in force BEFORE it: waiting six more hours on top of a pause that
      // lifted earlier would silently cost the day a retry.
      const floor = row.reservation_floor ?? utcDayAnchor(at);
      const next = laterOf(floor, utcDayAnchor(at), holdUntil);
      const prior = row.reservation_prior_attempt_at;
      await tx`UPDATE arxiv_collection_day SET attempts=GREATEST(attempts-1,0),
        last_attempt_at=${prior ? new Date(prior).toISOString() : null}::timestamptz WHERE day=${day}::date`;
      await setDue(tx, next, at);
      if (options.reservation !== undefined) await clearReservation(tx, at);
      return next.toISOString();
    }
    const closes = outcome === 'collected' || outcome === 'partial';
    const spent = dayRow!.attempts >= ARXIV_COLLECT_ATTEMPTS_PER_DAY;
    const next = closes || spent
      ? laterOf(nextUtcDayAnchor(at), intervalFloor, holdUntil)
      : laterOf(intervalFloor, holdUntil);
    await tx`UPDATE arxiv_collection_day SET last_outcome=${outcome},
      completed_at=CASE WHEN ${closes} THEN ${at.toISOString()}::timestamptz ELSE completed_at END
      WHERE day=${day}::date`;
    await advanceDue(tx, next, at);
    if (options.reservation !== undefined) await clearReservation(tx, at);
    return next.toISOString();
  });
}

/** The channel's persisted due instant, for read-only operator views. Never writes. */
export async function readCollectionDue(): Promise<{ nextDueAt: string | null; updatedAt: string | null }> {
  const rows = await sql<{ next_due_at: Date | null; updated_at: Date }[]>`
    SELECT next_due_at, updated_at FROM arxiv_collection_schedule WHERE key=${ARXIV_COLLECTION_KEY}`;
  const row = rows[0];
  return {
    nextDueAt: row?.next_due_at ? new Date(row.next_due_at).toISOString() : null,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}
