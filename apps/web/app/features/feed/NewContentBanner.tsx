import type { MouseEvent } from "react";

/**
 * The compact prompt: one button, top of the list, keyboard reachable, no counts shown. The
 * `role="status"` lives on the WRAPPER so the button keeps its native button semantics for
 * assistive tech; the status region announces the prompt without overriding the role.
 */
export function NewContentBanner({ visible, updating = false, error = false, onClick }: {
  visible: boolean;
  /** A click's update request is running: the button is disabled until it settles. */
  updating?: boolean;
  /** The last update attempt failed: the prompt stays up and doubles as the retry entry. */
  error?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  if (!visible) return null;
  return (
    <div role="status" className="mb-3 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        disabled={updating}
        className="h-9 rounded-full border border-accent/40 bg-accent/10 px-4 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-60"
      >
        {updating ? "正在更新…" : error ? "更新失败，点击重试" : "有新内容，点击更新"}
      </button>
    </div>
  );
}
