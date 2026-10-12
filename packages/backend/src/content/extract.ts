// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { accessFromPage, accessFromStatus, type Access } from "./coverage.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, reviseMaterial } from "./materials.ts";
import { markdownBody } from "./markdown.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
}

const MIN_BODY_CHARS = 200;

export function readable(html: string, url: string): ExtractedBody | null {
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

/**
 * What one bounded read of the article page produced.
 *  body        the article itself (nothing on the page restricted it);
 *  limited     the page states or the server confirmed a restriction (401/402, a paywall or
 *              challenge marker, 403/406). A readable fragment is kept for the excerpt, never as a
 *              body, and no paid reader and no retry is spent on it again;
 *  unavailable nothing readable and no access finding (a bare 200 with no article, an exhausted
 *              budget): the article is judged on what the listing gave;
 *  transient   an outage or rate limit (network, 429, 5xx): the bounded retry path handles it, and
 *              it is never recorded as a subscription.
 */
export type ExtractOutcome =
  | { kind: "body"; body: ExtractedBody; access: Access }
  | { kind: "limited"; access: Access; fragment: ExtractedBody | null; reason: string }
  | { kind: "unavailable"; access: Access | null; reason: string }
  | { kind: "transient"; reason: string };

/** A status that is a restriction on its face, whatever the body says. */
const RESTRICTED_STATUS = new Set([401, 402, 403, 406, 451]);

export async function extractFromUrl(url: string, subject: string): Promise<ExtractOutcome> {
  let status = 0;
  let html = "";
  let finalUrl = url;
  let type = "";
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    status = res.status;
    finalUrl = res.url;
    type = res.headers.get("content-type") ?? "";
    if (status === 200) html = res.text();
  } catch (error) {
    // A transport failure is not a paywall: the bounded retry handles it, and nothing is recorded.
    return { kind: "transient", reason: `transport: ${String(error instanceof Error ? error.message : error).slice(0, 120)}` };
  }
  const stated = html ? accessFromPage(html) : null;
  const confirmed = accessFromStatus(status) ?? stated;
  if (status !== 200 && !RESTRICTED_STATUS.has(status) && !confirmed) return { kind: "transient", reason: `HTTP ${status}` };
  if (html && /html/.test(type)) {
    const body = readable(html, finalUrl);
    if (body) {
      // Readable text on an unrestricted page is the article; on a page that states a limit it is
      // only the free fragment, and storing it as the body would present a teaser as the article.
      return confirmed ? { kind: "limited", access: confirmed, fragment: body, reason: `readable fragment on a ${confirmed} page` }
        : { kind: "body", body, access: "open" };
    }
  }
  if (confirmed) return { kind: "limited", access: confirmed, fragment: null, reason: `confirmed ${confirmed} (HTTP ${status})` };
  if (RESTRICTED_STATUS.has(status)) {
    // A refusal with no stated reason: it may be a wall or a bot rule. Recorded as uncertain and not
    // retried — a paid reader is not spent on a page that already refused us.
    return { kind: "limited", access: "maybe", fragment: null, reason: `HTTP ${status} with no readable page` };
  }
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject });
    const markdown = markdownBody(page.markdown, url);
    const text = stripTags(markdown);
    if (text.length < MIN_BODY_CHARS) return { kind: "unavailable", access: stated ?? "maybe", reason: "budgeted reader returned too little text" };
    return { kind: "body", body: { html: markdown, text, images: [], via: "jina" }, access: "open" };
  } catch (error) {
    if (error instanceof BudgetExceededError) return { kind: "unavailable", access: null, reason: "reader budget exhausted" };
    throw error;
  }
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; excerpt: string | null; x_post: { tweetId?: string } | null }[]>`
    SELECT id, url, body_status, revision, excerpt, x_post FROM articles WHERE id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);
  const outcome = await extractFromUrl(a.url, `article:${a.id}`);
  // An outage or a rate limit: the job retries it, bounded, and records nothing as a subscription.
  if (outcome.kind === "transient") throw new ExtractTransientError(outcome.reason);
  if (outcome.kind === "body") {
    // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
    return storeExtractedBody(articleId, a.revision, outcome.body, outcome.access);
  }
  if (outcome.kind === "limited") {
    // One bounded read found the page restricted. A readable fragment is kept as the excerpt (never as
    // the body, and never over the source's own abstract); either way the article is recorded as
    // read-once-and-restricted, so no paid reader and no retry is spent on it again. Storing the
    // fragment is itself a new revision, so the outcome — not a revision number — says what happened.
    const stored = outcome.fragment ? await storePublicExcerpt(articleId, a.revision, outcome.fragment, outcome.access) : "skipped";
    const marked = await markUnconfirmed(articleId, a.revision, outcome.access);
    return marked === "unconfirmed" || stored === "ok" ? "unconfirmed" : "skipped";
  }
  return markUnconfirmed(articleId, a.revision, outcome.access ?? null);
}

/** An outage or rate limit: retried by the extract job, never filed as a paywall or a missing body. */
export class ExtractTransientError extends Error {}

function storeExtractedBody(articleId: string, revision: number, got: ExtractedBody, access: Access): Promise<"ok" | "skipped"> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = 'ok', coverage = 'full_text', access = ${access}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        coverage = 'full_text', access = ${access},
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${sql.json(got.images as never)}::jsonb ELSE media END`,
      hash, title: row.title, bodyText: got.text,
    });
    return "ok";
  });
}

