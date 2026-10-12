import { weekdayShort } from "../../lib/format";
import { splitMath } from "../../lib/math.ts";
import { Formula } from "../../components/MathText.tsx";

/** Release notes carry a little Markdown: **bold** runs, and LaTeX now that the site renders formulas. */
export function Inline({ text }: { text: string }) {
  // Release notes carry **bold** and, since the site renders formulas everywhere, LaTeX too.
  return (
    <>
      {splitMath(text).map((part, i) =>
        part.kind === "math" ? (
          <Formula key={i} html={part.html} display={part.display} />
        ) : (
          part.text.split(/\*\*(.+?)\*\*/g).map((chunk, j) =>
            j % 2 ? <b key={`${i}-${j}`} className="font-semibold text-ink-2">{chunk}</b> : chunk,
          )
        ),
      )}
    </>
  );
}

export function dateHeading(date: string): { label: string; weekday: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { label: `${y} 年 ${m} 月 ${d} 日`, weekday: weekdayShort(date) };
}
