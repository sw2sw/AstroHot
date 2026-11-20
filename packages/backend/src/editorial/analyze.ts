// analyzeArticle: the judging and writing steps, each with its own prompt from the industry pack
// (industry/prompts/):
//   1. prefilter: does the material belong to this industry at all (wide recall). Only BLOCK stops an
//      item; UNKNOWN goes on like PASS (a BLOCK given while material is missing counts as UNKNOWN);
//   2. score: two independent scores against the source tier's threshold (industry/selection.ts) decide 精选;
//   3. structure: category, tags, subjects and the current news fact, beside scoring;
//   4. writing, once the structure is in: the Chinese title, summary and reason by the content
//      understanding for selected and near-selected items, by the cheaper title/summary prompts for the rest.
// Material with only a title or a feed summary has its article page fetched before it is judged.
import { z } from "zod";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import { AI4S_DOMAINS, AI4S_DOMAIN_KEYS } from "@aihot/industry/ai4s";
import { sql } from "../db.ts";
import { chatJson, MODELS, ModelOutputError, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, ProviderRejectedError, ReceiptUnknownError } from "../providers/receipts.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { modelFor } from "./models.ts";
import { buildMaterial, firstImageOf, firstImagePart, loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { pageFetchable } from "../content/extract.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, echoesWritingTemplate, finalizeCopy, isShortTweetInput, looksZh, materialHeading, MAX_BODY_CHARS, missingEvidence,
  needsShortTweetTranslation, parseTranslateOutput, PREFILTER_SYSTEM, prefilterUser, translateInputOf, AI4S_UNDERSTAND_SYSTEM, UNDERSTAND_SYSTEM, understandUser,
  type IdentityGuard,
} from "./writing.ts";
import { CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, normalizeTags, TOPIC_TAGS } from "./vocabulary.ts";
import { newsImageAttribution } from "./image-attribution.ts";
import { reviewFirstImage, type ImageReview } from "./image-review.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { ConferenceExtractionSchema, normalizeConference, type GroundedConference } from "./conference.ts";
import { projectConference } from "../content/conferences.ts";

export { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle };

export const PROMPT_VERSIONS = {
  prefilter: promptVersion("prefilter"),
  score: promptVersion("selection-score"),
  understand: promptVersion("understand"),
  summarize: promptVersion("summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context"),
  structure: promptVersion("structure"),
} as const;
/** Every step's prompt, as stored on each judgement. */
export const SELECTION_PROMPT_VERSION = [PROMPT_VERSIONS.prefilter, PROMPT_VERSIONS.score].join("+");
export const ANALYZE_PROMPT_VERSION = Object.values(PROMPT_VERSIONS).join("+");

// The AI4S column judges with its own prefilter, score and structure prompts, and writes under its own
// discipline-neutral understand/summarize prompts (the shared astronomy ones force astronomy translations
// that would misrender life-science/materials material). Versions stay separate so an AI4S receipt never
// collides with an astronomy one, and the astronomy versions are left untouched.
export const AI4S_PROMPT_VERSIONS = {
  prefilter: promptVersion("ai4s-prefilter"),
  score: promptVersion("ai4s-selection-score"),
  structure: promptVersion("ai4s-structure"),
  understand: promptVersion("ai4s-understand"),
  summarize: promptVersion("ai4s-summarize-article", "summarize-article-empty", "identity-context"),
} as const;
export const AI4S_ANALYZE_PROMPT_VERSION = [
  AI4S_PROMPT_VERSIONS.prefilter, AI4S_PROMPT_VERSIONS.score, AI4S_PROMPT_VERSIONS.understand, AI4S_PROMPT_VERSIONS.summarize, AI4S_PROMPT_VERSIONS.structure,
].join("+");

// Scoring

/** Independent score calls per article; their sum decides, their mean (floored) is shown. */
export const SCORE_CALLS = 2;

/**
 * The thresholds on the mean score, per source tier (industry/selection.ts): selected when
 * score1 + score2 >= 2 × threshold. Tiers without a threshold are not scored for 精选.
 */
export function tierThreshold(tier: string): number | null {
  return SELECTION.thresholds[tier] ?? null;
}

/** Unselected items above this mean are written like selected ones. */
export const UNDERSTAND_FLOOR = SELECTION.understandFloor;

/**
 * Call parameters per score model. The GLM scorer runs at temperature 1 with high reasoning (the model
 * registry adds top_p and thinking) and up to 180 s per call.
 */
const SCORE_CALL: Record<string, { temperature: number; maxTokens: number; timeoutMs: number }> = {
  "glm-5.3-flash-selection": { temperature: 1, maxTokens: 65_536, timeoutMs: 180_000 },
};
const scoreCall = (model: string) => SCORE_CALL[model] ?? { temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000 };

/** The score prompt: the industry's taste (industry/prompts/selection-score.md). */
export const SCORE_SYSTEM = promptText("selection-score");

/** The AI4S column's prefilter and score prompts (industry/prompts/ai4s-*.md). */
export const AI4S_PREFILTER_SYSTEM = promptText("ai4s-prefilter");
export const AI4S_SCORE_SYSTEM = promptText("ai4s-selection-score");

export const ScoreSchema = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

