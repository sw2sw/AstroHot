// arXiv hydration fault tolerance.
//
// A hydration request asks the official API for an explicit list of versioned IDs. The upstream can
// answer with fewer entries than requested (a single record gap) while everything else in the answer
// is correct. Treating that as a reason to discard the whole batch loses the good entries, holds the
// collection watermark and makes every later run ask for the same batch again, so here the answer is
// split instead:
//
//   * accepted   — requested and returned with the exact version, persisted immediately;
//   * missing    — requested and not returned, recorded as a durable open exception;
//   * unexpected — returned but never requested, recorded and never stored as a paper;
//   * mismatch   — same base ID, different version: the answer is untrustworthy, so the whole batch
//                  is rejected before anything is written.
//
// Missing/unexpected rows are an explicit, bounded recovery queue: ordinary collection skips them
// (it does not re-ask for a version that is already known to be absent), and refetchHydrationExceptions
// is the separate entry that retries them and is the only thing allowed to close them.

import { createHash } from "node:crypto";
import type { Tx } from "../db.ts";
import type { CollectionResult, RawArxivPaper } from "./collect.ts";
import { collectArxivMetadata, parseArxivPageInfo } from "./collect.ts";
import type { RawArxivDatabase } from "./raw-store.ts";
import { persistRawArxivRows, validateRawArxivCollection } from "./raw-store.ts";
import type { ArxivResponseMeta, ArxivChannelThrottle } from "./channel.ts";
import { createArxivChannel, retryAfterSeconds } from "./channel.ts";
import { ArxivHttpError, findArxivHttpError, isArxivRateLimited } from "./http.ts";
// Type-only, so it is erased at run time and the dynamic import of the state module stays the only
// runtime edge between the two entries.
import type { ArxivControlPlaneError as ControlPlaneFailure } from "./collection-state.ts";

export const RSS_CHANNEL = "astro-ph";
export const RSS_FEED_URL = "https://rss.arxiv.org/rss/astro-ph";

// How much of the raw response is kept inline. The rest stays reachable through raw_batch_hash,
// which points at the complete document in arxiv_raw_batches, so a truncated excerpt is always
// marked as truncated and never the only copy.
const RAW_RESPONSE_EXCERPT_LIMIT = 4000;

// PostgreSQL integer column bound; a version above it could never be stored.
const POSTGRES_INT_MAX = 2147483647;

const VERSIONED_ID = /^(.+?)v([1-9]\d*)$/;

export type HydrationExceptionKind = "missing" | "unexpected";

export interface HydrationException {
  arxivId: string;
  baseId: string;
  version: number;
  kind: HydrationExceptionKind;
}

export interface HydrationVersionMismatch {
  arxivId: string;
  baseId: string;
  requestedVersion: number;
  receivedVersion: number;
}

export interface HydrationClassification {
  accepted: RawArxivPaper[];
  missing: HydrationException[];
  unexpected: HydrationException[];
  versionMismatch: HydrationVersionMismatch[];
}

export function splitVersionedId(arxivId: string): { baseId: string; version: number } | undefined {
  const match = VERSIONED_ID.exec(arxivId);
  if (!match) return undefined;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1 || version > POSTGRES_INT_MAX) return undefined;
  return { baseId: match[1], version };
}

function exceptionOf(arxivId: string, kind: HydrationExceptionKind): HydrationException {
  const parts = splitVersionedId(arxivId);
  if (!parts) throw new Error(`Invalid versioned arXiv ID in hydration: ${arxivId}`);
  return { arxivId, baseId: parts.baseId, version: parts.version, kind };
}

// Pure partition of one hydration answer against the requested set. Order is preserved so the
// recorded request/returned lists stay reproducible.
export function classifyHydrationPage(
  papers: readonly RawArxivPaper[],
  requestedIds: readonly string[],
): HydrationClassification {
  const requested = new Set(requestedIds);
  const requestedVersions = new Map<string, number>();
  for (const id of requestedIds) {
    const parts = splitVersionedId(id);
    if (!parts) throw new Error(`Invalid versioned arXiv ID in hydration request: ${id}`);
    requestedVersions.set(parts.baseId, parts.version);
  }

  const accepted: RawArxivPaper[] = [];
  const unexpected: HydrationException[] = [];
  const versionMismatch: HydrationVersionMismatch[] = [];
  const returned = new Set<string>();

  for (const paper of papers) {
    if (returned.has(paper.arxiv_id)) continue;
    returned.add(paper.arxiv_id);
    if (requested.has(paper.arxiv_id)) {
      accepted.push(paper);
      continue;
    }
    const parts = splitVersionedId(paper.arxiv_id);
    if (!parts) throw new Error(`arXiv hydration returned an unversioned ID: ${paper.arxiv_id}`);
    const wanted = requestedVersions.get(parts.baseId);
    if (wanted !== undefined) {
      versionMismatch.push({
        arxivId: paper.arxiv_id,
        baseId: parts.baseId,
        requestedVersion: wanted,
        receivedVersion: parts.version,
      });
      continue;
    }
    unexpected.push({ arxivId: paper.arxiv_id, baseId: parts.baseId, version: parts.version, kind: "unexpected" });
  }

  const missing: HydrationException[] = [];
  for (const id of requestedIds) {
    if (returned.has(id)) continue;
    missing.push(exceptionOf(id, "missing"));
  }

  return { accepted, missing, unexpected, versionMismatch };
}

