import type { ArxivReport, ArxivPaper } from "../../../contracts/src/arxiv.ts";

function parseId(value: unknown, path = "arxiv_id"): { base: string; version: number } {
  if (typeof value !== "string") fail(path, "expected modern versioned arXiv ID");
  const match = /^(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5})v([1-9]\d*)$/.exec(value);
  if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[2]))) {
    fail(path, "expected YYMM.NNNN[N]vpositive-integer, month 01-12, no leading version zero");
  }
  return { base: match[1], version: Number(match[2]) };
}

export function arxivBaseId(versionedId: string): string {
  return parseId(versionedId).base;
}

export function arxivVersion(versionedId: string): number {
  return parseId(versionedId).version;
}

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}
function object(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, "expected a plain object");
  }
}
function array(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, "expected an array");
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      fail(`${path}[${i}]`, "required own array entry (accessors are not allowed)");
    }
  }
}

function member(value: unknown, allowed: readonly unknown[], path: string): void {
  if (!allowed.includes(value)) fail(path, `expected one of ${allowed.join(", ")}`);
}

function text(value: unknown, max: number, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(path, `expected nonblank string of at most ${max} characters`);
  }
}

function strings(value: unknown, max: number, path: string): void {
  array(value, path);
  (value as unknown[]).forEach((s, i) => text(s, max, `${path}[${i}]`));
}

