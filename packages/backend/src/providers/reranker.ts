// Optional shortlist ordering only. Relevance scores are never identity/merge evidence.
import { z } from "zod";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { modelFetch, withModelAdmission } from "./model-limit.ts";
import { completeReceipt, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

export function rerankerAvailable(): boolean {
  return config.modelCallsEnabled && !!credential("models", "RERANKER_BASE_URL")
    && !!credential("models", "RERANKER_API_KEY") && !!credential("models", "RERANKER_MODEL");
}

/** Returns input indices, preserving input order on equal relevance; completion means validated ordering. */
export async function rerank(query: string, documents: string[], subject: string): Promise<number[]> {
  if (!rerankerAvailable()) throw new Error("Reranker is not configured or model calls are disabled");
  if (documents.length < 2 || documents.length > 20) throw new Error("Reranker requires 2–20 candidates");
  const model = credential("models", "RERANKER_MODEL")!;
  const base = credential("models", "RERANKER_BASE_URL")!.replace(/\/+$/, "");
  const input = { model, query: query.slice(0, 2000), documents: documents.map(text => text.slice(0, 2000)), top_n: documents.length, return_documents: false };
  const url = `${base}/rerank`;
  const receipt = await withModelAdmission(url, "rerank", subject, () => paidRequest({
    service: "reranker", model, purpose: "rerank", subject,
    identity: { base, subject, model, query: sha256(input.query), documents: input.documents.map(sha256), top_n: input.top_n },
    requestSummary: { count: documents.length },
  }, async () => {
    const { res, text } = await modelFetch(url, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential("models", "RERANKER_API_KEY")!}` },
      body: JSON.stringify(input), signal: () => AbortSignal.timeout(60_000),
    }, "rerank", subject);
    if (!res.ok) throw new ProviderRejectedError(`rerank HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, res.status === 429 || res.status >= 500);
    let response: unknown;
    try { response = JSON.parse(text); } catch { response = { unparsable: text.slice(0, 20000) }; }
    return { response };
  }));
  let order: number[];
  try {
    const { results } = z.object({ results: z.array(z.object({
      index: z.number().int().nonnegative().max(documents.length - 1), relevance_score: z.number().finite(),
    })).length(documents.length) }).parse(receipt.response);
    if (new Set(results.map(r => r.index)).size !== documents.length) throw new Error("Reranker indices do not match candidates");
    order = results.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index).map(r => r.index);
  } catch (error) {
    await rejectReceivedResponse(receipt.receiptId, `unusable rerank response: ${String(error).slice(0, 500)}`);
    throw new Error(`Unusable rerank response for ${subject}`, { cause: error });
  }
  await completeReceipt(sql, receipt.receiptId);
  return order;
}