// The batch is rejected without storing a single row, and the message names every version involved
// so the failure can be triaged from the job log alone.
export function hydrationVersionMismatchError(mismatches: readonly HydrationVersionMismatch[]): Error {
  const detail = mismatches
    .map((m) => `${m.baseId}: requested v${m.requestedVersion}, received v${m.receivedVersion}`)
    .join("; ");
  return new Error(`arXiv hydration version mismatch, whole batch rejected (${detail})`);
}

export interface HydrationBatchMeta {
  httpStatus: number | null;
  headers: Record<string, string>;
  pagination: Record<string, unknown>;
  durationMs: number;
}

export interface HydrationBatchInput {
  page: CollectionResult;
  requestedIds: readonly string[];
  acceptedIds: readonly string[];
  exceptions: readonly HydrationException[];
  meta: HydrationBatchMeta;
}

export interface HydrationBatchResult {
  status: "imported" | "unchanged";
  batchHash: string;
  acceptedCount: number;
  // Versions of this answer that were stored for the first time; a replay of an already stored batch
  // reports 0 even though the batch is new.
  insertedPaperCount: number;
  recordedExceptionCount: number;
  resolvedExceptionCount: number;
  deferredAuthorUpdates: string[];
}

// The page counters are best effort: the OpenSearch block is optional in a hydration answer.
export function hydrationPagination(
  rawAtom: string,
  requestedCount: number,
  returnedCount: number,
  batchIndex: number,
  pageSize: number,
): Record<string, unknown> {
  const counters = { batchIndex, pageSize, requestedCount, returnedCount };
  try {
    const info = parseArxivPageInfo(rawAtom);
    return { ...counters, startIndex: info.startIndex, totalResults: info.totalResults, itemsPerPage: info.itemsPerPage };
  } catch {
    return counters;
  }
}

function defaultDatabase(): RawArxivDatabase {
  return {
    begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      const { sql } = await import("../db.ts");
      return sql.begin(fn) as Promise<T>;
    },
  };
}

// Persists the accepted versions of one hydration answer and records its exceptions in the SAME
// transaction: either both land or neither does, so a partially written batch can never look
// finished. The complete raw response is archived even when nothing is accepted, which keeps every
// exception traceable offline through raw_batch_hash.
export async function ingestHydratedArxivBatch(
  input: HydrationBatchInput,
  database?: RawArxivDatabase,
): Promise<HydrationBatchResult> {
  const validated = validateRawArxivCollection(input.page);

  const accepted = new Set(input.acceptedIds);
  const requested = new Set(input.requestedIds);
  for (const id of accepted) {
    if (!requested.has(id)) throw new Error(`arXiv hydration accepted ID was not requested: ${id}`);
  }
  const acceptedRows = validated.rows.filter((row) => accepted.has(row.paper.arxiv_id));
  if (acceptedRows.length !== accepted.size) {
    throw new Error("arXiv hydration accepted IDs are not part of the returned document");
  }

  const excerpt = validated.rawAtom.slice(0, RAW_RESPONSE_EXCERPT_LIMIT);
  const truncated = validated.rawAtom.length > excerpt.length;
  const requestedIds = [...input.requestedIds];
  const returnedIds = validated.rows.map((row) => row.paper.arxiv_id);
  const headers = JSON.stringify(input.meta.headers);
  const pagination = JSON.stringify(input.meta.pagination);

  const db = database ?? defaultDatabase();
  return db.begin(async (tx) => {
    const insertedBatch = await tx`
      INSERT INTO arxiv_raw_batches (content_hash, raw_atom, collected_at, paper_count)
      VALUES (${validated.batchHash}, ${validated.rawAtom}, ${validated.collectedAt}, ${validated.paperCount})
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING content_hash`;

    // Unlike the whole-page ingest this never short-circuits on an already stored batch: a recovery
    // refetch normally replays the same document, and the previously missing version still has to be
    // inserted.
    const { deferredAuthorUpdates, insertedIds } = await persistRawArxivRows(
      tx,
      validated.batchHash,
      validated.collectedAt,
      acceptedRows,
    );

    let recordedExceptionCount = 0;
    for (const exception of input.exceptions) {
      const saved = await tx`
        INSERT INTO arxiv_hydration_exceptions
          (arxiv_id, base_id, version, kind, request_ids, returned_ids, http_status, response_headers,
           pagination, duration_ms, raw_batch_hash, raw_response_excerpt, raw_response_truncated)
        VALUES
          (${exception.arxivId}, ${exception.baseId}, ${exception.version}, ${exception.kind},
           ${requestedIds}, ${returnedIds}, ${input.meta.httpStatus},
           ${headers}::text::jsonb, ${pagination}::text::jsonb, ${input.meta.durationMs},
           ${validated.batchHash}, ${excerpt}, ${truncated})
        ON CONFLICT (arxiv_id, kind) WHERE resolved_at IS NULL DO UPDATE SET
          last_seen_at = clock_timestamp(),
          attempts = arxiv_hydration_exceptions.attempts + 1,
          request_ids = EXCLUDED.request_ids,
          returned_ids = EXCLUDED.returned_ids,
          http_status = EXCLUDED.http_status,
          response_headers = EXCLUDED.response_headers,
          pagination = EXCLUDED.pagination,
          duration_ms = EXCLUDED.duration_ms,
          raw_batch_hash = EXCLUDED.raw_batch_hash,
          raw_response_excerpt = EXCLUDED.raw_response_excerpt,
          raw_response_truncated = EXCLUDED.raw_response_truncated
        RETURNING id`;
      recordedExceptionCount += saved.length;
    }

    // A version that is now stored closes its own open exceptions in the same transaction.
    const resolved = accepted.size === 0 ? [] : await tx<{ arxiv_id: string }[]>`
      UPDATE arxiv_hydration_exceptions SET resolved_at = clock_timestamp()
      WHERE arxiv_id = ANY(${[...accepted]}::text[]) AND resolved_at IS NULL
      RETURNING arxiv_id`;

    return {
      status: insertedBatch.length > 0 || insertedIds.length > 0 ? ("imported" as const) : ("unchanged" as const),
      batchHash: validated.batchHash,
      acceptedCount: acceptedRows.length,
      insertedPaperCount: insertedIds.length,
      recordedExceptionCount,
      resolvedExceptionCount: resolved.length,
      deferredAuthorUpdates,
    };
  });
}