function calendar(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.length !== 10) {
    fail(path, "expected YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    fail(path, "invalid calendar date");
  }
}
function timestamp(value: unknown, path: string): { second: number; fraction: string } {
  text(value, 64, path);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || m[0] !== value) fail(path, "expected ISO timestamp with explicit timezone");
  calendar(m[1], path);
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59
      || (m[6] !== "Z" && (+m[6].slice(1, 3) > 23 || +m[6].slice(4, 6) > 59))) {
    fail(path, "invalid timestamp time or timezone offset");
  }
  const second = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[6]}`) / 1000;
  if (!Number.isFinite(second)) fail(path, "invalid ISO timestamp");
  return { second, fraction: m[5] ?? "" };
}

function integer(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected nonnegative safe integer");
  }
}

function required(value: object, keys: readonly string[], path: string): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      fail(`${path}.${key}`, "required own data property (accessors are not allowed)");
    }
  }
}

function copyArray<T>(value: T[], path: string): T[] {
  array(value, path);
  const result: T[] = [];
  for (let i = 0; i < value.length; i++) result.push(value[i]);
  return result;
}

// Snapshot known fields before validation: ignore unknown keys, methods and iterators.
function snapshot(input: unknown): ArxivReport {
  const r = input as ArxivReport;
  object(r, "report");
  required(r, ["schema_version", "report_type", "run_id", "issue_date", "timezone",
    "generated_at_utc", "mode", "coverage", "review_status", "input_sha256",
    "input_collected_at_utc", "candidate_pool_count", "paper_count", "counts",
    "ranked_selected_ids", "items", "note_zh"], "report");
  object(r.counts, "counts");
  required(r.counts, ["SELECT", "REVIEW", "DEFER"], "counts");
  array(r.items, "items");
  if (r.items.length > 1000) fail("items", "at most 1000 papers allowed");
  return {
    schema_version: r.schema_version, report_type: r.report_type, run_id: r.run_id,
    issue_date: r.issue_date, timezone: r.timezone, generated_at_utc: r.generated_at_utc,
    mode: r.mode, coverage: r.coverage, review_status: r.review_status,
    input_sha256: r.input_sha256, input_collected_at_utc: r.input_collected_at_utc,
    candidate_pool_count: r.candidate_pool_count, paper_count: r.paper_count,
    counts: { SELECT: r.counts.SELECT, REVIEW: r.counts.REVIEW, DEFER: r.counts.DEFER },
    ranked_selected_ids: copyArray(r.ranked_selected_ids, "ranked_selected_ids"),
    items: copyArray(r.items, "items").map((p, i): ArxivPaper => {
      object(p, `items[${i}]`);
      required(p, ["paper_key", "arxiv_id", "title_original", "title_zh", "authors",
        "categories", "submitted_at", "updated_at", "url", "verdict", "study_type",
        "summary_zh", "reason_zh", "evidence_abstract_quote", "fulltext_review_question",
        "peer_review_status", "analysis_scope", "publication_status"], `items[${i}]`);
      return {
      paper_key: p.paper_key, arxiv_id: p.arxiv_id,
      title_original: p.title_original, title_zh: p.title_zh,
      authors: copyArray(p.authors, `items[${i}].authors`), categories: copyArray(p.categories, `items[${i}].categories`),
      submitted_at: p.submitted_at, updated_at: p.updated_at,
      ...(Object.hasOwn(p, "announced_on") ? { announced_on: p.announced_on } : {}),
      url: p.url,
      verdict: p.verdict, study_type: p.study_type, summary_zh: p.summary_zh,
      reason_zh: p.reason_zh, evidence_abstract_quote: p.evidence_abstract_quote,
      fulltext_review_question: p.fulltext_review_question,
      peer_review_status: p.peer_review_status, analysis_scope: p.analysis_scope,
      publication_status: p.publication_status,
      };
    }),
    note_zh: r.note_zh,
  };
}

export function validateArxivReport(input: unknown): ArxivReport {
  const r = snapshot(input);
  object(r, "report");
  object(r.counts, "counts");
  array(r.items, "items");
  if (r.items.length > 1000) fail("items", "at most 1000 papers allowed");
  array(r.ranked_selected_ids, "ranked_selected_ids");
  r.items.forEach((p, i) => object(p, `items[${i}]`));
  member(r.schema_version, [1], "schema_version");
  member(r.report_type, ["arxiv_astronomy_screening"], "report_type");
  member(r.timezone, ["Asia/Shanghai"], "timezone");
  member(r.mode, ["pilot", "daily"], "mode");
  r.items.forEach((p, i) => {
    const path = `items[${i}]`;
    member(p.publication_status, ["candidate_only"], `${path}.publication_status`);
    member(p.peer_review_status, ["unverified"], `${path}.peer_review_status`);
    member(p.analysis_scope, ["title_and_abstract_only"], `${path}.analysis_scope`);
    member(p.verdict, ["SELECT", "REVIEW", "DEFER"], `${path}.verdict`);
    member(p.study_type, ["observation", "simulation", "theory", "method", "mixed"], `${path}.study_type`);
  });
  text(r.run_id, 256, "run_id");
  text(r.coverage, 1000, "coverage");
  text(r.review_status, 256, "review_status");
  text(r.note_zh, 6000, "note_zh");
  r.items.forEach((p, i) => {
    const path = `items[${i}]`;
    text(p.title_original, 1000, `${path}.title_original`);
    text(p.title_zh, 1000, `${path}.title_zh`);
    text(p.summary_zh, 6000, `${path}.summary_zh`);
    text(p.reason_zh, 4000, `${path}.reason_zh`);
    text(p.fulltext_review_question, 4000, `${path}.fulltext_review_question`);
    text(p.evidence_abstract_quote, 12000, `${path}.evidence_abstract_quote`);
  });
  r.items.forEach((p, i) => parseId(p.arxiv_id, `items[${i}].arxiv_id`));
  const bases = new Set<string>();
  r.items.forEach((p, i) => {
    const base = arxivBaseId(p.arxiv_id);
    if (p.paper_key !== `arxiv:${base}`) fail(`items[${i}].paper_key`, "must equal arxiv:base-ID");
    if (bases.has(base)) fail(`items[${i}].arxiv_id`, "duplicate base ID");
    bases.add(base);
  });
  r.items.forEach((p, i) => {
    if (p.url !== `https://arxiv.org/abs/${p.arxiv_id}`) {
      fail(`items[${i}].url`, "must be exact https://arxiv.org/abs/versioned-ID");
    }
  });
  r.items.forEach((p, i) => {
    const path = `items[${i}]`;
    // Official RSS may retain a whole collaboration/affiliation block as one unparsed entry.
    // Preserve that evidence verbatim rather than imposing a short personal-name limit.
    strings(p.authors, 100_000, `${path}.authors`);
    if (p.authors.reduce((total, author) => total + author.length, 0) > 100_000) {
      fail(`${path}.authors`, "at most 100000 total characters per paper");
    }
    strings(p.categories, 128, `${path}.categories`);
    if (!p.categories.some(c => ["astro-ph.GA", "astro-ph.CO", "astro-ph.EP", "astro-ph.HE", "astro-ph.SR", "astro-ph.IM"].includes(c))) {
      fail(`${path}.categories`, "requires at least one of the six astro-ph subtypes");
    }
  });
  calendar(r.issue_date, "issue_date");
  timestamp(r.generated_at_utc, "generated_at_utc");
  timestamp(r.input_collected_at_utc, "input_collected_at_utc");
  // A record read out of the official RSS announcement feed states NO submission or update instant,
  // and an unknown date stays unknown: null is accepted exactly when the item carries the real
  // announcement day, so a reader always has one honest day to show. A synthesized timestamp would
  // have been indistinguishable from a real one and is refused by this shape.
  r.items.forEach((p, i) => {
    const path = `items[${i}]`;
    const hasSubmitted = p.submitted_at !== null && p.submitted_at !== undefined;
    const hasUpdated = p.updated_at !== null && p.updated_at !== undefined;
    if (hasSubmitted) timestamp(p.submitted_at, `${path}.submitted_at`);
    if (hasUpdated) timestamp(p.updated_at, `${path}.updated_at`);
    if (!hasSubmitted || !hasUpdated) {
      // The absent instant is named in the failure as well as the announcement day it would have
      // needed: `submitted_at` (or `updated_at`) really is the field the reader is looking at, and a
      // message that only said "announced_on" would send an operator to the wrong field.
      const absent = hasSubmitted ? `${path}.updated_at` : `${path}.submitted_at`;
      if (p.announced_on === null || p.announced_on === undefined) {
        fail(absent,
          "may be null only when announced_on states the real announcement day: an unknown date stays unknown, and the announcement day is the only honest day");
      }
      calendar(p.announced_on, `${path}.announced_on`);
    }
    if (hasSubmitted && !hasUpdated) fail(`${path}.updated_at`, "required when submitted_at is present");
    if (hasSubmitted && hasUpdated) {
      const submitted = timestamp(p.submitted_at, `${path}.submitted_at`);
      const updated = timestamp(p.updated_at, `${path}.updated_at`);
      const precision = Math.max(submitted.fraction.length, updated.fraction.length);
      if (updated.second < submitted.second || (updated.second === submitted.second
          && updated.fraction.padEnd(precision, "0") < submitted.fraction.padEnd(precision, "0"))) {
        fail(`${path}.updated_at`, "must not precede submitted_at");
      }
    }
  });
  if (typeof r.input_sha256 !== "string" || r.input_sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(r.input_sha256)) {
    fail("input_sha256", "expected 64 lowercase hexadecimal characters");
  }
  integer(r.candidate_pool_count, "candidate_pool_count");
  integer(r.paper_count, "paper_count");
  for (const verdict of ["SELECT", "REVIEW", "DEFER"] as const) integer(r.counts[verdict], `counts.${verdict}`);
  if (r.paper_count !== r.items.length) fail("paper_count", "must match items length");
  if (r.candidate_pool_count < r.paper_count) fail("candidate_pool_count", "must be at least paper_count");
  const actual = { SELECT: 0, REVIEW: 0, DEFER: 0 };
  for (const p of r.items) actual[p.verdict]++;
  for (const verdict of ["SELECT", "REVIEW", "DEFER"] as const) {
    if (r.counts[verdict] !== actual[verdict]) fail(`counts.${verdict}`, "must match item verdict count");
  }
  const selected = new Set(r.items.filter(p => p.verdict === "SELECT").map(p => p.arxiv_id));
  const ranks = new Set<string>();
  r.ranked_selected_ids.forEach((id, i) => {
    parseId(id, `ranked_selected_ids[${i}]`);
    if (ranks.has(id) || !selected.has(id)) fail(`ranked_selected_ids[${i}]`, "duplicate or non-SELECT ID");
    ranks.add(id);
  });
  if (ranks.size !== selected.size) fail("ranked_selected_ids", "must exactly cover SELECT IDs");
  // VALIDATION
  return r;
}
