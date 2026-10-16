// The durable due schedule of the arXiv collection channel (collection-due.ts).
//
// These tests drive the two rows that decide everything — arxiv_collection_day (the UTC-day budget)
// and arxiv_collection_schedule (the one authoritative due instant) — plus the real entry
// collectScheduledArxiv, whose collector is fed a fake transport. No test reaches the network: every
// `fetch` here is a stub, and the tests that must prove "no request was made" pass a transport that
// throws if it is ever called.
import './setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import {
  ARXIV_COLLECT_ATTEMPTS_PER_DAY, ARXIV_COLLECT_MIN_INTERVAL_MS,
  beginDueCollectionAttempt, collectionIsDue, finishDueCollectionAttempt, nextUtcDayAnchor, utcDayAnchor, utcDayKey,
} from '../packages/backend/src/arxiv/collection-due.ts';
import { collectScheduledArxiv, isScheduledSkip } from '../packages/backend/src/arxiv/collection-budget.ts';

type Slot = Awaited<ReturnType<typeof collectScheduledArxiv>>;
type CollectRun = Exclude<NonNullable<Slot>, { reason: string }>;
const ran = (value: Slot): CollectRun => {
  assert.ok(value !== undefined && !isScheduledSkip(value), 'expected the tick to run collection');
  return value as CollectRun;
};
const skipped = (value: Slot) => {
  assert.ok(value !== undefined && isScheduledSkip(value), 'expected the tick to be skipped');
  return value;
};
const at = (stamp: string) => () => new Date(stamp);
/** The test-only clock seam: the admission, the due floors and the collector share one timeline. */
const clockAt = (stamp: string) => ({ clock: at(stamp) });
/**
 * Frees the channel. The admission takes the channel lease in the same transaction that spends the
 * attempt, so a test that drives `beginDueCollectionAttempt` straight and then drives it again has to
 * hand the lease back the way a real run's `finally` does.
 */
const releaseLease = () => sql`UPDATE arxiv_collection_state SET owner=NULL,lease_until=NULL WHERE key='astro-ph'`;
/** Drive the admission/gate at one explicit instant through the test clock seam. */
const begin = (when: Date) => beginDueCollectionAttempt({ clock: () => when });
const isDue = (when: Date) => collectionIsDue({ clock: () => when });
const forbidden: typeof fetch = async () => { throw new Error('no arXiv request is allowed here'); };
const atomFor = (papers: { id: string; title?: string }[], start = 0) => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${papers.length}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${papers.length}</opensearch:itemsPerPage>${papers.map(({ id, title }) => `<entry><id>https://arxiv.org/abs/${id}</id><title>${title ?? `Title ${id}`}</title><summary>Abstract ${id}</summary><published>2026-10-01T00:00:00Z</published><updated>2026-10-01T00:00:00Z</updated><author><name>Alice</name></author><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;
/**
 * A feed shaped like the official one: every item carries the title, the `Abstract:` section of the
 * description and the `dc:creator` list, because that is what the ordinary RSS-primary round stores a
 * normal paper FROM. A minimal item (guid/link/category/pubDate only) is still perfectly valid
 * announcement evidence, but it can never become a paper — see rss-paper.ts — so a fixture that wants
 * a stored paper has to look like the real feed.
 */
const rssFor = (ids: string[], announceType = 'new') => `<rss version="2.0" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>astro-ph</title>${ids.map(id => `<item><title>Title for ${id}</title><guid>oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/, '')}</link><description>arXiv:${id} Announce Type: ${announceType} \nAbstract: Science abstract for ${id}.</description><dc:creator>Alice Smith, Bob Jones</dc:creator><pubDate>Wed, 07 Oct 2026 00:00:00 -0400</pubDate><category>astro-ph.CO</category><arxiv:announce_type>${announceType}</arxiv:announce_type></item>`).join('')}</channel></rss>`;
const clean = () => sql`TRUNCATE arxiv_raw_papers,arxiv_raw_batches,arxiv_announcements,arxiv_announcement_batches,arxiv_collection_state,arxiv_hydration_exceptions,arxiv_hydration_rejections,arxiv_collection_day,arxiv_collection_schedule,arxiv_rss_cache,ops_error_events CASCADE`;
// A feed that answers the hydration request for exactly the IDs it was asked about, and an empty window.
const serving = (feed: () => string, hits?: string[]): typeof fetch => async input => {
  const u = new URL(String(input));
  hits?.push(u.href);
  if (u.hostname === 'rss.arxiv.org') return new Response(feed());
  const ids = (u.searchParams.get('id_list') ?? '').split(',').filter(Boolean);
  if (ids.length) return new Response(atomFor(ids.map(id => ({ id }))));
  return new Response(atomFor([]));
};
const day = async (key: string) => (await sql<{ attempts: number; last_outcome: string | null; completed_at: Date | null; last_attempt_at: Date | null }[]>`
  SELECT attempts,last_outcome,completed_at,last_attempt_at FROM arxiv_collection_day WHERE day=${key}::date`)[0]!;
/** The same row, for the days a test expects to have been left alone entirely. */
const dayOrNull = async (key: string) => (await sql<{ attempts: number; last_outcome: string | null; completed_at: Date | null }[]>`
  SELECT attempts,last_outcome,completed_at FROM arxiv_collection_day WHERE day=${key}::date`)[0];
const ownerOf = async () => (await sql<{ owner: string | null }[]>`
  SELECT owner FROM arxiv_collection_state WHERE key='astro-ph'`)[0]?.owner ?? null;
const schedule = async () => (await sql<{ next_due_at: Date | null; updated_at: Date }[]>`
  SELECT next_due_at,updated_at FROM arxiv_collection_schedule WHERE key='astro-ph'`)[0];
const dueAt = async () => { const row = await schedule(); return row?.next_due_at ? new Date(row.next_due_at).toISOString() : null; };
const enable = () => Object.assign(process.env, { COLLECT_ENABLED: 'true', ARXIV_NATIVE_COLLECT_ENABLED: 'true' });
/**
 * Refuses exactly the release shape (owner cleared AND the term cleared with it), so a run that really
 * ran keeps working and only the hand-back fails. Used by the two cleanup tests below.
 */
const armReleaseRefusal = async () => {
  await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_release() RETURNS trigger AS $$
    BEGIN
      IF OLD.owner IS NOT NULL AND NEW.owner IS NULL AND NEW.lease_until IS NULL
        THEN RAISE EXCEPTION 'release refused by the harness'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_release ON arxiv_collection_state`;
  await sql`CREATE TRIGGER arxiv_test_block_release BEFORE UPDATE ON arxiv_collection_state
    FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_release()`;
};
const disarmReleaseRefusal = async () => {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_release ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_release()`;
};
/** Refuses EVERY write that clears the owner — the durable 429 hold as well as the release. */
const armOwnerClearingRefusal = async () => {
  await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_owner_clearing() RETURNS trigger AS $$
    BEGIN
      IF OLD.owner IS NOT NULL AND NEW.owner IS NULL
        THEN RAISE EXCEPTION 'owner-clearing write refused by the harness'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_owner_clearing ON arxiv_collection_state`;
  await sql`CREATE TRIGGER arxiv_test_block_owner_clearing BEFORE UPDATE ON arxiv_collection_state
    FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_owner_clearing()`;
};
const disarmOwnerClearingRefusal = async () => {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_owner_clearing ON arxiv_collection_state`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_owner_clearing()`;
};
/**
 * Refuses exactly ONE reservation-clearing write (the settle's last write), so the first settle of a
 * run fails and its retry succeeds. The counter is consumed ONLY on the clearing write, so the
 * admission's own schedule writes cannot eat it. Sequences are not transactional, so the consumption
 * survives the rolled-back transaction — which is what makes the failure transient.
 */
const armSettleFaultOnce = async () => {
  await sql`CREATE SEQUENCE IF NOT EXISTS arxiv_test_settle_fault_seq`;
  await sql`ALTER SEQUENCE arxiv_test_settle_fault_seq RESTART WITH 1`;
  await sql`CREATE OR REPLACE FUNCTION arxiv_test_settle_fault() RETURNS trigger AS $$
    BEGIN
      IF OLD.reservation IS NOT NULL AND NEW.reservation IS NULL THEN
        IF nextval('arxiv_test_settle_fault_seq') <= 1
          THEN RAISE EXCEPTION 'schedule settle refused by the harness'; END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_settle_fault ON arxiv_collection_schedule`;
  await sql`CREATE TRIGGER arxiv_test_settle_fault BEFORE UPDATE ON arxiv_collection_schedule
    FOR EACH ROW EXECUTE FUNCTION arxiv_test_settle_fault()`;
};
const disarmSettleFault = async () => {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_settle_fault ON arxiv_collection_schedule`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_settle_fault()`;
  await sql`DROP SEQUENCE IF EXISTS arxiv_test_settle_fault_seq`;
};
/**
 * Refuses EVERY reservation-clearing write, so BOTH settles of one attempt fail. The admission's own
 * write SETS the reservation (NULL -> value) and is never touched, which is what makes this the
 * "cleanup and settlement go wrong together" case rather than a broken admission.
 */
const armSettleRefusal = async () => {
  await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_settle() RETURNS trigger AS $$
    BEGIN
      IF OLD.reservation IS NOT NULL AND NEW.reservation IS NULL
        THEN RAISE EXCEPTION 'schedule settle refused by the harness'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_settle ON arxiv_collection_schedule`;
  await sql`CREATE TRIGGER arxiv_test_block_settle BEFORE UPDATE ON arxiv_collection_schedule
    FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_settle()`;
};
const disarmSettleRefusal = async () => {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_settle ON arxiv_collection_schedule`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_settle()`;
};
/** Makes EVERY write to the schedule row fail, so a settle cannot be confirmed at all. */
const armScheduleRefusal = async () => {
  await sql`CREATE OR REPLACE FUNCTION arxiv_test_block_schedule() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'schedule unavailable'; END $$ LANGUAGE plpgsql`;
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_schedule ON arxiv_collection_schedule`;
  await sql`CREATE TRIGGER arxiv_test_block_schedule BEFORE INSERT OR UPDATE ON arxiv_collection_schedule
    FOR EACH ROW EXECUTE FUNCTION arxiv_test_block_schedule()`;
};
const disarmScheduleRefusal = async () => {
  await sql`DROP TRIGGER IF EXISTS arxiv_test_block_schedule ON arxiv_collection_schedule`;
  await sql`DROP FUNCTION IF EXISTS arxiv_test_block_schedule()`;
};
/**
 * Holds one row of `table` from an INDEPENDENT connection until the returned release is called, so a
 * test can make the code under test really wait on a row lock. The row must already exist (and be
 * committed) before this is called.
 */
const holdRow = async (table: 'arxiv_collection_state' | 'arxiv_collection_schedule') => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let locked!: () => void;
  const lockedAt = new Promise<void>(resolve => { locked = resolve; });
  const blocker = sql.begin(async tx => {
    if (table === 'arxiv_collection_state') {
      await tx`SELECT owner FROM arxiv_collection_state WHERE key='astro-ph' FOR UPDATE`;
    } else {
      await tx`SELECT next_due_at FROM arxiv_collection_schedule WHERE key='astro-ph' FOR UPDATE`;
    }
    locked();
    await gate;
  });
  await lockedAt;
  return { release, blocker };
};

