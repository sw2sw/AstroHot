// How much of an article's text the site holds, and what one bounded page read found the original
// page to allow. Recorded as evidence beside the material; never a claim that a summary is the
// article. The reader-facing wording lives in publication/rules.ts (readerNote), never here.

/** What the stored material actually covers. */
export type Coverage = "full_text" | "official_abstract" | "public_excerpt" | "metadata_only";

/**
 * What a single bounded read of the article page found. `login`/`subscribe` are confirmed
 * restrictions (the page says so, or the server refused with 401/402); `challenge` is a bot/CAPTCHA
 * wall (nothing about it is a paywall claim); `maybe` is an unreadable page with no marker, and a
 * transport failure is not recorded at all (an outage must not be filed as "needs subscription").
 */
export type Access = "open" | "login" | "subscribe" | "maybe" | "challenge";

export const COVERAGE_LABEL: Record<Coverage, string> = {
  full_text: "完整正文",
  official_abstract: "官方摘要",
  public_excerpt: "公开可读片段",
  metadata_only: "仅标题与元数据",
};

/** The label the judging steps see for the stored text; a summary never reads as a full body. */
export function coverageLabel(c: string | null | undefined): string {
  return (c && (COVERAGE_LABEL as Record<string, string>)[c]) || "未记录范围";
}

/**
 * What the stored text is. A feed summary or a page fragment must never reach a prompt under a
 * heading that says it is the article; the judging steps are told the shape of what they were given.
 *
 * A stored body counts as the article only when the recorded scope says so — never merely because
 * text was stored. A feed that hands over a long block of its own is recorded as the source's own
 * abstract, and must not be introduced to the model, or to a reader, as the article itself. Coverage
 * that was never recorded keeps the old reading (the shape of the text alone), so rows written
 * before the scope was tracked behave exactly as before.
 */
export function textRoleLabel(input: { hasBody: boolean; hasExcerpt: boolean; coverage?: string | null }): string {
  const readAsArticle = input.hasBody && (input.coverage == null || input.coverage === "full_text");
  if (readAsArticle) return "正文";
  if (input.coverage === "official_abstract") return "官方摘要";
  if (input.coverage === "public_excerpt") return "公开可读片段";
  if (input.hasBody || input.hasExcerpt) return "摘要";
  return "（无）";
}

export const CONTENT_KIND_LABEL: Record<ContentKind, string> = {
  news: "新闻报道",
  research: "研究论文",
  review: "深度解读或评论",
  guide: "观测指南",
  unknown: "未分类",
};

// A page that names subscribers is a paid wall even when it also offers a sign-in ("Already a
// subscriber? Log in to continue."): the subscription is the finding that matters to a reader, and
// only a page that asks for an account without naming one is a login wall.
const SUBSCRIBE_MARKERS: RegExp[] = [
  /subscri(?:be|bers?)[^<]{0,40}(?:to )?(?:read|continue|access)/i,
  /(?:already a )?subscriber[^<]{0,30}(?:log in|sign in)/i,
  /this (?:article|story) is (?:for|available to) subscribers/i,
  /(?:免费|付费)(?:文章)?[^<]{0,20}订阅/,
  /订阅[^<]{0,10}(?:后)?[^<]{0,10}(?:继续|可)?阅读/,
];

const LOGIN_MARKERS: RegExp[] = [
  /sign in (?:to|or) (?:read|continue|to read)/i,
  /log in (?:to|or) (?:read|continue)/i,
  /register (?:to|or) (?:read|continue)/i,
  /登录[^<]{0,10}(?:后)?[^<]{0,10}(?:继续|可)?阅读/,
];

const CHALLENGE_MARKERS: RegExp[] = [
  /just a moment/i,
  /cf-chl/i,
  /enable javascript and cookies to continue/i,
  /attention required[^<]{0,40}cloudflare/i,
  /checking your browser/i,
];

/** Which restriction the page states, if any. A page that states none says nothing by itself. */
export function accessFromPage(html: string): Access | null {
  if (CHALLENGE_MARKERS.some((m) => m.test(html))) return "challenge";
  if (SUBSCRIBE_MARKERS.some((m) => m.test(html))) return "subscribe";
  if (LOGIN_MARKERS.some((m) => m.test(html))) return "login";
  return null;
}

/** The restriction a bare HTTP status confirms by itself (401 is a login wall, 402 a paid one). */
export function accessFromStatus(status: number): Access | null {
  if (status === 401) return "login";
  if (status === 402) return "subscribe";
  return null;
}

/** Whether an access finding is a confirmed restriction: the paid reader must not be spent again. */
export function isConfirmedAccess(access: string | null | undefined): boolean {
  return access === "login" || access === "subscribe";
}

/**
 * The precision of a source's own date string. A day-only value must not become an invented
 * instant (midnight UTC renders as 08:00 in Beijing) anywhere readers or the model can see it.
 */
export type DatePrecision = "instant" | "day";

export function datePrecisionOf(raw: string | null | undefined): DatePrecision {
  const value = (raw ?? "").trim();
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value) ? "day" : "instant";
}

/**
 * What kind of item this is, decided from the article's own URL (and its feed categories when the
 * pack knows them) — never from the source's reputation. A news story of a journal is a news story,
 * not a peer-reviewed paper, and a paper's abstract is not a full read of the paper.
 */
export type ContentKind = "news" | "research" | "review" | "guide" | "unknown";

const KIND_RULES: Array<{ test: RegExp; kind: ContentKind }> = [
  // Weave the two "This Week's Sky" brands and comparable observing columns together first: they
  // are guides even when their feed labels them news.
  { test: /(?:^|\/)(?:the-)?sky(?:-|_)this(?:-|_)week(?:\/|$)|(?:^|\/)(?:this-week'?s-)?sky-at-a-glance|observing-news/i, kind: "guide" },
  // Nature: s415xx-… is a research article with an abstract; d41586-… is the journal's own news.
  { test: /nature\.com\/articles\/s\d{5}-\d/i, kind: "research" },
  { test: /nature\.com\/articles\/d\d{5}-\d/i, kind: "news" },
  // Science's news desk, and its research URLs.
  { test: /science\.org\/content\/article\//i, kind: "news" },
  { test: /science\.org\/doi\//i, kind: "research" },
  { test: /link\.aps\.org\/doi\//i, kind: "research" },
  { test: /quantamagazine\.org\//i, kind: "review" },
  { test: /astronomy\.com\/the-sky-this-week\//i, kind: "guide" },
  { test: /astronomy\.com\/(?:science|news)\//i, kind: "news" },
  { test: /skyandtelescope\.org\/astronomy-news\//i, kind: "news" },
  { test: /newscientist\.com\/article\//i, kind: "news" },
  { test: /scientificamerican\.com\/article\//i, kind: "news" },
];

export function contentKindOf(url: string, categories: string[] = []): ContentKind {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const hay = `${path} ${url}`;
  for (const rule of KIND_RULES) if (rule.test.test(hay)) return rule.kind;
  const cats = categories.map((c) => c.toLowerCase());
  if (cats.some((c) => /research|article|paper/.test(c))) return "research";
  if (cats.some((c) => /news/.test(c))) return "news";
  if (cats.some((c) => /review|opinion|comment/.test(c))) return "review";
  return "unknown";
}
