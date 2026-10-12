// A deployment-wide ceiling on in-flight paid model calls. Six fixed database rows are the whole
// mechanism: a caller takes one by stamping a UUID token into a free row and gives it back when the
// call is done. The wait never holds a connection, so the ceiling costs one short UPDATE per attempt,
// not a long transaction. There is deliberately no TTL, reaper or expiry: a permit whose upstream
// outcome is unknown stays occupied until an operator releases that exact token after independently
// confirming the provider call finished.
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { ProviderRejectedError } from "./receipts.ts";
import { MODEL_NORMAL_ADMISSION_LOCK, MODEL_NORMAL_PERMIT_LIMIT, paceAfterResponse, providerPacing, tryProviderPermit, type ProviderPacing } from "./provider-pacing.ts";

/** Shared soft cap on simultaneously occupied slots across every admission path. */
export { MODEL_NORMAL_PERMIT_LIMIT };

/** Physical permit rows; normal admission never occupies more than MODEL_NORMAL_PERMIT_LIMIT. */
export const MODEL_PERMIT_LIMIT = 6;
const DEFAULT_WAIT_MS = 1000;

/** No free slot within the bounded wait (or the limiter database is unreachable). Never sent upstream. */
export class ModelLimitBusyError extends ProviderRejectedError {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds = 60) {
    super(message, null, true);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export interface AcquireModelPermitOptions {
  /** How long a caller may wait for a free slot before giving up. Bounded on purpose. */
  waitMs?: number;
  /** Stops the wait early (used for process shutdown). */
  signal?: AbortSignal;
  provider?: ProviderPacing | null;
}

function abortError(): ProviderRejectedError {
  return new ProviderRejectedError("model permit acquisition aborted", null, true);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Takes one of the model slots. Each attempt is a short transaction under the shared admission
 * lock, so it hands its database connection back as soon as it runs; the wait between attempts
 * happens entirely outside the database. No connection is held while the upstream call runs.
 */
export async function acquireModelPermit(purpose: string, subject: string, options: AcquireModelPermitOptions = {}): Promise<string> {
  const token = randomUUID();
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    let rows: { slot: number }[];
    let delayMs = 25;
    try {
      if (options.provider) {
        const result = await tryProviderPermit(options.provider, purpose, subject);
        if (result.token) return result.token;
        delayMs = result.waitMs;
        rows = [];
      } else rows = await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${MODEL_NORMAL_ADMISSION_LOCK}))`;
        const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM model_permits WHERE token IS NOT NULL`;
        if (Number(count!.n) >= MODEL_NORMAL_PERMIT_LIMIT) return [] as { slot: number }[];
        return await tx<{ slot: number }[]>`
          UPDATE model_permits SET
            token = ${token}, state = 'active', purpose = ${purpose}, subject = ${subject}, acquired_at = now()
          WHERE slot = (
            SELECT slot FROM model_permits
            WHERE token IS NULL AND state = 'active'
            ORDER BY slot
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING slot`;
      });
    } catch (error) {
      // A limiter that cannot reach its database must not let the call be sent.
      throw new ProviderRejectedError(`model limit unavailable: ${String(error).slice(0, 300)}`, null, true);
    }
    if (rows.length > 0) return token;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ModelLimitBusyError(`no model slot free within ${waitMs}ms`, options.provider ? Math.max(1, delayMs / 1000) : 60);
    await sleep(Math.min(delayMs, remaining), options.signal);
  }
}

/** Gives back a slot. Unknown token: false. A database failure throws (callers must fail closed). */
export async function releaseModelPermit(token: string): Promise<boolean> {
  const rows = await sql<{ slot: number }[]>`
    UPDATE model_permits SET token = NULL, state = 'active', purpose = NULL, subject = NULL, acquired_at = NULL
    WHERE token = ${token} RETURNING slot`;
  return rows.length > 0;
}

/** Keeps a slot occupied after an outcome we cannot vouch for. Only an operator frees it, by token. */
export async function quarantineModelPermit(token: string): Promise<boolean> {
  const rows = await sql<{ slot: number }[]>`
    UPDATE model_permits SET state = 'quarantined' WHERE token = ${token} RETURNING slot`;
  return rows.length > 0;
}

interface Admission { token: string; url: string; purpose: string; subject: string; used: boolean }
const admissions = new AsyncLocalStorage<Admission>();

