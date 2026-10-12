import type { NewsThumbnail } from "@aihot/contracts/site";

/**
 * The approved news card image, on the article page: uncropped, never taller than the screen, with
 * the caption and credit exactly as the image review approved them.
 */
export function NewsImage({ image, title }: { image: NewsThumbnail | null | undefined; title: string }) {
  if (!image) return null;
  const caption = typeof image.caption === "string" ? image.caption.trim() : "";
  const credit = typeof image.credit === "string" ? image.credit.trim() : "";
  return (
    <figure className="mt-7">
      <img
        src={image.fullUrl ?? image.url}
        srcSet={image.srcSet}
        sizes="(min-width: 1280px) 44rem, 100vw"
        alt={image.alt ?? title}
        width={image.width ?? undefined}
        height={image.height ?? undefined}
        loading="eager"
        decoding="async"
        className="mx-auto max-h-[70vh] w-auto max-w-full object-contain"
      />
      {(caption || credit || image.attributionUrl) && (
        <figcaption className="mt-2 text-[12px] leading-relaxed text-ink-3">
          {[caption, credit].filter(Boolean).join(" · ")}
          {image.attributionUrl && (
            <>
              {(caption || credit) && <span> · </span>}
              <a href={image.attributionUrl} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-accent">
                图源
              </a>
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}