test('the day is anchored at 05:30 UTC: midnight never starts it early and the anchor itself does', async () => {
  await clean();
  // 05:29:59.999 is one millisecond before the anchor: nothing may run, not even the initialization.
  const early = await begin(new Date('2026-10-07T05:29:59.999Z'));
  assert.equal(early.allowed, false);
  assert.equal(early.reason, 'not_due');
  assert.equal(early.nextDueAt, '2026-10-07T05:30:00.000Z', 'the day opens exactly at its UTC anchor');
  assert.equal((await day('2026-10-07')).attempts, 0, 'a tick before the anchor spends no attempt');
  // Exactly at the anchor it is admitted, with no tolerance in either direction.
  const open = await begin(new Date('2026-10-07T05:30:00.000Z'));
  assert.equal(open.allowed, true);
  assert.equal(open.attempt, 1);
  assert.equal(open.retry, false);
});

test('the first attempt admitted at 05:30:22 owns 11:30:22 as its retry, so the 11:30 slot is never dropped', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  // The real defect: the cron's 11:30 tick lands 22 seconds BEFORE the six hours are up, the whole
  // slot used to be discarded, and the day then waited until 17:30. Now the due instant is the real
  // admission plus the interval, and the per-minute tick fires as soon as it really arrives.
  const first = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T05:30:22.909Z') }));
  assert.equal(first.newContentCount, 0);
  assert.equal(first.attempt, 1);
  assert.equal(await dueAt(), '2026-10-07T11:30:22.909Z');
  const issued = hits.length;
  // The nominal 11:30 slot is early: refused, and it costs neither a request nor an attempt.
  const nominal = skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T11:30:00.000Z') }));
  assert.equal(nominal.reason, 'not_due');
  assert.equal(nominal.nextEligibleAt, '2026-10-07T11:30:22.909Z');
  assert.equal(hits.length, issued, 'a tick before the due instant touches no network');
  assert.equal((await day('2026-10-07')).attempts, 1);
  // One millisecond before the due instant: still refused.
  assert.equal(skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T11:30:22.908Z') })).reason, 'not_due');
  assert.equal(hits.length, issued);
  // Exactly at the due instant the retry runs.
  const retry = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T11:30:22.909Z') }));
  assert.equal(retry.attempt, 2);
  assert.equal(retry.retry, true);
  assert.ok(hits.length > issued, 'the due retry really asked the source');
  assert.equal(await dueAt(), '2026-10-07T17:30:22.909Z', 'the second retry is six real hours after the first');
});

