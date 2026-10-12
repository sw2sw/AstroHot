// The site-wide LaTeX renderer (app/lib/math.ts + app/components/MathText.tsx).
//
// These cover the behaviour the whole site depends on: every delimiter form, every reader-facing field
// (title in both languages, summary, reason, quoted evidence, report copy, Markdown and article bodies),
// the things that must NOT be read as math (prices, escaped dollars, URLs, code), illegal source falling
// back to the original text, and the injection guards. The render-point tests walk the real components so
// a page cannot claim coverage it does not have.
import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { hasMath, renderMathHtml, renderMathInMarkup, splitMath } from "../app/lib/math.ts";
import { renderMarkdown } from "../app/lib/markdown.ts";
import type { FeedItemSummary } from "@aihot/contracts/site";

let vite: ViteDevServer;
before(async () => {
  // fileURLToPath, not `new URL("..", import.meta.url).pathname`: on Windows the latter is `/D:/…`,
  // which Vite cannot resolve (the older tests in this folder hit exactly that).
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" });
});
after(async () => { await vite?.close(); });

test("markup attributes with quoted greater-than signs remain verbatim", () => {
  const prefix = '<a title="x > $y$" href="/x?value=$q$">';
  const result = renderMathInMarkup(`${prefix}$z$</a>`);
  assert.ok(result.startsWith(prefix));
  assert.equal((result.match(/class="math-inline"/g) || []).length, 1);
});
test("markup formulas decode escaped entities without changing surrounding prose", () => {
  const result = renderMathInMarkup('<p>A &amp; B $x &lt; y$</p>');
  assert.ok(result.startsWith('<p>A &amp; B '));
  assert.ok(result.includes('class="math-inline"'));
  assert.ok(result.includes('x &lt; y</annotation>'));
});

const load = (path: string) => vite.ssrLoadModule(path);
const el = createElement;
/** SSR of <MathText text={…} />, the component every reader-facing string goes through. */
const html = async (text: string) => renderToStaticMarkup(el((await load("/app/components/MathText.tsx")).MathText, { text }));
const mathSpans = (markup: string) => markup.match(/class="math-inline"/g)?.length ?? 0;
const blockSpans = (markup: string) => markup.match(/class="math-block"/g)?.length ?? 0;
/** In a router context (feed cards and the arXiv page are full of Links). Modules come back from Vite
 *  untyped, so the element is cast rather than each call site annotated. */
const routed = (node: unknown) => renderToStaticMarkup(el(MemoryRouter, {}, node as React.ReactNode));

// ---------------------------------------------------------------------------------------------
// The four delimiter forms
// ---------------------------------------------------------------------------------------------
describe("delimiters", () => {
  test("inline $...$ becomes a KaTeX span between verbatim text", async () => {
    const out = await html("能量满足 $E=mc^2$ 的关系");
    assert.match(out, /^能量满足 /);
    assert.match(out, /class="math-inline"/);
    assert.match(out, /class="katex"/);
    assert.ok(!out.includes("$E=mc^2$"), "the delimiters are consumed by the math span");
    assert.match(out, / 的关系$/);
  });

  test("inline \\(...\\) is the same as $...$", async () => {
    const out = await html("关系为 \\(a^2+b^2=c^2\\)");
    assert.equal(mathSpans(out), 1);
    assert.ok(!out.includes("\\(") && !out.includes("\\)"));
  });

  test("$$...$$ is a standing formula, not two inline ones", async () => {
    const out = await html("$$\\int_0^1 x\\,dx$$");
    assert.equal(blockSpans(out), 1, "one standing formula");
    assert.equal(mathSpans(out), 0, "and no inline one");
  });

  test("\\[...\\] is a standing formula too", async () => {
    assert.equal(blockSpans(await html("\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]")), 1);
  });

  test("a standing formula may span lines; an inline one may not", async () => {
    assert.equal(blockSpans(await html("$$\n\\frac{a}\n{b}\n$$")), 1);
    // `$a\nb$` is not a formula: the pair never closes on one line, so it stays text.
    assert.equal(hasMath("$a\nb$"), false);
  });

  test("a display formula keeps its own pair instead of losing it to the inline rule", () => {
    const parts = splitMath("$$x+y$$");
    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "math");
    assert.equal((parts[0] as { display: boolean }).display, true);
  });

  test("several formulas in one string all render", async () => {
    const out = await html("$a$ 与 $b$ 与 $$c$$");
    assert.equal(mathSpans(out), 2);
    assert.equal(blockSpans(out), 1);
  });

  test("an unpaired delimiter never opens a span", async () => {
    for (const text of ["价格 $5 起", "半成品 $", "\\(未闭合", "$$未闭合"]) {
      assert.equal(hasMath(text), false, `${text} was read as math`);
      assert.ok(!(await html(text)).includes("katex"), `${text} produced KaTeX markup`);
    }
  });

  test("an empty pair is not a formula", () => {
    assert.equal(hasMath("空 $$ 与 $ 尾"), false);
    assert.equal(hasMath("a $$ b"), false);
  });
});

