import {useEffect, useId, useRef} from "react";
import type {ImageryViewItem} from "./types.ts";
import {ImageryDetail} from "./ImageryDetail.tsx";

/** 原生模态负责焦点锁定与 Escape；关闭后回到打开它的控件。 */
export function ImageryDialog({item,kind,onClose,returnFocusTo}: {item: ImageryViewItem; kind: "birthday"|"archive"; onClose: () => void; returnFocusTo?: HTMLElement|null}) {
 const dialog = useRef<HTMLDialogElement>(null);
 const headingId = useId();
 useEffect(()=>{
  const element = dialog.current!;
  const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  element.showModal();
  return ()=>{element.close(); opener?.focus();};
 },[]);
 return <dialog ref={dialog} aria-labelledby={headingId} onClose={onClose} onClick={event=>{
  if(event.target !== event.currentTarget) return;
  const bounds=event.currentTarget.getBoundingClientRect();
  if(event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
 }} className="fixed inset-0 m-auto max-h-[94dvh] w-[calc(100%_-_1rem)] max-w-5xl overflow-y-auto rounded-card border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/65 sm:w-[calc(100%_-_3rem)]">
  <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2">
   <h2 id={headingId} className="font-semibold">{kind === "birthday" ? "生日宇宙" : "影像详情"} <span className="num text-sm font-normal text-ink-4">· {item.sourceDate}</span></h2>
   <button type="button" autoFocus aria-label="关闭详情" onClick={()=>dialog.current?.close()} className="min-h-11 min-w-11 rounded-full px-3 text-sm hover:bg-bg-sunk">关闭 ×</button>
  </div>
  <ImageryDetail item={item}/>
 </dialog>;
}