test('a delayed morning run opens its own six hours later instead of waiting for a fixed evening slot', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  // The first attempt of the day runs late, at 09:00:22 — the acceptance case: the next attempt must
  // be 15:00:22, not the retired 21:00 slot, and the 15:00:22 tick really runs.
  const late = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T09:00:22Z') }));
  assert.equal(late.newContentCount, 0);
  assert.equal(await dueAt(), '2026-10-07T15:00:22.000Z');
  const issued = hits.length;
  assert.equal(skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T15:00:21Z') })).reason, 'not_due');
  assert.equal(hits.length, issued);
  const afternoon = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T15:00:22Z') }));
  assert.equal(afternoon.attempt, 2);
  assert.ok(hits.length > issued, 'the 15:00:22 tick really asked the source');
  // The day keeps one last attempt, six real hours after this one — not the retired 21:00 nominal slot
  // (which the old fixed list would have reached from a nominal 15:00 that never existed).
  assert.equal(await dueAt(), '2026-10-07T21:00:22.000Z');
  const evening = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T21:00:22Z') }));
  assert.equal(evening.attempt, ARXIV_COLLECT_ATTEMPTS_PER_DAY);
  // The exhausted day moves to the next UTC anchor, but the strict interval is never shortened to
  // reach it: the next allowed instant is the later of the two.
  assert.equal(await dueAt(), '2026-10-08T05:30:00.000Z');
  assert.equal((await day('2026-10-07')).attempts, ARXIV_COLLECT_ATTEMPTS_PER_DAY);
});

test('the UTC day admits at most three real attempts and a refused tick spends nothing', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  for (const stamp of ['2026-10-07T05:30:00Z', '2026-10-07T11:30:00Z', '2026-10-07T17:30:00Z']) {
    const run = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at(stamp) }));
    assert.equal(run.newContentCount, 0);
    assert.equal(run.day, '2026-10-07');
  }
  assert.equal((await day('2026-10-07')).attempts, ARXIV_COLLECT_ATTEMPTS_PER_DAY);
  assert.equal((await day('2026-10-07')).completed_at, null, 'an unproductive day stays open until its budget is gone');
  const issued = hits.length;
  const spent = skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T23:30:00Z') }));
  assert.equal(spent.reason, 'budget');
  assert.equal(spent.attempts, ARXIV_COLLECT_ATTEMPTS_PER_DAY);
  assert.equal(spent.nextEligibleAt, '2026-10-08T05:30:00.000Z', 'a spent day waits for the next UTC anchor');
  assert.equal(hits.length, issued, 'a spent budget issues no request');
  // The budget is a UTC-day budget: the next UTC day opens a fresh one.
  const nextDay = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-08T05:30:00Z') }));
  assert.equal(nextDay.attempt, 1);
  assert.equal((await day('2026-10-08')).attempts, 1);
});

test('a very late attempt never steals the next UTC day first attempt and never backfills the old day', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  // 23:30 on the 7th: the day's first attempt, run very late.
  const late = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T23:30:00Z') }));
  assert.equal(late.day, '2026-10-07');
  assert.equal(await dueAt(), '2026-10-08T05:30:00.000Z', 'six real hours after the late attempt');
  const issued = hits.length;
  // The next day's 05:29 tick is EARLIER than the six hours the late attempt owns, so it is
  // refused — the strict interval is not shortened for a new day.
  const anchor = skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-08T05:29:00Z') }));
  assert.equal(anchor.reason, 'not_due');
  assert.equal(anchor.nextEligibleAt, '2026-10-08T05:30:00.000Z');
  assert.equal(hits.length, issued);
  // And the late attempt is not repeated: the 8th opens its own budget at 05:30.
  const resumed = ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-08T05:30:00Z') }));
  assert.equal(resumed.day, '2026-10-08');
  assert.equal(resumed.attempt, 1);
  assert.equal((await day('2026-10-07')).attempts, 1, 'the old day keeps exactly the one attempt it really ran');
});

test('an upgrade derives the due instant from the day row: a collected day is not repeated, an owed retry is kept', async () => {
  await clean();
  // Nothing in arxiv_collection_schedule at all — the state of a deployment that just migrated.
  assert.equal(await schedule(), undefined);
  // A day that already collected something new: its batch must not be run again.
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at,last_outcome,completed_at)
    VALUES('2026-10-07'::date,1,'2026-10-07T05:30:10Z'::timestamptz,'collected','2026-10-07T05:30:20Z'::timestamptz)`;
  assert.equal(await isDue(new Date('2026-10-07T09:30:00Z')), false, 'a closed day is not due');
  const closed = await begin(new Date('2026-10-07T09:30:00Z'));
  assert.equal(closed.allowed, false);
  assert.equal(closed.reason, 'completed');
  assert.equal(closed.nextDueAt, '2026-10-08T05:30:00.000Z', 'a closed day waits for the next UTC anchor');
  // A day whose morning attempt found nothing: the retry it still owes must survive the upgrade.
  await clean();
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at,last_outcome)
    VALUES('2026-10-08'::date,1,'2026-10-08T05:30:22.909Z'::timestamptz,'empty')`;
  assert.equal(await isDue(new Date('2026-10-08T11:30:00Z')), false, 'the owed retry is not due yet');
  assert.equal(await isDue(new Date('2026-10-08T11:30:22.909Z')), true, 'and it is due exactly six hours after the real admission');
  const owed = await begin(new Date('2026-10-08T11:30:22.909Z'));
  assert.equal(owed.allowed, true);
  assert.equal(owed.attempt, 2, 'the upgrade keeps the day budget instead of resetting it');
  assert.equal((await day('2026-10-08')).attempts, 2);
});

test('a tick that is not due only reads: no source request, no schedule write and no run', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  ran(await collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  const before = await schedule();
  const issued = hits.length;
  // Ten idle minutes: each one is a read that decides nothing.
  for (const minute of ['05:31', '05:32', '05:33', '05:34', '05:35', '05:36', '05:37', '05:38', '05:39', '05:40']) {
    assert.equal(await isDue(new Date(`2026-10-07T${minute}:00Z`)), false);
  }
  const after = await schedule();
  assert.equal(new Date(after!.updated_at).getTime(), new Date(before!.updated_at).getTime(), 'an idle tick does not touch the schedule');
  assert.equal(await dueAt(), '2026-10-07T11:30:00.000Z');
  assert.equal(hits.length, issued, 'an idle tick never reaches the source');
  assert.equal((await day('2026-10-07')).attempts, 1);
});

