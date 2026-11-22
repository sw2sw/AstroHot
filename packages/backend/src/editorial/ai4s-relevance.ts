import { z } from "zod";
import { collapseWhitespace } from "../lib/text.ts";

/** Same-request evidence, not a second classifier or a vocabulary of AI keywords. */
export const Ai4sRelevanceSchema = z.object({
  kind: z.enum(["research", "research-tool", "research-support", "none"]),
  role: z.enum(["primary", "incidental", "prospective", "none"]),
  scope: z.enum(["single", "composite", "unknown"]),
  titleAligned: z.boolean(),
  quote: z.string().trim().min(1).max(600),
  aiMethod: z.string().trim().min(1).max(100),
  researchTask: z.string().trim().min(1).max(160),
});

/** Missing/invalid grounding is unknown, never a fabricated negative. Explicit non-primary is BLOCK.
 * Composite copy has no per-column title/summary contract yet: conservatively hold it.
 * Semantic role/method identification remains the prefilter model's responsibility.
 */
export function validateAi4sPass(evidence: unknown, material: string): "PASS" | "BLOCK" | "UNKNOWN" {
  const parsed = Ai4sRelevanceSchema.safeParse(evidence);
  if (!parsed.success) return "UNKNOWN";
  const e = parsed.data;
  if (e.scope !== "single") return "UNKNOWN";
  if (e.kind === "none" || e.role !== "primary" || !e.titleAligned) return "BLOCK";
  const quote = collapseWhitespace(e.quote);
  return collapseWhitespace(material).includes(quote)
    && quote.includes(collapseWhitespace(e.aiMethod))
    && quote.includes(collapseWhitespace(e.researchTask)) ? "PASS" : "UNKNOWN";
}