// ---------------------------------------------------------------------------------------------
// What must not be read as math
// ---------------------------------------------------------------------------------------------
describe("not math", () => {
  for (const prefix of [String.raw`Price \$5; formula `, '`$` then ', 'https://example.invalid/$path then ', '```\n$\n``` then ']) {
    test(`protected prefix does not consume following math: ${prefix}`, async () => {
      const source = prefix + '$E=mc^2$';
      const parts = splitMath(source);
      assert.deepEqual(parts.filter((s) => s.kind === 'text'), [{ kind: 'text', text: prefix }]);
      assert.equal(parts.filter((s) => s.kind === 'math').length, 1);
      const react = await html(source);
      assert.ok(react.startsWith(prefix));
      assert.equal(mathSpans(react), 1);
      const markup = renderMathInMarkup(`<a href="/keep/$token" title="$attr$">${source}</a><code>$</code>`);
      assert.ok(markup.startsWith(`<a href="/keep/$token" title="$attr$">${prefix}`));
      assert.ok(markup.endsWith('</a><code>$</code>'));
      assert.equal(mathSpans(markup), 1);
      assert.equal(renderMathHtml(source), react);
    });
  }
  test("ordinary prices are left exactly as written", () => {
    for (const text of ["$5 and $10", "100$ 到 200$", "价格 $5$ 起", "预算 $1,200 与 $80", "花费 5$ 或 10$"]) {
      assert.equal(hasMath(text), false, `${text} was read as math`);
    }
  });

  test("an escaped dollar is a dollar, not a delimiter", () => {
    assert.equal(hasMath("\\$5 and \\$10"), false);
    assert.equal(hasMath("价 \\$5"), false);
  });

  test("a URL is an address, whatever it contains", async () => {
    for (const text of ["见 https://a.test/$x$ 页", "www.a.test/$x$", "https://a.test/a$b$c"]) {
      assert.equal(hasMath(text), false, `${text} was read as math`);
    }
    // The address survives in the output; only the formula inside it is left alone.
    assert.match(await html("见 https://a.test/$x$ 页"), /https:\/\/a\.test\/\$x\$/);
  });

  test("inline code and fenced code keep their command characters", async () => {
    assert.equal(hasMath("`$x$`"), false);
    assert.equal(hasMath("```\n$x$\n```"), false);
    assert.equal(hasMath("前 ```\n$E=mc^2$\n``` 后"), false);
    assert.match(await html("`$x$`"), /\$x\$/);
  });

  test("text with no formula comes back byte-for-byte", async () => {
    for (const text of ["研究摘要与科学结果", "质量为 10 太阳质量的天体", "M104：草帽星系的潮汐尾", "2026 年 10 月 7 日", ""]) {
      assert.equal(await html(text), text, `${text} was altered`);
    }
  });

  test("newlines and whitespace survive between formulas", async () => {
    const out = await html("第一段 $a+b$ 结束\n第二段没有数学\n第三段 $c_i$ 尾");
    assert.equal(mathSpans(out), 2);
    assert.ok(out.includes("\n"), "line breaks stay in the markup");
    assert.ok(out.indexOf("第二段没有数学") > out.indexOf("math-inline"));
  });

  test("an absurdly long run is left as text instead of typeset", () => {
    assert.equal(hasMath(`$${"a+".repeat(1200)}b$$`), false);
  });

  test("only the characters touching the delimiters decide, not the rest of the sentence", async () => {
    // A digit later in the line must not make a formula look like an amount.
    for (const [text, expected] of [
      ["半长轴 $a=38.2\\,\\mathrm{AU}$ 与偏心率 $e=0.42$。", 2],
      ["偏心率 $e=0.42$ 与半长轴 $a=38.2\\,\\mathrm{AU}$。", 2],
      ["The mass is $M=4.5$ and the period is 12.4 years.", 1],
      ["$H_0=67.4$ 与 $H_0=70.1$ 两组估计。", 2],
    ] as const) {
      assert.ok(hasMath(text), `${text} lost its formula`);
      assert.equal(mathSpans(await html(text)), expected, text);
    }
    // A digit right against a delimiter is still a price.
    assert.equal(hasMath("100$ 到 200$"), false);
    assert.equal(hasMath("$5 and $10"), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Legal source, illegal source
// ---------------------------------------------------------------------------------------------
describe("legal and illegal source", () => {
  test("a formula with Chinese inside a text command is typeset", async () => {
    const out = await html("观测波段 $\\text{近红外} \\lambda \\approx 2.2\\,\\mu\\mathrm{m}$ 覆盖");
    assert.equal(mathSpans(out), 1, "\\text{近红外} must not disqualify the formula");
    assert.ok(!out.includes("$"), "the delimiters are consumed");
    // KaTeX keeps the source in the MathML annotation (what a screen reader and a copy receive); what must
    // not survive is the source in the *visual* layer, next to the typeset formula.
    const visual = out.slice(out.indexOf("katex-html"));
    assert.ok(!visual.includes("\\text{近红外}"), "the visual layer is typeset, not raw");
    assert.ok(out.includes("<mtext>近红外</mtext>"), "the Chinese is set as text, not dropped");
  });

  test("CJK outside a text command is prose between dollars, not a formula", () => {
    assert.equal(hasMath("$100 到 200$"), false);
  });

  test("illegal LaTeX falls back to the verbatim original text", async () => {
    for (const text of ["公式 $\\frac{$ 错误", "$\\error{x}$ 单独", "尾部 $x^ 错", "$$未闭合 {$$"]) {
      assert.equal(hasMath(text), false, `${text} should not typeset`);
      assert.equal(await html(text), text, `${text} should come back verbatim`);
    }
  });

  test("an illegal formula does not stop the legal ones around it", async () => {
    const out = await html("$a$ 与 $\\frac{$ 与 $b$");
    assert.equal(mathSpans(out), 2, "both legal formulas render");
    assert.ok(out.includes("\\frac{"), "the illegal one stays as its own text");
  });

  test("a rejected formula keeps its delimiters rather than vanishing", async () => {
    const out = await html("前 $\\badmacro{x}$ 后");
    assert.ok(out.includes("$") && out.includes("\\badmacro"), out);
    assert.ok(!out.includes("katex"));
  });
});

// ---------------------------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------------------------
describe("injection", () => {
  test("markup in the source never reaches the markup as markup", async () => {
    const out = await html("前缀 $<script>alert(1)</script>$ 后缀");
    assert.ok(!/<script/i.test(out), "no script tag");
    assert.ok(!/onerror=/i.test(out), "no event handler");
    assert.ok(!/javascript:/i.test(out), "no javascript: URI");
  });

  test("trusted link and HTML commands are refused whole, not typeset as rejected source", async () => {
    for (const src of ["\\href{javascript:alert(1)}{x}", "\\url{javascript:alert(1)}", "\\href{https://a.test}{x}", "\\htmlClass{pwned}{x}"]) {
      const out = await html(`前 $${src}$ 后`);
      assert.equal(hasMath(`$${src}$`), false, `${src} should not be typeset at all`);
      // The source is kept verbatim as text, which is inert: what must not exist is anything live.
      assert.ok(!/<a[\s>]/i.test(out), `${src} produced an anchor`);
      assert.ok(!/href=|src=|xlink/i.test(out), `${src} produced a URL attribute`);
      assert.ok(out.includes(src), `${src} should be left as its own text`);
      assert.ok(!/katex/.test(out), `${src} should not be typeset at all`);
    }
  });

  test("\\includegraphics produces no image and nothing that fetches", async () => {
    const out = await html("$\\includegraphics{https://evil.test/x.png}$");
    assert.ok(!/<img/i.test(out), "no img element");
    assert.ok(!/src=/i.test(out), "nothing is fetched");
    assert.ok(!/katex/.test(out), "the command is not typeset at all");
  });

  test("a standing formula is a span, so it stays valid inside a heading or a paragraph", () => {
    const css = renderMathHtml("$$\\sum_{i=1}^{n}\\frac{1}{i^2}=\\frac{\\pi^2}{6}$$");
    assert.match(css, /class="math-block"/);
    assert.ok(!/<div/.test(css), "no block element inside inline text");
  });

  test("SSR output is deterministic, which is what keeps hydration quiet", async () => {
    const text = "相同输入 $\\alpha + \\beta$ 应该得到相同输出";
    assert.equal(await html(text), await html(text));
    assert.equal(await html("$$x$$ 与 $y$"), await html("$$x$$ 与 $y$"));
  });
});

// ---------------------------------------------------------------------------------------------
// Markup we produced ourselves: the site's Markdown and a sanitised article body
// ---------------------------------------------------------------------------------------------
describe("markup chains", () => {
  test("Markdown copy is typeset, including a link's label, while its address and code are not", () => {
    const out = renderMarkdown("观测 $\\alpha$ 关系。\n\n见 `$x$` 与 [链接](https://a.test/$y$)。", "https://s.test").html;
    assert.match(out, /class="math-inline"/);
    assert.match(out, /<code>\$x\$<\/code>/, "code keeps its dollar");
    assert.match(out, /href="https:\/\/a\.test\/\$y\$"/, "the address keeps its dollar");
  });

  test("an article body is typeset outside code and pre, and inside a link's label", () => {
    const body = [
      "<p>公式 $E=mc^2$ 成立。</p>",
      "<pre><code>const a = $x$;</code></pre>",
      "<p>行内 <code>$y$</code> 不动，<a href=\"https://a.test/$z$\">标题 $\\theta$</a> 排版。</p>",
      "<p>独立 $$a^2$$ 结束。</p>",
    ].join("");
    const out = renderMathInMarkup(body);
    assert.equal(mathSpans(out), 2, "the paragraph formula and the link label");
    assert.equal(blockSpans(out), 1, "only the standing one");
    assert.match(out, /<code>\$y\$<\/code>/);
    assert.match(out, /const a = \$x\$;/);
    assert.match(out, /href="https:\/\/a\.test\/\$z\$"/, "the address is untouched");
  });

  test("markup without formulas is unchanged apart from escaping", () => {
    assert.equal(renderMathInMarkup("<p>普通 <em>文字</em> &amp; 符号</p>"), "<p>普通 <em>文字</em> &amp; 符号</p>");
  });

  test("an unbalanced tag in the body does not swallow the rest", () => {
    const out = renderMathInMarkup("<p>前 $a$ 后<pre><code>$b$</code>");
    assert.equal(mathSpans(out), 1);
    assert.ok(out.includes("$b$"));
  });
});

// ---------------------------------------------------------------------------------------------
// Link labels, mismatched delimiters, and spacing that is legitimate
// ---------------------------------------------------------------------------------------------
describe("link labels, mismatched delimiters and spacing", () => {
  test("a Markdown link's visible label is typeset; its address is not touched", () => {
    const out = renderMarkdown("见 [含 $\\alpha$ 的论文标题](https://a.test/$y$)。", "https://s.test").html;
    assert.equal(mathSpans(out), 1, "the label's formula is typeset");
    assert.match(out, /href="https:\/\/a\.test\/\$y\$"/, "the address keeps its dollar");
    const label = /<a [^>]*>([\s\S]*?)<\/a>/.exec(out)?.[1] ?? "";
    assert.ok(label.includes("katex"), "the label holds the typeset formula");
    assert.ok(!label.includes("$\\alpha$"), "the label is not raw source");
  });

  test("an article body's link label is typeset while href, code and pre stay verbatim", () => {
    const body =
      '<p>见 <a href="https://a.test/$z$">含 $\\alpha$ 的标题</a> 与 <code>$c$</code>。</p>' +
      "<pre><code>const a = $x$;</code></pre>";
    const out = renderMathInMarkup(body);
    assert.equal(mathSpans(out), 1, "the link label is the only formula");
    assert.match(out, /href="https:\/\/a\.test\/\$z\$"/, "href untouched");
    assert.match(out, /<code>\$c\$<\/code>/);
    assert.match(out, /const a = \$x\$;/);
  });

  test("an address inside a link label is not typeset", () => {
    const out = renderMathInMarkup('<p><a href="/x">https://a.test/$y$</a></p>');
    assert.equal(mathSpans(out), 0, "a bare URL stays a URL");
  });

  for (const [prefix, suffix, display] of [
    [String.raw`\(x\] then `, String.raw`\(y\)`, false],
    [String.raw`\[x\) then `, String.raw`\[y\]`, true],
    [String.raw`\(x\]`, String.raw`\(y\)`, false],
    [String.raw`\[x\)`, String.raw`\[y\]`, true],
    [String.raw`\(unfinished `, String.raw`\(y\)`, false],
    [String.raw`\[unfinished `, String.raw`\[y\]`, true],
  ] as const) {
    test(`slash recovery preserves prefix: ${prefix}`, async () => {
      const source = prefix + suffix;
      const parts = splitMath(source);
      assert.equal(parts.length, 2);
      assert.deepEqual(parts[0], { kind: 'text', text: prefix });
      assert.equal(parts[1]?.kind, 'math');
      if (parts[1]?.kind === 'math') {
        assert.equal(parts[1].latex, 'y');
        assert.equal(parts[1].display, display);
      }
      const react = await html(source);
      assert.ok(react.startsWith(prefix));
      assert.equal(display ? blockSpans(react) : mathSpans(react), 1);
      assert.equal(renderMathHtml(source), react);
      assert.equal(renderMathInMarkup(`<p>${source}</p>`), `<p>${react}</p>`);
    });
  }

  test("mismatched delimiters fall back verbatim instead of forming a formula", async () => {
    for (const text of ["\\(x\\]", "\\[x\\)"]) {
      assert.equal(hasMath(text), false, `${text} was read as math`);
      assert.ok(!(await html(text)).includes("katex"), `${text} produced KaTeX markup`);
    }
  });

  test("whitespace inside the delimiters is legitimate", async () => {
    for (const text of ["$ x^2 $", "\\( x^2 \\)", "$$ x^2 $$", "\\[ x^2 \\]"]) {
      assert.equal(hasMath(text), true, `${text} lost its formula`);
      assert.equal(mathSpans(await html(text)) + blockSpans(await html(text)), 1, text);
    }
    // …but a space-padded pair is still not an amount.
    for (const text of ["$5 and $10", "100$ 到 200$", "价格 $5 $ 起"]) {
      assert.equal(hasMath(text), false, `${text} was read as math`);
    }
  });

  test("an explicit delimiter makes a bare number mathematics", async () => {
    for (const text of ["\\(5\\)", "\\[5\\]", "$$5$$"]) {
      assert.equal(hasMath(text), true, `${text} should be typeset`);
      assert.ok((await html(text)).includes("katex"), `${text} produced no KaTeX`);
    }
    // A single-dollar number stays an amount.
    assert.equal(hasMath("$5$"), false);
    assert.equal(hasMath("价格 $5$ 起"), false);
  });
});

// ---------------------------------------------------------------------------------------------
// The render points themselves: a field is only covered if the component renders it
// ---------------------------------------------------------------------------------------------
describe("render points", () => {
  const item = (over: Partial<FeedItemSummary> = {}): FeedItemSummary => ({
    id: "i1", title: "标题", summary: null, reason: null, publishedAt: null, timelineAt: "2026-10-07T00:00:00.000Z",
    category: "research", tags: [], score: null, selected: false, channel: "news",
    source: { name: "源", iconUrl: null, iconSrcSet: null }, x: null, ...over,
  } as unknown as FeedItemSummary);

  const feed = async (over: Record<string, unknown> = {}) => {
    const { FeedItem } = await load("/app/features/feed/FeedItem.tsx");
    return routed(el(FeedItem, { item: item(over) }));
  };

  test("feed card: the Chinese title renders as a formula", async () => {
    const out = await feed({ title: "$\\alpha$ 衰减观测" });
    assert.equal(mathSpans(out), 1);
    assert.ok(!out.includes("$\\alpha$"));
  });

  test("feed card: the English original title renders too", async () => {
    assert.equal(mathSpans(await feed({ title: "Observing $\\alpha$ decay" })), 1);
  });

  test("feed card: a standing formula in a title stays inside the heading", async () => {
    const out = await feed({ title: "$$\\frac{a}{b}$$ 结论" });
    assert.equal(blockSpans(out), 1);
    // The point of the check: the heading holds a span, never a block element that would break the page.
    const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(out)?.[1] ?? "";
    assert.ok(heading.includes("math-block"), "the standing formula is in the heading");
    assert.ok(!/<div|<p[ />]/.test(heading), "no block element inside the heading");
  });

  test("feed card: the summary renders", async () => {
    assert.equal(mathSpans(await feed({ summary: "摘要含 $\\beta$ 值" })), 1);
  });

  test("feed card: the recommendation reason renders", async () => {
    assert.equal(mathSpans(await feed({ reason: "推荐理由含 $\\gamma$" })), 1);
  });

  test("feed card: the X post text and the post it quotes both render", async () => {
    const out = await feed({
      channel: "x",
      summary: "原文含 $\\delta$",
      x: { authorName: "A", handle: "a", avatarUrl: null, avatarSrcSet: null, media: [], quoted: { authorName: "B", handle: "b", text: "quoted $\\epsilon$", translation: null } },
    } as Record<string, unknown>);
    assert.equal(mathSpans(out), 2, "the post and the quoted post");
  });

  test("hot strip: the ranked title renders", async () => {
    const { HotTopics } = await load("/app/features/feed/HotTopics.tsx");
    const out = routed(el(HotTopics, { entries: [{ rank: 1, title: "热点 $\\zeta$", heat: 90, trend: "up", storyPublicId: "s1", itemId: "i1", participants: [], participantCount: 2 }] }));
    assert.equal(mathSpans(out), 1);
  });

  test("arXiv page: the Chinese title, the English original and the summary all render", async () => {
    const { ArxivPageContent } = await load("/app/routes/arxiv.tsx");
    const out = routed(el(ArxivPageContent, {
      category: null,
      feed: {
        page: 1, pageSize: 20, total: 1, latestBatch: null,
        items: [{
          paper_key: "p1", arxiv_id: "2601.00001", url: "https://arxiv.org/abs/2601.00001",
          title_zh: "中文标题 $\\eta$", title_original: "English $\\eta$ title",
          summary_zh: "摘要含 $\\theta$", study_type: "theory",
          categories: ["astro-ph.GA"], submitted_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
        }],
      },
    } as never));
    assert.equal(mathSpans(out), 3, "zh title, en title, summary");
  });

  test("quoted evidence: the line on a card and the block on the item page both render", async () => {
    const { QuotedLine, QuotedPost } = await load("/app/features/item/QuotedPost.tsx");
    const quoted = { authorName: "B", handle: "b", text: "quoted $\\kappa$", translation: "引用 $\\lambda$", url: null };
    assert.equal(mathSpans(routed(el(QuotedLine, { quoted }))), 1);
    assert.equal(mathSpans(routed(el(QuotedPost, { quoted }))), 2, "translation and original");
  });

  test("event follow-ups render on the server without fetching", async () => {
    const { StoryFollowups } = await load("/app/features/item/StoryFollowups.tsx");
    const out = routed(el(StoryFollowups, { currentId: "i1", story: { publicId: "s1", title: "事件" } }));
    assert.equal(typeof out, "string");
  });
});

// ---------------------------------------------------------------------------------------------
// The report (日报/周报/月报), the event page, the ranking, imagery, calendar, topics
// ---------------------------------------------------------------------------------------------
describe("reports, events and the other reader pages", () => {
  const citation = (over: Record<string, unknown> = {}) => ({
    itemId: "i1", title: "报道 $\\theta$", summary: "报道摘要 $\\iota$", sourceName: "源",
    sourceUrl: "https://a.test/x", sourceIconUrl: null, firstParty: false,
    publishedAt: "2026-10-07T00:00:00.000Z", available: true, ...over,
  });
  const report = (over: Record<string, unknown> = {}) => ({
    kind: "daily", key: "2026-10-07", issueNumber: 300, title: "日报", generatedAt: "2026-10-07T08:00:00.000Z",
    lead: { title: "头条 $\\kappa$", leadParagraph: "导读段落 $\\lambda$" },
    leadItemId: "i1", overview: "本期导读 $\\mu$",
    // Distinct item ids: a report shows each citation once, so reusing one would drop the others.
    highlights: [citation({ itemId: "i2", title: "看点 $\\nu$" })],
    sections: [
      { label: "版名 $\\xi$", summary: "本版导读 $\\omicron$", items: [citation({ itemId: "i3", title: "版内 $\\rho$" })] },
    ],
    flashes: [citation({ itemId: "i4", title: "快讯 $\\pi$" })],
    cover: null, metrics: {}, readingMinutes: 5, prev: "2026-10-06", next: "2026-10-08",
    ...over,
  });

  const paper = async (over: Record<string, unknown> = {}) => {
    const { ReportPaper } = await load("/app/features/report/ReportPaper.tsx");
    return routed(el(ReportPaper, { report: report(over), index: [] }));
  };
  /** What a reader actually sees: attributes and the MathML annotation are not on the page. */
  const visible = (markup: string) =>
    markup.replace(/<annotation[\s\S]*?<\/annotation>/g, "").replace(/<[^>]+>/g, "");

  test("report: the front-page headline, its paragraph and the overview render", async () => {
    const out = visible(await paper());
    for (const src of ["\\kappa", "\\lambda", "\\mu", "\\nu"]) {
      assert.ok(!out.includes(src), `${src} is still raw on the page`);
    }
    assert.ok(mathSpans(await paper()) >= 4, "the front page carries several formulas");
  });

  test("report: a story's headline and summary render", async () => {
    const out = visible(await paper());
    assert.ok(!out.includes("\\theta"), "the story headline is typeset");
    assert.ok(!out.includes("\\iota"), "the story summary is typeset");
    assert.ok(!out.includes("\\rho"), "the section's own story is typeset");
  });

  test("report: the highlights and the flashes render", async () => {
    const out = visible(await paper());
    assert.ok(!out.includes("\\nu"), "the highlight title is typeset");
    assert.ok(!out.includes("\\pi"), "the flash title is typeset");
  });

  test("report: the section label and its intro render", async () => {
    const out = visible(await paper());
    assert.ok(!out.includes("\\xi"), "the section label is typeset");
    assert.ok(!out.includes("\\omicron"), "the section intro is typeset");
  });

  test("report: a standing formula in a headline stays a span", async () => {
    const out = await paper({ lead: { title: "$$\\frac{a}{b}$$ 头条", leadParagraph: "无" } });
    assert.ok(blockSpans(out) >= 1, "the standing formula is typeset as a block");
    // A standing formula must not put a block element inside a heading; the paper's own divs are fine.
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(out)?.[1] ?? "";
    assert.ok(heading.includes("math-block"), "the standing formula is in the headline");
    assert.ok(!/<div|<p[ />]/.test(heading), "no block element inside the headline");
  });

  test("report navigation: an issue's title in the archive list renders", async () => {
    const { ReportArchive } = await load("/app/features/report/ReportNav.tsx");
    const out = routed(el(ReportArchive, {
      kind: "daily", current: "2026-10-06",
      index: [{ key: "2026-10-07", issueNumber: 300, title: "本期 $\\sigma$", at: "2026-10-07T08:00:00.000Z" }],
    }));
    assert.ok(mathSpans(out) >= 1, "the issue title is typeset");
  });

  test("imagery card: the Chinese and English titles render", async () => {
    const { ImageryCard } = await load("/app/features/imagery/ImageryCard.tsx");
    const base = {
      id: "m1", sourceDate: "2026-10-05", titleEn: "English $\\sigma$", titleZh: "中文 $\\sigma$",
      explanationEn: "en $\\tau$", explanationZh: "中文 $\\upsilon$", altEn: "alt", imageUrl: null,
      mediaUrl: null, mediaKind: null, translationStatus: "ready", sourceUrl: "https://a.test", copyright: null,
    };
    const card = await routed(el(ImageryCard, { item: base, onOpen: () => {} }));
    assert.ok(mathSpans(card) >= 2, "both titles render");
    // The aria-label keeps the source (an attribute has nowhere to put a formula); the visible text does not.
    assert.ok(!visible(card).includes("\\sigma"), "the titles are typeset");
  });

  test("imagery detail: title and both explanations render", async () => {
    const { ImageryDetail } = await load("/app/features/imagery/ImageryDetail.tsx");
    const out = routed(el(ImageryDetail, {
      item: {
        id: "m1", sourceDate: "2026-10-05", titleEn: "English $\\sigma$", titleZh: "中文 $\\tau$",
        explanationEn: "en $\\upsilon$", explanationZh: "中文 $\\phi$", altEn: "alt", imageUrl: null,
        mediaUrl: null, mediaKind: null, translationStatus: "ready", sourceUrl: "https://a.test", copyright: null,
      },
    }));
    assert.equal(mathSpans(out), 4, "zh title, en title, zh explanation, en explanation");
  });

  test("calendar dialog: the event's title and description render", async () => {
    const { CalendarDialog } = await load("/app/features/calendar/CalendarDialog.tsx");
    const out = routed(el(CalendarDialog, {
      item: { id: "e1", date: "20261007", title: "天象 $\\chi$", description: "说明 $\\psi$" },
      onClose: () => {}, returnFocusTo: null,
    }));
    assert.equal(mathSpans(out), 2, "title and description");
  });

  test("topic list card: the latest title or the definition renders", async () => {
    const { TopicCard } = await load("/app/routes/topics.tsx");
    // The card itself, not the route: rendering the route needs a loader and a data router.
    const out = routed(el(TopicCard, {
      t: {
        slug: "t", name: "主题 $\\omega$", group: "g", definition: "定义 $\\varrho$", brand: null,
        indexable: true, total: 1, recent: 1, poolTotal: 1,
        latest: { title: "最新 $\\varsigma$", at: "2026-10-07T00:00:00.000Z" },
      },
    }));
    assert.equal(mathSpans(out), 2, "the topic name and its latest title");
  });

  test("topic list card: with no latest entry it shows the definition instead", async () => {
    const { TopicCard } = await load("/app/routes/topics.tsx");
    const out = routed(el(TopicCard, {
      t: {
        slug: "t", name: "主题", group: "g", definition: "定义 $\\varrho$", brand: null,
        indexable: true, total: 1, recent: 0, poolTotal: 1, latest: null,
      },
    }));
    assert.equal(mathSpans(out), 1, "the definition renders in place of the latest title");
  });
});
