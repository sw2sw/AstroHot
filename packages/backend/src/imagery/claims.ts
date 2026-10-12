import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";

// A claim is a five-minute lease on one (source, date) pair so only one worker generates imagery
// for it. The lease outlasts the longest paid stage (integration HTTP 20s, model call 60s); if a
// worker crashes mid-stage the lease expires and another worker reclaims the date. A crashed
// worker may leave a model outcome unknown, so orchestration must recover through stable receipt
// keys and the global limiter, never through the claim itself.

const SOURCE_PATTERN = /^[\x21-\x7e]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LEASE = "5 minutes";

function assertSource(source: string): void {
  if (typeof source !== "string" || !SOURCE_PATTERN.test(source)) {
    throw new Error("invalid imagery claim source");
  }
}

function assertDate(date: string): void {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    throw new Error("invalid imagery claim date");
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("invalid imagery claim date");
  }
}

function assertToken(token: string): void {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("invalid imagery claim token");
  }
}

/**
 * Claims the date for this source and returns the owner token, or null when another claim still
 * holds it. One statement, no held transaction: the loser returns without occupying a connection.
 */
export async function claimImageryDate(source: string, date: string): Promise<string | null> {
  assertSource(source);
  assertDate(date);
  const rows = await sql`
    INSERT INTO imagery_claims (source, source_date, token, expires_at)
    VALUES (${source}, ${date}, ${randomUUID()}, now() + ${LEASE}::interval)
    ON CONFLICT (source, source_date) DO UPDATE
      SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
      WHERE imagery_claims.expires_at < now()
    RETURNING token
  `;
  return rows[0]?.token ?? null;
}

/** Releases the date only when this token still owns it; a replaced token cannot free its successor. */
export async function releaseImageryDate(source: string, date: string, token: string): Promise<void> {
  assertSource(source);
  assertDate(date);
  assertToken(token);
  await sql`
    DELETE FROM imagery_claims
    WHERE source = ${source} AND source_date = ${date} AND token = ${token}
  `;
}
