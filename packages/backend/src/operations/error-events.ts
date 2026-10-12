// Automatic recording of operational failures as durable, reviewable events, plus a private offline
// copy of a failure response that no existing table already keeps.
//
// This module never decides whether a business operation retries, and it never replaces the error it
// was called about: recording a failure must not be able to turn a failed run into a successful one,
// and a failed record must not be reported as "no errors". When the record itself cannot be written
// the original failure survives and the gap is made explicit — a redacted structured line on stderr,
// and when the private data directory is writable, an appended ops/error-evidence/fallback.jsonl.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";

export type OpsErrorSeverity = "error" | "warning";

/** Metadata about a failure response: which source, over which HTTP exchange. Secrets never enter it. */
export interface OpsErrorEvidenceSource {
  host?: string | null;
  path?: string | null;
  httpStatus?: number | null;
  headers?: Record<string, string> | null;
  durationMs?: number | null;
}

export interface OpsErrorEvidence {
  /** The raw document to keep offline. Never a model answer — that belongs to its receipt. */
  content: string;
  /**
   * The ORIGINAL bytes the document was received as, when the caller has them. Hashing and writing
   * use these instead of re-encoding `content`, so the kept file really is the upstream byte prefix
   * and its SHA256 really covers those bytes — a text decode of a truncated multi-byte tail or an
   * invalid UTF-8 document would otherwise replace characters and no longer be the received prefix.
   */
  bytes?: Uint8Array | null;
  /** True when the caller's own limit already cut the document; a truncated copy is never "complete". */
  truncated?: boolean;
  source?: OpsErrorEvidenceSource | null;
}

export interface OpsErrorInput {
  stage: string;
  code: string;
  severity?: OpsErrorSeverity;
  message: string;
  /** Stable identity of ONE real observation; capturing it again must insert nothing. */
  observationKey: string;
  /** Aggregation key; defaults to stage / code / target. */
  groupKey?: string;
  jobRunId?: number | null;
  /**
   * Durable execution identity ("run:123", "exec:<uuid>"). It survives a job_runs cleanup, which a
   * FK does not: without it a cleaned run makes the parent/domain hiding rule stop recognising two
   * rows as one execution, and a group's stored-content sum silently drops what that run stored.
   * Defaults to "run:<jobRunId>" when a run id is given, so every existing caller stays correct.
   */
  runKey?: string | null;
  targetId?: string | null;
  receiptId?: number | null;
  receiptAttemptId?: number | null;
  details?: Record<string, unknown> | null;
  evidence?: OpsErrorEvidence | null;
  /** Points at evidence that already exists elsewhere ("arxiv_hydration_exceptions:123"). */
  evidenceRef?: string | null;
  evidenceSha256?: string | null;
}

export type OpsErrorRecordResult =
  | { recorded: true; id: number | null; evidenceRef: string | null }
  | { recorded: false; error: unknown };

// ---------------------------------------------------------------------------
// Redaction. Every string that is stored or printed passes through here first.
// The formats are the ones real provider and driver errors actually use: bare
// key/value pairs, JSON-quoted keys, whole Cookie/Set-Cookie header values, URL
// userinfo, credential query parameters, database DSNs and personal paths.
// Over-redaction is accepted; leakage is not.
// ---------------------------------------------------------------------------
const SECRET_KEYS =
  "access[-_]?key|api[-_]?key|apikey|auth|authorization|cookie|credential|csrf|customer[-_]?key|key|passwd|password|secret|session|set-cookie|sig|signature|token";