const SCORE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** The score input's time: Beijing time, ISO 8601 with +08:00 (the form the prompt was tuned on). */
export function scoreInputTime(at: Date): string {
  const ms = at.getTime() % 1000;
  return `${SCORE_TIME.format(at).replace(" ", "T")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}+08:00`;
}

/**
 * The score input: no source facts (the prompt forbids guessing them), the publication time, the
 * original title (items are scored before any Chinese copy exists) and the whole body.
 */
export function buildScoreInput(a: AnalyzeInputArticle): string {
  let body: string;
  if (a.xPost) {
    const quoted = a.xPost.quoted?.text ? `\n\n[引用 ${a.xPost.quoted.handle ? `@${a.xPost.quoted.handle}` : "原推文"}]：${a.xPost.quoted.text}` : "";
    body = `${String(a.xPost.text ?? "").trim()}${quoted}`.trim();
  } else {
    body = (a.bodyText ?? a.excerpt ?? "").trim();
  }
  if (!body) body = a.title;
  const at = a.publishedAt ?? a.discoveredAt ?? null;
  // The heading names what was actually stored: a scored feed summary must not be presented to the
  // model as the article's full text (the material range is stated on its own line as well).
  const heading = a.xPost ? "完整正文" : materialHeading(a);
  // A day-only source date is stated as a date, never as an invented instant.
  const when = !at ? "" : a.datePrecision === "day" ? `${beijingDate(at)}（原文只精确到日）` : scoreInputTime(at);
  return [
    "请按系统规则评估以下单篇材料所代表的事件。只输出 attentionScore。",
    `【发布时间（北京时间）】\n${when}`,
    `【标题】\n${a.title.trim()}`,
    // A sufficient abstract is scored, but the request states plainly that the full text was not read.
    ...(a.contentScope === "ai4s" && a.coverage !== "full_text" ? ["【评分范围】本条未阅读全文，仅依据上述官方摘要/公开片段评分；只按材料能证明的范围打分，不把摘要外的想象当证据。"] : []),
    `【${heading}】\n${body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body}`,
  ].join("\n\n");
}

// Step outputs

const PrefilterSchema = z.object({
  label: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  reason: z.string().max(200).catch(""),
});

const FactSchema = z
  .object({
    title: z.string().max(80),
    subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(),
    object: z.string().max(160).nullable().optional(),
    occurredAt: z.string().nullable().optional(),
    evidence: z.string().trim().max(600).nullable().catch(null),
    conditions: z.array(z.object({
      // Older reusable receipts may also contain a paraphrase. New extraction only copies evidence.
      text: z.string().trim().min(1).max(200).optional().catch(undefined),
      quote: z.string().trim().min(1).max(400),
    }).nullable().catch(null)).catch([]),
  })
  .nullable()
  .catch(null);

export const StructureSchema = z.object({
  scope: z.enum(["single", "composite", "unknown"]).catch("unknown"),
  category: z.enum(CATEGORY_KEYS).nullable().catch(null),
  tags: z.array(z.string()).max(12).catch([]),
  subjects: z.array(z.string()).max(6).catch([]),
  fact: FactSchema,
  // A conference notice is read in the same structure call: no extra model request. Absent or null for
  // every other article, which is what keeps older results compatible.
  conference: ConferenceExtractionSchema.optional().catch(null),
});

/** The AI4S structure step: a discipline domain and an evidence-backed AI4A finding, no astronomy category/tags. */
export const Ai4sStructureSchema = z.object({
  scope: z.enum(["single", "composite", "unknown"]).catch("unknown"),
  domain: z.enum(AI4S_DOMAIN_KEYS).nullable().catch(null),
  astroApplication: z.object({
    applies: z.boolean().nullable().catch(null),
    evidence: z.string().trim().max(600).nullable().catch(null),
    // The specific astronomy object, facility, survey or data product the AI was applied to, copied from
    // the evidence. A method word ("spectra") is not a referent; the gate checks it is in the quote.
    referent: z.string().trim().max(80).nullable().catch(null),
  }).nullable().catch(null),
  fact: FactSchema,
  conference: ConferenceExtractionSchema.optional().catch(null),
});


const UnderstandSchema = z.object({
  imageSuitability: z.unknown().optional(),
  itemType: z.enum(ITEM_TYPES),
  authorRole: z.enum(["principal", "observer", "relayer"]).catch("relayer"),
  // The understanding prompt asks for tags; the public ones come from the structure step.
  tags: z.array(z.string()).max(12).catch([]),
  editorialJudgment: z.string().max(400).catch(""),
  titleZh: z.string().trim().min(1).max(200),
  summaryZh: z.string().trim().min(1).max(4000),
});

const modelCopy = z.string().refine((text) => !echoesWritingTemplate(text), "Model echoed a writing template placeholder");
export const SummarizeSchema = z.object({ titleZh: modelCopy, summaryZh: modelCopy, bodyZh: modelCopy });

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** The existing category tag a conference notice carries; no parallel 「会议」 tag is introduced. */
const CONFERENCE_TAG = "学术会议";

/** The structure step owns the public category and tags, as well as grouping evidence (filled from the pack's vocabulary). */
export const STRUCTURE_SYSTEM = promptText("structure", {
  categoryCount: ZH_COUNT[CATEGORIES.length] ?? String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
});

