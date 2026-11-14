import { z } from "zod";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { shortHash, stableJson } from "../lib/ids.ts";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "./models.ts";
import { promptText, promptVersion } from "./prompts.ts";
import type { SelectionMaterial } from "./selection-material.ts";

export const TITLE_BATCH_LIMIT = 32;
export const TITLE_BATCH_VERSION = promptVersion("title-batch");
export const TITLE_BATCH_PURPOSE = "prefilter_title_batch";
export const TITLE_SELECTION_TAG = "title-selection:";

export interface TitleBatchItem {
  id: string;
  revision: number;
  title: string;
}

export interface TitleBatchReview extends TitleBatchItem {
  tag: string;
  materials: SelectionMaterial[];
}

export interface TitleBatchRound {
  items: TitleBatchItem[];
  reviews: TitleBatchReview[];
  selected: Array<{ title: string; url: string }>;
}

export function titleBatchSubject(round: TitleBatchRound) {
  return "title-batch:" + shortHash(stableJson(round));
}

export async function screenTitleBatch(round: TitleBatchRound) {
  const { items, reviews, selected } = round;
  const count = items.length;
  if ((!count && !reviews.length) || count > TITLE_BATCH_LIMIT) throw new RangeError("news batch size out of bounds");
  const decision = z.object({
    n: z.number().int().min(1).max(count),
    relevance: z.enum(["pass", "block", "unknown"]),
    titleZh: z.string().trim().min(1).max(240).nullish(),
    category: z.enum(CATEGORY_KEYS).nullish(),
    review: z.boolean(),
    sameAs: z.number().int().min(1).max(count).nullish(),
  });
  const reviewDecision = z.object({
    n: z.number().int().min(1).max(reviews.length || 1),
    verdict: z.enum(["select", "keep", "duplicate"]),
    titleZh: z.string().trim().min(1).max(240).nullish(),
    summaryZh: z.string().trim().min(1).max(240).nullish(),
    evidence: z.string().trim().min(12).max(400).nullish(),
    material: z.number().int().min(1).nullish(),
  });
  const schema = z.object({ items: z.array(decision).length(count), reviews: z.array(reviewDecision).length(reviews.length) }).refine(({ items: rows, reviews: decisions }) =>
    new Set(rows.map((r) => r.n)).size === count &&
    rows.every((r) => r.sameAs == null || (r.relevance === "pass" && rows.some((p) => p.n === r.sameAs && p.n < r.n && p.relevance === "pass"))) &&
    new Set(decisions.map((r) => r.n)).size === reviews.length,
  "Return every input number exactly once and only link to an earlier relevant title");
  const subject = titleBatchSubject(round);
  return chatJson({
    model: await modelFor("prefilter"),
    purpose: TITLE_BATCH_PURPOSE,
    subject,
    promptVersion: TITLE_BATCH_VERSION,
    system: promptText("title-batch", { categoryKeys: CATEGORY_KEYS.join(", ") }),
    user: JSON.stringify({
      items: items.map(({ title }, i) => ({ n: i + 1, title: title.slice(0, 500) })),
      reviews: reviews.map(({ title, materials }, i) => ({ n: i + 1, title, materials })),
      selected,
    }),
    schema,
    attemptTag: subject,
    temperature: 0,
    maxTokens: Math.max(1000, count * 145 + reviews.length * 450),
  });
}

export function supportedSelection(review: TitleBatchReview, decision: { verdict: string; material?: number | null; evidence?: string | null; titleZh?: string | null; summaryZh?: string | null }) {
  const material = decision.material ? review.materials[decision.material - 1] : null;
  return decision.verdict === "select" && decision.titleZh && decision.summaryZh && decision.evidence
    && material?.text.includes(decision.evidence) ? material : null;
}
