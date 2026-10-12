// A reader-facing string with LaTeX in it: the title on a card, a summary, a reason, a piece of quoted
// evidence, a line of a report. Split by lib/math.ts and rendered with KaTeX; anything that is not a
// formula stays text, so a page without formulas reads exactly as it did before.
//
// Pure and deterministic from its `text`, which is what lets the server and the browser agree (no
// hydration mismatch) and lets a test assert on the markup.
import { Fragment, createElement } from "react";
import { splitMath } from "../lib/math.ts";

export interface MathTextProps {
  text: string;
  /** Wrapping element. `inline` (the default) adds nothing, so a formula can sit inside a heading. */
  as?: "span" | "p" | "div";
  className?: string;
}

/**
 * One formula in the element CSS knows: `.math-inline` flows with the line, `.math-block` takes its own
 * line and scrolls sideways rather than widening the card, the heading or the phone.
 */
export function Formula({ html, display }: { html: string; display: boolean }) {
  return <span className={display ? "math-block" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MathText({ text, as, className }: MathTextProps) {
  // Keys are indexes: the parts are a stateless, deterministic split of one string.
  const parts = splitMath(text ?? "").map((part, index) =>
    part.kind === "text" ? (
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <Formula key={index} html={part.html} display={part.display} />
    ),
  );
  if (!as) return <>{parts}</>;
  return createElement(as, { className }, parts);
}
