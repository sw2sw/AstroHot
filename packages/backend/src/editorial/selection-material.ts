import * as cheerio from "cheerio";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { normalizeUrl } from "../lib/url.ts";
import { readable } from "../content/extract.ts";

export interface SelectionMaterial {
  url: string;
  kind: "announcement" | "abstract";
  text: string;
}

function primaryKind(input: string): SelectionMaterial["kind"] | null {
  const url = new URL(input);
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;
  if ((host === "arxiv.org" && /^\/abs\//.test(path))
    || (host === "nature.com" && /^\/articles\/s\d{5}-\d/.test(path))
    || (host === "doi.org" && /^\/10\.\d{4,9}\//.test(path))
    || (host === "science.org" && /^\/doi\//.test(path))) return "abstract";
  if ((host === "esa.int" && /^\/(articles\/|Science_Exploration\/Space_Science\/)/.test(path))
    || (host === "noirlab.edu" && /^\/public\/news\//.test(path))
    || (host === "eso.org" && /^\/public\/(?:\w+\/)?news\//.test(path))
    || (host === "nasa.gov" && /^\/(?:missions?|science|news-release)\//.test(path))
    || (host === "jpl.nasa.gov" && /^\/news\//.test(path))
    || (["bao.ac.cn", "shao.cas.cn", "pmo.cas.cn"].includes(host) && /\/xwdt\/|\/news\/|\/kyjz\//.test(path))) return "announcement";
  return null;
}

export function parseSelectionMaterial(html: string, url: string): SelectionMaterial | null {
  const kind = primaryKind(url);
  if (!kind) return null;
  const $ = cheerio.load(html);
  const raw = kind === "abstract"
    ? $('meta[name="citation_abstract"]').attr("content")
      || $('#Abs1-content, #abstract .c-article-section__content, section[aria-labelledby="abstract-heading"] .c-article-section__content, blockquote.abstract, .abstractSection').first().text()
    : readable(html, url)?.text || $('meta[property="og:description"]').attr("content");
  const text = collapseWhitespace(stripTags(raw ?? "")).replace(/^Abstract:\s*/i, "").slice(0, 2000);
  const canonical = $("link[rel=canonical]").attr("href");
  const pageUrl = new URL(url);
  const canonicalUrl = canonical && URL.canParse(canonical, url) ? new URL(canonical, url) : pageUrl;
  const finalUrl = canonicalUrl.hostname.replace(/^www\./, "") === pageUrl.hostname.replace(/^www\./, "")
    && primaryKind(canonicalUrl.href) === kind ? canonicalUrl : pageUrl;
  return text.length >= 80 ? { kind, url: finalUrl.origin + finalUrl.pathname, text } : null;
}

async function read(url: string) {
  try {
    const response = await guardedFetch(url, { timeoutMs: 10_000, maxBytes: 3 * 1024 * 1024 });
    if (response.status === 200 && response.headers.get("content-type")?.includes("html"))
      return { html: response.text(), url: response.url };
  } catch {
    // An unavailable source leaves the candidate in ordinary news.
  }
  return null;
}

export async function getSelectionMaterials(url: string, storedHtml: string | null, firstParty = false, excerpt: string | null = null): Promise<SelectionMaterial[]> {
  if (!normalizeUrl(url)) return [];
  const original = url.trim();
  const direct = primaryKind(original);
  if (direct) {
    if (direct === "announcement" && firstParty) {
      const text = stripTags(excerpt || storedHtml || "").slice(0, 2000);
      if (text.length >= 80) return [{ kind: direct, url: original, text }];
    }
    const page = await read(original);
    const material = page && parseSelectionMaterial(page.html, page.url);
    return material ? [material] : [];
  }
  const page = storedHtml ? { html: storedHtml, url: original } : await read(original);
  if (!page) return [];
  const $ = cheerio.load(page.html);
  const links = new Set<string>();
  for (const el of $("article a[href], main a[href], a[href]").toArray()) {
    const href = $(el).attr("href")!;
    if (!URL.canParse(href, page.url)) continue;
    const link = new URL(href, page.url).href;
    if (normalizeUrl(link) && primaryKind(link)) links.add(link);
    if (links.size === 3) break;
  }
  const materials = await Promise.all([...links].map(async link => {
    const target = await read(link);
    return target && parseSelectionMaterial(target.html, target.url);
  }));
  return materials.filter((material): material is SelectionMaterial => material !== null);
}
