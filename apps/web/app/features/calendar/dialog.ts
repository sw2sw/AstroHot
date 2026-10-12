export function openCalendarDialog(dialog: Pick<HTMLDialogElement, "showModal" | "close">, opener: Pick<HTMLElement, "focus"> | null): () => void {
  dialog.showModal();
  return () => { dialog.close(); opener?.focus(); };
}

export function closeCalendarBackdrop(dialog: Pick<HTMLDialogElement, "getBoundingClientRect" | "close">, event: { target: unknown; clientX: number; clientY: number }): void {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
}