/** Keep only quotes present both in the original material and in the text the structure model saw. */
export function normalizeStructure(data: z.infer<typeof StructureSchema>, a: AnalyzeInputArticle) {
  const visible = collapseWhitespace(buildMaterial(a));
  const originals = (a.xPost
    ? [String(a.xPost.text ?? a.title), String(a.xPost.quoted?.text ?? "")]
    : [a.bodyText ?? a.excerpt ?? ""]).map(collapseWhitespace);
  // A title is not the unseen contents of a video/article, regardless of the model's confidence.
  const scope = originals.some(Boolean) ? data.scope : "unknown";
  const grounded = (quote: string | null | undefined) => {
    const text = collapseWhitespace(quote ?? "");
    return text && visible.includes(text) && originals.some((original) => original.includes(text)) ? text : null;
  };
  const fact = !originals.some(Boolean) || scope === "composite" || !data.fact ? null : {
    ...data.fact,
    evidence: grounded(data.fact.evidence),
    conditions: data.fact.conditions.flatMap((c) => {
      if (!c) return [];
      const quote = grounded(c.quote);
      return quote ? [{ text: c.text ?? quote, quote }] : [];
    }).slice(0, 4),
  };
  return {
    category: data.category, tags: normalizeTags(data.tags),
    subjects: [...new Set(data.subjects.map((s) => s.trim().toLowerCase()).filter((s) => s in ENTITIES))],
    scope, fact,
    // Recognised in this same call, grounded against the original (conference.ts).
    conference: normalizeConference(data.conference, a),
  };
}

/** The AI4S structure prompt, filled from the column's discipline domains. */
export const AI4S_STRUCTURE_SYSTEM = promptText("ai4s-structure", {
  domainCount: ZH_COUNT[AI4S_DOMAINS.length] ?? String(AI4S_DOMAINS.length),
  domainGuide: AI4S_DOMAINS.map((d) => `- ${d.key}（${d.label}）：${d.guide}`).join("\n"),
});

// AI4A is a claim the model makes; this is a structural consistency gate, not a scientific verification.
// Three things must agree before the finding stands: the discipline the model assigned, the specific
// object it says the AI was applied to, and the verbatim quote it supplies. A quote that bears no
// astronomy application — a pure physics result, a laboratory measurement, astronomy named only as a
// background foil — cannot support the claim, so the finding stays null.
//
// The referent vocabulary names celestial objects, astronomy facilities, surveys and data products only.
// Measurement methods are deliberately absent: "spectra", "spectral", "photometric", "spectroscopic" and
// "interferometer" describe laboratory work just as well, so their presence alone proves nothing.
const ASTRO_EN = ["galaxy", "galaxies", "stellar", "star", "stars", "exoplanet", "supernova", "pulsar", "nebula", "asteroid", "comet", "telescope", "observatory", "redshift", "cosmic microwave", "gravitational wave", "black hole", "neutron star", "dark matter", "dark energy", "sky survey", "coronagraph", "light curve", "radial velocity", "astrometr", "cosmolog", "astrophys", "astronomical", "astronomy", "jwst", "hubble", "alma", "chandra", "fermi", "tess", "euclid", "rubin", "lsst", "sdss", "gaia", "kepler", "eht", "event horizon telescope", "m87"];
const ASTRO_ZH = ["星系", "恒星", "系外行星", "超新星", "脉冲星", "星云", "小行星", "彗星", "望远镜", "天文台", "红移", "巡天", "引力波", "黑洞", "中子星", "暗物质", "暗能量", "宇宙微波背景", "天体", "天文", "光变", "视向速度", "天体测量", "宇宙学"];
const astroPresent = (text: string) => new RegExp(`\\b(?:${ASTRO_EN.join("|")})\\b`, "i").test(text) || ASTRO_ZH.some((t) => text.includes(t));
const BACKGROUND_FOIL = /\b(?:unlike|rather than|compared (?:to|with)|in contrast (?:to|with)|instead of|as opposed to)\s+[^,.;]*|(?:不同于|而非|而不是|相较于|相比|有别于)[^，。；,.;]*/gi;
/** The quote must still name an astronomy application after background/contrast foils are removed. */
function supportsAstronomyApplication(evidence: string): boolean {
  return astroPresent(evidence) && astroPresent(evidence.replace(BACKGROUND_FOIL, " "));
}
/**
 * The discipline must be consistent with the claim: a work whose own domain is an astronomy or a
 * general research-method one can support an astronomy application; a life-sciences, chemistry or
 * materials finding that claims one is a contradiction the pipeline cannot resolve, so it is null and
 * stays available for a human astronomy determination (an audited override), never a silent pass.
 */
const AI4A_DOMAINS = new Set<string>(["astronomy-astrophysics", "methods-tools"]);

/**
 * The AI4S structure: the same grounding guard as the astronomy site for the fact, plus a discipline
 * domain and an AI4A finding. AI4A is true only when all of these hold: the model claims an astronomy
 * application; its quote is present verbatim in the original material; the quote names a specific
 * astronomy object or facility, not only a measurement method or a background foil; the model names that
 * same object as the referent; and the assigned domain is consistent with an astronomy application.
 * Anything else is null (unknown), not false — and never a claim of scientific verification.
 */