/**
 * A page that states a limit still rendered a fragment for us. It is kept as the excerpt, never as the
 * body, and only when the listing gave no summary of its own: a source's own abstract stays the better
 * evidence, and the fragment must not replace it. Either way the article is marked "unconfirmed" in the
 * same write, so a page that refused us is never fetched a second time.
 */
async function storePublicExcerpt(articleId: string, revision: number, fragment: ExtractedBody, access: Access): Promise<"ok" | "skipped"> {
  const excerpt = collapseWhitespace(fragment.text).slice(0, 2000);
  if (excerpt.length < MIN_BODY_CHARS) return "skipped";
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, body_text, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    if (row.excerpt?.trim() || row.body_text?.trim()) {
      // The stored text does not change — the source's own abstract stays the better evidence — so
      // only the access finding is recorded, and the range keeps saying what is really held.
      await tx`UPDATE articles SET access = ${access}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    const hash = contentHash({ title: row.title, bodyText: null, excerpt });
    if (hash === row.content_hash) return "skipped";
    await reviseMaterial(tx, articleId, {
      set: sql`excerpt = ${excerpt}, coverage = 'public_excerpt', access = ${access}, body_status = 'unconfirmed'`,
      hash, title: row.title, bodyText: null,
    });
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number, access: Access | null): Promise<"unconfirmed" | "skipped"> {
  const rows = await sql`UPDATE articles SET body_status = 'unconfirmed', access = coalesce(${access}, access), updated_at = now()
    WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
  return rows.length ? "unconfirmed" : "skipped";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string, revision: number): Promise<"ok" | "unconfirmed" | "skipped"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision, null);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post, x_article FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const block = (a: { title?: string | null; text?: string } | null) => (a ? [a.title ? `# ${a.title}` : "", a.text ?? ""].filter(Boolean).join("\n\n") : "");
    // The post's own text, without an article appended by an earlier extraction (an admin re-run
    // extracts again from the post; appending once more would repeat the article).
    const previous = block(row.x_article);
    let base = row.body_text ?? "";
    if (previous && base.endsWith(previous)) base = base.slice(0, -previous.length).replace(/\s+$/, "");
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [base, block(got)].filter(Boolean).join("\n\n");
    if (bodyText === row.body_text && title === row.title) {
      // The same article again: nothing new, no new revision.
      await tx`UPDATE articles SET body_status = 'ok', x_article = ${tx.json(got as never)}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`title = ${title}, body_text = ${bodyText}, x_article = ${sql.json(got as never)}, body_status = 'ok'`,
      hash: contentHash({ title, bodyText, excerpt: row.excerpt }), title, bodyText,
    });
    return "ok";
  });
}
