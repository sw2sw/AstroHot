// Offline only: outbound HTTP and analysis providers are replaced before imports.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, mock, test } from "node:test";
import { MockAgent, setGlobalDispatcher } from "undici";

registerHooks({ resolve(specifier, context, next) {
  const m = /^@aihot\/(backend|contracts|industry)\/(.+)$/.exec(specifier);
  return m ? next(new URL(`../${m[1] === "industry" ? "industry" : `packages/${m[1]}/src`}/${m[2]}.ts`, import.meta.url).href, context) : next(specifier, context);
} });
process.env.MODEL_CALLS_ENABLED = "false";
process.env.COLLECT_ENABLED = "false";
const network = new MockAgent();
network.disableNetConnect();
setGlobalDispatcher(network);
mock.method(globalThis, "fetch", async () => { throw new Error("network disabled"); });

const articleUrl = "https://esawebb.org/news/weic2610/";
const candidateUrl = "https://cdn.esawebb.org/archives/images/screen/weic2610a.jpg";
const pageUrl = "https://esawebb.org/images/weic2610a/";
const credit = "NASA, ESA, CSA, STScI; Image Processing: A. Pagan (STScI)";
const fixture = `<html><body><main><div class="credit"><p>${credit}</p></div></main><footer>All rights reserved; permission required; not covered</footer></body></html>`;
let html = fixture;
let finalUrl = pageUrl;
let status = 200;
let fetchError = false;
const fetchCalls: Array<{ url: string; options: any }> = [];
mock.module(new URL("../packages/backend/src/lib/http-fetch.ts", import.meta.url).href, { namedExports: {
  guardedFetch: async (url: string, options: any) => {
    fetchCalls.push({ url, options });
    if (fetchError) throw new Error("offline timeout");
    return { status, url: finalUrl, headers: new Headers(), body: Buffer.from(html), text: () => html };
  },
} });
const modelCalls: any[] = [];
const imageFetches: string[] = [];
let modelError: Error | null = null;
let suitability: any = { approved: true, category: "related", reason: "Related observation", depiction: "observation" };
mock.module(new URL("../packages/backend/src/db.ts", import.meta.url).href, { namedExports: { sql: () => { throw new Error("DB disabled"); } } });
mock.module(new URL("../packages/backend/src/editorial/models.ts", import.meta.url).href, { namedExports: { modelFor: async () => "offline-vision" } });
mock.module(new URL("../packages/backend/src/media/images.ts", import.meta.url).href, { namedExports: { produceImage: async (url: string) => { imageFetches.push(url); return { body: Buffer.from("offline image"), type: "image/jpeg" }; } } });
mock.module(new URL("../packages/backend/src/content/extract.ts", import.meta.url).href, { namedExports: { pageFetchable: () => false } });
mock.module(new URL("../packages/backend/src/jobs/queue.ts", import.meta.url).href, { namedExports: { shutdownSignal: new AbortController() } });
mock.module(new URL("../packages/backend/src/providers/llm.ts", import.meta.url).href, { namedExports: {
  MODELS: { "offline-vision": { vision: true } }, ModelOutputError: class extends Error {},
  chatJson: async (options: any) => {
    modelCalls.push(options);
    if (modelError) throw modelError;
    return { data: options.schema.parse({ imageSuitability: suitability, itemType: "image_release", authorRole: "observer", titleZh: "韦布望远镜观测", summaryZh: "韦布望远镜发布新的观测图像。", editorialJudgment: "观测新闻" }), model: "offline-vision", receiptId: 1, reused: false };
  },
} });
const { esaWebbImageAttribution, newsImageAttribution } = await import("../packages/backend/src/editorial/image-attribution.ts");
const { ProviderRejectedError } = await import("../packages/backend/src/providers/receipts.ts");
const { runUnderstand } = await import("../packages/backend/src/editorial/analyze.ts");
const article: import("../packages/backend/src/editorial/input.ts").AnalyzeInputArticle = {
  id: "offline", revision: 1, title: "Webb observation", url: articleUrl, author: null, publishedAt: null,
  bodyText: "Webb released a new observation of stars.", excerpt: null, xPost: null,
  media: [{ kind: "image", url: candidateUrl }], source: { name: "ESA Webb", kind: "rss", tier: "T1", firstParty: true },
};
beforeEach(() => { html = fixture; finalUrl = pageUrl; status = 200; fetchError = false; fetchCalls.length = 0; modelCalls.length = 0; modelError = null; imageFetches.length = 0; });

