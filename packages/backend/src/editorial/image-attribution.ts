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
  if (!/^https:\/\/www\.esa\.int\/(?:Science_Exploration|Our_Activities)\/Space_Science\/(?:[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\/)*[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/.test(articleUrl) || /\s/.test(articleUrl)) return null;
  const identity = esaImageIdentity(candidateUrl);
  if (!identity) return null;
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
    if (/\b(?:all\s+rights\s+reserved|permission\s+(?:is\s+)?required|not\s+(?:covered|licensed)|third[-\s]+party)\b/i.test(details?.innerText ?? "")) return null;
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
