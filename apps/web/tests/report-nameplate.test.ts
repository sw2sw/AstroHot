// Regression for the report nameplates: the SSR'd Nameplate must carry the responsive class and
// point at the generated SVGs in industry/brand/nameplates/, and those files must hold an
// accessible title, the report's width and both fillable paths (the subject word in the accent,
// the Chinese title in the ink). Regenerate them with scripts/nameplates.ts after changing the
// subject in industry/site.ts.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" });
});
after(async () => { await vite?.close(); });

// The class ReportPaper sets on the masthead's nameplate.
const RESPONSIVE = "block h-[44px] w-auto @[520px]:h-[58px] @[880px]:h-[74px] @[1040px]:h-[84px]";
const TITLES = { daily: "天文日报", weekly: "天文周报", monthly: "天文月报", archive: "日报合订本" } as const;

/** The generated file a dev-server asset URL stands for: /@fs/<abs> for files outside apps/web. */
function fileOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0]!;
  const m = /^\/@fs(\/.*)$/.exec(clean) ?? /^\/(.*)$/.exec(clean);
  assert.ok(m, `unexpected nameplate URL: ${url}`);
  const path = decodeURIComponent(m[1]!);
  // An absolute path is a file URL in its own right. Going through `../` would double the drive letter
  // on Windows, where Vite writes `/@fs/D:/…`.
  if (path.startsWith("/")) return fileURLToPath(new URL(`file:${path}`));
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

test("nameplates SSR with the responsive class and point at titled, wide generated SVGs", async () => {
  const { Nameplate } = await vite.ssrLoadModule("/app/features/report/Nameplate.tsx");
  for (const [which, title] of Object.entries(TITLES)) {
    const html = renderToStaticMarkup(createElement(Nameplate as React.ComponentType<{ which: string; className?: string }>, { which, className: RESPONSIVE }));
    const svg = /<svg[^>]*>[\s\S]*<\/svg>/.exec(html)?.[0] ?? "";
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /focusable="false"/);
    assert.ok(svg.includes(RESPONSIVE), `${which} nameplate lacks the responsive class`);
    const refs = [...svg.matchAll(/<use href="([^"]+)#(accent|ink)" class="(fill-accent|fill-ink)"/g)];
    assert.deepEqual(refs.map((r) => [r[2], r[3]]), [["accent", "fill-accent"], ["ink", "fill-ink"]]);

    const file = fileOf(refs[0]![1]!);
    // Separators compared the same way on every platform (Windows resolves to backslashes).
    assert.ok(file.replace(/\\/g, "/").endsWith(`industry/brand/nameplates/${which}.svg`), `${file} is not the ${which} nameplate`);
    const content = readFileSync(file, "utf8");
    const viewBox = /viewBox="([^"]+)"/.exec(content)?.[1] ?? "";
    assert.equal(/viewBox="([^"]+)"/.exec(svg)?.[1], viewBox);
    assert.ok(content.includes(`<title>${title}</title>`), `${which} nameplate lacks <title>${title}</title>`);
    if (which !== "archive") {
      // The AI-example subject set ~600-wide nameplates; the real subject word must set wider ones.
      const width = Number(viewBox.split(" ")[2]);
      assert.ok(width > 800, `${which} nameplate is only ${width} units wide`);
    }
    for (const part of ["accent", "ink"] as const) {
      const d = new RegExp(`<path id="${part}" d="([^"]*)"`, "g").exec(content)?.[1] ?? "";
      assert.ok(d.length > 0, `${which} nameplate has an empty ${part} path`);
    }
  }
});
