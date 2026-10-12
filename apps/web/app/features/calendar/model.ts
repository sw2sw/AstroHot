export type CalendarState = { month: string; date: string };
export type CalendarAction = { type: "move"; offset: number } | { type: "select"; date: string } | { type: "today"; now?: Date };

export function calendarState(state: CalendarState, action: CalendarAction): CalendarState {
  if (action.type === "today") {
    const date = shanghaiDate(action.now);
    return { month: date.slice(0, 6), date };
  }
  if (action.type === "select") return { month: action.date.slice(0, 6), date: action.date };
  const shifted = new Date(Date.UTC(Number(state.month.slice(0, 4)), Number(state.month.slice(4, 6)) - 1 + action.offset, 1));
  const month = `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
  return { month, date: `${month}01` };
}

export function monthDays(month: string): (string | null)[] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(4, 6)) - 1;
  const offset = (new Date(Date.UTC(year, index, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, cell) => {
    const day = cell - offset + 1;
    return day < 1 || day > count ? null : `${month}${String(day).padStart(2, "0")}`;
  });
}

export function shanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("");
}

export function weekdayLabel(date: string): string {
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6)))).getUTCDay();
  return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][day];
}
