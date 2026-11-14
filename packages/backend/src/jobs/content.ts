// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued. A failed
// step records when to try again, and the sweep (content.sweep) is the timer that queues it then; it
// also queues articles whose job was never created or has waited half an hour. A provider outage makes
// an article wait and retry with backoff; only a permanent refusal or exhausted retries end in
// "failed", which the admin re-queues in bulk.
import type { PgBoss } from "pg-boss";
import { addDays, beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError } from "../editorial/analyze.ts";
import { isHistorical } from "../content/materials.ts";
import { publishArticle, publishArticleTx } from "../publication/publish.ts";
import { seatedCondition } from "../publication/scope.ts";
import { screenTitleBatch, supportedSelection, titleBatchSubject, TITLE_BATCH_LIMIT, TITLE_BATCH_PURPOSE, TITLE_BATCH_VERSION, TITLE_SELECTION_TAG, type TitleBatchItem, type TitleBatchRound } from "../editorial/title-batch.ts";
import { getSelectionMaterials } from "../editorial/selection-material.ts";
import { normalizeUrl } from "../lib/url.ts";
import { BudgetExceededError, completeReceipt, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { ModelLimitBusyError } from "../providers/model-limit.ts";
import { enqueue, ensureQueue, QUEUES, shutdownSignal, work } from "./queue.ts";

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/** An article queued this long ago is queued again, in case its job was lost. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
  titleBatch: boolean;
  processingAttemptTag: string | null;
}

const usesTitleBatch = (source: { participation_mode: string; kind: string; selected: boolean }) =>
  config.titleBatchEnabled && !source.selected && source.participation_mode === "editorial" && ["rss", "web_list", "json_list"].includes(source.kind);

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * when there is only a title or a feed summary (the analysis judges the whole article), or when an X
 * post links an X Article (fetched before judging; a discussion post only while it is news, as
 * history adds no heat).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<{ body_status: string; participation_mode: string; kind: string; config: Record<string, unknown>; url: string; bare: boolean; backfill: boolean; published_at: Date | null; discovered_at: Date; selected: boolean; processing_attempt_tag: string | null }[]>`
    SELECT a.body_status, s.participation_mode, s.kind, s.config, a.url, (coalesce(a.body_text, '') = '' AND a.x_post IS NULL) AS bare,
           a.backfill, a.published_at, a.discovered_at, coalesce(p.selected, false) AS selected, a.processing_attempt_tag
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !signal && (wantsBody || (row.bare && pageFetchable(row.url, row.kind)));
  const needsXArticle = row.kind === "x_search" && (!signal || (row.participation_mode === "hot_signal" && !historical));
  return { step: pending && (needsPage || needsXArticle) ? "extract" : "analyze", signal, historical,
    titleBatch: usesTitleBatch(row), processingAttemptTag: row.processing_attempt_tag };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 */
const PRIORITY = { live: 0, liveSignal: -1, history: -2 } as const;

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
export async function queueProcessing(articleId: string, opts: { step?: Step; attemptTag?: string; db?: Db } = {}): Promise<string | null> {
  const db = opts.db ?? sql;
  const r = await route(articleId, db);
  if (!r) return null;
  if (r.titleBatch && !opts.step && !opts.attemptTag
    && (!r.processingAttemptTag || r.processingAttemptTag.startsWith(TITLE_SELECTION_TAG))) return null;
  const step = opts.step ?? r.step;
  const [queued] = await db<{ processing_attempt_tag: string | null }[]>`
    UPDATE articles SET processing_queued_at = now(), processing_attempt_tag = coalesce(${opts.attemptTag ?? null}, processing_attempt_tag)
    WHERE id = ${articleId} RETURNING processing_attempt_tag`;
  if (!queued) return null;
  // Extraction and the sweep only carry articleId; retain the current evaluation's paid identity.
  const attemptTag = queued.processing_attempt_tag ?? undefined;
  if (step === "extract") return enqueue(QUEUES.extractBody, { articleId, ...(opts.step && opts.db ? { force: true } : {}) }, { singletonKey: articleId, priority: r.historical ? PRIORITY.history : PRIORITY.live }, opts.db);
  if (r.signal && !attemptTag) {
    return enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: r.historical ? PRIORITY.history : PRIORITY.liveSignal }, opts.db);
  }
  const tagged = !!attemptTag;
  return enqueue(QUEUES.analyze, tagged ? { articleId, attemptTag } : { articleId },
    { singletonKey: tagged ? `manual:analyze:${articleId}:${attemptTag}` : articleId, priority: r.historical ? PRIORITY.history : PRIORITY.live }, opts.db);
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial'
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

