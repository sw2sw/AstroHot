// The AI4S column's bilingual limited intro: the Chinese intro beside the excerpt the source itself
// published (its own official abstract, or a readable fragment of a page that states a limit) on wide
// screens (lg:grid-cols-2), stacked on phones. Used only for AI4S; the astronomy detail keeps its own
// single-column summary. The side panel's heading names what the text really is — the server sends that
// label with the text and never sends a stored body here. Both sides go through the site's math renderer.
import { MathText } from "../../components/MathText";

export function Ai4sIntro({ summary, originalAbstract, originalLabel, label }: {
  summary: string;
  originalAbstract: string | null;
  originalLabel?: string | null;
  label: string;
}) {
  return (
    <section className="mt-7 xl:mt-8">
      <div className="mb-2 text-[12px] font-semibold text-accent">{label}</div>
      {originalAbstract ? (
        <div className="grid gap-5 lg:grid-cols-2 lg:gap-8">
          <p className="min-w-0 text-[18px] leading-[1.7] text-ink xl:text-[20px] xl:leading-[1.7]"><MathText text={summary} /></p>
          <div lang="en" className="min-w-0 border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <div className="mb-2 text-[12px] font-semibold text-ink-3">{originalLabel ?? "原文"}</div>
            <p className="text-[15px] leading-[1.7] text-ink-2"><MathText text={originalAbstract} /></p>
          </div>
        </div>
      ) : (
        <p className="text-[18px] leading-[1.7] text-ink xl:text-[20px] xl:leading-[1.7]"><MathText text={summary} /></p>
      )}
    </section>
  );
}