export function normalizeAi4sStructure(data: z.infer<typeof Ai4sStructureSchema>, a: AnalyzeInputArticle) {
  const base = normalizeStructure({ scope: data.scope, category: null, tags: [], subjects: [], fact: data.fact, conference: null }, a);
  const visible = collapseWhitespace(buildMaterial(a));
  const originals = (a.xPost
    ? [String(a.xPost.text ?? a.title), String(a.xPost.quoted?.text ?? "")]
    : [a.bodyText ?? a.excerpt ?? ""]).map(collapseWhitespace);
  const evidence = collapseWhitespace(data.astroApplication?.evidence ?? "");
  const grounded = !!evidence && visible.includes(evidence) && originals.some((original) => original.includes(evidence));
  const applies = data.astroApplication?.applies ?? null;
  const referent = collapseWhitespace(data.astroApplication?.referent ?? "");
  // The referent the model names must be in its own quote and must itself be an astronomy referent.
  const referentGrounded = !!referent && astroPresent(referent) && evidence.includes(referent);
  const domainConsistent = data.domain !== null && AI4A_DOMAINS.has(data.domain);
  const ai4a = applies === true
    ? (grounded && referentGrounded && domainConsistent && supportsAstronomyApplication(evidence) ? true : null)
    : applies === false ? false : null;
  return { ...base, domain: data.domain, ai4a, conference: normalizeConference(data.conference, a) };
}

export interface AnalysisRun {
  prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; reason: string; model: string; receiptId: number; reused: boolean };
  /**
   * The independent score calls and the tier threshold they are held against; absent when the material
   * is not scored. `refused`: the model's content filter declined it, so it is not selected.
   */
  scores: { model: string; threshold: number; values: number[]; receiptIds: number[]; reused: boolean; refused?: boolean } | null;
  /** The reader-facing copy: `understand` (selected, near-selected), `summarize`, `verbatim` (a Chinese short post), `none`. */
  writing: {
    kind: "understand" | "summarize" | "verbatim" | "none";
    model: string | null;
    titleZh: string;
    summaryZh: string;
    reasonZh: string | null;
    itemType?: string;
    authorRole?: string;
    identityGuard?: IdentityGuard;
    imageReview?: ImageReview;
    receiptIds: number[];
    reused: boolean;
  } | null;
  /**
   * The structure finding. `conference` is optional: results written before conference recognition
   * existed carry no such field, and a judgement without one is a judgement with no notice.
   */
  structure: (Omit<ReturnType<typeof normalizeStructure>, "conference"> & { conference?: GroundedConference | null; domain?: string | null; ai4a?: boolean | null; model: string; receiptId: number; reused: boolean }) | null;
}

const isContentFilter = (error: unknown) => error instanceof ProviderRejectedError && !error.retryable && /contentFilter|"1301"/.test(error.message);

/** Only a title or a feed summary, and a page to fetch: the article is judged on the page. */
export function waitsForPage(a: AnalyzeInputArticle): boolean {
  return a.bodyStatus === "pending" && !a.bodyText && !a.xPost && pageFetchable(a.url, a.source.kind);
}

type StepOpts = { attemptTag?: string; scoreModel?: string };
type ReceiptObserver = (receiptId: number) => void;
export class AnalysisInterruptedError extends Error {}

const observableReceiptId = (error: unknown): number | null =>
  error instanceof ModelOutputError || error instanceof ReceiptUnknownError ? error.receiptId : null;

function checkAnalysisRunning() {
  if (shutdownSignal.signal.aborted) throw new AnalysisInterruptedError("worker shutting down between analysis stages");
}

const subjectOf = (a: AnalyzeInputArticle) => `article:${a.id}@${a.revision}`;
const tagged = (attemptTag: string | undefined, step: string) => [attemptTag, step].filter(Boolean).join(":") || undefined;