for (const value of [null, {}, 'yes', { approved: 'true', category: 'related', reason: 'ok' }, { approved: true, category: 'related', reason: '' }, { approved: true, category: 'related', reason: 'ok', depiction: 'fake' }]) {
  test(`malformed review stays explicitly invalid without extra calls: ${JSON.stringify(value)}`, async () => {
    const original = suitability; suitability = value;
    try {
      const result = await runUnderstand(article);
      assert.equal(result?.imageReview?.status, 'invalid');
      assert.equal(result?.imageReview?.approved, false);
      assert.match(result?.imageReview?.reason ?? '', /格式无效/);
      assert.ok(result?.titleZh && result?.summaryZh);
      assert.equal(modelCalls.length, 1);
      assert.equal(fetchCalls.length, 0);
    } finally { suitability = original; }
  });
}
test('image prompt makes the seventh field required without contradictory six-only instruction', async () => {
  await runUnderstand(article);
  assert.match(modelCalls[0].user[0].text, /必须.*imageSuitability/);
  assert.match(modelCalls[0].system, /附图.*必须.*七个字段/);
  assert.doesNotMatch(modelCalls[0].system, /最终只返回.*六个字段/);
});
test('text-only understanding keeps six-field prompt and no review or attribution fetch', async () => {
  const result = await runUnderstand({ ...article, media: [] });
  assert.equal(result?.imageReview, undefined);
  assert.equal(result?.summaryZh, '韦布望远镜发布新的观测图像。');
  assert.equal(modelCalls.length, 1);
  assert.ok(typeof modelCalls[0].user === 'string');
  assert.match(modelCalls[0].user, /六个字段/);
  assert.equal(fetchCalls.length, 0);
});
for (const review of [{ approved: true, category: 'related', reason: 'Related' }, { approved: false, category: 'unrelated', reason: 'Unrelated' }]) {
  test(`completed review status retains model reason: ${JSON.stringify(review)}`, async () => {
    const original = suitability; suitability = review;
    try {
      const result = await runUnderstand(article);
      assert.equal(result?.imageReview?.status, review.approved ? 'approved' : 'image-rejected');
      assert.equal(result?.imageReview?.reason, review.reason);
      assert.equal(modelCalls.length, 1);
    } finally { suitability = original; }
  });
}
test('provider rate-limit backoff remains caller-owned with no additional understand call', async () => {
  modelError = new ProviderRejectedError('offline 429 rate limit', 429, true);
  await assert.rejects(runUnderstand(article), (error) => error === modelError);
  assert.equal(modelCalls.length, 1);
  assert.equal(fetchCalls.length, 0);
});
test('missing image review preserves text with an explicit operational status and no retry', async () => {
  const original = suitability; suitability = undefined;
  try {
    const result = await runUnderstand(article);
    assert.equal(result?.imageReview?.status, 'missing');
    assert.equal(result?.imageReview?.approved, false);
    assert.match(result?.imageReview?.reason ?? '', /imageSuitability/);
    assert.equal(result?.summaryZh, '韦布望远镜发布新的观测图像。');
    assert.equal(modelCalls.length, 1);
    assert.equal(fetchCalls.length, 0);
  } finally { suitability = original; }
});

test("understanding attaches attribution from the same model response without changing suitability", async () => {
  const result = await runUnderstand(article);
  assert.equal(result?.imageReview?.credit, credit);
  assert.equal(result?.imageReview?.attributionUrl, pageUrl);
  assert.equal(result?.imageReview?.approved, true);
  assert.equal(result?.imageReview?.category, "related");
  assert.equal(result?.imageReview?.depiction, "observation");
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].purpose, "understand_article");
  assert.ok(Array.isArray(modelCalls[0].user));
  assert.equal(fetchCalls.length, 1);
});

test("exact official fixture yields full credit with one bounded fixed image-page request", async () => {
  assert.deepEqual(await esaWebbImageAttribution(articleUrl, candidateUrl), { credit, attributionUrl: pageUrl });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, pageUrl);
  assert.equal(fetchCalls[0]!.options.timeoutMs, 8000);
  assert.equal(fetchCalls[0]!.options.maxBytes, 512 * 1024);
  assert.equal(fetchCalls[0]!.options.maxRedirects, 0);
});


