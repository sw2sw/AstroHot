// What the judging steps read about an article: loaded once per analysis and rendered per step.
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { collapseWhitespace, truncate } from "../lib/text.ts";
import { contentKindOf, coverageLabel, textRoleLabel, CONTENT_KIND_LABEL, type ContentKind } from "../content/coverage.ts";
import { produceImage } from "../media/images.ts";
import { esaImageIdentity } from "../media/esa-image.ts";
import type { ContentPart } from "../providers/llm.ts";
import { MAX_BODY_CHARS } from "./writing.ts";

export interface AnalyzeInputArticle {
  id: string;
  revision: number;
  title: string;
  url: string;
  author: string | null;
  publishedAt: Date | null;
  /** When the site first saw it (the score input's time when the source gives none). */
  discoveredAt?: Date | null;
  bodyText: string | null;
  excerpt: string | null;
  /** pending: no body fetched yet; ok; unconfirmed: fetching failed; none. */
  bodyStatus?: string;
  /** What the stored text covers (content/coverage.ts); null when the channel did not say. */
  coverage?: string | null;
  /** What a bounded read of the original page found; null when no page was read. */
  access?: string | null;
  /** The source's own date precision: a day-only value must not become an invented instant. */
  datePrecision?: string | null;
  /** The item's own nature, from its URL and the feed's categories — never the source's reputation. */
  contentKind?: string | null;
  xPost: Record<string, any> | null;
  media: Array<Record<string, any>>;
  source: {
    name: string;
    kind: string;
    tier: string;
    firstParty: boolean;
    tags?: string[];
    ownerEntityId?: string | null;
    /** The source asks for the article page (fetchPublicContent, detail pages, web listings). */
    fetchesBody?: boolean;
  };
  /** Stored Chinese translation of the body (e.g. a full post whose original was truncated). */
  translationZh?: string | null;
}

/**
 * The post as the judging steps read it: an X Article it published joins its text, so every step sees
 * the article rather than a bare link.
 */
export function withXArticle(xPost: Record<string, any> | null, article: { title?: string; text?: string } | null): Record<string, any> | null {
  if (!xPost || !article?.text) return xPost;
  const parts = [String(xPost.text ?? "").trim(), article.title ? `【X 长文】${article.title}` : "【X 长文】", article.text];
  return { ...xPost, text: parts.filter(Boolean).join("\n\n") };
}

export async function loadAnalyzeInput(articleId: string): Promise<AnalyzeInputArticle | null> {
  const [row] = await sql<{
    id: string; revision: number; title: string; url: string; author: string | null; published_at: Date | null; discovered_at: Date;
    body_text: string | null; excerpt: string | null; body_status: string; coverage: string | null; access: string | null;
    raw: { datePrecision?: string; categories?: string[] } | null;
    x_post: Record<string, any> | null; x_article: { title?: string; text?: string } | null;
    media: Array<Record<string, any>>; source_name: string; source_kind: string; tier: string; first_party: boolean; source_tags: string[]; owner_entity_id: string | null;
    config: Record<string, any>; translation_zh: string | null;
  }[]>`
    SELECT a.id, a.revision, a.title, a.url, a.author, a.published_at, a.discovered_at, a.body_text, a.excerpt, a.body_status, a.coverage, a.access, a.raw,
           a.x_post, a.x_article, a.media,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.first_party, s.tags AS source_tags, s.owner_entity_id, s.config,
           tr.body_text AS translation_zh
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'zh' AND tr.revision >= a.revision
    WHERE a.id = ${articleId}`;
  if (!row) return null;
  return {
    id: row.id, revision: row.revision, title: row.title, url: row.url, author: row.author, publishedAt: row.published_at, discoveredAt: row.discovered_at,
    bodyText: row.body_text, excerpt: row.excerpt, bodyStatus: row.body_status, coverage: row.coverage, access: row.access,
    datePrecision: row.raw?.datePrecision ?? null, contentKind: contentKindOf(row.url, row.raw?.categories ?? []),
    xPost: withXArticle(row.x_post, row.x_article), media: row.media,
    source: {
      name: row.source_name, kind: row.source_kind, tier: row.tier, firstParty: row.tier === "T1", tags: row.source_tags, ownerEntityId: row.owner_entity_id,
      fetchesBody: row.config?.fetchPublicContent === true || !!row.config?.detail || row.source_kind === "web_list",
    },
    translationZh: row.translation_zh,
  };
}