export type HydrationAttemptReason = "rate_limited" | "timeout" | "http_error" | "version_mismatch" | "content_conflict" | "transport";
/**
 * `failureReason` may also be 'lease_lost' or 'lease_unconfirmed', which are deliberately NOT among the
 * attempt reasons above: the refetch was stopped because the run could not show it still owned the
 * channel — either the row says somebody else holds it, or the renewal never answered. Nothing about
 * such a run is counted against the retry budget, and the two are kept apart so a database hiccup is
 * never logged as an upstream arXiv failure.
 */
export type HydrationRecoveryFailureReason = HydrationAttemptReason | "lease_lost" | "lease_unconfirmed";

export interface HydrationAttemptFailure {
  requestedIds: readonly string[];
  reason: HydrationAttemptReason;
  message: string;
  httpStatus: number | null;
  headers: Record<string, string>;
  durationMs: number;
}

// Classifies a transport/validation failure so the durable record says which one it was. The status is
// read through any wrapper the failure collected on its way here — a cleanup failure reported alongside
// the request error must not cost the record its HTTP status — and the same lookup is what the 429
// hold depends on.
export function describeHydrationFailure(
  error: unknown,
  requestedIds: readonly string[],
  response: ArxivResponseMeta | undefined,
  durationMs: number,
): HydrationAttemptFailure {
  const message = String(error instanceof Error ? error.message : error).slice(0, 4000);
  const http = findArxivHttpError(error);
  const status = response?.status ?? http?.status ?? null;
  const reason: HydrationAttemptReason =
    status === 429 ? "rate_limited"
      : status !== null && status >= 500 ? "http_error"
      : /timed out/i.test(message) ? "timeout"
      : http !== undefined ? "http_error"
      : "transport";
  return { requestedIds: [...requestedIds], reason, message, httpStatus: status, headers: response?.headers ?? {}, durationMs };
}

/**
 * Counts one failed recovery attempt against every open exception it covered. This is what bounds the
 * retries: `attempts < maxAttempts` selects the queue, so a 429, a timeout, an HTTP 5xx, a transport
 * failure or a version rejection can never be retried forever, and the row keeps the reason readable
 * offline. The exception is never resolved here — only a successful refetch may do that.
 */
export async function recordHydrationAttemptFailure(
  failure: HydrationAttemptFailure,
  database?: RawArxivDatabase,
): Promise<number> {
  if (failure.requestedIds.length === 0) return 0;
  const db = database ?? defaultDatabase();
  return db.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`
      UPDATE arxiv_hydration_exceptions
      SET attempts = attempts + 1,
          last_seen_at = clock_timestamp(),
          last_attempt_at = clock_timestamp(),
          last_error = ${failure.message},
          http_status = ${failure.httpStatus},
          response_headers = ${JSON.stringify(failure.headers)}::text::jsonb,
          duration_ms = ${failure.durationMs}
      WHERE arxiv_id = ANY(${[...failure.requestedIds]}::text[]) AND resolved_at IS NULL
      RETURNING id`;
    return rows.length;
  });
}

export type HydrationRejectionKind = "version_mismatch" | "content_conflict" | "transport";

export interface HydrationRejection {
  kind: HydrationRejectionKind;
  requestedIds: readonly string[];
  detail: string;
  findings: readonly unknown[];
  httpStatus: number | null;
  headers: Record<string, string>;
  durationMs: number;
  // The rejected document itself, when one exists. It is never stored as a paper or as a raw batch;
  // only its hash and a marked excerpt are kept so the decision can be reviewed offline.
  rawAtom?: string;
}

/**
 * Records the offline evidence of a batch rejected for a correctness reason. A version mismatch, a
 * same-version metadata conflict and an unreadable response are all stored here rather than only as
 * an error string, because that is what makes the rejection reviewable after the fact. The row id is
 * returned so the rejection can be referenced from the recorded failure event.
 */