for (const invalid of [
  'http://esawebb.org/news/weic2610/', 'https://evil.org/news/weic2610/',
  'https://esawebb.org.evil.org/news/weic2610/', 'https://user@esawebb.org/news/weic2610/',
  'https://esawebb.org:443/news/weic2610/', 'https://esawebb.org:8443/news/weic2610/',
  'https://esawebb.org/news/weic2610/?x=1', 'https://esawebb.org/news/weic2610/#x',
  'https://esawebb.org/news/../news/weic2610/', 'https://esawebb.org/news/%77eic2610/',
  'https://esawebb.org/news/weic-2610/', 'https://esawebb.org/news/weic2610',
  'https://esawebb.org/images/weic2610/', ' https://esawebb.org/news/weic2610/',
  'https://esawebb.org/news/weic2610/\n',
]) test(`reject article URL without HTTP: ${invalid}`, async () => {
  assert.equal(await esaWebbImageAttribution(invalid, candidateUrl), null);
  assert.equal(fetchCalls.length, 0);
});
for (const invalid of [
  'http://cdn.esawebb.org/archives/images/screen/weic2610a.jpg',
  'https://esawebb.org/archives/images/screen/weic2610a.jpg',
  'https://cdn.esawebb.org.evil.org/archives/images/screen/weic2610a.jpg',
  'https://user:pass@cdn.esawebb.org/archives/images/screen/weic2610a.jpg',
  'https://cdn.esawebb.org:443/archives/images/screen/weic2610a.jpg',
  'https://cdn.esawebb.org/archives/images/screen/weic2610a.jpg?x=1',
  'https://cdn.esawebb.org/archives/images/screen/weic2610a.jpg#x',
  'https://cdn.esawebb.org/archives/images/large/weic2610a.jpg',
  'https://cdn.esawebb.org/archives/images/screen/../screen/weic2610a.jpg',
  'https://cdn.esawebb.org/archives/images/screen/%77eic2610a.jpg',
  'https://cdn.esawebb.org/archives/images/screen/weic-2610a.jpg',
  'https://cdn.esawebb.org/archives/images/screen/weic2610a.png',
  'https://cdn.esawebb.org/archives/images/screen/weic2610a.jpg\n',
]) test(`reject candidate URL without HTTP: ${invalid}`, async () => {
  assert.equal(await esaWebbImageAttribution(articleUrl, invalid), null);
  assert.equal(fetchCalls.length, 0);
});
test('allows exact www article host and normalizes markup whitespace without truncating credit', async () => {
  html = `<main><div class="credit"><p> NASA, ESA, CSA, STScI;\n Image Processing: <a>A. Pagan (STScI)</a> </p><p>Additional: X &amp; Y</p></div></main>`;
  assert.deepEqual(await esaWebbImageAttribution(articleUrl.replace('://', '://www.'), candidateUrl), { credit: `${credit} Additional: X & Y`, attributionUrl: pageUrl });
});
for (const target of [
  'https://evil.org/images/weic2610a/', 'https://esawebb.org/images/other/',
  'http://esawebb.org/images/weic2610a/', 'https://www.esawebb.org/images/weic2610a/',
  `${pageUrl}?x=1`, `${pageUrl}#credit`, 'https://esawebb.org:443/images/weic2610a/',
]) test(`reject final response mismatch: ${target}`, async () => {
  finalUrl = target;
  assert.equal(await esaWebbImageAttribution(articleUrl, candidateUrl), null);
  assert.equal(fetchCalls.length, 1);
});
for (const marker of ['All rights reserved', 'permission required', 'not covered']) {
  test(`reject per-image restriction: ${marker}`, async () => {
    html = fixture.replace('</main>', `<p>This image: ${marker}</p></main>`);
    assert.equal(await esaWebbImageAttribution(articleUrl, candidateUrl), null);
  });
}
for (const markup of ['<main>No credit</main>', '<main><div class="credit"><p> </p></div></main>', `<main><div class="credit"><p>${'a'.repeat(2001)}</p></div></main>`, `<main>No credit</main><footer><div class="credit"><p>${credit}</p></div></footer>`]) {
  test(`missing, empty, oversized or footer-only credit is skipped (${markup.length})`, async () => {
    html = markup;
    assert.equal(await esaWebbImageAttribution(articleUrl, candidateUrl), null);
  });
}
test('fetch failure is best effort with no retry', async () => {
  fetchError = true;
  assert.equal(await esaWebbImageAttribution(articleUrl, candidateUrl), null);
  assert.equal(fetchCalls.length, 1);
  const result = await runUnderstand(article);
  assert.ok(result?.summaryZh);
  assert.equal(result?.imageReview?.credit, undefined);
  assert.equal(modelCalls.length, 1);
  assert.equal(fetchCalls.length, 2);
});
for (const code of [302, 404, 500]) test(`skip HTTP status ${code}`, async () => {
  status = code;
  assert.equal(await esaWebbImageAttribution(articleUrl, candidateUrl), null);
  assert.equal(fetchCalls.length, 1);
});
for (const review of [null, { approved: false, category: 'related', reason: 'Rejected' }, { approved: true, category: 'uncertain', reason: 'Uncertain' }, { approved: true, category: 'ad', reason: 'Advertisement' }, { approved: true, category: 'invalid', reason: 'Invalid schema' }]) {
  test(`attribution never upgrades original review ${JSON.stringify(review)}`, async () => {
    const original = suitability;
    suitability = review;
    try {
      const result = await runUnderstand(article);
      assert.equal(result?.imageReview?.credit, undefined);
      assert.equal(result?.imageReview?.attributionUrl, undefined);
      assert.equal(fetchCalls.length, 0);
      assert.equal(result?.imageReview?.approved, false);
      assert.equal(result?.imageReview?.category, review?.category === 'invalid' ? 'uncertain' : review?.category ?? 'uncertain');
      assert.equal(modelCalls.length, 1);
    } finally { suitability = original; }
  });
}
test('existing candidate credit and attribution are preserved without fetching', async () => {
  const result = await runUnderstand({ ...article, media: [{ ...article.media[0], credit: 'Original full credit', attributionUrl: 'https://esawebb.org/original/', caption: 'Original caption' }] });
  assert.equal(result?.imageReview?.credit, 'Original full credit');
  assert.equal(result?.imageReview?.attributionUrl, 'https://esawebb.org/original/');
  assert.equal(result?.imageReview?.caption, 'Original caption');
  assert.equal(fetchCalls.length, 0);
  assert.equal(modelCalls.length, 1);
});
for (const attributionUrl of ['', ' ', 'javascript:alert(1)', '/images/weic2610a/', 'https://user:pass@esawebb.org/images/weic2610a/']) {
  test(`unsafe or empty candidate attribution cannot erase the trusted fetched link: ${attributionUrl}`, async () => {
    const result = await runUnderstand({ ...article, media: [{ ...article.media[0], attributionUrl }] });
    assert.equal(result?.imageReview?.credit, credit);
    assert.equal(result?.imageReview?.attributionUrl, pageUrl);
    assert.equal(fetchCalls.length, 1);
    assert.equal(modelCalls.length, 1);
  });
}
for (const attributionUrl of [undefined, '', 'javascript:alert(1)', 'https://user@esawebb.org/images/weic2610a/']) {
  test(`existing exact credit with missing or unsafe attribution enriches once: ${attributionUrl}`, async () => {
    const originalCredit = '  Original full credit; X & Y  ';
    const result = await runUnderstand({ ...article, media: [{ ...article.media[0], credit: originalCredit, attributionUrl }] });
    assert.equal(result?.imageReview?.credit, originalCredit);
    assert.equal(result?.imageReview?.attributionUrl, pageUrl);
    assert.equal(fetchCalls.length, 1);
    assert.equal(modelCalls.length, 1);
  });
}
const esaArticle = 'https://www.esa.int/Science_Exploration/Space_Science/Mars_Express/Mars_Express_keeps_an_eye_on_curious_cloud';
const esaCandidate = 'https://www.esa.int/var/esa/storage/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated_article.jpg';
const esaPage = 'https://www.esa.int/ESA_Multimedia/Images/2018/10/Elongated_cloud_on_Mars_annotated';
const esaCredit = 'ESA/GCP/UPV/EHU Bilbao';
const ccUrl = 'https://creativecommons.org/licenses/by-sa/3.0/igo/';
const standardPath = '/ESA_Multimedia/Terms_and_conditions_of_use_of_images_and_videos_available_on_the_esa_website';
const esaFixture = `<main><img src="/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated_pillars.jpg"><ul class="modal__meta_licence"><li><b>CREDIT</b><br>ESA/GCP/UPV/EHU Bilbao</li><li><b>LICENCE</b><br><a href="${ccUrl}">CC BY-SA 3.0 IGO</a> or <a href="${standardPath}">ESA Standard Licence</a><br>(content can be used under either licence)</li></ul></main>`;
function esaFixtureSetup() { html = esaFixture; finalUrl = esaPage; }
const solarStorage = '/var/esa/storage/images/esa_multimedia/images/2022/05/solar_orbiter_at_perihelion_27_march_2022/24071526-1-eng-GB/Solar_Orbiter_at_perihelion_27_March_2022';
const solarArticle = 'https://www.esa.int/Science_Exploration/Space_Science/Solar_Orbiter/Solar_Orbiter_tracks_origin_of_mysterious_magnetic_switchbacks';
const solarPage = 'https://www.esa.int/ESA_Multimedia/Images/2022/05/Solar_Orbiter_at_perihelion_27_March_2022';
const solarCredit = 'ESA & NASA/Solar Orbiter/EUI Team';
function solarFixtureSetup() {
  finalUrl = solarPage;
  html = `<main><img src="${solarStorage}_pillars.png"><a class="dropdown__item" download href="${solarStorage}.png">PNG</a><ul class="modal__meta_licence"><li><b>CREDIT</b><br>ESA &amp; NASA/Solar Orbiter/EUI Team</li><li><b>LICENCE</b><a href="${ccUrl}">CC BY-SA 3.0 IGO</a> or <a href="${standardPath}">ESA Standard Licence</a></li></ul></main>`;
}
test('ESA RSS card PNG validates exact official PNG identity, credit, licence and original', async () => {
  solarFixtureSetup();
  assert.deepEqual(await newsImageAttribution(solarArticle, `https://www.esa.int${solarStorage}_card_full.png`), {
    credit: solarCredit, attributionUrl: solarPage, license: 'ESA Standard Licence',
    licenseUrl: 'https://www.esa.int' + standardPath, canonicalUrl: `https://www.esa.int${solarStorage}.png`,
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(modelCalls.length, 0);
});
for (const suffix of ['_article.png', '_pillars.png', '.png', '_card_full.jpg']) {
  test(`ESA same-identity rendition remains supported: ${suffix}`, async () => {
    solarFixtureSetup();
    if (suffix.endsWith('.jpg')) html = html.replaceAll('.png', '.jpg');
    const result = await newsImageAttribution(solarArticle, `https://www.esa.int${solarStorage}${suffix}`);
    assert.equal(result?.credit, solarCredit);
    assert.equal(result?.canonicalUrl, `https://www.esa.int${solarStorage}.${suffix.endsWith('.png') ? 'png' : 'jpg'}`);
    assert.equal(fetchCalls.length, 1);
  });
}
for (const bad of ['?x=1', '#credit', '\n']) {
  test(`ESA card PNG rejects malformed URL without a request: ${JSON.stringify(bad)}`, async () => {
    solarFixtureSetup();
    assert.equal(await newsImageAttribution(solarArticle, `https://www.esa.int${solarStorage}_card_full.png${bad}`), null);
    assert.equal(fetchCalls.length, 0);
  });
}
for (const replacement of [
  ['24071526-1-eng-GB', '999999-1-eng-GB'],
  ['_pillars.png', '_pillars.jpg'],
  [solarCredit.replace('&', '&amp;'), 'Getty Images'],
  [` or <a href="${standardPath}">ESA Standard Licence</a>`, ''],
  ['</ul>', '<li>Permission required</li></ul>'],
] as const) {
  test(`ESA PNG rejects missing identity or rights evidence: ${replacement[1]}`, async () => {
    solarFixtureSetup(); html = html.replace(replacement[0], replacement[1]);
    assert.equal(await newsImageAttribution(solarArticle, `https://www.esa.int${solarStorage}_card_full.png`), null);
    assert.equal(fetchCalls.length, 1);
  });
}
test('ESA PNG does not invent an original URL from a mismatched download link', async () => {
  solarFixtureSetup(); html = html.replace(`href="${solarStorage}.png"`, `href="${solarStorage}.jpg"`);
  assert.equal((await newsImageAttribution(solarArticle, `https://www.esa.int${solarStorage}_card_full.png`))?.canonicalUrl, undefined);
});
test('ESA PNG first-image understanding retains the RSS URL and uses verified PNG original', async () => {
  solarFixtureSetup();
  const candidate = `https://www.esa.int${solarStorage}_card_full.png`;
  const result = await runUnderstand({ ...article, url: solarArticle, media: [{ kind: 'image', url: candidate }] });
  assert.equal(result?.imageReview?.url, candidate);
  assert.equal(result?.imageReview?.credit, solarCredit);
  assert.equal(result?.imageReview?.rightsStatus, 'verified');
  assert.deepEqual(imageFetches, [`https://www.esa.int${solarStorage}.png`]);
  assert.equal(fetchCalls.length, 1); assert.equal(modelCalls.length, 1);
});
test('ESA Space Science maps the official first image, validates per-image licence and persists exact evidence', async () => {
  esaFixtureSetup();
  const result = await runUnderstand({ ...article, url: esaArticle, media: [{ kind: 'image', url: esaCandidate }] });
  assert.equal(result?.imageReview?.credit, esaCredit);
  assert.equal(result?.imageReview?.attributionUrl, esaPage);
  assert.equal(result?.imageReview?.license, 'ESA Standard Licence');
  assert.equal(result?.imageReview?.licenseUrl, 'https://www.esa.int' + standardPath);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, esaPage);
  assert.deepEqual(fetchCalls[0].options, { timeoutMs: 8000, maxBytes: 512 * 1024, maxRedirects: 0 });
  assert.equal(modelCalls.length, 1);
});

test('ESA unlicensed media cannot bypass per-image verification with preexisting credit', async () => {
  esaFixtureSetup(); html = html.replace(ccUrl, 'https://evil.org/licence').replace(standardPath, '/unknown-terms');
  const result = await runUnderstand({ ...article, url: esaArticle, media: [{ kind: 'image', url: esaCandidate, credit: 'Feed credit', attributionUrl: esaPage }] });
  assert.equal(result?.imageReview?.approved, false);
  assert.equal(result?.imageReview?.rightsStatus, 'unverified');
  assert.equal(result?.imageReview?.status, 'rights-unverified'); // never described as incomplete suitability
  assert.equal(result?.imageReview?.suitabilityStatus, 'approved');
  assert.equal(fetchCalls.length, 1);
  assert.equal(modelCalls.length, 1);
});

test('ESA Standard metadata cannot authorize a non-ESA copyright holder', async () => {
  esaFixtureSetup(); html = html.replace(esaCredit, 'Getty Images / Independent Photographer');
  assert.equal(await newsImageAttribution(esaArticle, esaCandidate), null);
});
test('ESA exact official credit cannot be replaced by a feed guess' , async () => {
  esaFixtureSetup();
  const result = await runUnderstand({ ...article, url: esaArticle, media: [{ kind: 'image', url: esaCandidate, credit: 'ESA', attributionUrl: 'https://example.org/guess' }] });
  assert.equal(result?.imageReview?.credit, esaCredit);
  assert.equal(result?.imageReview?.attributionUrl, esaPage);
  assert.equal(result?.imageReview?.rightsStatus, 'verified');
  assert.equal(fetchCalls.length, 1);
});
test('ESA Standard Licence alone permits the scoped editorial policy and provides the exact canonical download', async () => {
  esaFixtureSetup();
  html = html.replace(`<a href="${ccUrl}">CC BY-SA 3.0 IGO</a> or `, '').replace('<ul class="modal__meta_licence">', '<a class="dropdown__item" href="/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated.jpg" download>Download</a><ul class="modal__meta_licence">');
  const result = await newsImageAttribution(esaArticle, esaCandidate);
  assert.equal(result?.license, 'ESA Standard Licence');
  assert.equal(result?.licenseUrl, 'https://www.esa.int' + standardPath);
  assert.equal(result?.canonicalUrl, 'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated.jpg');
  assert.equal(fetchCalls.length, 1);
});
test('ESA accepts the same storage identity canonical full JPG candidate without switching images', async () => {
  esaFixtureSetup();
  const canonicalCandidate = esaCandidate.replace('/images/2018/', '/images/esa_multimedia/images/2018/').replace('_article.jpg', '.jpg');
  assert.equal((await newsImageAttribution(esaArticle, canonicalCandidate))?.credit, esaCredit);
  assert.equal(fetchCalls.length, 1);
});
for (const restriction of ['All rights reserved', 'permission required', 'not licensed', 'not covered', 'Third-party image: separate terms apply', 'Copyright belongs to a third party']) {
  test(`ESA explicit image restriction fails closed: ${restriction}`, async () => {
    esaFixtureSetup(); html = html.replace('</ul>', `<li>${restriction}</li></ul>`);
    assert.equal(await newsImageAttribution(esaArticle, esaCandidate), null);
  });
}
test('ESA per-image description restrictions override licence metadata', async () => {
  esaFixtureSetup(); html = html.replace('<main>', '<main><p>This image is not licensed for reuse; permission required.</p>');
  assert.equal(await newsImageAttribution(esaArticle, esaCandidate), null);
});
for (const candidate of [esaCandidate.replace('https:', 'http:'), esaCandidate.replace('www.esa.int', 'www.esa.int.evil.org'), esaCandidate.replace('www.esa.int', 'user@www.esa.int'), esaCandidate.replace('www.esa.int', 'www.esa.int:443'), esaCandidate + '?x=1', esaCandidate + '#credit', esaCandidate + '\n', esaCandidate.replace('/2018/', '/%32%30%31%38/'), esaCandidate.replace('/2018/', '/../2018/'), esaCandidate.replace('/10/', '/13/'), esaCandidate.replace('_article.jpg', '_logo.jpg'), esaCandidate.replace('annotated_article', 'other_article')]) {
  test(`ESA rejects unsafe or unrelated raw candidate without HTTP: ${candidate}`, async () => {
    esaFixtureSetup(); assert.equal(await newsImageAttribution(esaArticle, candidate), null); assert.equal(fetchCalls.length, 0);
  });
}
for (const url of [esaArticle.replace('https:', 'http:'), esaArticle.replace('www.esa.int', 'www.esa.int:443'), esaArticle.replace('www.esa.int', 'www.esa.int.evil.org'), esaArticle + '?x=1', esaArticle + '#x', esaArticle + '\n', esaArticle.replace('/Space_Science/', '/Human_and_Robotic_Exploration/'), esaArticle.replace('/Mars_Express/', '/../Mars_Express/'), esaArticle.replace('/Mars_Express/', '/%4dars_Express/')]) {
  test(`ESA rejects unsafe or out-of-scope raw article without HTTP: ${url}`, async () => {
    esaFixtureSetup(); assert.equal(await newsImageAttribution(url, esaCandidate), null); assert.equal(fetchCalls.length, 0);
  });
}
for (const target of [esaPage.replace('www.esa.int', 'evil.org'), esaPage + '?x=1', esaPage.replace('annotated', 'other')]) {
  test(`ESA final URL must match the exact derived page: ${target}`, async () => {
    esaFixtureSetup(); finalUrl = target; assert.equal(await newsImageAttribution(esaArticle, esaCandidate), null); assert.equal(fetchCalls.length, 1);
  });
}
for (const markup of [esaFixture.replace(esaCredit, ' '), esaFixture.replace(esaCredit, 'x'.repeat(2001)), esaFixture.replace('17836422-1-eng-GB', '999-1-eng-GB'), esaFixture.replace('modal__meta_licence', 'footer-credit'), esaFixture.replace(ccUrl, 'https://evil.org').replace(standardPath, '/unknown'), esaFixture.replace('CC BY-SA 3.0 IGO', 'All Rights Reserved').replace('ESA Standard Licence', 'Unknown licence')]) {
  test(`ESA missing/mismatched image-level evidence stays text-only (${markup.length})`, async () => {
    esaFixtureSetup(); html = markup; assert.equal(await newsImageAttribution(esaArticle, esaCandidate), null); assert.equal(fetchCalls.length, 1);
  });
}
test('ESA canonical download excludes other storage identities without fetching candidates', async () => {
  esaFixtureSetup(); html = html.replace('<main>', '<main><a class="dropdown__item" download href="https://evil.org/image.jpg">Download</a>');
  assert.equal((await newsImageAttribution(esaArticle, esaCandidate))?.canonicalUrl, undefined);
  assert.equal(fetchCalls.length, 1);
});
test('ESA failed bounded fetch preserves text without automatic retries', async () => {
  esaFixtureSetup(); fetchError = true;
  const result = await runUnderstand({ ...article, url: esaArticle, media: [{ kind: 'image', url: esaCandidate }] });
  assert.equal(result?.imageReview?.approved, false);
  assert.equal(result?.imageReview?.rightsStatus, 'unverified');
  assert.ok(result?.summaryZh); assert.equal(fetchCalls.length, 1); assert.equal(modelCalls.length, 1);
});
test('ESA dual-licence page prefers Standard editorial policy, including non-commercial restriction', async () => {
  esaFixtureSetup(); html = html.replace('</ul>', '<li>Commercial use prohibited without separate authorization.</li></ul>');
  const result = await newsImageAttribution(esaArticle, esaCandidate);
  assert.equal(result?.license, 'ESA Standard Licence');
});
test('ESA standalone CC BY-SA is held until a share-alike workflow exists', async () => {
  esaFixtureSetup(); html = html.replace(` or <a href="${standardPath}">ESA Standard Licence</a>`, '');
  const result = await newsImageAttribution(esaArticle, esaCandidate);
  assert.equal(result, null); // Share-alike redistribution is not implemented by this reader.
});
test('ESA first-image model input uses only the official same-identity canonical rendition', async () => {
  esaFixtureSetup(); html = html.replace('<main>', '<main><a class="dropdown__item" href="/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated.jpg" download>Download</a>');
  const result = await runUnderstand({ ...article, url: esaArticle, media: [{ kind: 'image', url: esaCandidate }, { kind: 'image', url: 'https://example.org/second.jpg' }] });
  assert.deepEqual(imageFetches, [result?.imageReview?.canonicalUrl]);
  assert.equal(result?.imageReview?.url, esaCandidate);
  assert.equal(fetchCalls.length, 1); assert.equal(modelCalls.length, 1);
});
const noirlabArticle = 'http://noirlab.edu/public/news/noirlab2624/';
const noirlabCandidate = 'https://storage.noirlab.edu/media/archives/images/screen/noirlab2624a.jpg';
const noirlabPage = 'https://noirlab.edu/public/images/noirlab2624a/';
const noirlabCredit = 'International Gemini Observatory/NOIRLab/NSF/AURA Acknowledgment: PI: T. Cunningham (Center for Astrophysics — Harvard & Smithsonian) Image Processing: J. Miller & M. Rodriguez (International Gemini Observatory/NSF NOIRLab), T.A. Rector (University of Alaska Anchorage/NSF NOIRLab), D. de Martin & M. Zamani (NSF NOIRLab)';
function noirlabFixture() {
  finalUrl = noirlabPage;
  html = `<main><div class="credit"><p>${noirlabCredit.replace(' Acknowledgment:', '<br />Acknowledgment:').replace(' Image Processing:', '<br />Image Processing:')}</p></div></main><footer>All rights reserved</footer>`;
}
test('NOIRLab full official credit enriches the reviewed first image without another model call', async () => {
  noirlabFixture();
  const result = await runUnderstand({ ...article, url: noirlabArticle, media: [{ kind: 'image', url: noirlabCandidate }] });
  assert.equal(result?.imageReview?.credit, noirlabCredit);
  assert.equal(result?.imageReview?.attributionUrl, noirlabPage);
  assert.equal(result?.imageReview?.approved, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, noirlabPage);
  assert.equal(fetchCalls[0].options.maxRedirects, 0);
  assert.equal(modelCalls.length, 1);
});

for (const invalid of [noirlabCandidate.replace('2624a', '2623a'), noirlabCandidate.replace('storage.noirlab.edu', 'storage.noirlab.edu.evil.org'), noirlabCandidate + '?x=1', noirlabCandidate.replace('/screen/', '/logos/'), noirlabCandidate.replace('https:', 'http:')]) {
  test(`NOIRLab rejects non-matching raw candidate without fetching: ${invalid}`, async () => {
    noirlabFixture();
    assert.equal(await newsImageAttribution(noirlabArticle, invalid), null);
    assert.equal(fetchCalls.length, 0);
  });
}
for (const invalid of [noirlabArticle.replace('noirlab.edu', 'noirlab.edu.evil.org'), noirlabArticle.replace('/news/', '/images/'), noirlabArticle + '?x=1', noirlabArticle.replace('noirlab.edu', 'noirlab.edu:443'), noirlabArticle.replace('noirlab2624', '%6eoirlab2624')]) {
  test(`NOIRLab rejects non-matching raw article without fetching: ${invalid}`, async () => {
    noirlabFixture();
    assert.equal(await newsImageAttribution(invalid, noirlabCandidate), null);
    assert.equal(fetchCalls.length, 0);
  });
}
for (const marker of ['All rights reserved', 'permission required', 'not covered', 'identifiable person', 'not licensed', 'permission is required']) {
  test(`NOIRLab skips individual image restriction: ${marker}`, async () => {
    noirlabFixture(); html = html.replace('</main>', `<p>${marker}</p></main>`);
    assert.equal(await newsImageAttribution(noirlabArticle, noirlabCandidate), null);
  });
}
test('NOIRLab skips missing credit and mismatched final image page', async () => {
  noirlabFixture(); html = '<main>No credit</main>';
  assert.equal(await newsImageAttribution(noirlabArticle, noirlabCandidate), null);
  noirlabFixture(); finalUrl = noirlabPage.replace('2624a', '2623a');
  assert.equal(await newsImageAttribution(noirlabArticle, noirlabCandidate), null);
});
for (const review of [null, { approved: false, category: 'related', reason: 'Rejected' }, { approved: true, category: 'logo', reason: 'Logo' }]) {
  test(`NOIRLab attribution cannot upgrade suitability: ${JSON.stringify(review)}`, async () => {
    noirlabFixture(); const original = suitability; suitability = review;
    try {
      const result = await runUnderstand({ ...article, url: noirlabArticle, media: [{ kind: 'image', url: noirlabCandidate }] });
      assert.equal(result?.imageReview?.approved, false);
      assert.equal(result?.imageReview?.credit, undefined);
      assert.equal(fetchCalls.length, 0);
    } finally { suitability = original; }
  });
}
test('blank credit is enriched but existing attribution URL is not overwritten', async () => {
  const result = await runUnderstand({ ...article, media: [{ ...article.media[0], credit: '  ', attributionUrl: 'https://esawebb.org/original/' }] });
  assert.equal(result?.imageReview?.credit, credit);
  assert.equal(result?.imageReview?.attributionUrl, 'https://esawebb.org/original/');
});