const SECRET_NAME = new RegExp(`(?:${SECRET_KEYS})`, "i");
/** Exact-match form for STRUCTURED field names: "design" is not a secret, "sig" alone is. */
const SECRET_NAME_EXACT = new RegExp(`^(?:${SECRET_KEYS})$`, "i");
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // URL userinfo: keep scheme and host, drop credentials.
  [/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@"],
  // Whole Cookie / Set-Cookie header values: every item is a credential, so the
  // entire value after the header name goes — not just the first pair before a
  // semicolon. The value ends where a cookie header can realistically end (line
  // end, or the start of a JSON object another part of the error carries), so a
  // mid-line JSON secret after the header survives for its own rule.
  [/((?:set-)?cookie\s*[:=]\s*)([^\r\n{}]+)/gi, "$1[redacted]"],
  // JSON-quoted secret keys, the shape provider errors actually arrive in:
  // {"api_key":"SECRET"} — the key's closing quote defeated the bare-key rule.
  [new RegExp(`(\\s*"(?:${SECRET_KEYS})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|-?\\d+(?:\\.\\d+)?)`, "gi"), "$1[redacted]"],
  // Credential query parameters in URLs (?key=...&...): the value runs to the
  // next & or whitespace, whatever the key is called.
  [new RegExp(`([?&](?:${SECRET_KEYS})[a-z0-9_-]*\\s*=\\s*)([^&\\s"']+)`, "gi"), "$1[redacted]"],
  // key=value / key: value secrets that routinely travel inside provider and driver errors. The
  // optional scheme word keeps "Authorization: Bearer <token>" from leaving the token behind. The
  // value stops at URL parameter boundaries too, so an already-redacted query value cannot drag the
  // next parameter into its replacement.
  [
    new RegExp(`((?:${SECRET_KEYS})\\s*[:=]\\s*)(?:(?:basic|bearer|token)\\s+)?(?:"[^"]*"|'[^']*'|[^\\s,;"&']+)`, "gi"),
    "$1[redacted]",
  ],
  // A database DSN is a credential.
  [/(postgres(?:ql)?:\/\/)\S+/gi, "$1[redacted]"],
  // Account names inside profile paths are not evidence.
  [/([A-Za-z]:\\Users\\)[^\\\s"']+/g, "$1[redacted]"],
  [/(\/home\/)[^/\s"']+/g, "$1[redacted]"],
];

/** Removes credentials, cookies, connection strings and personal account paths from a message. */
export function sanitizeOpsMessage(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Field constraints. `details` is NOT serialized as received: only allow-listed
// scalar/array shapes survive, strings inside them are redacted and bounded.
// Identifiers (observation key, group key, target) are constrained to a small
// charset so a hostile message can never become query syntax.
// ---------------------------------------------------------------------------
const MAX_DETAIL_ENTRIES = 32;
const MAX_DETAIL_STRING = 300;
const MAX_DETAIL_ARRAY = 100;
const ID_SAFE = /^[A-Za-z0-9:.@_\/-]{0,300}$/;

/** Constrain an identifier to a small charset; anything else becomes `_`. */
function constrainId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.slice(0, 300);
  return ID_SAFE.test(trimmed) ? trimmed : trimmed.replace(/[^A-Za-z0-9:.@_\/-]/g, "_").slice(0, 300);
}

function constrainDetailValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeOpsMessage(value).slice(0, MAX_DETAIL_STRING);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ARRAY).map((item) => constrainDetailValue(item));
  }
  // Objects and functions are never recorded — a small allow-list beats a
  // permissive serializer pretending to be one.
  return "[omitted]";
}

/** Redacts and bounds a `details` record before it reaches the jsonb column. */
function constrainDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!details) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, MAX_DETAIL_ENTRIES)) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) continue;
    // A key that NAMES a secret makes the value one, whatever its shape: the text-based sanitizer
    // only recognises "key=value" context and cannot see a bare value in a structured field, so a
    // key like `api_key` gets its value redacted WHOLE. Charset and scalar-shape rules are query
    // safety, never privacy redaction.
    if (SECRET_NAME_EXACT.test(key)) { out[key] = "[redacted]"; continue; }
    out[key] = constrainDetailValue(value);
  }
  return out;
}

/**
 * Bounded, query-free endpoint identity for a kept document — the safe subset of
 * `OpsErrorEvidenceSource` that is actually persisted (as flat, allow-listed `details` fields).
 * Headers never reach the row: they are credential-bearing by nature and the response status plus
 * endpoint already say what an operator needs; the full header set lives with the transport, not here.
 */