const KIND_LABEL: Record<string, string> = {
  rss: "RSS", web_list: "网页", json_list: "网页接口", x_search: "X 帖子", mp_account: "微信公众号", external: "外部上报",
};

/** The material as the structure step reads it (source facts, text, link). */
export function buildMaterial(a: AnalyzeInputArticle): string {
  // Conditions often occur at the end of an announcement. Use the existing body budget instead of
  // only its lead; beyond it, state the missing tail so it is not mistaken for complete evidence.
  const body = (text: string) => text.length <= MAX_BODY_CHARS ? text : `${text.slice(0, MAX_BODY_CHARS)}\n【原文超过 ${MAX_BODY_CHARS} 字符，后文未提供】`;
  const lines: string[] = [];
  lines.push("<source>");
  lines.push(`名称：${a.source.name}`);
  lines.push(`类型：${KIND_LABEL[a.source.kind] ?? a.source.kind}；分级：${a.source.tier}；一手来源：${a.source.firstParty ? "是" : "否"}`);
  lines.push("</source>");
  lines.push("<material>");
  if (a.publishedAt) {
    // A day-only source value is shown as a date: printing an instant invents a moment the source
    // never stated (a bare day parses to midnight UTC, which renders as 08:00 in Beijing).
    const day = a.datePrecision === "day";
    lines.push(`发布时间：${day ? beijingDate(a.publishedAt) : `${beijingDate(a.publishedAt)} ${beijingTime(a.publishedAt)}`}（北京时间${day ? "，原文只精确到日" : ""}）`);
  }
  if (a.author) lines.push(`作者：${a.author}`);
  lines.push(`内容类型：${CONTENT_KIND_LABEL[(a.contentKind ?? "unknown") as ContentKind] ?? "未分类"}`);
  // The range is stated before the text, so no step can take a summary for the article.
  lines.push(`材料范围：${coverageLabel(a.coverage)}`);
  if (a.xPost) {
    lines.push(`作者：${a.xPost.authorName ?? ""} (@${a.xPost.handle ?? ""})`);
    lines.push(`帖子：\n${body(String(a.xPost.text ?? a.title))}`);
    if (a.xPost.quoted?.text) lines.push(`引用的帖子（@${a.xPost.quoted.handle ?? ""}）：\n${body(String(a.xPost.quoted.text))}`);
    if (a.translationZh) lines.push(`帖子中文译文：\n${truncate(a.translationZh, 4000)}`);
  } else {
    lines.push(`标题：${collapseWhitespace(a.title)}`);
    const original = a.bodyText ?? a.excerpt ?? "";
    const role = textRoleLabel({ hasBody: !!a.bodyText, hasExcerpt: !!a.excerpt, coverage: a.coverage });
    lines.push(original ? `${role}：\n${body(original)}` : "正文：（无）");
    if (a.translationZh && !a.bodyText) lines.push(`正文中文译文：\n${truncate(a.translationZh, 5000)}`);
  }
  lines.push(`原文链接：${a.url}`);
  lines.push("</material>");
  return lines.join("\n");
}

/**
 * The article's first image, inlined: models often cannot reach the original hosts, so they get the
 * site's cached thumbnail. None when it cannot be fetched.
 * A post without its own image shows the quoted post's (a reaction to a chart or a launch card).
 */
/** One candidate only, shared by the review and the public card; never rank or retry other images. */
export function firstImageOf(a: Pick<AnalyzeInputArticle, "xPost" | "media">): Record<string, any> | null {
  return [...(a.xPost?.media ?? []), ...(a.xPost?.quoted?.media ?? []), ...(a.media ?? [])]
    .find((m: any) => m.kind === "image" && m.url) ?? null;
}

export async function firstImagePart(a: AnalyzeInputArticle): Promise<ContentPart | null> {
  const image = firstImageOf(a);
  if (!image) return null;
  try {
    // ESA's article rendition can disappear; use the same storage identity's original, never a different image.
    const url = esaImageIdentity(image.url)?.canonicalUrl ?? String(image.url);
    const { body, type } = await produceImage(url, "thumb");
    return /^image\/(jpeg|png|webp)$/.test(type) ? { type: "image_url", image_url: { url: `data:${type};base64,${body.toString("base64")}` } } : null;
  } catch {
    return null;
  }
}