async function processingInput(articleId: string) {
  const [row] = await sql<{ participation_mode: string; kind: string; revision: number; backfill: boolean; published_at: Date | null; discovered_at: Date; selected: boolean }[]>`
    SELECT s.participation_mode, s.kind, a.revision, a.backfill, a.published_at, a.discovered_at, coalesce(p.selected, false) AS selected
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id WHERE a.id = ${articleId}`;
  return row ? { ...row, historical: isHistorical(row) } : null;
}

/**
 * The analysis job: the article's current revision through analysis and publication; failures wait,
 * retry or end in "failed" (afterFailure). attemptTag makes an explicit re-evaluation a new (paid)
 * request; the same tag reuses its receipt.
 */
export async function processArticle(articleId: string, opts: { attemptTag?: string } = {}): Promise<{ state: string; retryAt?: Date }> {
  if (config.titleBatchEnabled && opts.attemptTag?.startsWith(TITLE_SELECTION_TAG)) return { state: "waiting-for-news-round" };
  const row = await processingInput(articleId);
  if (!row) return { state: "missing" };
  if (usesTitleBatch(row) && !opts.attemptTag) return { state: "waiting-for-title-batch" };
  try {
    return await processRevision(articleId, row, opts);
  } catch (error) {
    return afterFailure(articleId, row.revision, error);
  }
}

async function processRevision(articleId: string, row: NonNullable<Awaited<ReturnType<typeof processingInput>>>, opts: { attemptTag?: string }): Promise<{ state: string }> {
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId);
    if (group) await enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  try {
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag });
    if (!result) return { state: "missing" };
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract" });
      return { state: "fetching-body" };
    }
    if (result.stale) return { state: "stale" }; // the newer revision has its own job
    await publishArticle(articleId);
    // History still completes the identity gate; groupArticle confirms it without a model call.
    if (result.output.relevance === "pass") await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority: row.historical ? PRIORITY.history : PRIORITY.live });
    await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
              WHERE id = ${articleId} AND revision = ${row.revision}`;
    return { state: result.output.relevance };
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    if (error instanceof ReceiptUnknownError) {
      // The provider may have billed this request: stop; ops.recover releases it once and requeues the article.
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`}
                WHERE id = ${articleId} AND revision = ${row.revision}`;
      return { state: "unknown-receipt" };
    }
    throw error;
  }
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
async function afterFailure(articleId: string, revision: number, error: unknown): Promise<{ state: string; retryAt?: Date }> {
  // Let pg-boss retry this job after restart, reusing settled receipts. A deploy is not an article
  // failure and must neither consume processing_attempts nor turn an incomplete chain terminal.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  if (error instanceof ReceiptBusyError || error instanceof BudgetExceededError || error instanceof ModelLimitBusyError) {
    // Not the article's fault: the same request is in flight, or the budget window is full.
    const seconds = error instanceof BudgetExceededError || error instanceof ModelLimitBusyError ? error.retryAfterSeconds : 60;
    const retryAt = new Date(Date.now() + seconds * 1000);
    await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL
              WHERE id = ${articleId} AND revision = ${revision}`;
    return { state: "waiting", retryAt };
  }
  const [a] = await sql<{ processing_attempts: number }[]>`SELECT processing_attempts FROM articles WHERE id = ${articleId} AND revision = ${revision}`;
  if (!a) return { state: "stale" };
  const attempts = a.processing_attempts + 1;
  const refused = error instanceof ProviderRejectedError && !error.retryable;
  const exhausted = attempts > RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts >= MAX_OUTPUT_FAILURES);
  if (refused || exhausted) {
    await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId} AND revision = ${revision}`;
    return { state: "failed" };
  }
  const retryAt = new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);
  await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_attempts = ${attempts},
              processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId} AND revision = ${revision}`;
  return { state: "retrying", retryAt };
}