/** Wrap paidRequest, not its callback: a busy provider must not create a receipt attempt. */
export async function withModelAdmission<T>(url: string, purpose: string, subject: string, call: () => Promise<T>): Promise<T> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ProviderRejectedError('invalid model admission URL', null, false); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ProviderRejectedError('model admission URL must be http(s)', null, false);
  const provider = providerPacing(parsed);
  // A fresh query embedding is immediately followed by reranking; normal provider
  // spacing must not make that optional step silently fall back on every article.
  const waitMs = provider.name === 'agnes' ? DEFAULT_WAIT_MS : Math.min(provider.intervalMs + 250, 11_000);
  const token = await acquireModelPermit(purpose, subject, { provider, waitMs, signal: shutdownSignal.signal });
  const admission: Admission = { token, url, purpose, subject, used: false };
  try {
    return await admissions.run(admission, call);
  } finally {
    // Reused receipt, budget refusal or failure before modelFetch: no dispatch, so free the slot.
    // Once consumed, modelFetch alone owns release/quarantine, never this finally block.
    if (!admission.used) await releaseModelPermit(token);
  }
}

export function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

/**
 * fetch() for a paid model call, holding one shared slot for exactly as long as the request needs one.
 * The URL and body are validated before any slot is taken, so a malformed request never consumes one.
 * The slot is released as soon as the body has been read - HTTP errors included: the caller's
 * assertAccepted decides what a non-2xx answer means, and the slot must not leak. A connect failure
 * (the request never reached the provider) releases the slot too. Every other thrown transport or
 * body-read error quarantines the slot: a call that may have reached the provider is never silently
 * freed, and only an operator can release it once the outcome is independently proven.
 */
export type ModelRequestInit = Omit<RequestInit, 'signal'> & {
  /** Prefer a factory for model timeouts: invoked only after admission, immediately before send. */
  signal?: AbortSignal | null | (() => AbortSignal);
};

export async function modelFetch(url: string, init: ModelRequestInit, purpose: string, subject: string): Promise<{ res: Response; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderRejectedError(`invalid model url: ${url}`, null, true);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ProviderRejectedError(`model url must be http(s): ${url}`, null, true);
  if (typeof init.body !== "string" || init.body.length === 0) throw new ProviderRejectedError("model request body must be a non-empty string", null, true);

  const provider = providerPacing(parsed);
  const admission = admissions.getStore();
  if (admission && !admission.used && (admission.url !== url || admission.purpose !== purpose || admission.subject !== subject)) {
    throw new ProviderRejectedError('model admission does not match request', null, false);
  }
  const waitSignal = typeof init.signal === 'function' || !init.signal ? shutdownSignal.signal : AbortSignal.any([shutdownSignal.signal, init.signal]);
  // Known providers keep the short legacy fetch wait; unconfigured origins get the bounded
  // rerank-style wait so a cold origin still gets admitted instead of failing busy immediately.
  const token = admission && !admission.used ? admission.token : await acquireModelPermit(purpose, subject, {
    signal: waitSignal,
    provider,
    waitMs: provider.name === 'agnes' || provider.name === 'siliconflow' ? DEFAULT_WAIT_MS : Math.min(provider.intervalMs + 250, 11_000),
  });
  if (admission && !admission.used) admission.used = true;
  let requestSignal: AbortSignal;
  try {
    const signal = typeof init.signal === 'function' ? init.signal() : init.signal;
    // Shutdown stops admission and predispatch, not an already-sent paid answer.
    // Preserve caller cancellation/deadlines; unsignalled callers stay bounded within worker drain.
    requestSignal = signal ?? AbortSignal.timeout(180_000);
    requestSignal.throwIfAborted();
  } catch {
    await releaseModelPermit(token);
    throw new ProviderRejectedError('model signal unavailable or aborted before send', null, true);
  }
  if (shutdownSignal.signal.aborted) {
    await releaseModelPermit(token);
    throw new ProviderRejectedError("model call aborted before send", null, true);
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: requestSignal });
    if (res.status === 429) await paceAfterResponse(provider, res.headers.get('retry-after'));
  } catch (error) {
    if (isConnectFailure(error)) {
      await releaseModelPermit(token);
      throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
    }
    await quarantineModelPermit(token);
    throw error;
  }
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    await quarantineModelPermit(token);
    throw error;
  }
  await paceAfterResponse(provider);
  await releaseModelPermit(token);
  return { res, text };
}