async function runPrefilter(a: AnalyzeInputArticle, opts: StepOpts): Promise<AnalysisRun["prefilter"]> {
  const model = await modelFor("prefilter");
  checkAnalysisRunning();
  const ai4s = a.contentScope === "ai4s";
  const res = await chatJson({
    model,
    purpose: "prefilter_article",
    subject: subjectOf(a),
    promptVersion: ai4s ? AI4S_PROMPT_VERSIONS.prefilter : PROMPT_VERSIONS.prefilter,
    system: ai4s ? AI4S_PREFILTER_SYSTEM : PREFILTER_SYSTEM,
    user: prefilterUser(a),
    schema: PrefilterSchema,
    temperature: 0,
    maxTokens: 512,
    attemptTag: opts.attemptTag,
  });
  // A BLOCK without material to back it counts as UNKNOWN (which goes on).
  const label = res.data.label === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : res.data.label;
  return { label, reason: res.data.reason, model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** The production prefilter step, exposed separately so SelectBench can preserve partial receipt evidence. */
export async function runSelectionPrefilter(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<AnalysisRun["prefilter"]> {
  try {
    const result = await runPrefilter(a, opts);
    onReceipt?.(result.receiptId);
    return result;
  } catch (error) {
    const receiptId = observableReceiptId(error);
    if (receiptId !== null) onReceipt?.(receiptId);
    throw error;
  }
}

async function runScores(
  a: AnalyzeInputArticle,
  threshold: number,
  opts: StepOpts,
  onReceipt?: ReceiptObserver,
): Promise<NonNullable<AnalysisRun["scores"]>> {
  const model = opts.scoreModel ?? (await modelFor("score"));
  const call = scoreCall(model);
  const input = buildScoreInput(a);
  const ai4s = a.contentScope === "ai4s";
  const values: number[] = [];
  const receiptIds: number[] = [];
  let reused = true;
  // One after the other: the second call reuses the provider's cached prompt.
  for (let i = 0; i < SCORE_CALLS; i++) {
    checkAnalysisRunning();
    try {
      const res = await chatJson({
        model, purpose: "score_article", subject: subjectOf(a), promptVersion: ai4s ? AI4S_PROMPT_VERSIONS.score : PROMPT_VERSIONS.score, system: ai4s ? AI4S_SCORE_SYSTEM : SCORE_SYSTEM, user: input,
        schema: ScoreSchema, temperature: call.temperature, maxTokens: call.maxTokens, timeoutMs: call.timeoutMs,
        // Each call is its own paid request; an explicit re-evaluation gets new ones.
        attemptTag: tagged(opts.attemptTag, `score-${i + 1}`),
      });
      onReceipt?.(res.receiptId);
      values.push(res.data.attentionScore);
      receiptIds.push(res.receiptId);
      reused &&= res.reused;
    } catch (error) {
      const receiptId = observableReceiptId(error);
      if (receiptId !== null) onReceipt?.(receiptId);
      // The model's content filter declines the material (Zhipu 1301): not scored, so not selected.
      if (isContentFilter(error)) return { model, threshold, values, receiptIds, reused: false, refused: true };
      throw error;
    }
  }
  return { model, threshold, values, receiptIds, reused };
}

/** A result that is only promised, planned or still to come is not a stated result. */
const PLANNED = /\b(?:plan|plans|planned|planning|will|would|aim|aims|intend|intends|upcoming|forthcoming|expect|expects|expected|hope|hopes|soon|future)\b|计划|拟|将(?:于|在|会|来)|预计|有望|即将|后续|未來|未来/i;
/** Text that says the result is not there yet never becomes a result by being written down. */
const WITHHELD = /\b(?:not (?:yet )?available|no results?|results? (?:are|is|were) not|not (?:yet )?released|to be (?:published|released)|coming soon)\b|尚未|暂未|待公布|无结果|暂无|未能提供|结果未/i;
/** A concrete finding: a number with a unit, a share, a factor or a significance. */
const QUANTITY = /\d+(?:\.\d+)?\s*(?:%|percent|fold|×|x\b|σ|sigma|nm|μm|µm|mm|cm|km|eV|keV|MeV|GeV|TeV|Hz|kHz|MHz|GHz|ms|s\b|million|billion|thousand|万|亿)/i;
/** Verbs that state an action taken on an object (never a bare "we are working on it"). */
const RESULT_VERB = /\b(?:release[ds]?|reduc\w+|improv\w+|prov\w+|measur\w+|classif\w+|predict\w+|achiev\w+|outperform\w+|validat\w+|demonstrat\w+|report\w+|observ\w+|detect\w+|increas\w+|decreas\w+|enable[ds]?|identif\w+|benchmark\w*|found|finds|show\w*|estimat\w+|deriv\w+|refin\w+)\b/i;
const contentTokens = (s: string) => s.split(/\s+/).filter((t) => /[A-Za-z0-9\u4e00-\u9fff]/.test(t)).length;
/** Chinese has no word breaks: an action verb plus a clause long enough to carry an object. */
const ZH_RESULT = /(发布|提出|证明|测量|分类|预测|实现|提升|降低|减少|增加|验证|观测|探测|发现|公开|基准|估计|推导|改进|识别|重建|标定)/;
const statesResult = (s: string): boolean => {
  if (QUANTITY.test(s)) return true;
  if (RESULT_VERB.test(s) && contentTokens(s) >= 6) return true;
  return ZH_RESULT.test(s) && s.replace(/\s+/g, "").length >= 12;
};

/**
 * Whether an AI4S limited intro carries enough substance to score. Coverage type is not material
 * sufficiency, and neither is length: a one-line teaser or a blog description cannot support an attention
 * judgment, while one sentence stating a concrete result can. This is a substance floor, not a reading of
 * the science: the text must say what was done or found, and announcing, planned or explicitly withheld
 * results do not count, in however many sentences they are wrapped.
 */
export function ai4sMaterialSufficient(a: AnalyzeInputArticle): boolean {
  if (a.coverage === "full_text") return true;
  if (a.coverage === "metadata_only") return false;
  const text = collapseWhitespace(a.bodyText ?? a.excerpt ?? "");
  if (!text) return false;
  const sentences = text.split(/[.!?。！？]+/).map((s) => s.trim()).filter(Boolean);
  // A planned, forthcoming or explicitly withheld result is not a result, whatever surrounds it.
  const stated = sentences.filter((s) => !PLANNED.test(s) && !WITHHELD.test(s));
  if (!stated.length) return false;
  // A quantitative finding stands on its own; a qualitative one must name an action on a concrete object.
  return stated.some(statesResult);
}

/** The production score step; its threshold stays case-specific even when an evaluator shares model output. */
export async function runSelectionScores(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<AnalysisRun["scores"]> {
  // The AI4S column scores material that supports an attention judgment: confirmed full text, or a
  // sufficient official abstract scored within its proven range. A thin teaser carries no score and
  // cannot be auto-selected; auto-selection itself stays off until an authorized calibration.
  if (a.contentScope === "ai4s" && !ai4sMaterialSufficient(a)) return null;
  const threshold = tierThreshold(a.source.tier);
  return threshold === null ? null : runScores(a, threshold, opts, onReceipt);
}

export async function runStructure(a: AnalyzeInputArticle, opts: StepOpts = {}): Promise<NonNullable<AnalysisRun["structure"]>> {
  const model = await modelFor("structure");
  checkAnalysisRunning();
  if (a.contentScope === "ai4s") {
    const res = await chatJson({
      model,
      purpose: "structure_article",
      subject: subjectOf(a),
      promptVersion: AI4S_PROMPT_VERSIONS.structure,
      system: AI4S_STRUCTURE_SYSTEM,
      user: buildMaterial(a),
      schema: Ai4sStructureSchema,
      temperature: 0.2,
      maxTokens: 1200,
      attemptTag: tagged(opts.attemptTag, "structure"),
    });
    return { ...normalizeAi4sStructure(res.data, a), model: res.model, receiptId: res.receiptId, reused: res.reused };
  }
  const res = await chatJson({
    model,
    purpose: "structure_article",
    subject: subjectOf(a),
    promptVersion: PROMPT_VERSIONS.structure,
    system: STRUCTURE_SYSTEM,
    user: buildMaterial(a),
    schema: StructureSchema,
    temperature: 0.2,
    maxTokens: 1200,
    attemptTag: tagged(opts.attemptTag, "structure"),
  });
  return { ...normalizeStructure(res.data, a), model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** Content understanding grounded in the original; null on a content-filter refusal. */
export async function runUnderstand(a: AnalyzeInputArticle, opts: StepOpts = {}): Promise<AnalysisRun["writing"]> {
  const model = await modelFor("understand");
  const ai4s = a.contentScope === "ai4s";
  const call = (image: ContentPart | null) => {
    const text = understandUser(a, !!image);
    checkAnalysisRunning();
    return chatJson({
      model, purpose: "understand_article", subject: subjectOf(a), promptVersion: ai4s ? AI4S_PROMPT_VERSIONS.understand : PROMPT_VERSIONS.understand,
      system: ai4s ? AI4S_UNDERSTAND_SYSTEM : UNDERSTAND_SYSTEM,
      user: image ? [{ type: "text", text }, image] : text, schema: UnderstandSchema, temperature: 0.2, maxTokens: 16_384,
      timeoutMs: 180_000, attemptTag: tagged(opts.attemptTag, "understand"),
    });
  };
  // A model that is known not to read images gets the text only.
  const image = MODELS[model]?.vision === true ? await firstImagePart(a) : null;
  let reviewedImage = !!image;
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await call(image);
  } catch (error) {
    if (isContentFilter(error)) return null;
    // The model refused the image (download, format): the text is written without it.
    if (!image || !(error instanceof ProviderRejectedError) || error.retryable) throw error;
    try {
      reviewedImage = false;
      res = await call(null);
    } catch (retryError) {
      if (isContentFilter(retryError)) return null;
      throw retryError;
    }
  }
  const d = res.data;
  const candidate = firstImageOf(a);
  const suitability = candidate ? reviewFirstImage(String(candidate.url), reviewedImage ? d.imageSuitability : undefined) : null;
  if (suitability && !reviewedImage) {
    suitability.status = MODELS[model]?.vision !== true ? "no-vision" : !image ? "download-failed" : "provider-rejected";
    suitability.reason = `首图审核未完成：${suitability.status}；保留文本，不自动重试`;
  }
  const hasCredit = typeof candidate?.credit === "string" && !!candidate.credit.trim();
  let attributionUrl: string | undefined;
  try {
    const url = new URL(candidate?.attributionUrl);
    if (typeof candidate?.attributionUrl === "string" && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) attributionUrl = candidate.attributionUrl;
  } catch { /* Only safe absolute attribution URLs may override the official link. */ }
  const esaScience = /^https:\/\/www\.esa\.int\//.test(a.url);
  const attribution = candidate && suitability?.approved === true && suitability.category === "related" && (esaScience || !hasCredit || !attributionUrl) && !a.xPost
    ? await newsImageAttribution(a.url, String(candidate.url)) : null;
  const imageReview: ImageReview | undefined = candidate ? {
    ...(attribution ?? {}),
    ...suitability!,
    ...(esaScience ? { rightsStatus: attribution ? "verified" as const : "unverified" as const } : {}),
    ...(esaScience && suitability?.approved === true && !attribution
      ? { status: "rights-unverified" as const, suitabilityStatus: "approved" as const } : {}),
    // An inconsistent or uncertain answer never grants permission to show an image.
    approved: suitability?.approved === true && suitability.category === "related" && (!esaScience || !!attribution),
    url: String(candidate.url),
    ...(!esaScience && hasCredit ? { credit: candidate.credit } : {}),
    ...(typeof candidate.caption === "string" ? { caption: candidate.caption } : {}),
    ...(!esaScience && attributionUrl ? { attributionUrl } : {}),
  } : undefined;
  const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
  return {
    kind: "understand", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: d.editorialJudgment.trim() || null,
    ...(imageReview ? { imageReview } : {}),
    itemType: d.itemType, authorRole: d.authorRole, identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused,
  };
}

/** The title/summary prompts (articles, long and short posts). */
async function runSummarize(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  const t = translateInputOf(a);
  const isX = t.sourceKind === "x_search";
  const short = isShortTweetInput(t);
  const main = collapseWhitespace(t.mainText || t.title);
  const plain = { reasonZh: null, receiptIds: [] as number[], reused: true };
  // A short post already in Chinese is its own copy, and too little text is not written up from a title.
  if (short && !needsShortTweetTranslation(main)) return { kind: "verbatim", model: null, titleZh: main, summaryZh: main, ...plain };
  if (!short && t.text.trim().length < 20) return { kind: "none", model: null, titleZh: looksZh(t.title) ? t.title : "", summaryZh: "", ...plain };
  const model = await modelFor("summarize");
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "summarize_article",
    subject: subjectOf(a),
    promptVersion: a.contentScope === "ai4s" ? AI4S_PROMPT_VERSIONS.summarize : PROMPT_VERSIONS.summarize,
    system: "",
    user: short ? buildShortTweetPrompt(t) : isX ? buildLongTweetPrompt(t) : buildArticlePrompt(t),
    schema: SummarizeSchema,
    json: false,
    parse: parseTranslateOutput,
    temperature: 0.2,
    maxTokens: 2048,
    attemptTag: tagged(opts.attemptTag, "summarize"),
  });
  const p = res.data;
  const draft = short
    ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.bodyZh || p.summaryZh }
    : isX
      ? { titleZh: p.titleZh, summaryZh: p.summaryZh || p.bodyZh }
      : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  const copy = finalizeCopy(t, draft);
  return { kind: "summarize", model: res.model, titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: null, identityGuard: copy.identityGuard, receiptIds: [res.receiptId], reused: res.reused };
}

/** Runs the steps on the material as it is (or reuses their receipts) without writing business results. */
export async function runAnalysis(a: AnalyzeInputArticle, opts: StepOpts = {}): Promise<AnalysisRun> {
  checkAnalysisRunning();
  const prefilter = await runSelectionPrefilter(a, opts);
  // UNKNOWN is let through (its material is as complete as it will get); BLOCK stops here.
  if (prefilter.label === "BLOCK") return { prefilter, scores: null, writing: null, structure: null };
  // The structure step needs nothing from the scores: it runs beside them.
  const structure = runStructure(a, opts).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const scores = await runSelectionScores(a, opts);
    const sum = scores && !scores.refused && scores.values.length === SCORE_CALLS ? scores.values.reduce((total, v) => total + v, 0) : null;
    const near = sum !== null && (sum >= scores!.threshold * SCORE_CALLS || sum > UNDERSTAND_FLOOR * SCORE_CALLS);
    const s = await structure;
    if ("error" in s) throw s.error;
    const writing = (near ? await runUnderstand(a, opts) : null) ?? (await runSummarize(a, opts));
    return { prefilter, scores, writing, structure: s.value };
  } finally {
    // A score/writing error or deploy must not let the job finish while a paid structure request
    // still owns a response. It settles and stores its receipt before shutdown can close the DB.
    await structure;
  }
}

/** One judgement from the steps: the selection rule, the reader-facing copy and the structure. */
export function normalizeAnalysis(run: AnalysisRun, contentScope = "astro") {
  const label = run.prefilter.label;
  const titleZh = collapseWhitespace(run.writing?.titleZh ?? "");
  const summaryZh = (run.writing?.summaryZh ?? "").trim();
  // Past the prefilter (PASS or UNKNOWN) an item is relevant, but without a usable Chinese title and
  // summary it cannot be published: it waits.
  const relevance = label === "BLOCK" ? "block" : run.writing && (!titleZh || !summaryZh) ? "unknown" : "pass";
  // Selected when the two scores add up to twice the tier threshold; the mean, floored, is the score
  // shown (it never decides a half point on its own). The AI4S column does not auto-select until a
  // sample calibration is authorised (industry/selection.ts), so its items stay candidates only.
  const values = run.scores && !run.scores.refused ? run.scores.values : null;
  const sum = values?.length === SCORE_CALLS ? values.reduce((total, v) => total + v, 0) : null;
  const score = sum === null ? null : Math.floor(sum / SCORE_CALLS);
  const threshold = run.scores?.threshold ?? null;
  const autoSelection = contentScope === "ai4s" ? SELECTION.ai4sAutoSelection : true;
  const selected = relevance === "pass" && sum !== null && threshold !== null && sum >= threshold * SCORE_CALLS && autoSelection;
  const subjects = run.structure?.subjects ?? [];
  const tags = [...(run.structure?.tags ?? [])];
  for (const s of subjects) {
    const display = ENTITIES[s]?.displayTag;
    if (display && !tags.includes(display)) tags.push(display);
  }
  // A recognised notice is tagged here, not by the prompt: the AI4S structure step has no tag
  // vocabulary of its own, so leaving it to the model would let the same notice carry the tag in one
  // column and not in the other. Only a grounded notice reaches this point — ordinary material, a
  // results report and an ambiguous paragraph never do, and no other tag is touched.
  const conference = run.structure?.conference ?? null;
  if (conference && !tags.includes(CONFERENCE_TAG)) tags.unshift(CONFERENCE_TAG);
  return {
    relevance,
    selected,
    score,
    scores: values,
    scoreModel: run.scores?.model ?? null,
    scoreRefused: run.scores?.refused ?? false,
    threshold,
    category: run.structure?.category ?? null,
    tags: tags.slice(0, 6),
    subjects,
    titleZh,
    summaryZh,
    reasonZh: run.writing?.reasonZh ?? null,
    scope: run.structure?.scope ?? "unknown",
    fact: run.structure?.fact ?? null,
    contentScope,
    domain: run.structure?.domain ?? null,
    ai4a: run.structure?.ai4a ?? null,
    // The grounded conference notice (or null). It is projected into its own tables; it never adds a
    // selection score, a cross-listing or a second model call.
    conference,
  };
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
}

/**
 * Analyses the current revision and commits the judgement. A result computed for an older revision
 * is kept for traceability but never overwrites a newer input (stale = true).
 */
export async function analyzeArticle(articleId: string, opts: StepOpts = {}): Promise<AnalyzeResult | null> {
  const input = await loadAnalyzeInput(articleId);
  if (!input) return null;
  // Its page first; extraction queues the analysis again (normally the queue already routed it there).
  if (waitsForPage(input)) return { analysisId: null, stale: false, needsBody: true, output: null, receiptIds: [], reused: true };
  const run = await runAnalysis(input, opts);
  const contentScope = input.contentScope === "ai4s" ? "ai4s" : "astro";
  const out = normalizeAnalysis(run, contentScope);
  const receiptIds = [
    run.prefilter.receiptId, ...(run.scores?.receiptIds ?? []), ...(run.writing?.receiptIds ?? []), ...(run.structure ? [run.structure.receiptId] : []),
  ];
  const w = run.writing;
  // What the judgement was made on: the stored range and the access finding are recorded beside it, so
  // a summary-backed intro is traceable and a title-only item cannot be read as a full analysis.
  const hasText = !!(input.bodyText?.trim() || input.excerpt?.trim());
  const detail = {
    prefilter: { label: run.prefilter.label, reason: run.prefilter.reason },
    scores: out.scores, scoreModel: out.scoreModel, threshold: out.threshold, ...(out.scoreRefused ? { scoreRefused: true } : {}),
    ...(w ? { writer: w.kind, writerModel: w.model, itemType: w.itemType ?? null, authorRole: w.authorRole ?? null } : {}),
    ...(w?.imageReview ? { imageReview: w.imageReview } : {}),
    ...(w?.identityGuard?.outcome === "fallback" ? { identityGuard: w.identityGuard } : {}),
    coverage: input.coverage ?? null, access: input.access ?? null, contentKind: input.contentKind ?? null,
    // An item held back for lack of material is not the same finding as an irrelevant one, and neither
    // is a model answer that carried no usable copy.
    ...(out.relevance === "unknown" ? { unknownReason: hasText ? "writing" : "material" } : {}),
    scope: out.scope, fact: out.fact,
    contentScope, domain: out.domain, ai4a: out.ai4a,
    ...(out.conference ? { conference: out.conference } : {}),
  };
  const committed = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const stale = !current || current.revision !== input.revision;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, tags,
        subjects, title_zh, summary_zh, reason_zh, score, selected, output)
      VALUES (${articleId}, ${input.revision}, 'model', ${w?.model ?? run.prefilter.model}, ${contentScope === "ai4s" ? AI4S_ANALYZE_PROMPT_VERSION : ANALYZE_PROMPT_VERSION}, ${receiptIds},
        ${out.relevance}, ${out.category}, ${out.tags}, ${out.subjects}, ${out.titleZh}, ${out.summaryZh}, ${out.reasonZh},
        ${out.score}, ${out.selected}, ${tx.json(detail as never)})
      RETURNING id`;
    for (const id of receiptIds) await completeReceipt(tx, id);
    if (!stale) {
      await tx`UPDATE articles SET processing_state = ${out.relevance === "block" ? "blocked" : "analyzed"}, processing_error = NULL WHERE id = ${articleId}`;
      // The conference projection belongs to the same transaction as the judgement that produced it:
      // an interrupted run leaves neither a judgement without its conference nor a conference without
      // its judgement. A stale run writes nothing at all.
      await projectConference(tx, { articleId, revision: input.revision, contentScope, conference: out.conference });
    }
    return { analysisId: row!.id, stale };
  });
  const reused = run.prefilter.reused && (run.scores?.reused ?? true) && (w?.reused ?? true) && (run.structure?.reused ?? true);
  return { analysisId: committed.analysisId, stale: committed.stale, output: out, receiptIds, reused };
}
