import type { ImageryViewItem } from "./types.ts";
import { MathText } from "../../components/MathText.tsx";
import { ImageryRights } from "./ImageryRights.tsx";
import { ImageryMediaNote } from "./ImageryMediaNote.tsx";
import { mediaPlaceholder, safeImageUrl, safeSourceUrl, translationLabel, videoMediaNote } from "./view.ts";

export function ImageryCard({item, onOpen}: {item: ImageryViewItem; onOpen?: () => void}) {
 const imageUrl = safeImageUrl(item);
 const sourceHref = safeSourceUrl(item.sourceUrl);
 const title = item.translationStatus === "ready" && item.titleZh?.trim() ? item.titleZh : item.titleEn;
 const content = <>
  {imageUrl ? <img src={imageUrl} alt={item.altEn ?? item.titleEn} className="aspect-[4/3] max-h-80 w-full bg-bg-sunk object-contain" loading="lazy"/> : <p className="flex aspect-[4/3] items-center justify-center bg-bg-sunk p-5 text-sm text-ink-4">{videoMediaNote(item) ? "预览暂不可用" : mediaPlaceholder(item)}</p>}
  <div className="space-y-2 p-4">
   <p className="num text-xs text-ink-4">{item.sourceDate} · {item.source === "nasa-apod" ? "NASA APOD" : item.source}</p>
   <h3 className="text-lg font-semibold text-ink"><MathText text={title} /></h3>
   {title !== item.titleEn && <p lang="en" className="text-sm text-ink-3"><MathText text={item.titleEn} /></p>}
   <p className="text-xs text-ink-4">{translationLabel(item)}</p>
   {onOpen && <span className="inline-block pt-1 text-sm font-medium text-accent">查看详情 →</span>}
  </div>
 </>;
 return <article className="card flex min-w-0 flex-col overflow-hidden [overflow-wrap:anywhere]">
  {onOpen ? <button type="button" aria-label={`查看详情：${title}`} onClick={onOpen} className="block w-full text-left hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent">{content}</button> : <div>{content}</div>}
  <footer className="mt-auto space-y-3 border-t border-line px-4 py-3 text-xs text-ink-4">
   <ImageryRights item={item}/>
   <ImageryMediaNote item={item}/>
   {sourceHref && !videoMediaNote(item) && <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="inline-block min-h-8 text-accent hover:underline">NASA 原文 ↗</a>}
  </footer>
 </article>;
}
