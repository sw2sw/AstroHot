import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Tx } from "../db.ts";
import { parseArxivAtom } from "./collect.ts";
import type { CollectionResult, RawArxivPaper } from "./collect.ts";

export interface RawArxivDatabase {
  begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface RawArxivIngestResult {
  status: "imported" | "unchanged";
  batchHash: string;
  paperCount: number;
  // How many of the response's papers were actually stored for the first time. A duplicate collection
  // of an already stored version reports 0 even though its batch is new, which is what the collection
  // schedule reads to decide whether the UTC day still has something left to collect.
  insertedPaperCount: number;
  // arxiv_id values whose authors-only metadata adoption was deferred this call because an
  // active paid-analysis claim exists. Present only on the "imported" path.
  deferredAuthorUpdates?: string[];
}

export interface PendingRawArxivPaper {
  arxiv_id: string;
  base_id: string;
  version: number;
  metadata: unknown;
  metadata_hash: string;
  first_batch_hash: string;
  first_collected_at: Date;
  analysis_status: string;
}

// PostgreSQL integer column bound; versions above this cannot be stored.
const POSTGRES_INT_MAX = 2147483647;
// Strict ISO-8601 UTC timestamp: a UTC designator is required and the seconds field is optional,
// matching what collectArxivCollection emits.
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]00:00)$/;