export async function recordHydrationRejection(
  rejection: HydrationRejection,
  database?: RawArxivDatabase,
): Promise<number> {
  const raw = rejection.rawAtom;
  const excerpt = raw === undefined ? "" : raw.slice(0, RAW_RESPONSE_EXCERPT_LIMIT);
  const truncated = raw !== undefined && raw.length > excerpt.length;
  const digest = raw === undefined ? null : createHash("sha256").update(raw, "utf8").digest("hex");
  const db = database ?? defaultDatabase();
  return await db.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO arxiv_hydration_rejections
        (kind, arxiv_ids, detail, findings, http_status, response_headers, duration_ms,
         raw_response_sha256, raw_response_excerpt, raw_response_truncated)
      VALUES
        (${rejection.kind}, ${[...rejection.requestedIds]}, ${rejection.detail.slice(0, 4000)},
         ${JSON.stringify(rejection.findings)}::text::jsonb, ${rejection.httpStatus},
         ${JSON.stringify(rejection.headers)}::text::jsonb, ${rejection.durationMs},
         ${digest}, ${excerpt}, ${truncated})
      RETURNING id`;
    return rows[0]!.id;
  });
}

export interface ArxivRssCacheHit {
  rawRss: string;
  contentHash: string;
  fetchedAt: Date;
  itemCount: number;
}

export interface ArxivRssCacheEntry {
  channel: string;
  cacheDay: string;
  contentHash: string;
  itemCount: number;
  fetchedAt: Date;
  httpStatus: number | null;
  headers: Record<string, string>;
  durationMs: number;
}

// A cache row exists only for a feed that was already ingested, and it points at that stored batch,
// so a failed or unparsable fetch can never be replayed as a success.
export async function readArxivRssCache(channel: string, cacheDay: string): Promise<ArxivRssCacheHit | undefined> {
  const { sql } = await import("../db.ts");
  const rows = await sql<{ content_hash: string; fetched_at: Date; raw_rss: string; item_count: number }[]>`
    SELECT c.content_hash, c.fetched_at, c.item_count, b.raw_rss
    FROM arxiv_rss_cache c
    JOIN arxiv_announcement_batches b ON b.content_hash = c.content_hash
    WHERE c.channel = ${channel} AND c.cache_day = ${cacheDay}::date`;
  const row = rows[0];
  return row ? { rawRss: row.raw_rss, contentHash: row.content_hash, fetchedAt: row.fetched_at, itemCount: row.item_count } : undefined;
}

/**
 * The cache row is what lets a later run of the same day skip the feed, so the row must never point at
 * a feed other than the one that was really stored: it is written through `database` so the collection
 * job can commit it in the SAME transaction as the announcement batch it points at, under the same
 * ownership check. Written on its own, a run that was taken over in between could stamp the cache with
 * the feed it read before the handover, and the whole rest of the day would replay that stale feed
 * instead of asking arXiv again.
 */
export async function writeArxivRssCache(entry: ArxivRssCacheEntry, database?: RawArxivDatabase): Promise<void> {
  const db = database ?? defaultDatabase();
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO arxiv_rss_cache
        (channel, cache_day, content_hash, item_count, fetched_at, http_status, response_headers, duration_ms)
      VALUES
        (${entry.channel}, ${entry.cacheDay}::date, ${entry.contentHash}, ${entry.itemCount}, ${entry.fetchedAt},
         ${entry.httpStatus}, ${JSON.stringify(entry.headers)}::text::jsonb, ${entry.durationMs})
      ON CONFLICT (channel, cache_day) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        item_count = EXCLUDED.item_count,
        fetched_at = EXCLUDED.fetched_at,
        http_status = EXCLUDED.http_status,
        response_headers = EXCLUDED.response_headers,
        duration_ms = EXCLUDED.duration_ms`;
  });
}

export interface HydrationRecoveryOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
  minIntervalMs?: number;
  // Bounded work per explicit invocation; the metadata API accepts at most 100 IDs in one request.
  limit?: number;
  // An exception that already failed this many times stops being selected, so an operator-triggered
  // loop can never turn into an unbounded retry.
  maxAttempts?: number;
  // How often the shared collection lease is renewed while the refetch is in flight. The default keeps
  // a request that legitimately runs for a minute from losing the channel to the next entry.
  leaseHeartbeatMs?: number;
  // How long a single renewal may stay unanswered before the refetch fails closed, and how long the
  // local view of one lease term may go unrefreshed. Both are bounded on purpose: a run must not
  // dispatch on a lease nobody could confirm, and a hung database round trip must not hold it open.
  leaseRenewalTimeoutMs?: number;
  leaseSeconds?: number;
}

export type HydrationRecoveryStatus = "refetched" | "skipped" | "busy" | "idle" | "disabled" | "failed";

export interface HydrationRecoveryResult {
  status: HydrationRecoveryStatus;
  considered: number;
  requestedIds: string[];
  resolvedIds: string[];
  unresolvedIds: string[];
  recordedExceptionCount: number;
  resolvedExceptionCount: number;
  nextEligibleAt?: string;
  failureReason?: HydrationRecoveryFailureReason;
  message?: string;
  // Set when the run's own outcome could be reported but its lease could not be handed back. The
  // outcome is KEPT and this rides with it, so "refetched" is never silently also "and the channel is
  // still held". The recovery script prints the whole object, so an operator sees it without needing
  // any schema of its own.
  cleanupFailure?: string;
}

function emptyRecovery(status: HydrationRecoveryStatus): HydrationRecoveryResult {
  return {
    status,
    considered: 0,
    requestedIds: [],
    resolvedIds: [],
    unresolvedIds: [],
    recordedExceptionCount: 0,
    resolvedExceptionCount: 0,
  };
}

