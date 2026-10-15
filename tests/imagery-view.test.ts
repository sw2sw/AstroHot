import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Node's native TS stripping cannot parse JSX; use the existing Vite transformer.
const loader = `
import { readFile } from "node:fs/promises";
import { transformWithOxc } from ${JSON.stringify(import.meta.resolve("vite"))};
export async function load(url, context, nextLoad) {
  // Include shared TSX dependencies (for example MathText), not only imagery files.
  if (url.includes("/apps/web/app/") && /\\.tsx?$/.test(url)) {
    const result = await transformWithOxc(await readFile(new URL(url), "utf8"), new URL(url).pathname, { jsx: { runtime: "automatic" } });
    return { format: "module", shortCircuit: true, source: result.code };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

// Synthetic test fixture, not NASA content and never delivered in production screens.
// The image address uses the formal local media path issued by the API.
const item = {
  source: "fixture", sourceDate: "2000-02-29", titleEn: "Test <title>", titleZh: "测试标题",
  explanationEn: "Test English paragraph", explanationZh: "测试中文段落",
  credit: "Exact credit A / B", copyright: "Exact copyright C", sourceUrl: "https://example.org/original",
  mediaType: "image" as const, imageUrl: `/api/imagery/media/${"a".repeat(64)}`, mediaUrl: null, altEn: "Test image",
  translationStatus: "ready" as const, mediaStatus: "ready" as const,
};

const cardModule = new URL("../apps/web/app/features/imagery/ImageryCard.tsx", import.meta.url);
const detailModule = new URL("../apps/web/app/features/imagery/ImageryDetail.tsx", import.meta.url);

for (const moduleUrl of [cardModule, detailModule]) {
  const name = moduleUrl.pathname.split("/").at(-1);
  test(`${name} renders full rights and safe labelled attribution links as text, never raw HTML`, async () => {
    const module = await import(moduleUrl.href);
    const Component = module.ImageryCard ?? module.ImageryDetail;
    const credit = 'Full attribution '.repeat(40) + 'END CREDIT';
    const copyright = '© Full rights '.repeat(40) + 'END RIGHTS';
    const html = renderToStaticMarkup(createElement(Component, {item: {...item, credit, copyright,
      creditLinks: [{label:'Author <name>',url:'https://author.example/portfolio'}, {label:'bad link',url:'javascript:alert(1)'}],
      copyrightLinks: [{label:'Rights policy',url:'https://science.nasa.gov/rights'}, {label:'secret',url:'https://user:pass@example.org/'}],
      rawCreditHtml: '<script>raw-rights-marker</script>', rawCopyrightHtml: '<img src="raw-rights-marker" onerror="bad()">',
    }}));
    assert.ok(html.includes(credit));
    assert.ok(html.includes(copyright));
    assert.match(html, /href="https:\/\/author.example\/portfolio"/);
    assert.match(html, /Author &lt;name&gt;/);
    assert.match(html, /href="https:\/\/science.nasa.gov\/rights"/);
    assert.match(html, /Rights policy/);
    assert.doesNotMatch(html, /truncate|line-clamp|javascript:|user:pass|raw-rights-marker|<script/);
  });
  test(`${name} preserves English when Chinese is missing, pending or failed`, async () => {
    const module = await import(moduleUrl.href);
    const Component = module.ImageryCard ?? module.ImageryDetail;
    for (const translationStatus of ["pending", "failed", "ready"] as const) {
      const html = renderToStaticMarkup(createElement(Component, { item: { ...item, titleZh: null, explanationZh: null, translationStatus } }));
      assert.match(html, /Test &lt;title&gt;/);
      if (name === "ImageryDetail.tsx") assert.match(html, /Test English paragraph/);
      assert.match(html, /中文翻译/);
      assert.doesNotMatch(html, /AI 翻译<|undefined|null/);
    }
  });
  test(`${name} links non-image media safely to the original only`, async () => {
    const module = await import(moduleUrl.href);
    const Component = module.ImageryCard ?? module.ImageryDetail;
    for (const mediaType of ["video", "iframe"] as const) {
      const html = renderToStaticMarkup(createElement(Component, { item: { ...item, mediaType, mediaUrl: "https://example.org/autoplay-video", mediaStatus: "not_applicable" } }));
      assert.match(html, /href="https:\/\/example.org\/original"/);
      assert.match(html, /原始|原文|原站/);
      assert.doesNotMatch(html, /<img|<iframe|<video|autoplay-video|download=/);
    }
    for (const sourceUrl of ["javascript:alert(1)", "data:text/html,test", "//example.org/unsafe", "/birthday?date=2000-02-29"]) {
      const html = renderToStaticMarkup(createElement(Component, { item: { ...item, mediaType: "iframe", sourceUrl } }));
      assert.doesNotMatch(html, /href=|<iframe|<video/);
    }
  });
  test(`${name} displays missing or failed media without unsafe or remote image URLs`, async () => {
    const module = await import(moduleUrl.href);
    const Component = module.ImageryCard ?? module.ImageryDetail;
    for (const imageUrl of [null, "https://example.org/remote.jpg", "//example.org/remote.jpg", "data:image/svg+xml,test", "/cache/../remote.jpg"]) {
      const html = renderToStaticMarkup(createElement(Component, { item: { ...item, imageUrl } }));
      assert.doesNotMatch(html, /<img/);
      assert.match(html, /图片/);
    }
    for (const mediaStatus of ["pending", "failed", "not_applicable"] as const) {
      const html = renderToStaticMarkup(createElement(Component, { item: { ...item, mediaStatus } }));
      assert.doesNotMatch(html, /<img/);
      assert.match(html, /图片/);
      assert.match(html, /Test &lt;title&gt;/);
    }
  });
}

test("card stays compact without full explanations", async () => {
  const { ImageryCard } = await import(cardModule.href);
  const html = renderToStaticMarkup(createElement(ImageryCard, { item }));
  assert.doesNotMatch(html, /Test English paragraph|测试中文段落/);
});

test("card displays date, bilingual plain-text titles and uncropped local image", async () => {
  const { ImageryCard } = await import(cardModule.href);
  const html = renderToStaticMarkup(createElement(ImageryCard, { item }));
  assert.match(html, /2000-02-29/);
  assert.match(html, /测试标题/);
  assert.match(html, /Test &lt;title&gt;/);
  assert.match(html, /object-contain/);
  assert.match(html, /src="\/api\/imagery\/media\/a{64}"/);
  assert.match(html, /alt="Test image"/);
  assert.doesNotMatch(html, /object-cover|<iframe|<video/);
});

test("detail renders full bilingual plain text, exact attribution and responsive layout", async () => {
  const { ImageryDetail } = await import(detailModule.href);
  const html = renderToStaticMarkup(createElement(ImageryDetail, { item: { ...item, explanationEn: '<script>alert(1)</script>\nSecond English paragraph', explanationZh: '中文全文\n第二段' } }));
  for (const text of ['测试标题', 'Test &lt;title&gt;', '中文全文', '第二段', 'Second English paragraph', 'Exact credit A / B', 'Exact copyright C', 'AI 翻译']) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/example.org\/original"/);
  assert.match(html, /rel="[^"]*noopener[^"]*"/);
  assert.match(html, /max-w-4xl/);
  assert.match(html, /whitespace-pre-wrap/);
  assert.match(html, /object-contain/);
  assert.doesNotMatch(html, /<script|<iframe|<video/);
});

test("empty Chinese strings are not advertised as a completed AI translation", async () => {
 const {translationLabel}=await import('../apps/web/app/features/imagery/view.ts');
 assert.equal(translationLabel({...item,titleZh:' ',explanationZh:''}),'中文翻译待完成');
});
test("local image URLs reject trailing newlines and cards bound image height", async () => {
 const {safeImageUrl}=await import('../apps/web/app/features/imagery/view.ts');
 assert.equal(safeImageUrl({...item,imageUrl:'/api/imagery/media/'+'a'.repeat(64)+'\n'}),null);
 const {ImageryCard}=await import(cardModule.href);
 assert.match(renderToStaticMarkup(createElement(ImageryCard,{item})),/max-h-/);
});

test("rights merge only whitespace-identical text and identical labelled URLs", async () => {
 const {ImageryRights}=await import('../apps/web/app/features/imagery/ImageryRights.tsx');
 const html=renderToStaticMarkup(createElement(ImageryRights,{item:{...item,credit:'Author A',copyright:'Author   A',creditLinks:[{label:'Author A',url:'https://example.org/a'}],copyrightLinks:[{label:'Author A',url:'https://example.org/a'},{label:'Author A',url:'https://example.org/b'},{label:'Distinct copyright',url:'https://example.org/c'}]}}));
 assert.equal((html.match(/Author A/g)??[]).length,2);
 assert.doesNotMatch(html,/Author   A/);
 assert.equal((html.match(/href="https:\/\/example.org\/a"/g)??[]).length,1);
 assert.match(html,/href="https:\/\/example.org\/b"/);
 assert.match(html,/Distinct copyright/);
});

test("hero synopsis is bounded Chinese copy with honest English fallback", async () => {
 const {imagerySynopsis}=await import('../apps/web/app/features/imagery/view.ts');
 assert.equal(imagerySynopsis(item),'测试中文段落');
 assert.equal(imagerySynopsis({...item,explanationZh:' ',translationStatus:'pending'}),'Test English paragraph');
 assert.equal(imagerySynopsis({...item,explanationZh:'天'.repeat(180)}),'天'.repeat(119)+'…');
});

test("archive cards place their detail action inside the article without nested links", async () => {
 const {ImageryCard}=await import(cardModule.href);
 const html=renderToStaticMarkup(createElement(ImageryCard,{item,onOpen:()=>{}}));
 assert.match(html,/<button[^>]*>[\s\S]*查看详情[\s\S]*<\/button>[\s\S]*<\/article>/);
 assert.doesNotMatch(html,/<button[^>]*>[\s\S]*<a[^>]*>[\s\S]*<\/button>/);
});
test("detail defaults to Chinese with a language switch and English fallback", async () => {
 const {ImageryDetail}=await import(detailModule.href);
 const html=renderToStaticMarkup(createElement(ImageryDetail,{item}));
 assert.match(html,/aria-pressed="true"[^>]*>中文/);
 assert.match(html,/lang="en"[^>]*hidden/);
 const fallback=renderToStaticMarkup(createElement(ImageryDetail,{item:{...item,explanationZh:' ',titleZh:null}}));
 assert.doesNotMatch(fallback,/lang="en"[^>]*hidden/);
 assert.match(fallback,/Test English paragraph/);
});
test("birthday results use a labelled native dialog with an accessible close action", async () => {
 const {ImageryDialog}=await import('../apps/web/app/features/imagery/ImageryDialog.tsx');
 const html=renderToStaticMarkup(createElement(ImageryDialog,{item,kind:'birthday',onClose:()=>{}}));
 assert.match(html,/<dialog[^>]*aria-labelledby=/);
 assert.match(html,/生日宇宙/);
 assert.match(html,/<button[^>]*aria-label="关闭详情"/);
});

test("birthday outcome never retains a previous item for an empty response", async () => {
 const {birthdayOutcome}=await import('../apps/web/app/features/imagery/view.ts');
 assert.deepEqual(birthdayOutcome({item:null,status:'pending'}),{item:null,notice:'这一天的影像正在准备，请稍后重试。'});
 assert.equal(birthdayOutcome({item,status:'ready'}).item,item);
 assert.equal(birthdayOutcome({item:null,status:'unavailable'}).item,null);
});

// Birthday lookup: the pure date validation is pinned here; real interactions (submit states,
// duplicate submits, callback failures) are exercised against the local demo page in a browser.
const birthdayDateModule = new URL("../apps/web/app/features/imagery/birthday-date.ts", import.meta.url);
const birthdayLookupModule = new URL("../apps/web/app/features/imagery/BirthdayLookup.tsx", import.meta.url);

test("birthday date validation accepts real dates inside the archive range", async () => {
  const { validateBirthdayDate, BIRTHDAY_MIN_DATE } = await import(birthdayDateModule.href);
  assert.equal(BIRTHDAY_MIN_DATE, "1995-06-16");
  for (const [value, today] of [
    ["1995-06-16", "2000-03-01"], // first archived day, inclusive
    ["2000-02-29", "2000-03-01"], // leap day of the leap year in the fixture
    ["2000-03-01", "2000-03-01"], // today is an allowed upper bound
  ] as const) {
    const result = validateBirthdayDate(value, today);
    assert.equal(result.ok, true, value);
    if (result.ok) assert.equal(result.date, value, "the validated date must be returned unchanged");
  }
});

test("birthday date validation rejects incomplete, impossible, early and future dates", async () => {
  const { validateBirthdayDate } = await import(birthdayDateModule.href);
  const rejected = [
    "", "2000-2-29", "2000/02/29", "2000-02-2", " 2000-02-29", "2000-02-29 ", "20000229",
    "2000-02-30", "2001-02-29", "1900-02-29", "2000-13-01", "2000-00-10", "2000-01-00", "2100-02-29",
  ];
  for (const value of rejected) {
    const result = validateBirthdayDate(value, "2000-03-01");
    assert.equal(result.ok, false, value);
  }
  const early = validateBirthdayDate("1995-06-15", "2000-03-01");
  assert.equal(early.ok, false);
  if (!early.ok) assert.match(early.message, /1995-06-16/, "must state the archive start date");
  const future = validateBirthdayDate("2000-03-02", "2000-03-01");
  assert.equal(future.ok, false);
});

test("birthday lookup renders an accessible form with no storage, log or navigation side effects", async () => {
  const module = await import(birthdayLookupModule.href);
  const html = renderToStaticMarkup(createElement(module.BirthdayLookup, { onLookup: async () => {}, today: "2000-03-01" }));
  assert.match(html, /<label[^>]*for=/);
  assert.match(html, /<input[^>]*type="text"/);
  assert.match(html, /placeholder="YYYY-MM-DD"/);
  assert.match(html, /<button[^>]*type="submit"/);
  assert.match(html, /1995-06-16/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|console\.|method="/);
  assert.doesNotMatch(html, /action="/);
});
