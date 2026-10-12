import { importArxivReport } from "./store.ts";

export const MAX_REPORT_BYTES = 5 * 1024 * 1024;

/**
 * Optional host pin for ARXIV_REPORT_URL (ARXIV_REPORT_HOST). No host is hard-coded: a deployment
 * that imports a screening report sets the exact host it trusts, and anything else is rejected.
 */
export function validateReportUrl(raw: string, allowedHost = process.env.ARXIV_REPORT_HOST ?? ""): URL {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || raw.includes("#")) {
    throw new Error("ARXIV_REPORT_URL must be a credential-free HTTP(S) URL without fragment");
  }
  if (allowedHost && url.hostname !== allowedHost) {
    throw new Error(`ARXIV_REPORT_URL host must be ${allowedHost}`);
  }
  return url;
}

interface SyncDependencies {
  fetch?: typeof globalThis.fetch;
  store?: typeof importArxivReport;
}

export async function syncArxivReport(raw = process.env.ARXIV_REPORT_URL ?? "", dependencies: SyncDependencies = {}) {
  const url = validateReportUrl(raw);
  const response = await (dependencies.fetch ?? globalThis.fetch)(url, {
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" },
  });
  if (!response.ok || response.redirected) throw new Error(`arxiv report HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_REPORT_BYTES) {
    await response.body?.cancel();
    throw new Error("arxiv report exceeds 5MB");
  }
  if (!response.body) throw new Error("arxiv report missing body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPORT_BYTES) throw new Error("arxiv report exceeds 5MB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Only the configured URL is fetched. Imported paper links never become fetch targets.
  // The production store validates before opening its atomic transaction.
  return (dependencies.store ?? importArxivReport)(input);
}