test('an attempt admitted and then crashed keeps its consumed attempt and its next floor', async () => {
  await clean();
  // The admission is what a run does before it touches the network. A process that dies right after it
  // must not let a restart re-request the source: the attempt and the floor both survive.
  const admission = await begin(new Date('2026-10-07T05:30:00Z'));
  assert.equal(admission.allowed, true);
  assert.equal(admission.nextDueAt, '2026-10-07T11:30:00.000Z');
  assert.equal((await day('2026-10-07')).attempts, 1, 'the attempt is consumed before the run starts');
  assert.equal(await dueAt(), '2026-10-07T11:30:00.000Z');
  const restarted = await begin(new Date('2026-10-07T05:30:05Z'));
  assert.equal(restarted.allowed, false, 'a restart five seconds later cannot re-request the source');
  assert.equal(restarted.reason, 'not_due');
  assert.equal((await day('2026-10-07')).attempts, 1, 'and it does not spend a second attempt');
});

test('two concurrent deliveries of one due instant cannot both start a collection', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  const results = await Promise.all([
    collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }),
    collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }),
  ]);
  const running = results.filter((value): value is CollectRun => value !== undefined && !isScheduledSkip(value));
  const refused = results.filter(value => value !== undefined && isScheduledSkip(value));
  assert.equal(running.length, 1, 'exactly one delivery is admitted');
  assert.equal(refused.length, 1);
  assert.equal((await day('2026-10-07')).attempts, 1, 'the due instant is spent exactly once');
});

test('a durable hold freezes the channel without spending an attempt and is honoured by the due instant', async () => {
  await clean();
  enable();
  await sql`INSERT INTO arxiv_collection_state(key,owner,lease_until)
    VALUES('astro-ph',NULL,'2026-10-07T08:00:00Z'::timestamptz)`;
  const blocked = skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(blocked.reason, 'rate_limited', 'a frozen channel is reported as rate limited, not as a run');
  assert.equal((await day('2026-10-07')).attempts, 0, 'an attempt that never ran is given back');
  const held = await sql<{ lease_until: Date }[]>`SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`;
  const holdUntil = new Date(held[0]!.lease_until);
  assert.equal(await dueAt(), holdUntil.toISOString(), 'the due instant becomes the hold\'s own deadline');
  assert.equal(await isDue(new Date(holdUntil.getTime() - 60_000)), false, 'and every tick until then is a pure read');
  // A manual pause is not lifted by the schedule: only the hold's own deadline may end it, and then the
  // channel is free to be tried again.
  assert.equal(await isDue(new Date(holdUntil.getTime() + 1_000)), true, 'once the pause really lifts, the channel may be tried again');
});

test('a productive attempt closes the day, and the closed day is not due again', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const fake = serving(() => rssFor(['2610.07001v1']), hits);
  const first = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(first.status, 'imported');
  // The feed item is ONE piece of new content: the new announcement and the normal paper it yields
  // are the same fact, so they are not counted twice. What decides the day is the real insert count.
  assert.equal(first.newContentCount, 1, 'the new announcement is new content');
  assert.equal(first.insertedPaperCount, 1, 'and the version it announced was really stored from the feed');
  assert.equal(first.rssItemCount, 1, 'the feed really listed one item');
  assert.equal(hits.filter(href => href.startsWith('https://export.arxiv.org')).length, 0,
    'the ordinary round never touches the export API');
  assert.equal(first.day, '2026-10-07');
  assert.equal((await day('2026-10-07')).completed_at !== null, true);
  assert.equal(await dueAt(), '2026-10-08T05:30:00.000Z', 'a closed day waits for the next UTC anchor');
  assert.equal(await isDue(new Date('2026-10-07T12:00:00Z')), false);
  const issued = hits.length;
  const closed = skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T17:30:00Z') }));
  assert.equal(closed.reason, 'completed');
  assert.equal(hits.length, issued, 'a closed day issues no further request');
});

