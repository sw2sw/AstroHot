// Where the reader came from. A list card records its item id as it opens the detail; the list that
// comes back claims it and puts focus on that same card, so a keyboard reader is not dropped at the top
// of the document (or on <body>) after closing an article. Memory only, one entry: the reader can only
// be returning to the list they left.
import { useEffect } from "react";

let origin: string | null = null;

export function rememberOrigin(id: string) {
  origin = id;
}

/** Claims the pending origin once, so a later visit to the list does not steal focus. */
export function takeOrigin(): string | null {
  const pending = origin;
  origin = null;
  return pending;
}

export function focusCard(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
  const target = card?.querySelector<HTMLElement>("a[href]") ?? card;
  if (!target) return false;
  target.focus({ preventScroll: true });
  // The card the reader left comes back into view, without yanking a scroll they did not make.
  target.scrollIntoView?.({ block: "nearest" });
  return true;
}

/**
 * Restores focus to the card this reader opened, once the list has rendered it. The loader may still be
 * revalidating on the way back, so the card is looked for over a short window instead of the first paint
 * only; a card that never appears leaves focus where the browser put it rather than guessing elsewhere.
 */
export function useReturnFocus(): void {
  useEffect(() => {
    const id = takeOrigin();
    if (!id) return;
    let frames = 0;
    let raf = 0;
    const attempt = () => {
      if (focusCard(id)) return;
      frames += 1;
      if (frames < 60) raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, []);
}
