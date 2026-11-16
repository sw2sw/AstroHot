// External collection reports (docs/sources.md). Same identity rules and timeline
// rule as every other entrance: old or future-dated items and explicit backfill never count as
// today's news and are never pushed. Unknown sources are created isolated, awaiting an operator.
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { upsertMaterial } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";

export const MAX_ITEMS = 50;

export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ItemIn {
  title?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  /** A trusted ingest-token holder classifies each article; this never grants cross-list approval. */
  contentScope?: unknown;
  scopeReason?: unknown;
  raw?: { _aihot?: { backfill?: boolean; baseline?: boolean } } & Record<string, unknown>;
}

export async function ingestItems(body: { sourceId?: unknown; sourceName?: unknown; items?: unknown }): Promise<{ ok: true; created: number }> {
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const items = Array.isArray(body.items) ? (body.items as ItemIn[]) : [];
  if (!sourceId || !items.length) throw new IngestError(400, "sourceId and items[] required");
  if (items.length > MAX_ITEMS) throw new IngestError(413, `items[] exceeds max ${MAX_ITEMS} per request`);

  // Validate every explicit classification before writing even a newly discovered source.
  for (const it of items) {
    if (!it || typeof it !== "object" || it.contentScope === undefined) continue;
    if (it.contentScope !== "astro" && it.contentScope !== "ai4s") throw new IngestError(400, "contentScope must be astro or ai4s");
    if (typeof it.scopeReason !== "string" || !it.scopeReason.trim() || it.scopeReason.trim().length > 1000) {
      throw new IngestError(400, "explicit contentScope requires scopeReason (1-1000 characters)");
    }
  }

  const [source] = await sql<{ id: string; participation_mode: string; enabled: boolean; config: Record<string, unknown> }[]>`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
    VALUES (${sourceId.slice(0, 120)}, ${typeof body.sourceName === "string" && body.sourceName.trim() ? body.sourceName.trim().slice(0, 200) : sourceId.slice(0, 120)},
            'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ${["ingest:auto-created"]})
    ON CONFLICT (id) DO UPDATE SET last_ok_at = now() WHERE sources.enabled
    RETURNING id, participation_mode, enabled, config`;
  if (!source) throw new IngestError(409, "source paused");

  const seen = new Set<string>();
  let created = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const title = typeof it.title === "string" ? it.title.trim() : "";
    const rawUrl = typeof it.url === "string" ? it.url.trim() : "";
    if (!title || !rawUrl) continue;
    const url = normalizeUrl(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const published = typeof it.publishedAt === "string" ? new Date(it.publishedAt) : null;
    const flags = it.raw?._aihot ?? {};
    const contentScope = it.contentScope === "ai4s" || it.contentScope === "astro"
      ? it.contentScope : source.config.contentScope === "ai4s" ? "ai4s" : "astro";
    const res = await sql.begin(async (tx) => {
      const result = await upsertMaterial({
        sourceId: source!.id,
        // Keep the reported origin for publisher ownership; shared identity rules deduplicate it.
        url: rawUrl,
        title,
        author: typeof it.author === "string" ? it.author.slice(0, 200) : null,
        publishedAt: published && Number.isFinite(published.getTime()) ? published : null,
        raw: it.raw ?? null,
        via: "ingest",
        backfill: flags.backfill ? "reported-backfill" : flags.baseline ? "reported-baseline" : null,
        contentScope,
      }, tx);
      // The conflict check shares the material transaction: even a concurrent duplicate or a
      // changed title cannot revise/reconcile an existing identity into another column.
      const [stored] = await tx<{ content_scope: string }[]>`SELECT content_scope FROM articles WHERE id = ${result.articleId}`;
      if (it.contentScope !== undefined && stored!.content_scope !== contentScope) {
        throw new IngestError(409, "existing article has a different contentScope; review its classification separately");
      }
      if (result.created && it.contentScope !== undefined) {
        await audit("ingest-token", "content.classify", `content:${result.articleId}`, (it.scopeReason as string).trim(),
          null, { contentScope, sourceId: source!.id }, { db: tx });
      }
      return result;
    });
    if (res.created) created += 1;
    if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
  }
  await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${source!.id}`;
  await sql`INSERT INTO ingest_events (client, kind, status, summary) VALUES ('ingest-items', 'items', 'ok', ${sql.json({ sourceId: source!.id, received: items.length, created })})`;
  return { ok: true, created };
}
