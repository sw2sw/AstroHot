// Provider-wide admission uses one settings row and the existing six permits. No expiring leases:
// live/quarantined permit tokens stay in the provider's concurrency count until explicitly released.
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Db } from '../db.ts';
import { ProviderRejectedError } from './receipts.ts';

export interface ProviderPacing {
  name: string;
  intervalMs: number;
  maxConcurrent: number;
}

/** Soft cap on occupied permit rows (active or quarantined) shared by every admission path. */
export const MODEL_NORMAL_PERMIT_LIMIT = 4;
/** One global admission lock, always taken before any provider lock so ordering is consistent. */
export const MODEL_NORMAL_ADMISSION_LOCK = 'model_permits:normal_admission';

function positiveInteger(env: string, fallback: number): number {
  const value = process.env[env];
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new ProviderRejectedError(`${env} must be a positive integer`, null, false);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new ProviderRejectedError(`${env} must be a positive integer`, null, false);
  return n;
}

function maxConcurrent(env: string, fallback: number): number {
  const n = positiveInteger(env, fallback);
  if (n > MODEL_NORMAL_PERMIT_LIMIT) throw new ProviderRejectedError(`${env} must be at most ${MODEL_NORMAL_PERMIT_LIMIT}`, null, false);
  return n;
}

/** True when a hostname reaches this machine over loopback (a local test double, or a locally run server). */
function isSameHost(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!v4 && Number(v4[1]) === 127;
}

/** The spacing a loopback origin gets. Unset means the same conservative default as any other origin. */
function loopbackIntervalMs(): number {
  const value = process.env.MODEL_LOOPBACK_ORIGIN_INTERVAL_MS;
  if (value === undefined || value === '') return 10_000;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new ProviderRejectedError('MODEL_LOOPBACK_ORIGIN_INTERVAL_MS must be a non-negative integer', null, false);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new ProviderRejectedError('MODEL_LOOPBACK_ORIGIN_INTERVAL_MS must be a non-negative integer', null, false);
  return n;
}

/** Every model origin gets a pacing policy: known providers by name, everything else by origin. */
export function providerPacing(url: URL): ProviderPacing {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ProviderRejectedError('model url must be an http(s) URL without userinfo', null, false);
  }
  const matches = (name: string, hosts: string[]) => {
    const configured = process.env[`${name}_BASE_URL`];
    if (!configured) return hosts.includes(url.hostname);
    let base: URL;
    try { base = new URL(configured); } catch { throw new ProviderRejectedError(`${name}_BASE_URL must be an http(s) URL`, null, false); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new ProviderRejectedError(`${name}_BASE_URL must be an http(s) URL without userinfo`, null, false);
    }
    return hosts.includes(url.hostname) || base.origin === url.origin;
  };
  const agnes = matches('AGNES', ['api.agnes-ai.cn', 'apihub.agnes-ai.com']);
  const siliconflow = matches('SILICONFLOW', ['api.siliconflow.cn']);
  if (agnes && siliconflow) throw new ProviderRejectedError('ambiguous provider pacing origin', null, false);
  if (agnes) return {
    name: 'agnes',
    intervalMs: Math.ceil(60_000 / positiveInteger('AGNES_REQUESTS_PER_MINUTE', 6)),
    maxConcurrent: maxConcurrent('AGNES_MAX_CONCURRENT', 1),
  };
  if (siliconflow) return {
    name: 'siliconflow',
    intervalMs: Math.ceil(60_000 / positiveInteger('SILICONFLOW_REQUESTS_PER_MINUTE', 6)),
    maxConcurrent: maxConcurrent('SILICONFLOW_MAX_CONCURRENT', 1),
  };
  // An origin on this machine is reached over loopback: a local test double, or a model server (or a
  // gateway) the operator runs beside the application. Reaching the host locally says nothing about a
  // rate limit behind it — a local proxy can still forward to a metered upstream — so this origin keeps
  // the same conservative spacing as any other unconfigured origin. A test environment that serves its
  // own fake provider on this machine lowers it explicitly through MODEL_LOOPBACK_ORIGIN_INTERVAL_MS
  // (tests/setup.ts sets 0); left unset, production behaviour is unchanged. The origin concurrency and
  // the global soft cap apply either way.
  if (isSameHost(url.hostname)) return {
    name: `origin:${createHash('sha256').update(url.origin).digest('hex')}`,
    intervalMs: loopbackIntervalMs(),
    maxConcurrent: maxConcurrent('MODEL_ORIGIN_MAX_CONCURRENT', 2),
  };
  // Unconfigured remote origins share one conservative local policy, keyed by origin alone (no model,
  // key or path), so all model paths on the same origin stay inside one spacing window.
  return {
    name: `origin:${createHash('sha256').update(url.origin).digest('hex')}`,
    intervalMs: 10_000,
    maxConcurrent: maxConcurrent('MODEL_ORIGIN_MAX_CONCURRENT', 2),
  };
}

