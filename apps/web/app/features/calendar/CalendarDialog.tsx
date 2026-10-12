import { useEffect, useId, useRef } from "react";
import type { CalendarEvent } from "./Calendar";
import { closeCalendarBackdrop, openCalendarDialog } from "./dialog";
import { MathText } from "../../components/MathText";

export function CalendarDialog({ item, onClose, returnFocusTo }: { item: CalendarEvent; onClose: () => void; returnFocusTo: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => openCalendarDialog(dialog.current!, returnFocusTo), [returnFocusTo]);
  return <dialog ref={dialog} aria-labelledby={titleId} onClose={onClose} onClick={event => closeCalendarBackdrop(event.currentTarget, event)} className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-card border border-line bg-surface p-5 text-left text-ink shadow-xl backdrop:bg-black/65 sm:p-6 [overflow-wrap:anywhere]">
    <h2 id={titleId} className="text-xl font-semibold leading-8"><MathText text={item.title} /></h2>
    <p className="mt-2 text-sm text-ink-3">{item.date.slice(0, 4)}-{item.date.slice(4, 6)}-{item.date.slice(6)} · 来源：合成示例数据</p>
    {item.description !== "" && <p data-event-description="" className="mt-4 whitespace-pre-wrap text-sm leading-7 text-ink-2"><MathText text={item.description} /></p>}
    <button type="button" autoFocus aria-label="关闭详情" onClick={() => dialog.current?.close()} className="mt-5 min-h-11 min-w-11 rounded-control border border-line px-4 text-sm hover:bg-bg-sunk">关闭 ×</button>
  </dialog>;
}