export async function enqueueTitleBatch() {
  const empty = { enqueued: false, titles: 0, candidates: 0, withMaterials: 0 };
  if (!config.titleBatchEnabled || !config.modelCallsEnabled) return empty;
  await ensureQueue(QUEUES.titleBatch);
  if ((await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.titleBatch}
    AND state IN ('created', 'active', 'retry') LIMIT 1`).length) return empty;
  const items = await sql<TitleBatchItem[]>`
    SELECT a.id, a.revision, a.title FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.processing_state = 'new' AND a.processing_attempt_tag IS NULL
      AND s.enabled AND s.participation_mode = 'editorial' AND s.kind IN ('rss', 'web_list', 'json_list')
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id AND p.selected)
      AND a.updated_at < now() - interval '1 minute'
      AND (a.processing_retry_at IS NULL OR a.processing_retry_at <= now())
    ORDER BY a.discovered_at, a.id LIMIT ${TITLE_BATCH_LIMIT}`;
  const candidates = await sql<(TitleBatchItem & { tag: string; url: string; body_html: string | null; first_party: boolean; excerpt: string | null })[]>`
    SELECT a.id,a.revision,a.title,a.url,a.body_html,a.excerpt,s.first_party,a.processing_attempt_tag AS tag
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.processing_state = 'new' AND a.processing_attempt_tag LIKE ${TITLE_SELECTION_TAG + "%"}
      AND s.enabled AND s.participation_mode = 'editorial'
    ORDER BY a.discovered_at, a.id LIMIT 2`;
  const reviews = await Promise.all(candidates.map(async ({ url, body_html, first_party, excerpt, ...item }) => ({
    ...item, materials: await getSelectionMaterials(url, body_html, first_party, excerpt),
  })));
  const withMaterials = reviews.filter(r => r.materials.length > 0).length;
  if (!items.length && !withMaterials) {
    await sql.begin(async tx => {
      for (const item of reviews) await settleTitleSelection(tx, item);
    });
    return { ...empty, candidates: reviews.length };
  }
  const selected = await sql<TitleBatchRound["selected"]>`
    SELECT p.title,coalesce(an.output->>'evidenceUrl',p.url) AS url
    FROM publications p LEFT JOIN analyses an ON an.id=p.analysis_id
    WHERE ${seatedCondition(new Date())} AND p.timeline_at >= now() - interval '7 days'
    ORDER BY p.timeline_at DESC,p.article_id LIMIT 20`;
  const id = await enqueue(QUEUES.titleBatch, { items, reviews, selected: [...selected] }, { singletonKey: "automatic" });
  return { enqueued: !!id, titles: items.length, candidates: reviews.length, withMaterials };
}

async function settleTitleSelection(tx: Db, item: TitleBatchRound["reviews"][number]) {
  return (await tx`UPDATE articles SET processing_state='analyzed', processing_attempt_tag=NULL,
    processing_queued_at=NULL, processing_retry_at=NULL, processing_attempts=0, processing_error=NULL,
    grouping_status='complete'
    WHERE id=${item.id} AND revision=${item.revision} AND processing_attempt_tag=${item.tag}
      AND processing_state='new' AND EXISTS (
        SELECT 1 FROM sources s WHERE s.id=articles.source_id AND s.enabled AND s.participation_mode='editorial'
      ) RETURNING id`).length > 0;
}

export async function processTitleBatch(round: TitleBatchRound) {
  const { items, reviews } = round;
  if (!items.length && !reviews.length) return { screened: 0 };
  const revisions = sql.json(items.map(({ id, revision }) => ({ id, revision })));
  const [ready] = await sql`SELECT 1 FROM articles a JOIN sources s ON s.id = a.source_id
    JOIN jsonb_to_recordset(${revisions}::jsonb) AS batch(id text, revision int)
      ON a.id = batch.id AND a.revision = batch.revision
    WHERE a.processing_state = 'new' AND a.processing_attempt_tag IS NULL AND s.enabled AND s.participation_mode = 'editorial'
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id AND p.selected)
    LIMIT 1`;
  const reviewInputs = sql.json(reviews.filter(r => r.materials.length).map(({ id, revision, tag }) => ({ id, revision, tag })));
  const [reviewReady] = await sql`SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id
    JOIN jsonb_to_recordset(${reviewInputs}::jsonb) AS batch(id text, revision int, tag text)
      ON a.id=batch.id AND a.revision=batch.revision AND a.processing_attempt_tag=batch.tag
    WHERE a.processing_state='new' AND s.enabled AND s.participation_mode='editorial' LIMIT 1`;
  if (!ready && !reviewReady) return { screened: 0 };
  let result;
  try {
    result = await screenTitleBatch(round);
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof ModelLimitBusyError || error instanceof ReceiptBusyError) {
      const seconds = error instanceof ReceiptBusyError ? 60 : error.retryAfterSeconds;
      // Retain the exact batch across budget waits so its paid identity cannot change.
      await enqueue(QUEUES.titleBatch, round, { singletonKey: titleBatchSubject(round), startAfter: seconds });
      return { screened: 0, waiting: seconds };
    }
    if (error instanceof ReceiptUnknownError || error instanceof ModelOutputError || (error instanceof ProviderRejectedError && !error.retryable)) {
      const reason = error instanceof ReceiptUnknownError ? "title batch receipt " + titleBatchSubject(round) : error.message.slice(0, 500);
      await sql`UPDATE articles a SET processing_state = 'failed',
        processing_error = ${reason}
        FROM jsonb_to_recordset(${revisions}::jsonb) AS batch(id text, revision int)
        WHERE a.id = batch.id AND a.revision = batch.revision AND a.processing_state = 'new' AND a.processing_attempt_tag IS NULL`;
      await sql`UPDATE articles a SET processing_state='failed', processing_error=${reason}
        FROM jsonb_to_recordset(${reviewInputs}::jsonb) AS batch(id text, revision int, tag text)
        WHERE a.id=batch.id AND a.revision=batch.revision AND a.processing_attempt_tag=batch.tag AND a.processing_state='new'`;
      return { screened: 0, failed: items.length, ...(error instanceof ProviderRejectedError ? {} : { receiptId: error.receiptId }) };
    }
    throw error;
  }
  const counts = { pass: 0, block: 0, unknown: 0, review: 0, reviewed: 0, selected: 0, duplicate: 0 };
  await sql.begin(async (tx) => {
    // A single transaction completes the whole receipt. A crash before commit can reuse the answer.
    const usedEvidence = new Set(round.selected.map(s => normalizeUrl(s.url)));
    for (const decision of [...result.data.reviews].sort((a,b) => a.n - b.n)) {
      const item = reviews[decision.n - 1]!;
      if (!(await settleTitleSelection(tx, item))) continue;
      const material = supportedSelection(item, decision);
      const key = material && normalizeUrl(material.url);
      const duplicate = decision.verdict === "duplicate" || !!(key && usedEvidence.has(key));
      const select = !!(material && key && !duplicate);
      if (select) usedEvidence.add(key);
      await tx`INSERT INTO analyses (article_id,input_revision,origin,model,prompt_version,receipt_ids,relevance,category,title_zh,summary_zh,selected,output)
        VALUES (${item.id},${item.revision},'model',${result.model},${TITLE_BATCH_VERSION},${[result.receiptId]},'pass',
          (SELECT category FROM analyses WHERE article_id=${item.id} AND output->>'screening'=${TITLE_BATCH_PURPOSE}
            ORDER BY input_revision DESC,id DESC LIMIT 1),
          ${select ? decision.titleZh ?? null : null},${select ? decision.summaryZh ?? null : null},${select},
          ${tx.json({ titleSelection: true, batchedReview: true, verdict: select ? "select" : duplicate ? "duplicate" : "keep",
            evidenceUrl: select ? key : null, evidenceKind: select ? material?.kind : null, evidence: select ? decision.evidence : null } as never)})`;
      await publishArticleTx(tx, item.id);
      counts.reviewed += 1;
      if (select) counts.selected += 1;
      if (duplicate) counts.duplicate += 1;
    }
    for (const decision of [...result.data.items].sort((a, b) => a.n - b.n)) {
      const item = items[decision.n - 1]!;
      const [a] = await tx<{ excerpt: string | null; url: string; kind: string; tier: string; coverage: string | null }[]>`
        SELECT a.excerpt, a.url, s.kind, s.tier, a.coverage
        FROM articles a JOIN sources s ON s.id = a.source_id
        WHERE a.id = ${item.id} AND a.revision = ${item.revision} AND a.processing_state = 'new'
          AND a.processing_attempt_tag IS NULL AND s.enabled AND s.participation_mode = 'editorial'
          AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id AND p.selected)
        FOR UPDATE OF a`;
      if (!a) continue;
      const review = decision.relevance === "pass" && decision.review && decision.sameAs == null && counts.review < 2 &&
        a.tier !== "EXCLUDE_MP" && pageFetchable(a.url, a.kind);
      const attemptTag = review ? TITLE_SELECTION_TAG + result.receiptId : null;
      const summary = decision.relevance === "pass" && a.coverage !== "public_excerpt" ? a.excerpt?.trim() || null : null;
      const evidence = {
        screening: TITLE_BATCH_PURPOSE, coverage: summary ? "official_abstract" : "metadata_only",
        review, ...(decision.sameAs == null ? {} : { possibleDuplicateOf: items[decision.sameAs - 1]!.id }),
      };
      await tx`INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, title_zh, summary_zh, selected, output)
        VALUES (${item.id}, ${item.revision}, 'model', ${result.model}, ${TITLE_BATCH_VERSION}, ${[result.receiptId]}, ${decision.relevance},
          ${decision.category ?? null}, ${decision.titleZh ?? null}, ${summary}, false, ${tx.json(evidence as never)})`;
      await tx`UPDATE articles SET processing_state = ${review ? "new" : decision.relevance === "block" ? "blocked" : "analyzed"},
        processing_attempt_tag = ${attemptTag}, processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL,
        processing_queued_at = NULL,
        grouping_status = ${review ? "pending" : "complete"}
        WHERE id = ${item.id}`;
      await publishArticleTx(tx, item.id);
      if (review) counts.review += 1;
      counts[decision.relevance] += 1;
    }
    await completeReceipt(tx, result.receiptId);
  });
  return { screened: counts.pass + counts.block + counts.unknown, ...counts, receiptId: result.receiptId, reused: result.reused, usage: result.usage };
}

/** Daily production usage, counted from provider attempts rather than processed articles. */
export async function recordNewsRoundUsage(now = new Date()) {
  const today = beijingDate(now);
  const date = addDays(today, -1);
  const [totals] = await sql<{ calls: number; withUsage: number; tokensIn: number; tokensOut: number; tokensTotal: number }[]>`
    SELECT count(*)::int AS calls,
           count(a.usage)::int AS "withUsage",
           coalesce(sum((a.usage->>'prompt_tokens')::bigint),0)::float8 AS "tokensIn",
           coalesce(sum((a.usage->>'completion_tokens')::bigint),0)::float8 AS "tokensOut",
           coalesce(sum(coalesce((a.usage->>'total_tokens')::bigint,
             (a.usage->>'prompt_tokens')::bigint + (a.usage->>'completion_tokens')::bigint)),0)::float8 AS "tokensTotal"
    FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    WHERE r.purpose=${TITLE_BATCH_PURPOSE} AND a.origin='live'
      AND a.started_at >= ${beijingMidnight(date)} AND a.started_at < ${beijingMidnight(today)}`;
  return { date, ...totals! };
}

export async function registerContentJobs(boss: PgBoss) {
  await work(boss, QUEUES.analyze, { localConcurrency: 3, pollingIntervalSeconds: 2 }, ({ articleId, attemptTag }) => processArticle(articleId, { attemptTag }));
  if (config.titleBatchEnabled) {
    await work(boss, QUEUES.titleBatch, { localConcurrency: 1, pollingIntervalSeconds: 2 }, processTitleBatch);
  }
}

/**
 * Body extraction before analysis. Failures are retried a few times; after that the article is judged
 * on the excerpt it has ("unconfirmed" body, never a wrong one).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await work(boss, QUEUES.extractBody, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async ({ articleId, force }) => {
    const [input] = await sql<{ revision: number; processing_attempt_tag: string | null; kind: string; participation_mode: string; selected: boolean }[]>`
      SELECT a.revision, a.processing_attempt_tag, s.kind, s.participation_mode, coalesce(p.selected, false) AS selected
      FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id WHERE a.id = ${articleId}`;
    if (!input) return { state: "missing" };
    if (config.titleBatchEnabled && input.processing_attempt_tag?.startsWith(TITLE_SELECTION_TAG)) return { state: "waiting-for-news-round" };
    if (usesTitleBatch(input) && !input.processing_attempt_tag && !force) return { state: "waiting-for-title-batch" };
    try {
      const state = await extractArticleBody(articleId);
      // Extraction's failures do not count against the analysis that follows (a new revision starts over anyway).
      if (state !== "skipped") await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL WHERE id = ${articleId} AND revision = ${input.revision}`;
      // A newer revision may still need a body after this task's result was discarded.
      await queueProcessing(articleId);
      return { state };
    } catch (error) {
      // A deploy is not the article's failure: pg-boss retries this job after the restart, as for analysis.
      if (shutdownSignal.signal.aborted) throw error;
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const [a] = await sql<{ processing_attempts: number }[]>`
        UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${`extract: ${message}`},
          processing_queued_at = NULL, processing_retry_at = now() + interval '10 minutes'
        WHERE id = ${articleId} AND revision = ${input.revision} AND body_status <> 'ok' RETURNING processing_attempts`;
      if (!a) {
        await queueProcessing(articleId);
        return { state: "skipped" };
      }
      if (a.processing_attempts < MAX_EXTRACT_FAILURES) return { state: "retrying" };
      await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL
        WHERE id = ${articleId} AND revision = ${input.revision} AND body_status = 'pending'`;
      await queueProcessing(articleId);
      return { state: "unconfirmed" };
    }
  });
}

/**
 * The retry timer (content.sweep): articles waiting for processing whose retry time has come, whose
 * job was never created (a crash between write and enqueue), or whose job has waited half an hour
 * (pg-boss refuses the duplicate while it still exists). Returns the jobs actually created.
 */
export async function sweepUnprocessed(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (NOT ${config.titleBatchEnabled} OR processing_attempt_tag IS NULL OR processing_attempt_tag NOT LIKE ${TITLE_SELECTION_TAG + "%"})
      AND (NOT ${config.titleBatchEnabled} OR processing_attempt_tag IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM sources s WHERE s.id = articles.source_id AND s.participation_mode = 'editorial'
        AND s.kind IN ('rss', 'web_list', 'json_list')) OR EXISTS (
        SELECT 1 FROM publications p WHERE p.article_id = articles.id AND p.selected))
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at DESC LIMIT 500`;
  let enqueued = 0;
  for (const r of rows) if (await queueProcessing(r.id)) enqueued += 1;
  return { enqueued };
}