interface State { nextAt: number; cooldownUntil: number; tokens: string[] }
const emptyState = (): State => ({ nextAt: 0, cooldownUntil: 0, tokens: [] });
const keyFor = (provider: ProviderPacing) => `provider_pacing:${provider.name}`;

async function readState(tx: Db, key: string): Promise<State> {
  const [row] = await tx<{ value: State }[]>`SELECT value FROM settings WHERE key=${key}`;
  if (!row) return emptyState();
  const state = row.value;
  if (!state || !Number.isFinite(state.nextAt) || !Number.isFinite(state.cooldownUntil) ||
      !Array.isArray(state.tokens) || state.tokens.some(token => typeof token !== 'string')) {
    throw new Error('invalid provider pacing state; operator inspection required');
  }
  return state;
}

/** One short transaction admits BOTH the provider and global slot, or admits neither. */
export async function tryProviderPermit(provider: ProviderPacing, purpose: string, subject: string): Promise<{ token?: string; waitMs: number }> {
  return await sql.begin(async tx => {
    // Global admission lock before the provider lock: named, generic and legacy callers all
    // count the same soft cap under the same key, so processes never exceed it together.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MODEL_NORMAL_ADMISSION_LOCK}))`;
    const key = keyFor(provider);
    const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
    if (!lock!.locked) return { waitMs: 100 };
    const state = await readState(tx, key);
    const [clock] = await tx<{ ms: number }[]>`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms`;
    const now = Number(clock!.ms);
    const remaining = Math.max(state.nextAt, state.cooldownUntil) - now;
    if (remaining > 0) return { waitMs: Math.ceil(remaining) };
    const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM model_permits WHERE token IS NOT NULL`;
    if (Number(count!.n) >= MODEL_NORMAL_PERMIT_LIMIT) return { waitMs: 100 };
    const held = state.tokens.length ? await tx<{ token: string }[]>`SELECT token FROM model_permits WHERE token IN ${tx(state.tokens)}` : [];
    state.tokens = held.map(row => row.token);
    if (state.tokens.length >= provider.maxConcurrent) return { waitMs: 100 };
    const token = randomUUID();
    const slots = await tx`UPDATE model_permits SET token=${token},state='active',purpose=${purpose},subject=${subject},acquired_at=now()
      WHERE slot=(SELECT slot FROM model_permits WHERE token IS NULL AND state='active' ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING slot`;
    if (!slots.length) return { waitMs: 100 };
    state.tokens.push(token);
    state.nextAt = now + provider.intervalMs;
    await tx`INSERT INTO settings (key,value) VALUES (${key},${tx.json(state as never)})
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
    return { token, waitMs: 0 };
  }) as { token?: string; waitMs: number };
}

// With the conservative serial default, leave a full interval AFTER an answer too. This avoids
// an initial connection setup delaying the first send and compressing subsequent upstream arrivals.
export async function paceAfterResponse(provider: ProviderPacing, retryAfter?: string | null): Promise<void> {
  await sql.begin(async tx => {
    const key = keyFor(provider);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const state = await readState(tx, key);
    const [clock] = await tx<{ ms: number }[]>`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms`;
    const now = Number(clock!.ms);
    state.nextAt = Math.max(state.nextAt, now + provider.intervalMs);
    if (retryAfter !== undefined) {
      const value = retryAfter?.trim() ?? '';
      const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      const until = Number.isFinite(seconds) ? now + seconds * 1000 : (/^[A-Za-z]{3}, /.test(value) ? Date.parse(value) : NaN);
      state.cooldownUntil = Math.max(state.cooldownUntil, now + provider.intervalMs,
        Number.isFinite(until) && until >= now ? until : now + 60_000);
    }
    await tx`UPDATE settings SET value=${tx.json(state as never)},updated_at=now() WHERE key=${key}`;
  });
}
