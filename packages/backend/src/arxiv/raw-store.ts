import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Tx } from "../db.ts";
import { parseArxivAtom } from "./collect.ts";
import type { CollectionResult, RawArxivPaper } from "./collect.ts";
import { parseArxivRssFeed, rssPaperMetadata, type RssItemIsolation } from "./rss-paper.ts";

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
  // arxiv_id values this Atom document carried whose version is already stored from the official
  // announcement feed AND whose science agrees with it. The feed's document is the one being analyzed,
  // so these are additional evidence for the same identity and NOT a rewrite (see persistRawArxivRows).
  // Present only on the "imported" path.
  crossSourceOverlaps?: string[];
  // Versions this document carried whose science does NOT agree with the document already stored for
  // the same identity (or could not be compared at all). Neither original is overwritten; the
  // disagreement is recorded and the version is held back from starting a new analysis. A version
  // listed here is deliberately NOT also reported as a duplicate.
  contentConflictIds?: string[];
}

export interface PendingRawArxivPaper {
  arxiv_id: string;
  base_id: string;
  version: number;
  metadata: unknown;
  metadata_hash: string;
  // NULL for a row read out of the official announcement feed: its evidence document is the
  // announcement batch it came from (first_rss_batch_hash), not an Atom archive batch.
  first_batch_hash: string | null;
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

/**
 * The per-paper serialization boundary shared by the two writers that can change WHICH document a
 * versioned identity is stored as: the paid-analysis claim, and the adoption of a corrected document
 * (a creator-list correction, from either source).
 *
 * Both take it, on the identity, BEFORE they read the row they are about to decide on, and hold it to
 * the end of their own transaction. Without it the two only appeared to be ordered: a plain SELECT of
 * `arxiv_analysis_claims` followed by an unconditional UPDATE leaves a window in which a claim is
 * committed for the stored document and then quietly overwritten by a corrected one — the in-flight
 * analysis then completes against a row that is no longer there, and the corrected document is paid
 * for a second time on the next round. The window is not hypothetical; it is the exact interleaving
 * the round-2 review reproduced (RSS-U2 F2).
 *
 * A transaction-scoped ADVISORY lock is used rather than a table or row lock so nothing else is
 * affected: it is keyed on the identity, it is taken in a deterministic order (one per paper, in the
 * order the batch presents them), and it is released automatically at commit or rollback. The same
 * boundary also carries the admission decision of a new analysis (see analyze.ts), so "read the stored
 * document, decide, write" is one ordered step on either side.
 */
export async function lockArxivIdentity(tx: Tx, arxivId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('arxiv_raw_papers:' || ${arxivId}, 0))`;
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

/**
 * How the scientific fields of two documents about one identity compare.
 *
 *   equal        both state the same title and the same abstract. Only the presentation may differ —
 *                line wrapping and indentation are how a source formats text, not what it says — so
 *                whitespace is normalised before the comparison and nothing else is.
 *   different    both state a title and an abstract, and they are not the same words.
 *   incomparable a field is missing or is not text at all, so no honest comparison exists.
 *
 * "different" and "incomparable" are deliberately NOT the same answer, but neither of them may be
 * reported as "the same paper": the caller decides what to do, and both keep both documents.
 */
export type ScientificVerdict = "equal" | "different" | "incomparable";

const SCIENTIFIC_FIELDS = ["title_original", "abstract_original"] as const;

function comparableScientificText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalised = value.replace(/\s+/g, " ").trim();
  return normalised.length === 0 ? undefined : normalised;
}

export function compareScientificContent(stored: unknown, arriving: unknown): ScientificVerdict {
  if (
    stored === null || arriving === null ||
    typeof stored !== "object" || typeof arriving !== "object" ||
    Array.isArray(stored) || Array.isArray(arriving)
  ) {
    return "incomparable";
  }
  const storedRecord = stored as Record<string, unknown>;
  const arrivingRecord = arriving as Record<string, unknown>;
  const storedTexts = SCIENTIFIC_FIELDS.map((field) => comparableScientificText(storedRecord[field]));
  const arrivingTexts = SCIENTIFIC_FIELDS.map((field) => comparableScientificText(arrivingRecord[field]));
  if (storedTexts.some((text) => text === undefined) || arrivingTexts.some((text) => text === undefined)) {
    return "incomparable";
  }
  return storedTexts.every((text, index) => text === arrivingTexts[index]) ? "equal" : "different";
}

export type SameVersionConflictKind =
  | "same_source_drift" | "cross_source_difference" | "author_correction_deferred";

export interface SameVersionConflict {
  arxivId: string;
  baseId: string;
  kind: SameVersionConflictKind;
  storedSource: "atom" | "rss";
  arrivingSource: "atom" | "rss";
  /** The hash of the document that is stored — the identity a paid analysis keys on. */
  storedMetadataHash: string;
  /** The hash of the arriving document, so a replay of it records the same conflict once. */
  arrivingDocumentHash: string;
  detail: Record<string, unknown>;
}

/** Both scientific values, bounded, so the disagreement stays reviewable offline. */
function conflictDetail(verdict: ScientificVerdict, stored: unknown, arriving: unknown): Record<string, unknown> {
  const field = (value: unknown, key: string): string | null => {
    const raw = value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key] : undefined;
    return typeof raw === "string" ? raw.slice(0, 500) : null;
  };
  return {
    verdict,
    stored_title: field(stored, "title_original"),
    arriving_title: field(arriving, "title_original"),
    stored_abstract: field(stored, "abstract_original"),
    arriving_abstract: field(arriving, "abstract_original"),
  };
}

/** Records one disagreement inside a transaction the caller already owns. */
export async function insertSameVersionConflict(tx: Tx, conflict: SameVersionConflict): Promise<void> {
  await tx`
    INSERT INTO arxiv_same_version_conflicts
      (arxiv_id, base_id, kind, stored_source, arriving_source, stored_metadata_sha256,
       arriving_document_sha256, detail, defers_analysis)
    VALUES
      (${conflict.arxivId}, ${conflict.baseId}, ${conflict.kind}, ${conflict.storedSource}, ${conflict.arrivingSource},
       ${conflict.storedMetadataHash}, ${conflict.arrivingDocumentHash}, ${JSON.stringify(conflict.detail)}::text::jsonb,
       ${conflict.kind !== "author_correction_deferred"})
    ON CONFLICT (arxiv_id, arriving_document_sha256) DO NOTHING`;
}

/**
 * Records one disagreement on its OWN connection, for the case where the surrounding transaction is
 * about to be rolled back and the evidence must outlive it. That is exactly the same-source drift red
 * line: the incoming batch is refused as a whole, so nothing written inside its transaction survives —
 * including the row that explains why it was refused.
 */
export async function recordSameVersionConflict(
  conflict: SameVersionConflict,
  database?: RawArxivDatabase,
): Promise<void> {
  const db = database ?? defaultDatabase();
  await db.begin((tx) => insertSameVersionConflict(tx, conflict));
}

/**
 * The same-source drift red line. Two documents of the SAME source disagree about the science of one
 * versioned identity, and nothing in either document can say which one is right. The incoming batch is
 * refused as a whole; the error carries the recorded disagreement so the caller does not have to parse
 * a message to know what happened.
 */
export class SameSourceContentDriftError extends Error {
  readonly conflict: SameVersionConflict;
  constructor(conflict: SameVersionConflict) {
    super(`RSS content drift: arxiv_id ${conflict.arxivId} is already stored from the same source with different scientific content`);
    this.name = "SameSourceContentDriftError";
    this.conflict = conflict;
  }
}

/**
 * A SAME-SOURCE re-announcement whose science is identical but whose creator list is not: the feed
 * corrected the author list. Between two announcements of one version the announcement day and type
 * legitimately move, so only the science is required to match; the correction itself is taken from the
 * arriving document while every other stored field is left exactly as the first document stated it.
 */
function rssAuthorCorrection(stored: unknown, arriving: unknown): Record<string, unknown> | undefined {
  if (
    stored === null || arriving === null ||
    typeof stored !== "object" || typeof arriving !== "object" ||
    Array.isArray(stored) || Array.isArray(arriving)
  ) {
    return undefined;
  }
  const storedRecord = stored as Record<string, unknown>;
  const arrivingRecord = arriving as Record<string, unknown>;
  if (!hasOwnValidAuthors(storedRecord) || !hasOwnValidAuthors(arrivingRecord)) return undefined;
  if (isDeepStrictEqual(storedRecord.authors, arrivingRecord.authors)) return undefined;
  return {
    ...storedRecord,
    authors: [...(arrivingRecord.authors as string[])],
    authors_original: arrivingRecord.authors_original,
    authors_quality: arrivingRecord.authors_quality,
  };
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
): Promise<{ deferredAuthorUpdates: string[]; insertedIds: string[]; crossSourceOverlaps: string[]; contentConflictIds: string[] }> {
  const deferredAuthorUpdates: string[] = [];
  const insertedIds: string[] = [];
  // Versions whose stored row came from the official announcement feed and whose science this Atom
  // document AGREES with (see the branch below). Reported so the overlap is visible rather than
  // silently dropped.
  const crossSourceOverlaps: string[] = [];
  // Versions whose stored row came from the feed and whose science this document does NOT agree with.
  // Recorded rather than overwritten, and reported so the disagreement is never counted as a duplicate.
  const contentConflictIds: string[] = [];

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
    //
    // The boundary is taken BEFORE the row is read, so the decision and the write below cannot be
    // split by a paid-analysis claim being committed in between (see lockArxivIdentity).
    await lockArxivIdentity(tx, row.paper.arxiv_id);
    const existing = await tx`
      SELECT metadata, metadata_hash, source FROM arxiv_raw_papers WHERE arxiv_id = ${row.paper.arxiv_id}`;
    if (existing[0]?.metadata_hash !== row.metadataHash) {
      // ATOM LATER, FEED FIRST. The stored document came from the official announcement feed, this one
      // from the export API, and both are documents ABOUT the same versioned identity — one identity,
      // one analyzable paper. Their metadata shapes cannot be compared field by field (the feed states
      // no submission instant, so submitted_at/updated_at are legitimately absent there and present
      // here), so the comparison is made on the SCIENTIFIC fields alone, with nothing but whitespace
      // normalised: the same title and the same abstract is the same paper however the two sources wrap
      // their text, and a genuinely different abstract is not the same paper at all.
      //
      // Rewriting the stored row would change its metadata_hash, and with it the identity a paid
      // analysis started under — the second analysis the design forbids. Overwriting is also what
      // RSS-DESIGN rules out when cross-source equivalence cannot be established ("若无法判定科学内容
      // 一致，保留证据、延后该项处理，不覆盖已分析输入"). So:
      //   * an equivalent document is additional evidence: the stored row stays, the paper stays
      //     analyzable from the document already stored, and the overlap is reported;
      //   * a document that states DIFFERENT science, or states too little to compare, is recorded as a
      //     conflict: both originals are kept, the stored row is untouched, and the version is held
      //     back from starting a new analysis until a human compares the two documents.
      // Either way the rest of the batch is untouched.
      if (existing[0].source === "rss") {
        const verdict = compareScientificContent(existing[0].metadata, row.paper);
        if (verdict === "equal") {
          crossSourceOverlaps.push(row.paper.arxiv_id);
          continue;
        }
        const conflict: SameVersionConflict = {
          arxivId: row.paper.arxiv_id,
          baseId: row.paper.base_id,
          kind: "cross_source_difference",
          storedSource: "rss",
          arrivingSource: "atom",
          storedMetadataHash: existing[0].metadata_hash,
          arrivingDocumentHash: batchHash,
          detail: conflictDetail(verdict, existing[0].metadata, row.paper),
        };
        await insertSameVersionConflict(tx, conflict);
        contentConflictIds.push(row.paper.arxiv_id);
        continue;
      }
      if (!isAuthorsOnlyMetadataChange(existing[0]?.metadata, row.paper)) {
        throw new Error(
          `raw feed conflict: arxiv_id ${row.paper.arxiv_id} is already stored with different metadata for the same version`,
        );
      }
      // An active paid-analysis claim owns this paper's analysis run: defer the metadata
      // adoption so the in-flight analysis stays consistent with the hash it started under. The
      // admission is decided INSIDE the write, in one statement, rather than by a SELECT followed by an
      // unconditional UPDATE: a claim committed in that gap would otherwise be overwritten, and the
      // analysis holding it could no longer complete honestly.
      const adopted = await tx`
        UPDATE arxiv_raw_papers
        SET metadata = ${row.metadata}::text::jsonb, metadata_hash = ${row.metadataHash}
        WHERE arxiv_id = ${row.paper.arxiv_id}
          AND metadata_hash = ${existing[0].metadata_hash}
          AND NOT EXISTS(SELECT 1 FROM arxiv_analysis_claims c WHERE c.arxiv_id = ${row.paper.arxiv_id})
        RETURNING arxiv_id`;
      if (adopted.length === 0) {
        // Either a paid analysis owns the paper, or the stored document moved under this batch. Neither
        // is an adoption, so none is reported: the correction stays classified as deferred and is
        // picked up by the controlled adoption procedure once the
        // paper is free again.
        deferredAuthorUpdates.push(row.paper.arxiv_id);
        continue;
      }
      // Move any existing retry-guard rows from the old hash to the new hash, preserving
      // counts, locks and cooldowns. The new hash has no retry row yet (the paper was never
      // analyzed under it), so a PK conflict here cannot happen in practice; if it ever did,
      // failing loudly is correct.
      await tx`
        UPDATE arxiv_analysis_retry SET metadata_hash = ${row.metadataHash}
        WHERE arxiv_id = ${row.paper.arxiv_id} AND metadata_hash = ${existing[0].metadata_hash}`;
    }
  }

  return { deferredAuthorUpdates, insertedIds, crossSourceOverlaps, contentConflictIds };
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

    const { deferredAuthorUpdates, insertedIds, crossSourceOverlaps, contentConflictIds } = await persistRawArxivRows(
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
      crossSourceOverlaps,
      contentConflictIds,
    };
  });
}

/**
 * The RSS-native ingest entry. The official announcement batch has just been written under
 * `batchHash` inside the CALLER's transaction, and this persists the papers of that same document
 * there — so the evidence, the announcements and the analyzable papers either all land or none do.
 *
 * The raw document is what is read: this function parses the feed itself instead of trusting anything
 * the caller extracted, exactly as the Atom ingest reparses its raw document. Nothing synthesized
 * ever reaches the table, and `submitted_at`/`updated_at` are stored as null because the feed does
 * not state them.
 *
 * Two rules keep the identity red lines intact:
 *   * an arxiv_id that already has a raw row (of either source) is left EXACTLY as it is — the RSS
 *     announcement adds evidence, it never downgrades or rewrites metadata that is already stored;
 *   * an item whose content is unusable is isolated with its own raw text and reason, and the rest of
 *     the batch is stored normally. Identity/version/namespace violations never reach here: they
 *     already threw inside parseArxivAnnouncements and rolled the batch back.
 */
export async function persistRssArxivBatch(
  tx: Tx,
  rawRss: string,
  batchHash: string,
  collectedAt: string,
  database?: RawArxivDatabase,
): Promise<{
  itemCount: number; announcementCount: number;
  insertedIds: string[]; duplicateIds: string[]; conflictedIds: string[];
  adoptedAuthorUpdates: string[]; deferredAuthorUpdates: string[];
  isolated: RssItemIsolation[];
}> {
  const parsed = parseArxivRssFeed(rawRss);

  const insertedIds: string[] = [];
  // Versions already stored whose science this document agrees with (byte-identical metadata, or an
  // equivalent or corrected document of the other/same source). A repeat is reported, never hidden.
  const duplicateIds: string[] = [];
  // Versions already stored of the OTHER source whose science this document does NOT agree with.
  const conflictedIds: string[] = [];
  // Creator corrections this batch adopted, and those it had to defer behind a live paid-analysis claim.
  const adoptedAuthorUpdates: string[] = [];
  const deferredAuthorUpdates: string[] = [];
  for (const item of parsed.items) {
    const metadata = rssPaperMetadata(item);
    const serialized = JSON.stringify(metadata);
    const metadataHash = rawMetadataDigest(metadata);
    const saved = await tx`
      INSERT INTO arxiv_raw_papers
        (arxiv_id, base_id, version, metadata, metadata_hash, first_batch_hash, first_rss_batch_hash,
         first_collected_at, analysis_status, source)
      VALUES
        (${item.arxiv_id}, ${item.base_id}, ${item.version}, ${serialized}::text::jsonb,
         ${metadataHash}, NULL, ${batchHash}, ${collectedAt}, 'pending', 'rss')
      ON CONFLICT (arxiv_id) DO NOTHING
      RETURNING arxiv_id`;
    if (saved.length > 0) {
      insertedIds.push(item.arxiv_id);
      continue;
    }
    // A document for this exact versioned identity is already stored, of one source or the other. That
    // stored document is the one a paid analysis keys on: it is NEVER rewritten by this path, and a
    // document that disagrees with it is never counted as an ordinary duplicate.
    //
    // The per-paper boundary is taken before the row is read, so a paid-analysis claim committed by
    // another process cannot land between this decision and the write below (see lockArxivIdentity).
    await lockArxivIdentity(tx, item.arxiv_id);
    const rows = await tx<{ metadata: unknown; metadata_hash: string; source: string }[]>`
      SELECT metadata, metadata_hash, source FROM arxiv_raw_papers WHERE arxiv_id = ${item.arxiv_id}`;
    const existing = rows[0];
    if (existing === undefined) {
      throw new Error(`raw feed mismatch: arxiv_id ${item.arxiv_id} vanished between insert and read`);
    }
    if (existing.metadata_hash === metadataHash) {
      // The very same document, said again. Nothing changed, so nothing is written.
      duplicateIds.push(item.arxiv_id);
      continue;
    }

    if (existing.source === "rss") {
      // SAME SOURCE, DIFFERENT DOCUMENT. Two announcements of one version legitimately move their day
      // and their type between batches, so the comparison is made on the SCIENCE alone (title and
      // abstract, whitespace-normalised — see compareScientificContent) and never on the scaffolding.
      const verdict = compareScientificContent(existing.metadata, metadata);
      if (verdict !== "equal") {
        // The feed has stated different science for one identity. Nothing in either document can say
        // which one is right, so the incoming batch is refused AS A WHOLE — the existing red line —
        // and the healthy items beside it are rolled back with it. The disagreement is recorded on its
        // OWN connection, because the throw below rolls this batch back and the reason a batch was
        // refused must outlive it, or the round would report a refusal it cannot explain.
        const conflict: SameVersionConflict = {
          arxivId: item.arxiv_id, baseId: item.base_id,
          kind: "same_source_drift", storedSource: "rss", arrivingSource: "rss",
          storedMetadataHash: existing.metadata_hash, arrivingDocumentHash: batchHash,
          detail: conflictDetail(verdict, existing.metadata, metadata),
        };
        await recordSameVersionConflict(conflict, database);
        throw new SameSourceContentDriftError(conflict);
      }
      const corrected = rssAuthorCorrection(existing.metadata, metadata);
      if (corrected === undefined) {
        duplicateIds.push(item.arxiv_id);
        continue;
      }
      // A creator-list correction with untouched science. It is ADOPTED — but only while the paper is
      // still free: the stored document must still be the one this batch compared against, and no paid
      // analysis may own it. Both conditions are decided INSIDE the write, in ONE statement, under the
      // per-paper boundary — a plain SELECT of the claims table followed by an unconditional UPDATE
      // leaves a window in which a claim committed for the old document is overwritten by the corrected
      // one, the in-flight analysis can no longer complete honestly, and the same scientific content is
      // paid for again on the next round (RSS-U2 F2).
      const correctedHash = rawMetadataDigest(corrected);
      const adopted = await tx`
        UPDATE arxiv_raw_papers
        SET metadata = ${JSON.stringify(corrected)}::text::jsonb, metadata_hash = ${correctedHash}
        WHERE arxiv_id = ${item.arxiv_id}
          AND metadata_hash = ${existing.metadata_hash}
          AND NOT EXISTS(SELECT 1 FROM arxiv_analysis_claims c WHERE c.arxiv_id = ${item.arxiv_id})
        RETURNING arxiv_id`;
      if (adopted.length === 0) {
        // NOT an adoption, and therefore not reported as one: either an analysis owns the paper, or its
        // stored document moved. The correction is classified and kept exactly like the deferred case,
        // so it is never lost — the controlled adoption procedure takes
        // it from here once the paper is free.
        const current = (await tx<{ metadata_hash: string }[]>`
          SELECT metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = ${item.arxiv_id}`)[0];
        await insertSameVersionConflict(tx, {
          arxivId: item.arxiv_id, baseId: item.base_id,
          kind: "author_correction_deferred", storedSource: "rss", arrivingSource: "rss",
          storedMetadataHash: current?.metadata_hash ?? existing.metadata_hash, arrivingDocumentHash: batchHash,
          detail: conflictDetail("equal", existing.metadata, metadata),
        });
        deferredAuthorUpdates.push(item.arxiv_id);
        continue;
      }
      // The retry guard follows the document it guards, so counts, locks and cooldowns are preserved
      // rather than reset. The new hash has no retry row yet, so a PK conflict cannot happen here.
      await tx`
        UPDATE arxiv_analysis_retry SET metadata_hash = ${correctedHash}
        WHERE arxiv_id = ${item.arxiv_id} AND metadata_hash = ${existing.metadata_hash}`;
      adoptedAuthorUpdates.push(item.arxiv_id);
      continue;
    }

    // CROSS SOURCE, FEED LAST: the stored document came from the export API, this one from the feed.
    // Their metadata shapes cannot be compared field by field (the feed states no submission instant),
    // so the comparison is again made on the science alone. An equivalent document is additional
    // evidence for one identity and the stored row stays untouched; a document that states DIFFERENT
    // science, or too little to compare, is a recorded conflict — both originals kept, the version held
    // back from a NEW analysis until a human has compared them.
    const verdict = compareScientificContent(existing.metadata, metadata);
    if (verdict === "equal") {
      duplicateIds.push(item.arxiv_id);
      continue;
    }
    await insertSameVersionConflict(tx, {
      arxivId: item.arxiv_id, baseId: item.base_id,
      kind: "cross_source_difference", storedSource: "atom", arrivingSource: "rss",
      storedMetadataHash: existing.metadata_hash, arrivingDocumentHash: batchHash,
      detail: conflictDetail(verdict, existing.metadata, metadata),
    });
    conflictedIds.push(item.arxiv_id);
  }

  for (const isolation of parsed.isolated) {
    await tx`
      INSERT INTO arxiv_rss_item_isolations
        (batch_hash, item_sha256, arxiv_id, reason, raw_item_excerpt, raw_item_truncated)
      VALUES
        (${batchHash}, ${isolation.itemSha256}, ${isolation.arxivId}, ${isolation.reason},
         ${isolation.excerpt}, ${isolation.truncated})
      ON CONFLICT (batch_hash, item_sha256, reason) DO NOTHING`;
  }

  return {
    itemCount: parsed.itemCount,
    announcementCount: parsed.announcementCount,
    insertedIds,
    duplicateIds,
    conflictedIds,
    adoptedAuthorUpdates,
    deferredAuthorUpdates,
    isolated: parsed.isolated,
  };
}

/**
 * The CONTROLLED, operator-invoked adoption of a deferred creator correction.
 *
 * A creator correction that arrived while a paid analysis owned the paper is recorded as
 * `author_correction_deferred` and deliberately NOT adopted — the in-flight run keeps the document it
 * started under. Nothing consumes that row automatically: replaying the original announcement is a
 * no-op (the batch is already archived), and setting `resolved_at` alone would update nobody. This is
 * the missing disposition step, and it is intentionally a manual one, with no scheduler, no queue, no
 * source request and no re-analysis behind it.
 *
 * It adopts ONLY from the preserved original: the arriving document is located through its archived
 * announcement batch and re-parsed here, and the correction is re-derived from it. The stored `detail`
 * is a bounded excerpt kept for a human to read, never the input of a write.
 *
 * Nothing is written unless the whole safety boundary still holds, and the check and the write are one
 * ordered step under the same per-paper lock the automatic adoption uses:
 *   * the archived document must still be there (`document_missing`);
 *   * the stored document must still be the one the conflict named (`hash_moved` — a later adoption
 *     already moved it, so this correction is stale and must be re-reviewed, not re-applied);
 *   * no paid analysis may own the paper (`deferred` — try again after it finishes);
 *   * the archived document must still state a correction over what is stored (`superseded` — it was
 *     already adopted, or the stored authors already match).
 * The retry guard follows the document exactly as the automatic path does (counts, locks and cooldowns
 * are preserved, never reset), and the conflict is closed with `resolved_at` only when the metadata row
 * was really rewritten.
 */
export interface DeferredAuthorCorrectionOutcome {
  status:
    | "adopted" | "deferred" | "hash_moved" | "superseded" | "document_missing"
    | "not_found" | "already_resolved";
  arxivId?: string;
  /** The metadata hash the paper is stored under after this call (adopted or already moved). */
  storedMetadataHash?: string;
}

export async function adoptDeferredAuthorCorrection(
  conflictId: number,
  database?: RawArxivDatabase,
): Promise<DeferredAuthorCorrectionOutcome> {
  if (!Number.isSafeInteger(conflictId) || conflictId < 1) {
    throw new Error(`conflictId must be a positive integer, received ${String(conflictId)}`);
  }
  const db = database ?? defaultDatabase();
  return db.begin(async (tx) => {
    const conflicts = await tx<{
      arxiv_id: string; kind: string; stored_metadata_sha256: string;
      arriving_document_sha256: string; resolved_at: Date | null;
    }[]>`
      SELECT arxiv_id, kind, stored_metadata_sha256, arriving_document_sha256, resolved_at
      FROM arxiv_same_version_conflicts WHERE id = ${conflictId}`;
    const conflict = conflicts[0];
    if (conflict === undefined) return { status: "not_found" as const };
    if (conflict.kind !== "author_correction_deferred") {
      throw new Error(
        `conflict ${conflictId} is a ${conflict.kind}, not an author correction: a scientific conflict is released with an explicit resolved_at UPDATE, it is never adopted`,
      );
    }
    if (conflict.resolved_at !== null) return { status: "already_resolved" as const, arxivId: conflict.arxiv_id };

    // The preserved original, located through the batch the correction arrived in.
    const batches = await tx<{ raw_rss: string }[]>`
      SELECT raw_rss FROM arxiv_announcement_batches WHERE content_hash = ${conflict.arriving_document_sha256}`;
    const archived = batches[0];
    if (archived === undefined) return { status: "document_missing" as const, arxivId: conflict.arxiv_id };

    await lockArxivIdentity(tx, conflict.arxiv_id);
    const rows = await tx<{ metadata: unknown; metadata_hash: string }[]>`
      SELECT metadata, metadata_hash FROM arxiv_raw_papers WHERE arxiv_id = ${conflict.arxiv_id}`;
    const stored = rows[0];
    if (stored === undefined) return { status: "superseded" as const, arxivId: conflict.arxiv_id };
    if (stored.metadata_hash !== conflict.stored_metadata_sha256) {
      return { status: "hash_moved" as const, arxivId: conflict.arxiv_id, storedMetadataHash: stored.metadata_hash };
    }
    const claims = await tx`
      SELECT 1 FROM arxiv_analysis_claims WHERE arxiv_id = ${conflict.arxiv_id}`;
    if (claims.length > 0) {
      return { status: "deferred" as const, arxivId: conflict.arxiv_id, storedMetadataHash: stored.metadata_hash };
    }
    const item = parseArxivRssFeed(archived.raw_rss).items.find((entry) => entry.arxiv_id === conflict.arxiv_id);
    const corrected = item === undefined ? undefined : rssAuthorCorrection(stored.metadata, rssPaperMetadata(item));
    if (corrected === undefined) {
      return { status: "superseded" as const, arxivId: conflict.arxiv_id, storedMetadataHash: stored.metadata_hash };
    }
    const correctedHash = rawMetadataDigest(corrected);
    const adopted = await tx`
      UPDATE arxiv_raw_papers
      SET metadata = ${JSON.stringify(corrected)}::text::jsonb, metadata_hash = ${correctedHash}
      WHERE arxiv_id = ${conflict.arxiv_id}
        AND metadata_hash = ${conflict.stored_metadata_sha256}
        AND NOT EXISTS(SELECT 1 FROM arxiv_analysis_claims c WHERE c.arxiv_id = ${conflict.arxiv_id})
      RETURNING arxiv_id`;
    if (adopted.length === 0) {
      return { status: "deferred" as const, arxivId: conflict.arxiv_id, storedMetadataHash: stored.metadata_hash };
    }
    await tx`
      UPDATE arxiv_analysis_retry SET metadata_hash = ${correctedHash}
      WHERE arxiv_id = ${conflict.arxiv_id} AND metadata_hash = ${conflict.stored_metadata_sha256}`;
    const closed = await tx`
      UPDATE arxiv_same_version_conflicts SET resolved_at = clock_timestamp()
      WHERE id = ${conflictId} AND resolved_at IS NULL RETURNING id`;
    if (closed.length === 0) {
      // The row was closed by somebody else between the read and here. The metadata write above is
      // already the adoption the other operator made, so this is not a silent no-op — but it is not
      // claimed as this call's adoption either.
      return { status: "already_resolved" as const, arxivId: conflict.arxiv_id, storedMetadataHash: correctedHash };
    }
    return { status: "adopted" as const, arxivId: conflict.arxiv_id, storedMetadataHash: correctedHash };
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
        -- Two documents of one version disagree about the science and no automatic rule can say which
        -- is right: the version is held back from starting a NEW analysis until an operator has read
        -- both. Only an unresolved conflict that genuinely doubts the SCIENCE defers (a pending creator
        -- correction must not stall a paper whose science is not in question), and resolution is the
        -- operator's explicit UPDATE ... SET resolved_at — nothing here ever resolves it.
        AND NOT EXISTS(SELECT 1 FROM arxiv_same_version_conflicts v
          WHERE v.arxiv_id=p.arxiv_id AND v.resolved_at IS NULL AND v.defers_analysis)
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