/** Canonical, key-sorted SHA256 of arbitrary JSON-ish metadata. Array order is significant. */
export function rawMetadataDigest(value: unknown): string {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") {
      return `{${Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Calendar fields are validated explicitly because Date.parse silently rolls impossible dates
// (e.g. 2026-02-30 -> 2026-03-02) instead of rejecting them.
function assertCollectedAtUtc(value: unknown): asserts value is string {
  const message = "collected_at_utc must be a real ISO-8601 UTC timestamp";
  if (typeof value !== "string") throw new Error(message);
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) throw new Error(message);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(message);
  }
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = days[month - 1];
  if (maxDay === undefined || day < 1 || day > maxDay) throw new Error(message);
}

function paperVersion(paper: RawArxivPaper): number {
  const { arxiv_id, base_id } = paper;
  const prefix = `${base_id}v`;
  if (base_id.length === 0 || !arxiv_id.startsWith(prefix)) {
    throw new Error(`raw feed mismatch: arXiv id ${arxiv_id} is inconsistent with base ${base_id}`);
  }
  const versionText = arxiv_id.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(versionText)) {
    throw new Error(`raw feed mismatch: arXiv id ${arxiv_id} has an invalid version`);
  }
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1 || version > POSTGRES_INT_MAX) {
    throw new Error(`raw feed mismatch: arXiv id ${arxiv_id} version is out of range`);
  }
  return version;
}

// Reparsing the raw Atom is the authority: supplied papers must be exactly the parser's output,
// element for element, with object key order being the only thing that may differ.
function assertSuppliedPapersMatch(
  supplied: unknown,
  reparsed: readonly RawArxivPaper[],
): asserts supplied is RawArxivPaper[] {
  if (!Array.isArray(supplied) || supplied.length !== reparsed.length) {
    throw new Error("raw feed mismatch: supplied papers do not match the raw_atom document");
  }
  for (let i = 0; i < reparsed.length; i += 1) {
    const expected = reparsed[i];
    const candidate = supplied[i];
    if (
      expected === undefined ||
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(`raw feed mismatch: papers[${i}] is not a valid paper`);
    }
    if (rawMetadataDigest(candidate) !== rawMetadataDigest(expected)) {
      throw new Error(`raw feed mismatch: papers[${i}] does not match the raw_atom document`);
    }
  }
}

function rawAtomHash(rawAtom: string): string {
  return createHash("sha256").update(rawAtom, "utf8").digest("hex");
}

// The default database is imported lazily so validation can reject bad input without loading db.ts.
function defaultDatabase(): RawArxivDatabase {
  return {
    begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      const { sql } = await import("../db.ts");
      return sql.begin(fn) as Promise<T>;
    },
  };
}

function hasOwnValidAuthors(record: Record<string, unknown>): boolean {
  const authors = record.authors;
  return (
    Object.hasOwn(record, "authors") &&
    Array.isArray(authors) &&
    authors.length > 0 &&
    authors.every((author) => typeof author === "string" && author.trim().length > 0)
  );
}

// A same-version re-ingest may only differ in the authors array (e.g. an arXiv author-list
// correction). Both sides must be non-null non-array objects carrying their own valid authors
// array (nonempty, string elements with nonempty trimmed names), every other key must be strictly
// deep-equal after excluding authors, and the authors arrays themselves must actually differ.
function isAuthorsOnlyMetadataChange(stored: unknown, incoming: unknown): boolean {
  if (
    stored === null || incoming === null ||
    typeof stored !== "object" || typeof incoming !== "object" ||
    Array.isArray(stored) || Array.isArray(incoming)
  ) {
    return false;
  }
  const storedRecord = stored as Record<string, unknown>;
  const incomingRecord = incoming as Record<string, unknown>;
  if (!hasOwnValidAuthors(storedRecord) || !hasOwnValidAuthors(incomingRecord)) return false;
  if (isDeepStrictEqual(storedRecord.authors, incomingRecord.authors)) return false;
  const { authors: _storedAuthors, ...storedRest } = storedRecord;
  const { authors: _incomingAuthors, ...incomingRest } = incomingRecord;
  return isDeepStrictEqual(storedRest, incomingRest);
}

export interface RawArxivBatchRow {
  paper: RawArxivPaper;
  version: number;
  metadata: string;
  metadataHash: string;
}

export interface ValidatedRawArxivCollection {
  rawAtom: string;
  batchHash: string;
  collectedAt: string;
  paperCount: number;
  rows: RawArxivBatchRow[];
}

// Validates the whole document before any transaction is opened, even for a batch that already
// exists. Callers that persist a subset of the response (hydration) reuse this so a partial write
// can never be built on a document the parser or the supplied-papers check would reject.
export function validateRawArxivCollection(input: CollectionResult): ValidatedRawArxivCollection {
  if (!input || typeof input !== "object") throw new Error("collection input must be an object");
  const rawAtom = input.raw_atom;
  if (typeof rawAtom !== "string") throw new Error("raw_atom must be a string");

  const reparsed = parseArxivAtom(rawAtom);
  assertSuppliedPapersMatch(input.papers, reparsed);
  assertCollectedAtUtc(input.collected_at_utc);

  return {
    rawAtom,
    batchHash: rawAtomHash(rawAtom),
    collectedAt: input.collected_at_utc,
    paperCount: input.papers.length,
    rows: input.papers.map((paper) => ({
      paper,
      version: paperVersion(paper),
      metadata: JSON.stringify(paper),
      metadataHash: rawMetadataDigest(paper),
    })),
  };
}

// Persists the given rows of an already validated batch inside the caller's own transaction. The
// same-version rules are unchanged: identical metadata is a no-op, an authors-only change is adopted
// (or deferred while a paid-analysis claim is live), and anything else rejects the whole transaction.
export async function persistRawArxivRows(
  tx: Tx,
  batchHash: string,
  collectedAt: string,
  rows: readonly RawArxivBatchRow[],
): Promise<{ deferredAuthorUpdates: string[]; insertedIds: string[] }> {
  const deferredAuthorUpdates: string[] = [];
  const insertedIds: string[] = [];

  for (const row of rows) {
    const insertedPaper = await tx`
      INSERT INTO arxiv_raw_papers
        (arxiv_id, base_id, version, metadata, metadata_hash, first_batch_hash, first_collected_at, analysis_status)
      VALUES
        (${row.paper.arxiv_id}, ${row.paper.base_id}, ${row.version}, ${row.metadata}::text::jsonb,
         ${row.metadataHash}, ${batchHash}, ${collectedAt}, 'pending')
      ON CONFLICT (arxiv_id) DO NOTHING
      RETURNING arxiv_id`;
    if (insertedPaper.length > 0) {
      insertedIds.push(row.paper.arxiv_id);
      continue;
    }
    // A row for this exact version already exists: it must carry identical raw metadata, or the
    // whole new batch is rejected. The only accepted exception is an authors-only metadata
    // change, which updates just metadata and metadata_hash inside this transaction.
    const existing = await tx`
      SELECT metadata, metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = ${row.paper.arxiv_id}`;
    if (existing[0]?.metadata_hash !== row.metadataHash) {
      if (!isAuthorsOnlyMetadataChange(existing[0]?.metadata, row.paper)) {
        throw new Error(
          `raw feed conflict: arxiv_id ${row.paper.arxiv_id} is already stored with different metadata for the same version`,
        );
      }
      // An active paid-analysis claim owns this paper's analysis run: defer the metadata
      // adoption so the in-flight analysis stays consistent with the hash it started under.
      const activeClaim = await tx`
        SELECT 1 FROM arxiv_analysis_claims WHERE arxiv_id = ${row.paper.arxiv_id}`;
      if (activeClaim.length > 0) {
        deferredAuthorUpdates.push(row.paper.arxiv_id);
        continue;
      }
      await tx`
        UPDATE arxiv_raw_papers
        SET metadata = ${row.metadata}::text::jsonb, metadata_hash = ${row.metadataHash}
        WHERE arxiv_id = ${row.paper.arxiv_id}`;
      // Move any existing retry-guard rows from the old hash to the new hash, preserving
      // counts, locks and cooldowns. The new hash has no retry row yet (the paper was never
      // analyzed under it), so a PK conflict here cannot happen in practice; if it ever did,
      // failing loudly is correct.
      await tx`
        UPDATE arxiv_analysis_retry SET metadata_hash = ${row.metadataHash}
        WHERE arxiv_id = ${row.paper.arxiv_id} AND metadata_hash = ${existing[0].metadata_hash}`;
    }
  }

  return { deferredAuthorUpdates, insertedIds };
}

export async function ingestRawArxivCollection(
  input: CollectionResult,
  database?: RawArxivDatabase,
): Promise<RawArxivIngestResult> {
  const validated = validateRawArxivCollection(input);
  const db = database ?? defaultDatabase();
  return db.begin(async (tx) => {
    const insertedBatch = await tx`
      INSERT INTO arxiv_raw_batches (content_hash, raw_atom, collected_at, paper_count)
      VALUES (${validated.batchHash}, ${validated.rawAtom}, ${validated.collectedAt}, ${validated.paperCount})
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING content_hash`;
    if (insertedBatch.length === 0) {
      // Duplicate collection: keep the first stored timestamp, statuses and raw metadata.
      return { status: "unchanged" as const, batchHash: validated.batchHash, paperCount: validated.paperCount, insertedPaperCount: 0 };
    }

    const { deferredAuthorUpdates, insertedIds } = await persistRawArxivRows(
      tx,
      validated.batchHash,
      validated.collectedAt,
      validated.rows,
    );

    return {
      status: "imported" as const,
      batchHash: validated.batchHash,
      paperCount: validated.paperCount,
      insertedPaperCount: insertedIds.length,
      deferredAuthorUpdates,
    };
  });
}

export async function readPendingRawArxivPapers(
  limit: number = 20,
  database?: RawArxivDatabase,
): Promise<PendingRawArxivPaper[]> {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`limit must be an integer between 1 and 100, received ${String(limit)}`);
  }

  const db = database ?? defaultDatabase();
  return db.begin(async (tx) => {
    const {reconcileArxivRetryHistory}=await import('./analysis-retry.ts');
    await reconcileArxivRetryHistory(tx);
    return await tx<PendingRawArxivPaper[]>`
      SELECT p.arxiv_id, p.base_id, p.version, p.metadata, p.metadata_hash, p.first_batch_hash,
             p.first_collected_at, p.analysis_status
      FROM arxiv_raw_papers p
      WHERE p.analysis_status = 'pending'
        AND (NOT EXISTS(SELECT 1 FROM arxiv_collection_state WHERE key='astro-ph')
          OR (p.metadata->>'submitted_at')::timestamptz >= (SELECT analysis_start_on FROM arxiv_collection_state WHERE key='astro-ph')
          OR EXISTS(SELECT 1 FROM arxiv_announcements a WHERE a.base_id=p.base_id AND a.announce_type='new'
            AND a.announced_on >= (SELECT analysis_start_on FROM arxiv_collection_state WHERE key='astro-ph')))
        AND NOT EXISTS(SELECT 1 FROM arxiv_analysis_claims c WHERE c.arxiv_id=p.arxiv_id)
        AND NOT EXISTS(SELECT 1 FROM arxiv_analysis_retry r WHERE r.arxiv_id=p.arxiv_id AND r.metadata_hash=p.metadata_hash
          AND (r.blocked_reason IS NOT NULL OR r.next_attempt_at>clock_timestamp()))
        AND (SELECT coalesce(sum(r.validation_failures),0) FROM arxiv_analysis_retry r
          WHERE r.arxiv_id=p.arxiv_id AND r.metadata_hash=p.metadata_hash)<3
        AND p.version = (
          SELECT max(h.version) FROM arxiv_raw_papers h WHERE h.base_id = p.base_id
        )
      ORDER BY p.first_collected_at ASC, p.arxiv_id ASC
      LIMIT ${limit}`;
  });
}