test('a failed attempt keeps the day open and its retry runs when the due instant arrives', async () => {
  await clean();
  enable();
  const down: typeof fetch = async () => { throw new Error('feed down'); };
  await assert.rejects(collectScheduledArxiv({ fetch: down, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  const state = await day('2026-10-07');
  assert.equal(state.attempts, 1);
  assert.equal(state.last_outcome, 'failed');
  assert.equal(state.completed_at, null, 'a failure never closes the day');
  assert.equal(await dueAt(), '2026-10-07T11:30:00.000Z');
  // A pg-boss retry, a re-delivery or a restart seconds later must not run the collection again.
  const tooSoon = skipped(await collectScheduledArxiv({ fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T05:30:06Z') }));
  assert.equal(tooSoon.reason, 'not_due');
  assert.equal((await day('2026-10-07')).attempts, 1, 'a refused re-delivery spends no attempt');
  const retry = ran(await collectScheduledArxiv({ fetch: serving(() => rssFor(['2610.09001v1'])), sleep: async () => {}, now: at('2026-10-07T11:30:00Z') }));
  assert.ok(retry.newContentCount > 0);
  assert.equal((await day('2026-10-07')).attempts, 2);
});

test('pure time helpers agree with the anchors the schedule writes', () => {
  assert.equal(utcDayKey(new Date('2026-10-07T23:59:59Z')), '2026-10-07');
  assert.equal(utcDayAnchor(new Date('2026-10-07T23:59:59Z')).toISOString(), '2026-10-07T05:30:00.000Z');
  assert.equal(nextUtcDayAnchor(new Date('2026-10-07T23:59:59Z')).toISOString(), '2026-10-08T05:30:00.000Z');
  assert.equal(nextUtcDayAnchor(new Date('2026-10-07T00:30:00Z')).toISOString(), '2026-10-07T05:30:00.000Z');
  assert.equal(nextUtcDayAnchor(new Date('2026-10-07T05:30:00Z')).toISOString(), '2026-10-08T05:30:00.000Z');
  assert.equal(ARXIV_COLLECT_MIN_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('finishDueCollectionAttempt is idempotent about the day it is given', async () => {
  await clean();
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at) VALUES('2026-10-07'::date,1,clock_timestamp())`;
  const next = await finishDueCollectionAttempt('2026-10-07', 'empty', {
    admittedAt: new Date('2026-10-07T05:30:00Z'), clock: at('2026-10-07T05:30:00Z'),
  });
  assert.equal(next, '2026-10-07T11:30:00.000Z');
  assert.equal(await dueAt(), '2026-10-07T11:30:00.000Z');
  // A later finish for the same day may only push the due instant further out, never back.
  const later = await finishDueCollectionAttempt('2026-10-07', 'empty', {
    admittedAt: new Date('2026-10-07T06:30:00Z'), clock: at('2026-10-07T06:30:00Z'),
  });
  assert.equal(later, '2026-10-07T12:30:00.000Z');
  assert.equal(await dueAt(), '2026-10-07T12:30:00.000Z');
});

// ---------------------------------------------------------------------------------------------
// R1 — the authoritative admission instant is the DATABASE clock, read after the locks are held.
// ---------------------------------------------------------------------------------------------

test('R1: the admission instant is the database clock read AFTER the locks, not the caller clock', async t => {
  const dbNow = new Date((await sql<{ at: Date }[]>`SELECT clock_timestamp() AS at`)[0]!.at);
  if (dbNow < utcDayAnchor(dbNow)) return t.skip('real database clock is before the daily anchor');
  await clean();
  // Another connection holds the schedule row's lock, so the admission MUST wait on it.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const lockedAt = new Promise<void>((resolve) => { locked = resolve; });
  const blocker = sql.begin(async (tx) => {
    await tx`INSERT INTO arxiv_collection_schedule(key) VALUES('astro-ph') ON CONFLICT(key) DO NOTHING`;
    await tx`SELECT next_due_at FROM arxiv_collection_schedule WHERE key='astro-ph' FOR UPDATE`;
    locked();
    await gate;
  });
  await lockedAt;
  const startedMs = Date.now();
  // The PRODUCTION path: no injected clock, so the authoritative instant is the database's own.
  const pending = beginDueCollectionAttempt();
  await new Promise((resolve) => setTimeout(resolve, 800));
  release();
  await blocker;
  const admission = await pending;
  assert.equal(admission.allowed, true);
  const waited = new Date(admission.admittedAt).getTime() - startedMs;
  assert.ok(waited >= 500, `the recorded admission is the instant the lock was really obtained (waited ${waited} ms), not the instant the call was made`);
  // The budget is charged to the UTC day the AUTHORITATIVE instant falls in, and the floor is measured
  // from it, so a lock wait can neither shorten the six hours nor charge the wrong day.
  const charged = utcDayKey(new Date(admission.admittedAt));
  assert.equal((await day(charged)).attempts, 1);
  assert.equal(admission.nextDueAt, new Date(new Date(admission.admittedAt).getTime() + ARXIV_COLLECT_MIN_INTERVAL_MS).toISOString());
});

// ---------------------------------------------------------------------------------------------
// R2 — the channel lease and the day budget are one atomic decision, fenced by a reservation.
// ---------------------------------------------------------------------------------------------

test('R2: a channel really held by another process is refused without spending an attempt', async () => {
  await clean();
  enable();
  // Another process — or the explicit hydration recovery entry — really owns the channel right now.
  await sql`INSERT INTO arxiv_collection_state(key,owner,lease_until)
    VALUES('astro-ph',gen_random_uuid(),clock_timestamp()+interval '120 seconds')`;
  const hits: string[] = [];
  const busy = skipped(await collectScheduledArxiv({ fetch: serving(() => rssFor([]), hits), sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(busy.reason, 'busy', 'a busy channel is reported as busy, not as a failed collection');
  assert.equal(busy.attempts, 0, 'no attempt is spent');
  assert.equal(hits.length, 0, 'and no source request is made');
  assert.equal((await day('2026-10-07')).attempts, 0, 'the day budget is untouched');
  // The read-only gate agrees, so an idle minute leaves no run row either.
  assert.equal(await isDue(new Date('2026-10-07T05:30:00Z')), false);
});

test('R2: a late finish from a superseded reservation cannot refund a successor or roll its due back', async () => {
  await clean();
  const a = await begin(new Date('2026-10-07T05:30:00Z'));
  assert.equal(a.allowed, true);
  assert.equal(a.reservation !== undefined, true, 'an admitted attempt carries a reservation identity');
  assert.equal(a.nextDueAt, '2026-10-07T11:30:00.000Z');
  // A's run never hands the channel back in this test; the successor only begins once it is free.
  await releaseLease();
  const b = await begin(new Date('2026-10-07T11:30:00Z'));
  assert.equal(b.allowed, true);
  assert.equal(b.attempt, 2);
  assert.equal(await dueAt(), '2026-10-07T17:30:00.000Z');
  // A's finish arrives LATE, after B already owns the day's next attempt.
  const late = await finishDueCollectionAttempt('2026-10-07', 'untouched', {
    admittedAt: new Date(a.admittedAt), reservation: a.reservation, clock: at('2026-10-07T11:30:05Z'),
  });
  assert.equal(late, '2026-10-07T17:30:00.000Z', 'a stale finish returns the CURRENT due instant');
  assert.equal((await day('2026-10-07')).attempts, 2, "and cannot refund a successor's attempt");
  assert.equal(await dueAt(), '2026-10-07T17:30:00.000Z', "nor roll the due instant back to A's floor");
  // A duplicate of the same finish changes nothing either.
  const duplicate = await finishDueCollectionAttempt('2026-10-07', 'untouched', {
    admittedAt: new Date(a.admittedAt), reservation: a.reservation, clock: at('2026-10-07T11:30:06Z'),
  });
  assert.equal(duplicate, '2026-10-07T17:30:00.000Z');
  assert.equal((await day('2026-10-07')).attempts, 2);
});

test('R2: an untouched reservation returns the previous real floor, not a phantom six hours', async () => {
  await clean();
  // The day already had a real admission at 05:30, so its six-hour floor is 11:30.
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at) VALUES('2026-10-07'::date,1,'2026-10-07T05:30:00Z'::timestamptz)`;
  const a = await begin(new Date('2026-10-07T11:30:00Z'));
  assert.equal(a.allowed, true);
  assert.equal(a.nextDueAt, '2026-10-07T17:30:00.000Z', 'the admission writes its provisional floor');
  const next = await finishDueCollectionAttempt('2026-10-07', 'untouched', {
    admittedAt: new Date(a.admittedAt), reservation: a.reservation, clock: at('2026-10-07T11:30:01Z'),
  });
  assert.equal(next, '2026-10-07T11:30:00.000Z', 'the floor in force BEFORE the reservation is restored, not a phantom six hours');
  assert.equal((await day('2026-10-07')).attempts, 1, 'and the reserved attempt is given back');
  await releaseLease();
  // A live hold still bounds the restored floor: a pause that lifts earlier never costs the day a retry.
  const b = await begin(new Date('2026-10-07T11:30:02Z'));
  assert.equal(b.allowed, true);
  const held = await finishDueCollectionAttempt('2026-10-07', 'untouched', {
    admittedAt: new Date(b.admittedAt), reservation: b.reservation, holdUntil: '2026-10-07T12:30:00Z', clock: at('2026-10-07T11:30:03Z'),
  });
  assert.equal(held, '2026-10-07T12:30:00.000Z', "the hold's own deadline bounds the restored floor");
});

// ---------------------------------------------------------------------------------------------
// R3 — the upgrade path must not lose the six hours a previous-day admission owns.
// ---------------------------------------------------------------------------------------------

test('R3: an upgrade after a very late previous-day admission keeps the six hours', async () => {
  await clean();
  // The old schedule's last real admission was 23:30 yesterday; the new table has no row at all and
  // today has no day row yet — exactly the state of a deployment that just migrated.
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at,last_outcome,completed_at)
    VALUES('2026-10-06'::date,1,'2026-10-06T23:30:00Z'::timestamptz,'collected','2026-10-06T23:31:00Z'::timestamptz)`;
  const early = await begin(new Date('2026-10-07T05:29:00Z'));
  assert.equal(early.allowed, false, '05:29 is less than six hours after a 23:30 admission');
  assert.equal(early.reason, 'not_due');
  assert.equal(early.nextDueAt, '2026-10-07T05:30:00.000Z', "the previous day's real admission owns the floor");
  const at0530 = await begin(new Date('2026-10-07T05:30:00.000Z'));
  assert.equal(at0530.allowed, true, 'and exactly six hours later the new day opens its own budget');
  assert.equal(at0530.attempt, 1, 'the new day starts from its own first attempt');
  assert.equal((await day('2026-10-07')).attempts, 1);
});

test('R3: a spent previous day keeps the same six-hour floor', async () => {
  await clean();
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at) VALUES('2026-10-06'::date,3,'2026-10-06T23:30:00Z'::timestamptz)`;
  const r = await begin(new Date('2026-10-07T05:29:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextDueAt, '2026-10-07T05:30:00.000Z');
});

test('R3: a persisted due instant that is too early is re-calibrated against the real admission', async () => {
  await clean();
  // A rollback to the old image and a switch back: the schedule row exists, but its instant predates the
  // six hours the last real admission owns, so it must not be trusted over that admission.
  await sql`INSERT INTO arxiv_collection_schedule(key,next_due_at) VALUES('astro-ph','2026-10-07T05:29:00Z'::timestamptz)`;
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at) VALUES('2026-10-06'::date,1,'2026-10-06T23:30:00Z'::timestamptz)`;
  const r = await begin(new Date('2026-10-07T05:29:00Z'));
  assert.equal(r.allowed, false, 'a stale, too-early due instant is not trusted over the real admission');
  assert.equal(r.nextDueAt, '2026-10-07T05:30:00.000Z');
});

// ---------------------------------------------------------------------------------------------
// R4 — the day is closed on real raw-paper persistence, never on RSS evidence alone.
// ---------------------------------------------------------------------------------------------

test('R4: RSS evidence alone never closes the day when no raw paper was really stored', async () => {
  await clean();
  enable();
  const fake = serving(() => rssFor(['2610.07001v1']));
  // Day one really stores the announced version as a raw paper — from the feed itself, with no API
  // request at all. The paper stays a normal pending raw paper from there on.
  const first = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
  assert.equal(first.insertedPaperCount, 1, 'the announced version was really stored');
  assert.equal((await day('2026-10-07')).completed_at !== null, true);
  // Day two publishes a DIFFERENT feed — the same version, re-announced as a cross-list rather than as
  // a new paper — so a brand-new batch of evidence is really imported while the version itself is
  // already stored. The cache row is cleared so the next day really refetches instead of replaying.
  await sql`DELETE FROM arxiv_rss_cache`;
  const second = ran(await collectScheduledArxiv({
    fetch: serving(() => rssFor(['2610.07001v1'], 'cross')), sleep: async () => {}, now: at('2026-10-08T05:30:00Z'),
  }));
  assert.ok(second.newContentCount > 0, 'the re-announced feed is real RSS evidence');
  assert.equal(second.insertedPaperCount, 0, 'but no raw paper was really stored');
  assert.equal(second.duplicateCount, 1, 'the version the feed re-announced was already stored');
  assert.equal(second.partial, false);
  const state = await day('2026-10-08');
  assert.equal(state.last_outcome, 'empty', 'RSS evidence alone is not "collected"');
  assert.equal(state.completed_at, null, 'and the day stays open for its retry budget');
});

// ---------------------------------------------------------------------------------------------
// R5 — a failed run leaves structured, reviewable facts; a failed settle hides nothing.
// ---------------------------------------------------------------------------------------------

test('R5: a failed scheduled run leaves its schedule facts as a durable ops event', async () => {
  await clean();
  enable();
  const runId = (await sql<{ id: number }[]>`INSERT INTO job_runs(job) VALUES('arxiv.collect') RETURNING id`)[0]!.id;
  const down: typeof fetch = async () => { throw new Error('feed down'); };
  await assert.rejects(collectScheduledArxiv({ fetch: down, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'), jobRunId: runId }));
  const events = await sql<{ code: string; job_run_id: number | null; details: Record<string, unknown> }[]>`
    SELECT code, job_run_id, details FROM ops_error_events WHERE stage='arxiv.collect' AND code='schedule_failed'`;
  assert.equal(events.length, 1, 'the known schedule facts are recorded for the failed run');
  assert.equal(events[0]!.job_run_id, runId, 'and are tied to the run that observed the failure');
  const details = events[0]!.details;
  assert.equal(details.day, '2026-10-07');
  assert.equal(details.attempt, 1);
  assert.equal(details.retry, false);
  assert.equal(details.scheduleSettled, true);
  assert.equal(details.nextDueAt, '2026-10-07T11:30:00.000Z');
});

test('R5: a failed schedule write keeps BOTH the source error and the schedule failure', async () => {
  await clean();
  enable();
  const runId = (await sql<{ id: number }[]>`INSERT INTO job_runs(job) VALUES('arxiv.collect') RETURNING id`)[0]!.id;
  // The schedule table is made unwritable WHILE the run is failing, so the settle that follows the real
  // source failure is the thing that breaks. The run's own error must survive it.
  const down: typeof fetch = async () => {
    await sql`CREATE OR REPLACE FUNCTION tmp_block_schedule() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'schedule unavailable'; END; $f$`;
    await sql`CREATE TRIGGER tmp_block_schedule BEFORE INSERT OR UPDATE ON arxiv_collection_schedule FOR EACH ROW EXECUTE FUNCTION tmp_block_schedule()`;
    throw new Error('feed down');
  };
  try {
    const thrown = await collectScheduledArxiv({ fetch: down, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'), jobRunId: runId }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(thrown !== undefined, 'the run still fails');
    const parts = thrown instanceof AggregateError ? thrown.errors.map(String) : [String(thrown)];
    const text = parts.join(' | ');
    assert.match(text, /feed down/, 'the source error is kept');
    assert.match(text, /schedule unavailable/, 'and so is the schedule failure');
    const events = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE stage='arxiv.collect' AND code='schedule_failed'`;
    assert.equal(events.length, 1, 'the schedule facts are still recorded, with the gap stated');
    assert.equal(events[0]!.details.scheduleSettled, false);
    assert.equal(events[0]!.details.nextDueAt, null);
  } finally {
    await sql`DROP TRIGGER IF EXISTS tmp_block_schedule ON arxiv_collection_schedule`;
    await sql`DROP FUNCTION IF EXISTS tmp_block_schedule()`;
  }
});

// ---------------------------------------------------------------------------------------------
// ROUND 3 — R1: the instant is read after EVERY admission lock, including the channel state row.
// ---------------------------------------------------------------------------------------------

test('R1: the admission instant is read AFTER the channel lease is taken, not before the state-row wait', async t => {
  const dbNow = new Date((await sql<{ at: Date }[]>`SELECT clock_timestamp() AS at`)[0]!.at);
  if (dbNow < utcDayAnchor(dbNow)) return t.skip('real database clock is before the daily anchor');
  await clean();
  // Another connection really holds the CHANNEL STATE row — a release, a hold or a renewal in flight.
  // The admission reaches its lease claim and waits there, AFTER it has already sampled a clock.
  await sql`INSERT INTO arxiv_collection_state(key) VALUES('astro-ph') ON CONFLICT(key) DO NOTHING`;
  const { release, blocker } = await holdRow('arxiv_collection_state');
  const startedMs = Date.now();
  // The PRODUCTION path: no injected clock, so the authoritative instant is the database's own.
  const pending = beginDueCollectionAttempt();
  await new Promise(resolve => setTimeout(resolve, 800));
  release();
  await blocker;
  const admission = await pending;
  assert.equal(admission.allowed, true);
  const waited = new Date(admission.admittedAt).getTime() - startedMs;
  assert.ok(waited >= 500,
    `the recorded admission is the instant the STATE lock was really obtained (waited ${waited} ms), not the instant sampled before it`);
  const charged = utcDayKey(new Date(admission.admittedAt));
  assert.equal((await day(charged)).attempts, 1);
  assert.equal(admission.nextDueAt, new Date(new Date(admission.admittedAt).getTime() + ARXIV_COLLECT_MIN_INTERVAL_MS).toISOString(),
    'and the six hours are measured from that same instant');
});

test('R1: a midnight crossing while the channel lease was waited on does not charge the old day', async () => {
  await clean();
  // The clock seam advances across midnight between the instant sampled before the lease wait and the
  // instant sampled after it — exactly what a wait that straddles midnight produces.
  const readings = ['2026-10-07T23:59:59.500Z', '2026-10-07T23:59:59.500Z', '2026-10-08T00:00:00.100Z'];
  let call = 0;
  const clock = () => new Date(readings[Math.min(call++, readings.length - 1)]!);
  const admission = await beginDueCollectionAttempt({ clock });
  // The whole admission — the lease claim included — is rolled back and re-decided against the day it
  // really reached. 00:00:00.100 is before that day's own 05:30 anchor, so nothing is admitted; above
  // all, the attempt is NOT charged to the day that had already ended.
  assert.equal(utcDayKey(new Date(admission.admittedAt)), '2026-10-08',
    'the decision belongs to the day that was really reached');
  assert.equal(admission.allowed, false);
  assert.equal(admission.reason, 'not_due');
  assert.equal(admission.nextDueAt, '2026-10-08T05:30:00.000Z', "the new day's own anchor is what it waits for");
  assert.equal((await dayOrNull('2026-10-07'))?.attempts ?? 0, 0, 'the day that had already ended keeps no attempt');
  assert.equal(await ownerOf(), null, 'and the lease claimed before the roll was not left behind either');
  assert.equal(await dueAt(), '2026-10-08T05:30:00.000Z');
});

test('R1: the finish instant is read AFTER the schedule row lock, not before the wait', async () => {
  await clean();
  await sql`INSERT INTO arxiv_collection_schedule(key) VALUES('astro-ph') ON CONFLICT(key) DO NOTHING`;
  await sql`INSERT INTO arxiv_collection_day(day,attempts,last_attempt_at) VALUES('2026-10-07'::date,1,clock_timestamp())`;
  const { release, blocker } = await holdRow('arxiv_collection_schedule');
  const startedMs = Date.now();
  const pending = finishDueCollectionAttempt('2026-10-07', 'empty', { admittedAt: new Date('2026-10-07T05:30:00Z') });
  await new Promise(resolve => setTimeout(resolve, 800));
  release();
  await blocker;
  const next = await pending;
  assert.equal(next, '2026-10-07T11:30:00.000Z');
  const row = await schedule();
  const waited = new Date(row!.updated_at).getTime() - startedMs;
  assert.ok(waited >= 500,
    `the settle instant is the instant the lock was obtained (waited ${waited} ms), not the instant sampled before it`);
});

// ---------------------------------------------------------------------------------------------
// ROUND 3 — R2: a tick refused BEFORE the collector can never keep the channel or spend the day.
// ---------------------------------------------------------------------------------------------

test('R2: an invalid collection configuration is refused before the attempt is reserved', async () => {
  await clean();
  enable();
  const hits: string[] = [];
  const empty = serving(() => rssFor([]), hits);
  for (const [name, options] of [
    ['pageSize', { pageSize: 0 }],
    ['pageSize', { pageSize: 101 }],
    ['pageSize', { maxResults: Number.NaN }],
    ['maxPages', { maxPages: 0 }],
    ['maxPages', { maxPages: 101 }],
  ] as const) {
    await assert.rejects(
      collectScheduledArxiv({ fetch: empty, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'), ...options }),
      new RegExp(`Invalid arXiv ${name}`),
    );
    assert.equal(await ownerOf(), null, 'a configuration fault never takes the channel');
    assert.equal((await dayOrNull('2026-10-07'))?.attempts ?? 0, 0, 'and never spends the day budget');
  }
  assert.equal(hits.length, 0, 'and it never reaches the source');
  // Nothing was left behind at all: no schedule row either.
  assert.equal(await schedule(), undefined);
});

test('R2: a tick the collector turns away hands the channel back, and a release that fails is visible', async () => {
  await clean();
  enable();
  await armReleaseRefusal();
  try {
    // The collector's own enable gate is turned off BETWEEN the tick's pre-check and the collector call,
    // which is what a configuration change mid-flight looks like. The tick has already spent the attempt
    // and taken the channel, so both have to be handed back.
    const options = {
      fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'),
      get maxPages() { process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'false'; return 10; },
    };
    const thrown = await collectScheduledArxiv(options).then(() => undefined, (error: unknown) => error);
    assert.ok(thrown !== undefined, 'the tick does not report a clean hand-back it did not achieve');
    assert.match(String(thrown), /release refused by the harness/,
      'and the release failure is stated rather than swallowed');
    assert.equal((await day('2026-10-07')).attempts, 0, 'the attempt that never ran is still given back');
    assert.notEqual(await ownerOf(), null,
      'the channel really is still held, so the cleanup failure is the case under test');
  } finally {
    process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
    await disarmReleaseRefusal();
  }
});

test('R2: a 429 whose hold could not be persisted keeps the channel instead of releasing it', async () => {
  await clean();
  enable();
  // Every write that clears the owner is refused, so BOTH the durable hold and the release fail. The
  // owner is the only thing that still says "do not dispatch"; a generic catch that released it would
  // erase the pause nobody could vouch for.
  await armOwnerClearingRefusal();
  try {
    const limited: typeof fetch = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } });
    const thrown = await collectScheduledArxiv({ fetch: limited, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') })
      .then(() => undefined, (error: unknown) => error);
    assert.ok(thrown !== undefined, 'the run still fails');
    assert.match(String(thrown), /429/, 'and the 429 is still the failure a caller reads');
    assert.notEqual(await ownerOf(), null,
      'the channel is deliberately still held: the pause that could not be persisted must not be erased');
    const held = (await sql<{ lease_until: Date | null }[]>`SELECT lease_until FROM arxiv_collection_state WHERE key='astro-ph'`)[0];
    assert.notEqual(held?.lease_until ?? null, null, 'and the term it was left holding is still on the row');
  } finally {
    await disarmOwnerClearingRefusal();
  }
});

// ---------------------------------------------------------------------------------------------
// ROUND 3 — R5: a settle can never rewrite the outcome the run earned.
// ---------------------------------------------------------------------------------------------

test('R5: a transient settle failure after a successful run still closes the day', async () => {
  await clean();
  enable();
  await armSettleFaultOnce();
  try {
    const fake = serving(() => rssFor(['2610.07001v1']));
    const run = ran(await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z') }));
    assert.equal(run.insertedPaperCount, 1, 'the run really stored its paper');
    const state = await day('2026-10-07');
    assert.equal(state.last_outcome, 'collected', 'the outcome the run earned survives the transient settle failure');
    assert.notEqual(state.completed_at, null, 'and the day really closes instead of being re-run six hours later');
    assert.equal(await dueAt(), '2026-10-08T05:30:00.000Z');
    const events = await sql`SELECT 1 FROM ops_error_events WHERE code='schedule_failed'`;
    assert.equal(events.length, 0, 'a settle that recovered is not reported as a failed run');
  } finally {
    await disarmSettleFault();
  }
});

test('R5: a transient settle failure after a tick that never ran still refunds the attempt', async () => {
  await clean();
  enable();
  await armSettleFaultOnce();
  try {
    // The same configuration drift as above: the tick reserved the attempt, then the collector's gate
    // turned the run away. The outcome is `untouched`, and the settle that follows it fails once.
    const options = {
      fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'),
      get maxPages() { process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'false'; return 10; },
    };
    assert.equal(await collectScheduledArxiv(options), undefined);
    const state = await day('2026-10-07');
    assert.equal(state.attempts, 0, 'the attempt that never ran is refunded, not left spent');
    assert.notEqual(state.last_outcome, 'failed', 'and the tick is not recorded as a failed run');
    assert.equal(await dueAt(), '2026-10-07T05:30:00.000Z', 'the floor in force before the reservation is restored');
  } finally {
    process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
    await disarmSettleFault();
  }
});

test('R5: a settle that keeps failing after a successful run keeps the outcome and the papers it stored', async () => {
  await clean();
  enable();
  const runId = (await sql<{ id: number }[]>`INSERT INTO job_runs(job) VALUES('arxiv.collect') RETURNING id`)[0]!.id;
  const inner = serving(() => rssFor(['2610.07001v1']));
  let armed = false;
  const fake: typeof fetch = async input => {
    // Armed only AFTER the admission has written the schedule row, so what fails is the settle.
    if (!armed) { armed = true; await armScheduleRefusal(); }
    return inner(input);
  };
  try {
    const thrown = await collectScheduledArxiv({ fetch: fake, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'), jobRunId: runId })
      .then(() => undefined, (error: unknown) => error);
    assert.ok(thrown !== undefined, 'the tick does not pretend the settle happened');
    assert.match(String(thrown), /the arXiv collected outcome could not be settled/,
      'and it says the settle is what failed, not the run');
    const state = await day('2026-10-07');
    assert.notEqual(state.last_outcome, 'failed', 'a run that stored its paper is never rewritten as failed');
    assert.equal(state.completed_at, null, 'and the day is left exactly as the admission left it');
    const events = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE code='schedule_failed'`;
    assert.equal(events.length, 1, 'the known facts are recorded durably');
    assert.equal(events[0]!.details.outcome, 'collected', 'including the outcome the run really earned');
    assert.equal(events[0]!.details.insertedPaperCount, 1, 'and the papers it really stored');
    assert.equal(events[0]!.details.scheduleSettled, false);
    assert.equal(events[0]!.details.nextDueAt, null);
  } finally {
    await disarmScheduleRefusal();
  }
});

test('F1: cleanup and settlement failing together keeps BOTH the release and the settle failure', async () => {
  await clean();
  enable();
  // The collector's gate is turned off BETWEEN the tick's own pre-check and the collector call, the
  // same mid-flight configuration drift the R2 test above drives: the tick has already spent the
  // attempt and taken the channel, so it hands the lease back itself. Here the hand-back fails AND
  // both settles fail, which is the combination the review found: the release failure used to be
  // rewritten by the settle failure, so the lease that was never given back became invisible.
  await armReleaseRefusal();
  await armSettleRefusal();
  try {
    const options = {
      fetch: forbidden, sleep: async () => {}, now: at('2026-10-07T05:30:00Z'),
      get maxPages() { process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'false'; return 10; },
    };
    const thrown = await collectScheduledArxiv(options).then(() => undefined, (error: unknown) => error);
    assert.ok(thrown !== undefined, 'the tick does not pretend either write happened');
    const flattened = `${String(thrown)} ${((thrown as AggregateError).errors ?? []).map(String).join(' | ')}`;
    assert.match(String(thrown), /could not be settled/,
      'the settlement failure is still what the caller reads first');
    assert.match(flattened, /release refused by the harness/,
      'and the cleanup failure is kept instead of being overwritten by the settle failure');
    assert.equal((await day('2026-10-07')).last_outcome, null,
      'the outcome the tick earned is untouched, never rewritten as a failed run');
    assert.notEqual(await ownerOf(), null,
      'the channel really is still held: the failed hand-back is the case under test');
    const events = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM ops_error_events WHERE code='schedule_failed'`;
    assert.equal(events.length, 1, 'the schedule facts are recorded durably');
    assert.equal(events[0]!.details.outcome, 'untouched', 'including the outcome the tick really earned');
    assert.equal(events[0]!.details.reservation !== null, true,
      'and the reservation the settles were fenced on, not a replacement identity');
    assert.match(String(events[0]!.details.cleanupFailure), /release refused by the harness/,
      'the ops event states the cleanup failure as well as the settle failure');
  } finally {
    process.env.ARXIV_NATIVE_COLLECT_ENABLED = 'true';
    await disarmSettleRefusal();
    await disarmReleaseRefusal();
  }
});

test.after(async () => { await closeDb(); });
