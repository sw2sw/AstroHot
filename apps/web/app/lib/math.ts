// One LaTeX parser and one KaTeX configuration for the whole site. Every reader-facing string that may
// carry a formula — titles, summaries, reasons, quoted evidence, report copy, article bodies — is split
// here and rendered by <MathText> (React) or renderMathHtml / renderMathInMarkup (markup we produced
// ourselves). No page writes a parser of its own.
//
// Grammar, in the order it is recognised:
//   $$…$$  and  \[…\]   a formula standing on its own (may span lines)
//   $…$    and  \(…\)   a formula inside a sentence (one line)
// Display delimiters are taken first, so a display formula never loses its outer pair to the inline rule.
//
// What is deliberately NOT math: prices (`$5 and $10`, `100$ 到 200$`), escaped dollars (`\$`), URLs,
// inline code and fenced code blocks. Text with no formula comes back byte-for-byte unchanged, and so
// does a formula KaTeX cannot parse — a wrong rendering is worse than the source.
import katex from "katex";

export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; latex: string; html: string; display: boolean };

/** Past this length a "$…$" run is prose we misread, not a formula worth typesetting. */
const MAX_SOURCE = 2000;
/** KaTeX's own guards: cap macro expansion, and the em size any single command may ask for. */
const KATEX_LIMITS = { maxExpand: 1000, maxSize: 20 } as const;

const CJK = /[⺀-鿿　-〿＀-￯]/;
/**
 * Text-bearing LaTeX commands. CJK inside one of these is content the author meant to set
 * (\text{观测波段}), so it must not disqualify the formula; CJK anywhere else is prose between dollars.
 */
const TEXT_ARG =
  /\\(?:text|textbf|textit|textnormal|textrm|mathrm|mathbf|mathit|mathcal|mathbb|mathfrak|mathsf|mathtt|mbox|href|url|operatorname|label)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g;

interface Span {
  start: number;
  end: number;
}