function constrainEvidenceSource(source: OpsErrorEvidenceSource | null | undefined): Record<string, unknown> | null {
  if (!source) return null;
  const out: Record<string, unknown> = {};
  if (typeof source.host === "string" && /^[A-Za-z0-9.-]{1,120}$/.test(source.host)) out.evidenceHost = source.host;
  if (typeof source.path === "string") {
    // The path alone, query string dropped — query parameters are where credentials travel.
    const clean = source.path.split("?")[0]!.slice(0, 200);
    if (/^[A-Za-z0-9._\-/]*$/.test(clean)) out.evidencePath = clean;
  }
  if (typeof source.httpStatus === "number" && Number.isSafeInteger(source.httpStatus)) out.evidenceStatus = source.httpStatus;
  if (typeof source.durationMs === "number" && Number.isFinite(source.durationMs) && source.durationMs >= 0) {
    out.evidenceDurationMs = Math.round(source.durationMs);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Private evidence storage. The directory and every file in it are 0700/0600 —
// including ones that already existed: a pre-created wide-permission directory
// is corrected before anything private lands in it, and an unusable target is
// never overwritten. Content-addressed names make identical documents the same
// file; concurrent writers use exclusive, per-write temporary names and publish
// atomically, so a reader never observes a half-written document.
//
// The configured data directory is the ONE trusted root. Everything this module
// creates under it is walked level by level and checked with lstat: a symlink at
// ANY level (a linked `ops`, not only a linked `error-evidence`) is refused, so a
// private document can never be written through to a directory outside the root.
// ---------------------------------------------------------------------------
const TRUSTED_ROOT = path.resolve(config.dataDir);
/** The two directory levels this module owns under the trusted root. */
const PRIVATE_SEGMENTS = ["ops", "error-evidence"] as const;
const EVIDENCE_DIR = path.join(TRUSTED_ROOT, ...PRIVATE_SEGMENTS);

/**
 * Creates (if needed) and verifies one directory level under the trusted root. `mkdir` without
 * `recursive` is used on purpose: a recursive create would happily build a real directory INSIDE a
 * linked parent, so the link would never be seen. Each level is lstat-ed, so an existing symlink is
 * refused instead of being followed, and an existing wide-permission directory is corrected.
 */
async function ensurePrivateLevel(dir: string): Promise<void> {
  let info = await lstat(dir).catch(() => undefined);
  if (info === undefined) {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      // EEXIST is the ordinary first-time race between two NORMAL recorders: both lstat-ed "absent",
      // one created the level, the other lost. It is re-verified by exactly the same checks below, so
      // a symlink or a plain file at this level is still refused — but a concurrent writer no longer
      // makes a real failure go unrecorded. Any other error stays a degradation.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    info = await lstat(dir);
  }
  if (info.isSymbolicLink()) throw new Error(`ops evidence path is a symbolic link: ${dir}`);
  if (!info.isDirectory()) throw new Error(`ops evidence path is not a directory: ${dir}`);
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/** Walks the module's own directory chain under the trusted root, refusing a link at any level. */
async function ensurePrivateDir(): Promise<string> {
  // The trusted root itself is the configured data directory: it is created if absent (as before)
  // and is not policed — everything BELOW it, which this module owns, is checked level by level.
  await mkdir(TRUSTED_ROOT, { recursive: true, mode: 0o700 });
  let current = TRUSTED_ROOT;
  for (const segment of PRIVATE_SEGMENTS) {
    current = path.join(current, segment);
    await ensurePrivateLevel(current);
  }
  return EVIDENCE_DIR;
}

/** The exact bytes an evidence document is kept as: the raw prefix when supplied, else the UTF-8 text. */
function evidenceBytes(payload: { content?: string; bytes?: Uint8Array | null }): Buffer {
  if (payload.bytes !== undefined && payload.bytes !== null) return Buffer.from(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength);
  return Buffer.from(payload.content ?? "", "utf8");
}

async function writeEvidence(payload: { content?: string; bytes?: Uint8Array | null }): Promise<{ evidenceRef: string; sha256: string }> {
  const data = evidenceBytes(payload);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const dir = await ensurePrivateDir();
  const target = path.join(dir, `${sha256}.txt`);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    // A link at the content-addressed name is not this document and is never followed: chmod or
    // readFile through it would touch an untrusted target outside this directory.
    if (existing.isSymbolicLink()) throw new Error(`ops evidence target is a symbolic link: ${sha256}.txt`);
    if (!existing.isFile()) throw new Error(`ops evidence target is not a regular file: ${sha256}.txt`);
    if ((existing.mode & 0o077) !== 0) await chmod(target, 0o600);
    // A file that is already there must actually BE this document: a hash-named
    // file with different content is corruption, and overwriting it would hide that.
    const current = await readFile(target);
    if (createHash("sha256").update(current).digest("hex") !== sha256) {
      throw new Error(`ops evidence target content mismatch: ${sha256}.txt`);
    }
    return { evidenceRef: `ops/error-evidence/${sha256}.txt`, sha256 };
  }
  // Exclusive per-write temporary name: two concurrent writers of the SAME
  // content never share a file handle. Both rename into the same target, which
  // is atomic within the directory and lands identical bytes either way.
  const tmp = path.join(dir, `${sha256}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, target);
  } catch (error) {
    // Another process may have published the same content first; that is the same document, so
    // losing the rename is not a failure — but ONLY the actual document counts: the winner is
    // verified to be a regular file with private permissions and THIS content. A symlink, an
    // unusable file or different bytes at the target is corruption, and the original error stands.
    const winner = await lstat(target).catch(() => undefined);
    if (winner === undefined || winner.isSymbolicLink() || !winner.isFile()) throw error;
    if ((winner.mode & 0o077) !== 0) await chmod(target, 0o600);
    const current = await readFile(target);
    if (createHash("sha256").update(current).digest("hex") !== sha256) throw error;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return { evidenceRef: `ops/error-evidence/${sha256}.txt`, sha256 };
}


/** The floor when the database itself is unavailable: redacted, structured, and impossible to miss. */
async function reportRecordingGap(input: OpsErrorInput, error: unknown): Promise<void> {
  const line = {
    level: "error",
    code: "ops_error_recording_failed",
    stage: input.stage,
    failed_code: input.code,
    observation_key: constrainId(input.observationKey),
    message: sanitizeOpsMessage(String(error)).slice(0, 500),
  };
  console.error(JSON.stringify(line));
  try {
    const dir = await ensurePrivateDir();
    const fallback = path.join(dir, "fallback.jsonl");
    // O_NOFOLLOW where the platform has it: the open itself refuses a link at the final component, so
    // the handle can never belong to a different file than the one lstat checked. The handle is then
    // verified to BE a regular file opened for append, and its permissions are fixed through the
    // HANDLE (handle.chmod) rather than by path — a path-based chmod would follow a link again.
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    const appendFlags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow;
    const opened = await open(fallback, appendFlags, 0o600).catch(() => undefined);
    if (opened === undefined) {
      // The open failed (a link at the final component, a directory, or an unusable path). An
      // existing wide-permission regular file gets its mode corrected, then ONE retry; anything that
      // is not a plain regular file is never appended to.
      const info = await lstat(fallback).catch(() => undefined);
      if (info === undefined || info.isSymbolicLink() || !info.isFile()) return;
      if ((info.mode & 0o077) !== 0) await chmod(fallback, 0o600);
    }
    const handle = opened ?? await open(fallback, appendFlags, 0o600).catch(() => undefined);
    if (handle === undefined) return;
    try {
      // The handle, not the path, is the authority: a handle that is not a regular file (or that a
      // link turned into something else) is closed without writing.
      const info = await handle.stat();
      if (!info.isFile()) return;
      if ((info.mode & 0o077) !== 0) await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // The structured stderr line above is the floor; nothing else can be done here.
  }
}

/**
 * Appends one failure event. Never throws for its own sake: the caller keeps whatever error it was
 * already handling, and reads `recorded` to state that the record is incomplete.
 */
export async function recordOpsError(input: OpsErrorInput, db: Db = sql): Promise<OpsErrorRecordResult> {
  const message = sanitizeOpsMessage(input.message).slice(0, 4000);
  const groupKey = constrainId(input.groupKey ?? [input.stage, input.code, input.targetId ?? "-"].join(":"))
    ?? `${input.stage}:${input.code}`;
  const observationKey = constrainId(input.observationKey);
  if (observationKey === null || observationKey === "") {
    return { recorded: false, error: new Error("observation key is required and must be a safe identifier") };
  }
  // The durable execution identity: an explicit scope when the caller has one, otherwise derived from
  // the run id. It is NEVER derived from the FK at read time, so a later job_runs cleanup cannot make
  // two rows of the same execution look like two different ones.
  const runKey = constrainId(input.runKey ?? (input.jobRunId !== undefined && input.jobRunId !== null ? `run:${input.jobRunId}` : null));
  try {
    let evidenceRef: string | null = input.evidenceRef ?? null;
    let evidenceSha: string | null = input.evidenceSha256 ?? null;
    let truncated = false;
    const details = constrainDetails(input.details);
    if (input.evidence) {
      // Whether the document could be READ completely travels independently of whether any byte
      // survived: a body whose first read was rejected, or that hung until the timeout, is INCOMPLETE
      // evidence — not absent evidence — and must never be reported as a complete empty document.
      truncated = input.evidence.truncated === true;
      const hasBytes = (input.evidence.bytes?.byteLength ?? 0) > 0;
      const hasText = (input.evidence.content ?? "") !== "";
      if (hasBytes || hasText) {
        const stored = await writeEvidence({ content: input.evidence.content, bytes: input.evidence.bytes });
        evidenceRef = stored.evidenceRef;
        evidenceSha = stored.sha256;
      } else if (truncated) {
        // Nothing was readable at all. No empty file is invented (that would fake a document the
        // origin never sent), but the event still says the body is unknown so the truncation state is
        // never mistaken for "the origin returned nothing".
        details.bodyUnavailable = true;
      }
      // The endpoint the document came from travels WITH the evidence as bounded safe fields beside
      // it, whether or not a copy could actually be kept.
      const sourceFields = constrainEvidenceSource(input.evidence.source);
      if (sourceFields) Object.assign(details, sourceFields);
    }
    const rows = await db<{ id: number }[]>`
      INSERT INTO ops_error_events
        (stage, code, severity, sanitized_message, observation_key, group_key, job_run_id, run_key, target_id,
         receipt_id, receipt_attempt_id, details, evidence_ref, evidence_sha256, evidence_truncated)
      VALUES
        (${input.stage}, ${input.code}, ${input.severity ?? "error"}, ${message}, ${observationKey},
         ${groupKey}, ${input.jobRunId ?? null}, ${runKey}, ${constrainId(input.targetId)}, ${input.receiptId ?? null},
         ${input.receiptAttemptId ?? null}, ${JSON.stringify(details)}::text::jsonb,
         ${evidenceRef}, ${evidenceSha}, ${truncated})
      ON CONFLICT (observation_key) DO NOTHING
      RETURNING id`;
    // A duplicate observation is a success, not a new row: the same real failure was seen again.
    return { recorded: true, id: rows[0]?.id ?? null, evidenceRef };
  } catch (error) {
    await reportRecordingGap(input, error);
    return { recorded: false, error };
  }
}

/** Keeps the original failure and states beside it that the record is incomplete. */
export function withRecordingFailure(original: unknown, record: OpsErrorRecordResult): unknown {
  if (record.recorded) return original;
  return new AggregateError(
    [original, record.error],
    `${String(original)} (the failure could not be recorded in ops_error_events: ${sanitizeOpsMessage(String(record.error)).slice(0, 300)})`,
  );
}
