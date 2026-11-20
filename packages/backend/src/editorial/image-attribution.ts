import { parseHTML } from "linkedom";
import { guardedFetch } from "../lib/http-fetch.ts";
import { esaImageIdentity, ESA_IMAGE_LICENSES } from "../media/esa-image.ts";
import { collapseWhitespace } from "../lib/text.ts";

export interface ImageAttribution {
  credit: string;
  attributionUrl: string;
  license?: string;
  licenseUrl?: string;
  canonicalUrl?: string;
  assetEvidence?: string;
}

/** Exact official credit for this one candidate; neither suitability nor display permission. */
export async function esaWebbImageAttribution(
  articleUrl: string,
  candidateUrl: string,
): Promise<ImageAttribution | null> {
  // Validate the raw strings: URL parsing alone normalizes ports, dot paths and escapes.
  if (!/^https:\/\/(?:www\.)?esawebb\.org\/news\/[A-Za-z0-9]+\/$/.test(articleUrl)) return null;
  const image = /^https:\/\/cdn\.esawebb\.org\/archives\/images\/screen\/([A-Za-z0-9]+)\.jpg$/.exec(candidateUrl);
  if (!image) return null;
  const attributionUrl = `https://esawebb.org/images/${image[1]}/`;
  return officialImageAttribution(attributionUrl);
}

/** NOIRLab public news only; logos and unrelated archives do not match. */
export async function newsImageAttribution(
  articleUrl: string,
  candidateUrl: string,
): Promise<ImageAttribution | null> {
  const article = /^https?:\/\/noirlab\.edu\/public\/news\/(noirlab[0-9]+)\/$/.exec(articleUrl);
  if (article) {
    const image = /^https:\/\/storage\.noirlab\.edu\/media\/archives\/images\/screen\/(noirlab[0-9]+)([a-z])\.jpg$/.exec(candidateUrl);
    if (!image || image[1] !== article[1]) return null;
    return officialImageAttribution(`https://noirlab.edu/public/images/${image[1]}${image[2]}/`);
  }
  return await esaScienceImageAttribution(articleUrl, candidateUrl) ?? await esaWebbImageAttribution(articleUrl, candidateUrl);
}

