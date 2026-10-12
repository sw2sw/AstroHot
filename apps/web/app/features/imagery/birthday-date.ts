// Birthday validation is pure and calendar-exact: complete YYYY-MM-DD, real Gregorian dates
// (leap days included), bounded by the first archived picture and the current UTC date.
export const BIRTHDAY_MIN_DATE = "1995-06-16";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type BirthdayDateResult = { ok: true; date: string } | { ok: false; message: string };

/** True only for complete, real YYYY-MM-DD calendar dates; rejects zero months/days and non-leap Feb 29. */
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** Current UTC date as YYYY-MM-DD. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validate a birthday against the archive range [1995-06-16, today]. The input is never rewritten:
 * an out-of-range date is reported as-is so callers cannot silently substitute year or month/day.
 */
export function validateBirthdayDate(value: string, today: string): BirthdayDateResult {
  if (!isCalendarDate(value)) {
    return { ok: false, message: "请输入完整且真实存在的公历日期，格式为 YYYY-MM-DD，例如 2000-02-29。" };
  }
  if (value < BIRTHDAY_MIN_DATE) {
    return {
      ok: false,
      message: `天文图片档案从 ${BIRTHDAY_MIN_DATE} 开始收录，早于该日期无法查询，请改用 ${BIRTHDAY_MIN_DATE} 或之后的日期。`,
    };
  }
  if (value > today) {
    return { ok: false, message: "这是未来的日期，还没有对应的档案，请输入今天或更早的日期。" };
  }
  return { ok: true, date: value };
}
