import type { ImageryViewItem } from "./types.ts";
import { safeSourceUrl, videoMediaNote } from "./view.ts";

/** Keep this outside card buttons: the source link must remain independently actionable. */
export function ImageryMediaNote({item, centered = false}: {item: ImageryViewItem; centered?: boolean}) {
 const note = videoMediaNote(item);
 if (!note) return null;
 const href = safeSourceUrl(item.sourceUrl);
 return <p className={`text-xs font-semibold text-ink-3${centered ? " w-full px-5 pt-4 text-center" : ""}`}>（{note}{href
  ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">NASA 原文 ↗</a>
  : "NASA 原文"}）</p>;
}
