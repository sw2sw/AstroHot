import { useId, useRef, useState } from "react";
import { BIRTHDAY_MIN_DATE, isCalendarDate, utcToday, validateBirthdayDate } from "./birthday-date.ts";

/**
 * Birthday entry for "what did the sky look like that day". The component validates the date and
 * hands it to the caller's async callback — it never fetches, never navigates, and never stores,
 * logs or transmits the birthday itself. Errors stay generic; a finished or failed lookup can be
 * submitted again right away.
 *
 * Parent integration: resolve `onLookup` by POSTing `{"date"}` JSON to /api/imagery/lookup and
 * rejecting on 400/429/503 or transport failure — the component only needs resolve/reject. A null
 * item from a racing first request means "offer manual retry", so the form stays resubmittable;
 * never echo upstream error bodies into the UI.
 */
export function BirthdayLookup({
  onLookup,
  today,
}: {
  onLookup: (date: string) => Promise<void>;
  today?: string;
}) {
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const upperBound = today !== undefined && isCalendarDate(today) ? today : utcToday();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const result = validateBirthdayDate(value, upperBound);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    inFlight.current = true;
    setSubmitting(true);
    try {
      await onLookup(result.date);
    } catch {
      setError("这次查询没有完成，请稍后重试。");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-2 sm:grid-cols-[1fr_auto]" noValidate>
      <label htmlFor={fieldId} className="block text-sm font-semibold text-ink sm:col-span-2">
        选择日期
      </label>
      <input
        id={fieldId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="YYYY-MM-DD"
        maxLength={10}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        disabled={submitting}
        aria-invalid={error === null ? undefined : true}
        aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
        className="w-full rounded-(--radius-tile) border border-line bg-surface px-3 py-2 text-sm text-ink"
      />
      <p id={hintId} className="text-xs text-ink-4 sm:col-span-2 sm:row-start-3">
        输入 {BIRTHDAY_MIN_DATE} 至今天的公历日期，查询那天的天文图片。
      </p>
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-xs text-hot sm:col-span-2">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="min-h-11 w-full rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-contrast hover:bg-accent-ink disabled:opacity-45 sm:col-start-2 sm:row-start-2"
      >
        {submitting ? "正在寻找那天的宇宙…" : "查看那天的宇宙"}
      </button>
    </form>
  );
}