/**
 * The receipts of an article's analysis: an unknown outcome on any of them stops the article
 * ("failed"). Extraction never does: it retries, then judges the article on what it has.
 */
const ARTICLE_STEPS = new Set(["prefilter_article", "score_article", "structure_article", "understand_article", "summarize_article"]);

/**
 * After a receipt is released (operations/recover.ts), the article that stopped on it goes straight
 * back to processing: one action, not two. Returns whether it was queued.
 */
export async function resumeAfterRelease(receipt: { purpose: string; subject: string | null }, db: Db): Promise<boolean> {
  if (receipt.purpose === TITLE_BATCH_PURPOSE) {
    const rows = await db`UPDATE articles SET processing_state = 'new', processing_error = NULL, processing_retry_at = NULL
      WHERE processing_state = 'failed' AND processing_error = ${"title batch receipt " + receipt.subject} RETURNING id`;
    return rows.length > 0;
  }
  const article = ARTICLE_STEPS.has(receipt.purpose) ? /^article:([^@:#]+)/.exec(receipt.subject ?? "")?.[1] : undefined;
  if (!article) return false;
  const [a] = await db`UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
                        WHERE id = ${article} AND processing_state = 'failed' RETURNING id`;
  return !!a && !!(await queueProcessing(article, { step: "analyze", db }));
}

/** How the runs page groups failures: the message with ids and numbers masked. */
export const failureGroupSql = (column = "processing_error") =>
  sql.unsafe(`regexp_replace(left(coalesce(${column}, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`);

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the sweep picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql()} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}
