import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { ImageryViewItem } from "../app/features/imagery/types.ts";

const preview: ImageryViewItem = {
  source: "nasa-apod", sourceDate: "2026-10-06", titleEn: "A Complete Auroral Oval from SMILE", titleZh: null,
  // Source-explanation excerpt verified against NASA apod-basic/261006; cached path is a local test fixture.
  explanationEn: "Explanation: Have you ever seen a complete auroral oval? You can't see one from the ground because it makes too large a circle around one of Earth's magnetic poles. But spacecraft high above the Earth can see them. The featured video from ESA and CAS's robotic SMILE spacecraft shows not only a full auroral oval, but using ultraviolet light, one that occurred during the day.",
  explanationZh: null, credit: "ESA and CAS", copyright: null,
  sourceUrl: "https://science.nasa.gov/image-article/apod-2026-october-6-a-complete-auroral-oval-from-smile/",
  mediaType: "image", imageUrl: `/api/imagery/media/${"a".repeat(64)}`, mediaUrl: null,
  altEn: null, translationStatus: "pending", mediaStatus: "ready",
};
let vite: ViteDevServer;
before(async () => { vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" }); });
after(async () => { await vite?.close(); });
async function render(component: "ImageryCard" | "ImageryDetail", item = preview) {
  const mod = await vite.ssrLoadModule(`/app/features/imagery/${component}.tsx`);
  return renderToStaticMarkup(createElement(mod[component], { item, onOpen: () => {} }));
}

test("Oct6 image metadata with explicit featured-video evidence labels the cached preview in cards and details", async () => {
  for (const component of ["ImageryCard", "ImageryDetail"] as const) {
    const html = await render(component);
    assert.match(html, /（视频截图，原视频请看 /);
    assert.match(html, /text-xs font-semibold/);
    assert.match(html, /NASA 原文 ↗/);
    assert.equal([...html.matchAll(/NASA 原文 ↗/g)].length, 1);
    assert.match(html, /<img /);
    assert.match(html, /href="https:\/\/science.nasa.gov\/image-article\/apod-2026-october-6-a-complete-auroral-oval-from-smile\/"/);
    assert.match(html, /）<\/p>/);
    assert.doesNotMatch(html, /<button\b[^>]*>[\s\S]*?<a\b[\s\S]*?<\/button>/);
  }
});

test("latest imagery hero carries one note outside its clickable preview", async () => {
  const { default: ImageryPage } = await vite.ssrLoadModule("/app/routes/imagery.tsx");
  const router = createMemoryRouter([{ id: "imagery", path: "/imagery", Component: ImageryPage }], {
    initialEntries: ["/imagery"], hydrationData: { loaderData: { imagery: { items: [preview], available: true } } },
  });
  try {
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    const hero = html.slice(html.indexOf('<section aria-labelledby="today-title"'), html.indexOf('<section aria-labelledby="birthday-title"'));
    assert.match(hero, /（视频截图，原视频请看 /);
    assert.equal([...hero.matchAll(/NASA 原文 ↗/g)].length, 1);
    for (const [button] of hero.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) assert.doesNotMatch(button, /<a\b/);
  } finally { router.dispose(); }
});

test("video and iframe metadata without a safe preview never claim a screenshot or embed media", async () => {
  for (const mediaType of ["video", "iframe"] as const) {
    const item = { ...preview, mediaType, explanationEn: "Auroras seen from space.", mediaUrl: "https://example.org/video.mp4" };
    for (const component of ["ImageryCard", "ImageryDetail"] as const) {
      const html = await render(component, item);
      assert.match(html, /（本期为视频，原视频请看 /);
      assert.doesNotMatch(html, /视频截图|视频或互动内容|<img |<video\b|<iframe\b|example.org/);
      assert.equal([...html.matchAll(/NASA 原文 ↗/g)].length, 1);
    }
  }
});

test("ordinary photos and incidental video mentions have no video annotation", async () => {
  for (const explanationEn of ["A photograph of a galaxy.", "Watch a video of the mission. This image shows a galaxy.", "A featured video of a previous mission is also available.", "This still photo was taken before the featured video was recorded.", "Unlike the featured video from yesterday, this image is a photograph."]) {
    for (const component of ["ImageryCard", "ImageryDetail"] as const) {
      const html = await render(component, { ...preview, explanationEn });
      assert.doesNotMatch(html, /视频截图|本期为视频/);
      assert.match(html, /<img /);
    }
  }
  const { videoMediaNote } = await vite.ssrLoadModule("/app/features/imagery/view.ts");
  assert.equal(videoMediaNote({ ...preview, source: "other-source" }), null);
  assert.equal(videoMediaNote({ ...preview, mediaType: "iframe", explanationEn: "Interactive sky map.", mediaUrl: "https://example.org/sky-map" }), null);
  assert.equal(videoMediaNote({ ...preview, sourceDate: "2000-01-01", titleEn: "Another title" }), "视频截图，原视频请看 ");
});

test("explicit featured-video evidence with missing or unsafe images uses the no-screenshot note", async () => {
  for (const override of [{ imageUrl: null }, { imageUrl: "https://example.org/still.jpg" }, { mediaStatus: "failed" as const }]) {
    const html = await render("ImageryDetail", { ...preview, ...override });
    assert.match(html, /（本期为视频，原视频请看 /);
    assert.doesNotMatch(html, /视频截图|<img /);
  }
});

test("unsafe source links leave an honest plain media note with no actionable link", async () => {
  for (const sourceUrl of ["javascript:alert(1)", "not-a-url", "//science.nasa.gov/", "http://science.nasa.gov/", "https://user:password@science.nasa.gov/"]) {
    for (const component of ["ImageryCard", "ImageryDetail"] as const) {
      const html = await render(component, { ...preview, sourceUrl });
      assert.match(html, /（视频截图，原视频请看 NASA 原文）/);
      assert.doesNotMatch(html, /<a\b|NASA 原文 ↗/);
    }
  }
});

test("archive and birthday dialogs share the detail media note without duplication", async () => {
  const { ImageryDialog } = await vite.ssrLoadModule("/app/features/imagery/ImageryDialog.tsx");
  for (const kind of ["archive", "birthday"]) {
    const html = renderToStaticMarkup(createElement(ImageryDialog, { item: preview, kind, onClose: () => {} }));
    assert.match(html, /<dialog\b/);
    assert.match(html, /（视频截图，原视频请看 /);
    assert.match(html, /）<\/p>/);
    assert.equal([...html.matchAll(/NASA 原文 ↗/g)].length, 1);
  }
});