// The one explicit entry that retries unresolved hydration exceptions. It is never scheduled and
// never called by collectAndStoreArxiv: ordinary collection skips open exceptions instead of
// re-asking for versions it already knows are absent.
//
// It shares ordinary collection's durable gate: the same owner lease is claimed first, so two
// refetches — or a refetch and a collection — can never overlap, and neither touches the network while
// the ownerless HTTP429 hold is active. A transport failure is counted against every open exception it
// covered, a rate limit hands the lease over to the shared hold, and only a stored version resolves.
export async function refetchHydrationExceptions(
  options: HydrationRecoveryOptions = {},
): Promise<HydrationRecoveryResult> {
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`limit must be an integer between 1 and 100, received ${String(limit)}`);
  }
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, received ${String(maxAttempts)}`);
  }

  // The recovery entry obeys the same collection switches as the scheduled job: with collection
  // switched off it must not reach arXiv at all.
  if (process.env.COLLECT_ENABLED !== "true" || process.env.ARXIV_NATIVE_COLLECT_ENABLED !== "true") {
    return emptyRecovery("disabled");
  }

  const stateApi = await import("./collection-state.ts");
  const { sql } = await import("../db.ts");

  const admission = await stateApi.claimCollectionLease();
  if ("status" in admission && admission.status === "skipped") {
    return { ...emptyRecovery("skipped"), nextEligibleAt: admission.nextEligibleAt };
  }
  if ("status" in admission) {
    return { ...emptyRecovery("busy"), nextEligibleAt: admission.nextEligibleAt ?? undefined };
  }
  const lease = admission;
  // Set when a real 429 could not be turned into a durable hold: the lease must then be left in place
  // rather than released, so the row cannot be read as "no pause was needed".
  let holdUnconfirmed = false;
  // The value this call is about to hand back, recorded as it is built. Every exit below goes through
  // `settle`, which is what lets the finally still reach the very object the caller will receive: a
  // release that fails AFTER the outcome was decided is attached to that outcome instead of being
  // swallowed by a bare `.catch(() => {})` that announced a clean finish which never happened.
  let settled: HydrationRecoveryResult | undefined;
  const settle = (value: HydrationRecoveryResult): HydrationRecoveryResult => (settled = value, value);
  // Held rather than thrown from the catch, so the cleanup below cannot replace what the run really
  // reported — the same arrangement, and the same reason, as the collection job's own run.
  let pendingError: unknown;

  try {
    const open = await sql<{ arxiv_id: string }[]>`
      SELECT arxiv_id FROM arxiv_hydration_exceptions
      WHERE resolved_at IS NULL AND attempts < ${maxAttempts}
      GROUP BY arxiv_id
      ORDER BY min(first_seen_at) ASC
      LIMIT ${limit}`;
    const requestedIds = open.map((row) => row.arxiv_id);
    if (requestedIds.length === 0) return settle(emptyRecovery("idle"));

    // The retry budget this queue is built on (`attempts < maxAttempts`) is shared state, so it is only
    // ever moved while this process still owns the lease, and the ownership check runs INSIDE the same
    // transaction as the update. A stale owner that was taken over can therefore neither spend a retry
    // the new owner needs nor overwrite the reason the exception is carrying. `undefined` means the
    // write was refused because the lease was gone, which is reported as exactly that instead of as a
    // counted failure.
    const recordAttempt = async (failure: HydrationAttemptFailure): Promise<number | undefined> => {
      try {
        return await recordHydrationAttemptFailure(failure, stateApi.ownerGuardedDatabase(lease));
      } catch (error) {
        if (error instanceof stateApi.ArxivControlPlaneError) return undefined;
        throw error;
      }
    };
    // Both control-plane failures are reported as themselves and neither is counted. They stay apart so
    // a database that could not answer is never written down as a confirmed takeover — the ownership
    // may well still be ours — while both stop the run, because neither can show the channel is still
    // held, and that is exactly the distinction the caller needs to read.
    const controlPlane = (error: ControlPlaneFailure): HydrationRecoveryResult => {
      const unconfirmed = !(error instanceof stateApi.ArxivLeaseLostError);
      return {
        ...emptyRecovery("failed"),
        considered: requestedIds.length,
        requestedIds,
        unresolvedIds: requestedIds,
        recordedExceptionCount: 0,
        failureReason: unconfirmed ? "lease_unconfirmed" : "lease_lost",
        message: error.cause === undefined
          ? error.message
          : `${error.message} (the request it stopped reported: ${String(error.cause)})`,
      };
    };

    const throttle: ArxivChannelThrottle = stateApi.collectionThrottle({
      minIntervalMs: options.minIntervalMs,
      sleep: options.sleep,
      now: options.now,
    });
    const channel = createArxivChannel({
      fetch: options.fetch,
      sleep: options.sleep,
      now: options.now,
      minIntervalMs: options.minIntervalMs,
      throttle,
      // The dispatch boundary's real question, asked of the durable state rather than of the local
      // cancellation signal: the refetch renews the shared lease with nothing left between it and the
      // network call, and refuses to send the request when the answer is missing or says the channel
      // has changed hands. See createArxivChannel and confirmCollectionLease.
      guard: (signal) => {
        signal.throwIfAborted();
        return stateApi.confirmCollectionLease(lease, { context: "before the request was dispatched" });
      },
    });
    /**
     * Turns a real HTTP429 into the shared durable hold. The owner-conditioned write goes first; if it
     * fails — the row could not be reached, or the lease CAS no longer matched — a conservative ownerless
     * floor is attempted, which never steals a successor's lease and only ever EXTENDS the pause. BOTH
     * writes carry the source's own Retry-After, so the fallback cannot report success while quietly
     * cutting a longer deadline back to six hours. Only when both fail is the hold unconfirmed.
     * `undefined` means the hold is durable.
     */
    const holdAfterRateLimit = async (retryAfter?: number): Promise<unknown | undefined> => {
      try {
        await stateApi.deferRateLimitedCollection(lease, retryAfter);
        return undefined;
      } catch (holdError) {
        try {
          if (await stateApi.holdCollectionConservatively(lease, retryAfter)) return undefined;
        } catch (fallbackError) {
          return new AggregateError([holdError, fallbackError],
            "the durable 429 hold could not be written, and neither could a conservative ownerless floor");
        }
        return holdError;
      }
    };

    let durationMs = 0;
    let page: CollectionResult;
    try {
      // The refetch shares the collection lease, so it is renewed before the request and kept alive
      // while the answer is in flight: a slow recovery answer cannot lose the channel to the next
      // entry in the middle of its request. The signal it hands back is that lease's cancellation, so a
      // takeover aborts the request instead of letting it finish on a connection this process no longer
      // owns, and a lease already lost before the request is refused at the dispatch boundary.
      page = await stateApi.withLeaseHeartbeat(lease, (signal) => channel.run(signal, async (fetchImpl) => {
        const startedMs = Date.now();
        try {
          return await collectArxivMetadata({
            idList: [...requestedIds],
            fetch: fetchImpl,
            maxResults: requestedIds.length,
            timeoutMs: options.timeoutMs,
            maxBytes: options.maxBytes,
          });
        } finally {
          durationMs = Date.now() - startedMs;
        }
      }), { intervalMs: options.leaseHeartbeatMs, renewalTimeoutMs: options.leaseRenewalTimeoutMs, leaseSeconds: options.leaseSeconds });
    } catch (error) {
      // The real 429 is identified FIRST — through whatever wrappers it collected on the way here — and
      // the steps below cannot lose it. A rate limit is a fact about arXiv, not about whether this run
      // could still write its diagnostics or spend its budget, so neither a diagnostic that could not be
      // stored, nor a budget write refused because the channel changed hands, nor a takeover that made
      // the renewal fail may turn a real 429 into "no pause was needed".
      const rateLimited = isArxivRateLimited(error);
      const controlPlaneFailure = error instanceof stateApi.ArxivControlPlaneError ? error : undefined;

      // The failure really was observed — a request was dispatched and it failed — so its evidence is
      // written down whatever happens next. This table is append-only diagnostics that no scheduling
      // decision reads, so it is the part of the record that survives an ownership change: if the budget
      // write below is refused because the channel changed hands, the status, headers and duration of
      // what this run really saw are still there to review. Its OWN failure is kept as a second fact
      // instead of being allowed to abort everything after it.
      const failure = describeHydrationFailure(error, requestedIds, channel.lastResponse(), durationMs);
      let evidenceError: unknown | undefined;
      if (controlPlaneFailure === undefined || rateLimited) {
        try {
          await recordHydrationRejection({
            kind: "transport",
            requestedIds,
            detail: failure.message,
            findings: [],
            httpStatus: failure.httpStatus,
            headers: failure.headers,
            durationMs,
          });
        } catch (writeError) {
          evidenceError = writeError;
        }
      }

      // The shared retry budget comes next, and only while this process still owns the lease: a run that
      // was taken over may not spend a retry the new owner needs. A budget write that fails outright is
      // kept as its own fact too, because it must not be able to stop the 429 below either.
      let recordedExceptionCount: number | undefined;
      let budgetError: unknown | undefined;
      if (controlPlaneFailure === undefined) {
        try {
          recordedExceptionCount = await recordAttempt(failure);
        } catch (writeError) {
          budgetError = writeError;
        }
      }

      // The 429 comes LAST because handing the row to the ownerless hold takes the lease away, and the
      // two writes above are owner-guarded: doing it first would refuse this run's OWN budget write and
      // turn a countable failure into a takeover. What matters is that it is reached on EVERY path that
      // saw a real 429 — which is exactly the property round 6 was missing — and nothing above can skip
      // it any more, because both of them are now bounded by try/catch instead of returning or throwing.
      // Both of its own writes are owner-conditioned, so a successor's lease is never taken over here:
      // when somebody else owns the row the hold simply cannot be committed by this run, which is
      // REPORTED rather than forced. When neither write goes through, the run keeps its lease instead of
      // releasing it (holdUnconfirmed), so the row can never afterwards be read as "no hold was needed".
      let holdError: unknown | undefined;
      if (rateLimited) {
        holdError = await holdAfterRateLimit(retryAfterSeconds(
          channel.lastResponse()?.headers["retry-after"], options.now?.() ?? new Date()));
        if (holdError !== undefined) holdUnconfirmed = true;
      }

      /**
       * The ONE shape for "a real 429 that could not be made into a durable pause": the request error,
       * whatever else this branch collected, the hold failure itself, and the operator duty it implies.
       * Round 7 found the opposite arrangement here — every exit rebuilt this list by hand, so one of
       * them could report the pause without the failure and, worse, the plain-429 exit below reported
       * a clean "skipped" without ever looking at `holdError` at all. Every exit that knows a hold
       * failure now goes through here, which is what makes both impossible: no exit may announce the
       * shared pause without the hold, and none may report the hold without the failure. `error` is
       * the request failure itself — and on the control-plane path it is the very object
       * `controlPlaneFailure` names — so the real 429 is always the first fact in the aggregate.
       */
      const holdFailureReport = (context: string, extra: readonly unknown[] = []): AggregateError =>
        new AggregateError(
          [error, ...extra, ...(evidenceError === undefined ? [] : [evidenceError]), holdError],
          `arXiv HTTP 429: ${context}; the shared durable cooldown could not be committed — ${stateApi.ARXIV_HOLD_UNCONFIRMED_NOTICE}`,
        );

      // A lease lost while the refetch was running is not an upstream failure. The renewal was refused,
      // the request it aborted never produced a trustworthy answer, and counting it would spend a retry
      // of the budget the new owner needs — including the case where the INITIAL renewal is refused and
      // no request was ever dispatched. It is reported as the takeover it was, with nothing counted.
      // Whatever the cancelled request reported is carried along as the cause instead of being dropped.
      // An UNCONFIRMED renewal — a database that never answered — is treated the same way for the same
      // reason, and is reported under its own name so the two are never confused in the record.
      //
      // The old owner still never moves the shared business budget. But it may not silently drop the
      // real 429 either: the hold above was already attempted, so the pause is stated on the takeover's
      // own record instead of disappearing behind it, and a hold that could not be committed is
      // reported as a second fact rather than swallowed.
      if (controlPlaneFailure !== undefined) {
        if (holdError !== undefined) throw holdFailureReport("the channel was lost");
        const reported = controlPlane(controlPlaneFailure);
        return settle(rateLimited
          ? { ...reported, message: `${reported.message}; the real HTTP429 was committed as a shared durable hold, so every entry point waits it out` }
          : reported);
      }

      // The budget could not be written at all. The 429's hold was still attempted above, so its
      // semantics survive; both facts are reported instead of one replacing the other.
      if (budgetError !== undefined) {
        // A hold that failed ALONGSIDE the budget is not dropped here. They are two separate facts and
        // an operator needs both to know what is missing; this branch used to report the budget alone,
        // so a 429 whose pause never became durable vanished from exactly the record meant to carry it.
        if (rateLimited && holdError !== undefined) {
          throw holdFailureReport("the run failed and its recovery budget could not be written", [budgetError]);
        }
        throw rateLimited
          ? new AggregateError([error, ...(evidenceError === undefined ? [] : [evidenceError]), budgetError],
              "arXiv HTTP 429: the run failed and its recovery budget could not be written; the shared durable hold was committed, so every entry point still waits it out")
          : budgetError;
      }
      // Refused: the lease was taken over between the answer and the write, so the failure that was
      // really observed by this run may no longer be attributed to the shared budget. The hold above
      // stands either way: a 429 was already a fact before the budget was touched.
      if (recordedExceptionCount === undefined) {
        const lost = new stateApi.ArxivLeaseLostError(
          "arXiv collection lease lost before the recovery budget could be written");
        if (holdError !== undefined) {
          // The refused budget is reported as the takeover it was, the takeover is named as its own
          // fact, and the 429 the run really got stays in the report alongside them — an operator
          // reading this must not have to infer the rate limit from the prose.
          throw holdFailureReport("the lease was lost", [lost]);
        }
        const reported = controlPlane(lost);
        return settle(rateLimited
          ? { ...reported, message: `${reported.message}; the real HTTP429 was committed as a shared durable hold, so every entry point waits it out` }
          : reported);
      }
      if (rateLimited) {
        // A rate limit is shared: the lease was handed over to the durable hold, so ordinary collection
        // and every later recovery skip the network until it expires. The failed attempt is already
        // counted, so this can never become an unbounded retry loop. The status was read through any
        // wrapper, so a 429 still established the hold even when a cleanup failure travelled with it.
        //
        // This is the exit round 7 caught: it tested `rateLimited` alone and never looked at
        // `holdError`, so a hold that failed while the budget write happened to SUCCEED fell all the
        // way through to here and was returned as an ordinary "skipped" — carrying a `nextEligibleAt`
        // read from a row that still held nothing but the plain 120 s lease. That announced a shared
        // pause which had never been established. The pause is now only described, and only ever given
        // a deadline, once the hold is CONFIRMED: with a hold failure in hand there is no pause to
        // report and the failure takes this exit instead of a success result.
        if (holdError !== undefined) throw holdFailureReport("the run was rate limited");
        const held = await sql<{ lease_until: Date }[]>`
          SELECT lease_until FROM arxiv_collection_state WHERE key = 'astro-ph'`;
        return settle({
          ...emptyRecovery("skipped"),
          considered: requestedIds.length,
          requestedIds,
          unresolvedIds: requestedIds,
          recordedExceptionCount,
          nextEligibleAt: held[0]?.lease_until?.toISOString(),
          failureReason: failure.reason,
          message: failure.message,
        });
      }
      // Not a rate limit, so no hold was ever attempted and `holdError` cannot be set on this path —
      // every exit above that could carry one has already taken it. What the run really saw is still
      // reported, with the rejection evidence's own failure appended rather than allowed to replace it.
      return settle({
        ...emptyRecovery("failed"),
        considered: requestedIds.length,
        requestedIds,
        unresolvedIds: requestedIds,
        recordedExceptionCount,
        failureReason: failure.reason,
        message: evidenceError === undefined
          ? failure.message
          : `${failure.message} (the rejection evidence could not be recorded: ${String(evidenceError).slice(0, 300)})`,
      });
    }

    const classified = classifyHydrationPage(page.papers, requestedIds);
    if (classified.versionMismatch.length > 0) {
      // The answer is untrustworthy: nothing is stored, but the rejection and the failed attempt both
      // stay reviewable offline instead of collapsing into one error string.
      const error = hydrationVersionMismatchError(classified.versionMismatch);
      const response = channel.lastResponse();
      await recordHydrationRejection({
        kind: "version_mismatch",
        requestedIds,
        detail: error.message,
        findings: classified.versionMismatch,
        httpStatus: response?.status ?? null,
        headers: response?.headers ?? {},
        durationMs,
        rawAtom: page.raw_atom,
      });
      const recordedExceptionCount = await recordAttempt({
        requestedIds,
        reason: "version_mismatch",
        message: error.message,
        httpStatus: response?.status ?? null,
        headers: response?.headers ?? {},
        durationMs,
      });
      if (recordedExceptionCount === undefined) {
        return settle(controlPlane(new stateApi.ArxivLeaseLostError(
          "arXiv collection lease lost before the recovery budget could be written")));
      }
      return settle({
        ...emptyRecovery("failed"),
        considered: requestedIds.length,
        requestedIds,
        unresolvedIds: requestedIds,
        recordedExceptionCount,
        failureReason: "version_mismatch",
        message: error.message,
      });
    }

    const response = channel.lastResponse();
    let saved: HydrationBatchResult;
    try {
      saved = await ingestHydratedArxivBatch({
        page,
        requestedIds,
        acceptedIds: classified.accepted.map((paper) => paper.arxiv_id),
        exceptions: [...classified.missing, ...classified.unexpected],
        meta: {
          httpStatus: response?.status ?? null,
          headers: response?.headers ?? {},
          pagination: hydrationPagination(page.raw_atom, requestedIds.length, page.papers.length, 0, requestedIds.length),
          durationMs,
        },
      }, stateApi.ownerGuardedDatabase(lease));
    } catch (error) {
      if (/raw feed conflict/.test(String(error))) {
        // The stored version disagrees with the answer: the batch is rolled back (nothing was written)
        // and the failed attempt is counted like any other, so the retry stays bounded too.
        await recordHydrationRejection({
          kind: "content_conflict",
          requestedIds,
          detail: String(error).slice(0, 4000),
          findings: [],
          httpStatus: response?.status ?? null,
          headers: response?.headers ?? {},
          durationMs,
          rawAtom: page.raw_atom,
        });
        const recordedExceptionCount = await recordAttempt({
          requestedIds,
          reason: "content_conflict",
          message: String(error).slice(0, 4000),
          httpStatus: response?.status ?? null,
          headers: response?.headers ?? {},
          durationMs,
        });
        if (recordedExceptionCount === undefined) {
          return settle(controlPlane(new stateApi.ArxivLeaseLostError(
            "arXiv collection lease lost before the recovery budget could be written")));
        }
        return settle({
          ...emptyRecovery("failed"),
          considered: requestedIds.length,
          requestedIds,
          unresolvedIds: requestedIds,
          recordedExceptionCount,
          failureReason: "content_conflict",
          message: String(error).slice(0, 4000),
        });
      }
      throw error;
    }

    const resolvedIds = classified.accepted.map((paper) => paper.arxiv_id);
    const resolved = new Set(resolvedIds);
    return settle({
      status: "refetched",
      considered: requestedIds.length,
      requestedIds,
      resolvedIds,
      unresolvedIds: requestedIds.filter((id) => !resolved.has(id)),
      recordedExceptionCount: saved.recordedExceptionCount,
      resolvedExceptionCount: saved.resolvedExceptionCount,
    });
  } catch (error) {
    pendingError = error;
  } finally {
    // Handing the lease to the durable hold clears the owner, so this release is a no-op then. It is
    // skipped entirely when a 429 could not be turned into a durable hold: clearing the row would erase
    // the only trace of the pause and let the next entry read "no hold" from a state nobody could vouch
    // for. The lease is left to expire on its own instead, which is the conservative side.
    if (!holdUnconfirmed) {
      try {
        await stateApi.releaseCollection(lease);
      } catch (releaseError) {
        // One rule for two runs: a release failure may never replace what the run itself reported.
        // When the run produced a result, the failure rides WITH it — `settled` is the very object the
        // caller receives — so "refetched" is never also a silent "and the channel is still held".
        // When the run is already throwing there is no result to carry it, so it is merged into the
        // error on its way out instead of being dropped by a bare `.catch(() => {})`.
        if (settled !== undefined) {
          settled.cleanupFailure =
            `the collection lease could not be released: ${String(releaseError).slice(0, 300)}`;
        } else {
          pendingError = pendingError === undefined
            ? releaseError
            : new AggregateError([pendingError, releaseError],
                "the hydration recovery failed and its collection lease could not be released");
        }
      }
    }
  }
  // Only reached when the run threw: every successful exit returned from inside the try above, and the
  // `settle` call that built that result is how the finally could still reach the object it handed
  // back. Nothing here can run with an unset `pendingError`, but the type has to be told so.
  throw pendingError ?? new Error("the hydration recovery ended without an outcome or a result");
}