/** Regions whose text is never typeset, earliest match first. */
const PROTECTED: ReadonlyArray<readonly [RegExp, string]> = [
  // Fenced code, then inline code: both hold command characters that are not ours to interpret.
  [/```[\s\S]*?(?:```|$)/g, "code"],
  [/`[^`\n]*`/g, "code"],
  // An address, with or without a scheme. A formula inside one is part of the address.
  [/(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi, "url"],
  // `\$5` is an escaped dollar: not a delimiter, and not a backslash in the output either.
  [/\\\$/g, "escape"],
];

/**
 * Commands KaTeX only honours when `trust` is on. They are refused here rather than typeset as KaTeX's red
 * "rejected source": a formula that asks for a link, an image or a raw attribute is not something to show
 * as if it had worked, and it keeps those strings out of the page entirely.
 */
const UNTRUSTED = /\\(?:href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData|includehtml|link|class|style|data|def|let|newenvironment|input|catcode|char|verb)\b/;

/**
 * Which pair of delimiters opened a formula. `$…$` is the ambiguous one — that same character is a
 * currency symbol — so the guesses about bare numbers and neighbouring digits apply to it alone.
 * `\(…\)`, `$$…$$` and `\[…\]` are unambiguous statements of intent.
 */
type Delim = "inline" | "paren" | "display" | "bracket";

const isMathSource = (latex: string, delim: Delim, before: string, after: string): boolean => {
  const source = latex.trim();
  const display = delim === "display" || delim === "bracket";
  if (!source || source.length > MAX_SOURCE) return false;
  // A standing formula is written across lines; a running one is not.
  if (!display && delim !== "paren" && /[\n\r]/.test(latex)) return false;
  if (UNTRUSTED.test(source)) return false;
  // CJK inside a text command (\text{观测波段}) is content the author meant to set; CJK anywhere else is
  // prose that happened to sit between two dollars, such as a price range: `100$ 到 200$`.
  if (CJK.test(source.replace(TEXT_ARG, ""))) return false;
  // Space inside the delimiters is a writer's habit, not a decision: `$ x^2 $` is the same formula as
  // `$x^2$`. What follows is only about telling a single `$` used as currency from one used as a delimiter.
  if (delim === "inline") {
    // A bare number between single dollars is money far more often than mathematics (`$5$`, `$1,200$`).
    // Between explicit delimiters it is unambiguous, so `\(5\)`, `$$5$$` and `\[5\]` are typeset.
    if (/^[\d.,\s]+$/.test(source)) return false;
    // A digit against either delimiter makes the pair an amount: `$5 and $10`, `100$ 到 200$`.
    if (/\d$/.test(before) || /^\d/.test(after)) return false;
  }
  return true;
};

/** KaTeX's HTML for one source, or null when it is not something we can typeset. */
function render(latex: string, display: boolean): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      // trust stays off: \href, \url, \includegraphics, \htmlClass and friends come out as their own
      // rejected source — never a link, an image or an attribute.
      trust: false,
      // MathML for screen readers with the visual HTML beside it (KaTeX's default, named on purpose:
      // it is what carries the formula to assistive technology instead of to a sighted reader only).
      output: "htmlAndMathml",
      throwOnError: true,
      ...KATEX_LIMITS,
    });
  } catch {
    return null;
  }
}

/** Ranges of `text` that no delimiter pair may overlap. */
function protectedRanges(text: string): Span[] {
  const ranges: Span[] = [];
  for (const [pattern] of PROTECTED) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) ranges.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Every delimiter pair, in source order. `\(`…`\)` and `\[`…`\]` first, then `$$…$$`, then `$…$`;
 * a pair landing inside one already taken is dropped rather than allowed to interleave.
 *
 * Each backslash form is matched with its own closer, never with the other's: `\(x\]` and `\[x\)` are
 * mismatched and must stay text, so they are not a candidate pair at all here.
 */
function delimiterPairs(text: string): Array<Span & { latex: string; display: boolean; delim: Delim }> {
  const taken: Span[] = [];
  const pairs: Array<Span & { latex: string; display: boolean; delim: Delim }> = [];
  const clashes = (s: Span) => taken.some((t) => s.start < t.end && t.start < s.end);
  const add = (m: RegExpExecArray, latex: string, delim: Delim) => {
    const display = delim === "display" || delim === "bracket";
    const span = { start: m.index, end: m.index + m[0].length, latex, display, delim };
    if (clashes(span)) return;
    taken.push(span);
    pairs.push(span);
  };
  // Any intervening slash delimiter ends this attempt, including a wrong closer or
  // a fresh opener. The regex can then retry at that later opener without losing it.
  for (const m of text.matchAll(/\\\(((?:(?!\\[()[\]])[\s\S])*?)\\\)/g)) add(m, m[1]!, "paren");
  for (const m of text.matchAll(/\\\[((?:(?!\\[()[\]])[\s\S])*?)\\\]/g)) add(m, m[1]!, "bracket");
  for (const m of text.matchAll(/\$\$([\s\S]+?)\$\$/g)) add(m, m[1]!, "display");
  for (const m of text.matchAll(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g)) add(m, m[1]!, "inline");
  return pairs.sort((a, b) => a.start - b.start);
}

/**
 * `text` as alternating plain and formula segments. A pair that is not a formula (a price range), or one
 * KaTeX refuses, stays text; the scan then carries on past it instead of abandoning the rest of the string.
 */
export function splitMath(text: string, escapedMarkup = false): MathSegment[] {
  if (!text) return [];
  const blocked = protectedRanges(text);
  const free = (s: Span) => !blocked.some((b) => s.start < b.end && b.start < s.end);
  const segments: MathSegment[] = [];
  let last = 0;
  // Pair only within unprotected runs: a dollar in code, a URL or an escape must never
  // consume the opener of a later formula. Keep original offsets and fallback bytes.
  const pairs: ReturnType<typeof delimiterPairs> = [];
  let cursor = 0;
  for (const range of [...blocked, { start: text.length, end: text.length }]) {
    if (range.start > cursor) {
      for (const pair of delimiterPairs(text.slice(cursor, range.start))) {
        pairs.push({ ...pair, start: pair.start + cursor, end: pair.end + cursor });
      }
    }
    cursor = Math.max(cursor, range.end);
  }
  for (const pair of pairs) {
    // The characters touching the delimiters, and only those: a digit further along the sentence says
    // nothing about this pair.
    const before = text[pair.start - 1] ?? "";
    const after = text[pair.end] ?? "";
    const latex = escapedMarkup ? decodeMarkupSource(pair.latex) : pair.latex;
    if (pair.start < last || !free(pair) || !isMathSource(latex, pair.delim, before, after)) continue;
    const html = render(latex, pair.display);
    if (html === null) continue;
    if (pair.start > last) segments.push({ kind: "text", text: text.slice(last, pair.start) });
    segments.push({ kind: "math", latex, html, display: pair.display });
    last = pair.end;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** True when `text` holds at least one formula we can actually typeset. */
export const hasMath = (text: string): boolean => splitMath(text).some((s) => s.kind === "math");

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as const;
const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c as keyof typeof ESCAPES]);

/**
 * The same split as HTML. Plain text is escaped here, so callers may pass untrusted source; only KaTeX's
 * own output is markup. A display formula is a `<span>` that CSS makes a block, so typesetting a formula
 * never puts a `<div>` inside a `<p>`, a heading or a list item.
 */
export function renderMathHtml(text: string): string {
  return renderSegments(splitMath(text), true);
}

/** `escape` is false where the text came out of markup already (see renderMathInMarkup). */
function renderSegments(parts: MathSegment[], escapeText: boolean): string {
  return parts
    .map((s) =>
      s.kind === "text"
        ? escapeText
          ? escape(s.text)
          : s.text
        : `<span class="${s.display ? "math-block" : "math-inline"}">${s.html}</span>`,
    )
    .join("");
}

/**
 * Elements whose text is left exactly as it is: code, preformatted text, and anything the browser does
 * not show as prose. A link is deliberately *not* here: its address lives in an attribute, which the
 * walk below never touches, while its visible label is ordinary reader-facing text and is typeset like
 * any other.
 */
const OPAQUE = new Set(["code", "kbd", "pre", "samp", "script", "style", "textarea"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

// Decode only formula sources, not surrounding escaped prose or attributes.
function decodeMarkupSource(source: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return source.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return named[name.toLowerCase()] ?? entity;
    const value = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

/**
 * Math for markup this site produced itself (sanitised article bodies, the site's own Markdown): every
 * text node is typeset, everything inside opaque elements such as code and pre is untouched. It walks the markup string
 * rather than the live page, so the result is the same on the server and after hydration, with no
 * dependence on script having run. Text nodes are already escaped here, so they are not escaped again.
 */
export function renderMathInMarkup(html: string): string {
  const out: string[] = [];
  // Start of the run of markup not yet copied, and the element whose text we are inside ("" for none).
  let cursor = 0;
  let opaque = "";
  const flush = (to: number) => {
    const chunk = html.slice(cursor, to);
    out.push(opaque || !chunk ? chunk : renderSegments(splitMath(chunk, true), false));
  };
  for (const m of html.matchAll(TAG)) {
    const [tag, slash, name] = m;
    const lower = name.toLowerCase();
    const closing = slash === "/";
    // Inside opaque elements the markup is copied through whole, tags included.
    if (opaque && !(closing && lower === opaque)) continue;
    flush(m.index!);
    out.push(tag);
    cursor = m.index! + tag.length;
    if (opaque) opaque = "";
    else if (!closing && !tag.endsWith("/>") && OPAQUE.has(lower)) opaque = lower;
  }
  flush(html.length);
  return out.join("");
}
