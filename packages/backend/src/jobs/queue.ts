// Job queue on PostgreSQL (pg-boss). Every queue is declared here with the data its jobs carry and its
// retry policy: business code enqueues by name, the worker registers one handler per queue (jobs/*.ts),
// and both sides are checked against JobData, so a payload cannot drift between producer and consumer.
import { PgBoss, type SendOptions, type WorkOptions } from "pg-boss";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { recordOpsError, sanitizeOpsMessage, withRecordingFailure } from "../operations/error-events.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
export { shutdownSignal } from "../lib/shutdown.ts";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export interface JobData {
  "imagery.apod": { date: string };
  "content.analyze": { articleId: string; attemptTag?: string };
  "content.extract-body": { articleId: string };
  "events.group": { articleId: string; signalOnly?: boolean };
  "events.digest": { storyId: number };
  "sources.fetch": { sourceId: string; force?: boolean };
  "sources.fetch-x": { key: string; sourceIds: string[] };
  "sources.mp": { sourceId: string; reason?: "schedule" | "manual" };
  "notify.selected": { articleId: string; attempt?: number };
  "publication.republish-source": { sourceId: string };
  "media.prepare": { articleId: string } | { url: string; mode: string };
}
export type QueueName = keyof JobData;

export const QUEUES = {
  imageryApod: "imagery.apod",
  analyze: "content.analyze",
  extractBody: "content.extract-body",
  group: "events.group",
  digest: "events.digest",
  fetchSource: "sources.fetch",
  fetchXShard: "sources.fetch-x",
  mpCheck: "sources.mp",
  notifySelected: "notify.selected",
  republishSource: "publication.republish-source",
  prepareMedia: "media.prepare",
} as const satisfies Record<string, QueueName>;

type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;
type QueueUpdateOptions = NonNullable<Parameters<PgBoss["updateQueue"]>[1]>;

/** Queue definitions in one place; created on first use by any process. */
const QUEUE_OPTIONS: Record<QueueName, QueueOptions> = {
  [QUEUES.imageryApod]: { policy: "exclusive", retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.analyze]: { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.extractBody]: { policy: "short", retryLimit: 2, retryDelay: 120, expireInSeconds: 300 },
  [QUEUES.group]: { policy: "short", retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.digest]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.fetchSource]: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
  [QUEUES.fetchXShard]: { policy: "short", retryLimit: 0, expireInSeconds: 900 },
  [QUEUES.mpCheck]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.notifySelected]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.republishSource]: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 },
  [QUEUES.prepareMedia]: { policy: "short", retryLimit: 1, retryDelay: 120, expireInSeconds: 600 },
};

const ensured = new Set<string>();

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: config.databaseUrl, max: 4, schema: "pgboss", application_name: "aihot-jobs" });
    b.on("error", (err) => console.error("[pg-boss]", err));
    try {
      await b.start();
      boss = b;
      return b;
    } catch (error) {
      await b.stop({ graceful: false }).catch((cleanup) => console.error("[pg-boss] startup cleanup", cleanup));
      throw error;
    } finally {
      // A temporary connection error must not leave every caller sharing a rejected promise.
      starting = null;
    }
  })();
  return starting;
}

/** The longest single paid call (a translation batch, 180 s) plus margin; Docker waits longer (stop_grace_period). */
export const STOP_TIMEOUT_MS = 195_000;

export async function stopBoss(): Promise<void> {
  shutdownSignal.abort();
  if (boss) await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  boss = null;
  starting = null;
}

/** A queue's settings that pg-boss can update; policy is fixed at creation time and is not one. */
function updatable(options: QueueOptions): QueueUpdateOptions {
  const { policy: _policy, ...rest } = options as QueueOptions & { policy?: unknown };
  return rest as QueueUpdateOptions;
}

/** Whether an existing queue disagrees with the settings this call asked for. */
function queueDrift(existing: object, options: QueueOptions): boolean {
  const current = existing as Record<string, unknown>;
  return Object.entries(options).some(([key, value]) => key !== "policy" && current[key] !== value);
}

export async function ensureQueue(name: string, options: QueueOptions = QUEUE_OPTIONS[name as QueueName] ?? {}): Promise<void> {
  if (ensured.has(name)) return;
  const b = await getBoss();
  const existing = await b.getQueue(name);
  if (!existing) await b.createQueue(name, options);
  // An existing queue keeps whatever it was created with, so a changed retry policy would otherwise
  // never take effect: an arXiv collection queue that still retried internally would run a second
  // attempt seconds after a failure, outside the six-hour spacing and outside its daily budget.
  else if (queueDrift(existing, options)) await b.updateQueue(name, updatable(options));
  ensured.add(name);
}

function queueDb(tx: Db) {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
}

/** Enqueues a job. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueue<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions = {}, tx?: Db): Promise<string | null> {
  await ensureQueue(name);
  const b = await getBoss();
  return b.send(name, data, tx ? { ...options, db: queueDb(tx) } : options);
}

/** A receipt release also wakes jobs (e.g. grouping/embeddings) that exhausted their queue retries.
 * The release must follow the failed attempt's start: it may arrive while that attempt is finishing,
 * but cannot keep reviving attempts started after it.
 * Reading the durable audit also recovers a crash between the release and this sweep.
 */