/** ESA storage paths are not licences: verify this image's official metadata once. */
export async function esaScienceImageAttribution(articleUrl: string, candidateUrl: string): Promise<ImageAttribution | null> {
  const identity = esaImageIdentity(candidateUrl);
  if (!identity) return null;
  if (identity.kind === "modern") return modernEsaImageAttribution(articleUrl, identity);
  if (!/^https:\/\/www\.esa\.int\/(?:Science_Exploration|Our_Activities)\/Space_Science\/(?:[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\/)*[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/.test(articleUrl) || /\s/.test(articleUrl)) return null;
  const { attributionUrl, storage, canonicalUrl } = identity;
  const extension = canonicalUrl.endsWith(".png") ? "png" : "jpg";
  try {
    const response = await guardedFetch(attributionUrl, { timeoutMs: 8000, maxBytes: 512 * 1024, maxRedirects: 0 });
    if (response.status !== 200 || response.url !== attributionUrl) return null;
    const { document } = parseHTML(response.text());
    // Require the same storage identity, not a related image's credit or a guessed page.
    if (![...document.querySelectorAll("img[src]")].some((node) => node.getAttribute("src") === `${storage}_pillars.${extension}`)) return null;
    const metadata = document.querySelector("ul.modal__meta_licence");
    if (!metadata) return null;
    for (const node of document.querySelectorAll("footer, header, nav, script, style, .footer, #footer")) node.remove();
    const details = document.querySelector("#modal__tab-content--details, main, [role='main']") ?? metadata.parentElement;
    const detailsText = details && "innerText" in details && typeof details.innerText === "string" ? details.innerText : "";
    if (/\b(?:all\s+rights\s+reserved|permission\s+(?:is\s+)?required|not\s+(?:covered|licensed)|third[-\s]+party)\b/i.test(detailsText)) return null;
    const fields = [...metadata.querySelectorAll("li")];
    const creditNode = fields.find((node) => node.querySelector("b")?.textContent?.trim() === "CREDIT");
    const licenseNode = fields.find((node) => node.querySelector("b")?.textContent?.trim() === "LICENCE");
    if (!creditNode || !licenseNode) return null;
    creditNode.querySelector("b")?.remove();
    const credit = collapseWhitespace(creditNode.textContent ?? "");
    if (!credit || credit.length > 2000 || !/\bESA\b/.test(credit)) return null;
    const licence = ESA_IMAGE_LICENSES.find((policy) => [...licenseNode.querySelectorAll("a")].some((node) =>
      [policy.licenseUrl, policy.licenseUrl.replace("https://www.esa.int", "")].includes(node.getAttribute("href") ?? "") && collapseWhitespace(node.textContent ?? "") === policy.license));
    if (!licence) return null;
    const canonical = [...document.querySelectorAll("a.dropdown__item[download]")].some((node) => node.getAttribute("href") === `${storage}.${extension}`);
    return { credit, attributionUrl, ...licence, ...(canonical ? { canonicalUrl } : {}) };
  } catch {
    return null;
  }
}

const ESA_FETCH_OPTIONS = { timeoutMs: 8000, maxBytes: 512 * 1024, maxRedirects: 0 } as const;
const MODERN_ARTICLE = /^https:\/\/www\.esa\.int\/articles\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODERN_MEDIA = /^https:\/\/www\.esa\.int\/media\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** New ESA pages do not encode their media-page URL in the rendition URL: prove both edges from official DOM. */
async function modernEsaImageAttribution(
  articleUrl: string,
  identity: Extract<NonNullable<ReturnType<typeof esaImageIdentity>>, { kind: "modern" }>,
): Promise<ImageAttribution | null> {
  if (!MODERN_ARTICLE.test(articleUrl) || /\s/.test(articleUrl)) return null;
  try {
    const articleResponse = await guardedFetch(articleUrl, ESA_FETCH_OPTIONS);
    if (articleResponse.status !== 200 || articleResponse.url !== articleUrl) return null;
    const { document } = parseHTML(articleResponse.text());
    const pages = [...document.querySelectorAll("a[href]")].flatMap((node) => {
      const attributionUrl = node.getAttribute("href") ?? "";
      const micrioId = node.closest(".articles-modules__full-image")?.querySelector("micr-io[id]")?.getAttribute("id") ?? "";
      const visibleLabel = [...node.childNodes].filter((child) => child.nodeType !== 1 || !(child as typeof node).matches('.sr-only, [aria-hidden="true"]')).map((child) => child.textContent ?? "").join(" ");
      return collapseWhitespace(visibleLabel) === "Open image" && MODERN_MEDIA.test(attributionUrl) && /^[A-Za-z0-9]+$/.test(micrioId)
        ? [{ attributionUrl, micrioId }] : [];
    }).slice(0, 4);
    for (const { attributionUrl, micrioId } of pages) {
      const attribution = await modernEsaMediaPage(attributionUrl, micrioId, identity);
      if (attribution) return attribution;
    }
  } catch {
    // Missing or ambiguous evidence is text-only; never guess a page from a title or slug.
  }
  return null;
}

async function modernEsaMediaPage(
  attributionUrl: string,
  micrioId: string,
  identity: Extract<NonNullable<ReturnType<typeof esaImageIdentity>>, { kind: "modern" }>,
): Promise<ImageAttribution | null> {
  try {
    const response = await guardedFetch(attributionUrl, ESA_FETCH_OPTIONS);
    if (response.status !== 200 || response.url !== attributionUrl) return null;
    const { document } = parseHTML(response.text());
    if (document.querySelector('link[rel="canonical"]')?.getAttribute("href") !== attributionUrl) return null;
    for (const node of document.querySelectorAll("footer, header, nav, script, style, .footer, #footer")) node.remove();
    const main = document.querySelector("main, [role='main']") ?? document.body;
    if (!main || !("innerText" in main) || typeof main.innerText !== "string" || /\b(?:all\s+rights\s+reserved|permission\s+(?:is\s+)?required|not\s+(?:covered|licensed)|third[-\s]+party)\b/i.test(main.innerText)) return null;
    const modals = [...main.querySelectorAll('.interactive-media-modal--static')];
    if (modals.length !== 1) return null;
    const modal = modals[0]!;
    const ids = [...modal.querySelectorAll('micr-io[id]')].map((node) => node.getAttribute('id'));
    if (ids.length !== 1 || ids[0] !== micrioId) return null;
    // A name shared by a hero image and a download is not same-asset evidence.
    // Only use a rendition expressly offered by this exact official media panel.
    if (![...modal.querySelectorAll('a[download][href]')].some((node) => {
      const href = node.getAttribute('href');
      return href === identity.canonicalUrl || href === `${identity.canonicalUrl}?dl`;
    })) return null;
    const sections = [...modal.querySelectorAll(".interactive-media-modal__credits-section")];
    const field = (label: string) => {
      const section = sections.find((node) => collapseWhitespace(node.querySelector(".interactive-media-modal__credits-label")?.textContent ?? "") === label);
      return section ? collapseWhitespace(section.querySelector(".interactive-media-modal__credits-text")?.textContent ?? "") : "";
    };
    const credit = field("Credits");
    if (!credit || credit.length > 2000 || !/\bESA\b/.test(credit)) return null;
    if (field("Licence") !== "CC BY-SA 3.0 IGO or ESA Standard Licence") return null;
    return { credit, attributionUrl, ...ESA_IMAGE_LICENSES[0], assetEvidence: `${identity.storage}|${attributionUrl}` };
  } catch {
    return null;
  }
}

async function officialImageAttribution(attributionUrl: string): Promise<ImageAttribution | null> {
  try {
    // No redirects: even another official image's page is not evidence for this image.
    const response = await guardedFetch(attributionUrl, { timeoutMs: 8000, maxBytes: 512 * 1024, maxRedirects: 0 });
    if (response.status !== 200 || response.url !== attributionUrl) return null;
    const { document } = parseHTML(response.text());
    // Site-wide legal boilerplate is not a restriction on the individual image.
    for (const node of document.querySelectorAll("footer, header, nav, script, style, .footer, #footer")) node.remove();
    const main = document.querySelector("main, [role='main'], #content, #main-content") ?? document.body;
    if (!main || /\b(?:all\s+rights\s+reserved|permission\s+(?:is\s+)?required|not\s+(?:covered|licensed)|identifiable\s+person)\b/i.test(main.textContent ?? "")) return null;
    for (const br of main.querySelectorAll("div.credit br")) br.replaceWith(document.createTextNode(" "));
    const paragraphs = main.querySelectorAll("div.credit p");
    const credit = collapseWhitespace([...paragraphs].map((p) => p.textContent ?? "").join(" "));
    if (!credit || credit.length > 2000) return null;
    return { credit, attributionUrl };
  } catch {
    // Missing attribution is text-only, not an article failure or a reason to try other images.
    return null;
  }
}