export async function retryReleasedReceiptJobs(): Promise<number> {
  const b = await getBoss();
  return sql.begin(async (tx) => {
    const jobs = await tx<{ id: string; name: string }[]>`
      SELECT j.id, j.name FROM pgboss.job j
      WHERE j.state = 'failed'
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'receipt.release'
                    AND a.subject = 'receipt:' || (j.output->>'receiptId') AND a.created_at > j.started_on)
      ORDER BY j.completed_on LIMIT 200 FOR UPDATE OF j SKIP LOCKED`;
    for (const job of jobs) await b.retry(job.name, job.id, { db: queueDb(tx) });
    return jobs.length;
  });
}

/** The worker's handler for one queue (jobs/*.ts), called with each job's data. */
export async function work<Q extends QueueName>(boss: PgBoss, name: Q, options: WorkOptions, handler: (data: JobData[Q]) => Promise<unknown>): Promise<void> {
  await ensureQueue(name);
  await boss.work<JobData[Q]>(name, options, async ([job]) => (job ? handler(job.data) : undefined));
}

// Scheduled task bookkeeping: every run leaves a row, so operators see the latest result.

/**
 * A run that completed but left something behind is still visible as failed for operators; it just is
 * not retried. arXiv analysis catches per-paper model errors to keep healthy papers moving, and the
 * arXiv collection reports a structured partial result when its window was handled but some versions
 * stayed as open exceptions — retrying those would run the whole window again, which the durable
 * collection budget now stops.
 */
function incompleteReason(job: string, detail: object): string | undefined {
  if (job === "arxiv.collect" && "partial" in detail && detail.partial === true) {
    return "arXiv 采集未完全入库：个别版本留在异常记录中；详见运行明细";
  }
  if (job === "arxiv.analyze" && "failed" in detail && typeof detail.failed === "number" && detail.failed > 0) {
    return "arXiv 初筛部分论文失败；详见运行明细";
  }
  return undefined;
}

/**
 * Redacts credentials from an error's message and stack (and any `cause` or AggregateError members)
 * before it leaves recordRun. The job_runs row is not the only place this text lands: the caller
 * (the worker) serialises the thrown error into its own job output, which operator views read back,
 * so redaction must travel WITH the error rather than stop at the row. The error object and its class
 * are preserved, so failure handling that inspects the error keeps working — only the text a caller
 * would store or print is redacted.
 */
function redactErrorForEgress(error: unknown, seen = new Set<unknown>()): unknown {
  if (typeof error === "string") return sanitizeOpsMessage(error);
  if (!(error instanceof Error) || seen.has(error)) return error;
  seen.add(error);
  error.message = sanitizeOpsMessage(error.message);
  if (typeof error.stack === "string") error.stack = sanitizeOpsMessage(error.stack);
  // The recursion result must be written BACK, not merely computed: a cause or an AggregateError
  // member can be a plain string (a driver DSN routinely is), and a string cannot be mutated in
  // place. Dropping the returned value would leave the original string on the error, which the
  // caller's serialiser then writes out.
  if (error.cause !== undefined) error.cause = redactErrorForEgress(error.cause, seen);
  if (error instanceof AggregateError) {
    const members = error.errors;
    for (let i = 0; i < members.length; i++) members[i] = redactErrorForEgress(members[i], seen);
  }
  return error;
}

/**
 * Runs one job and leaves its row in job_runs. The run id is handed to the callback so a domain entry
 * can tie the failure events it records to this run instead of guessing at "the latest one".
 */
export async function recordRun<T>(job: string, fn: (runId: number) => Promise<T>): Promise<T> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`;
  const runId = row!.id;
  try {
    const result = await fn(runId);
    const detail = result && typeof result === "object" ? result : { result };
    const incomplete = incompleteReason(job, detail);
    await sql`UPDATE job_runs SET status = ${incomplete ? 'failed' : 'ok'}, finished_at = now(),
      detail = ${sql.json(detail as never)}, error = ${incomplete ?? null}
      WHERE id = ${runId}`;
    return result;
  } catch (error) {
    // The run row update is bookkeeping, not the failure itself: when the database cannot even take
    // this UPDATE, the original error must still leave the run — with the bookkeeping failure beside
    // it and the recording gap stated, not one quietly replacing the other. The message is redacted
    // here too: a driver error routinely carries a DSN, and this row is read back by operator views.
    let reported = error;
    try {
      await sql`UPDATE job_runs SET status = 'failed', finished_at = now(), error = ${sanitizeOpsMessage(String(error)).slice(0, 4000)} WHERE id = ${runId}`;
    } catch (updateError) {
      reported = new AggregateError([error, updateError], `${sanitizeOpsMessage(String(error))} (the job_runs row could not be marked failed)`);
    }
    // A domain entry that observed this failure records the event the report counts; this generic row
    // is its parent and is never added on top of it (see docs/ERROR-RECORDING.md). Recording is best-effort
    // and must not replace the error that is already on its way out.
    const record = await recordOpsError({
      stage: "job",
      code: "task_failed",
      message: String(error),
      observationKey: `job_run:${runId}`,
      groupKey: `job:${job}`,
      jobRunId: runId,
      details: { job, parent: true },
    });
    throw redactErrorForEgress(withRecordingFailure(reported, record));
  }
}
