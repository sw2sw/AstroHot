const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST = '1995-06-16';

export function validateApodDate(date: string, now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new Error('now 必须是有效时间');
  if (!DATE_PATTERN.test(date)) throw new Error(`日期必须是 YYYY-MM-DD 字面量：${date}`);
  const [y, m, d] = date.split('-').map(Number);
  const round = new Date(Date.UTC(y, m - 1, d)).toISOString();
  if (round !== `${date}T00:00:00.000Z`) throw new Error(`日期不是真实存在的公历日期：${date}`);
  if (date < EARLIEST) throw new Error(`日期早于最早可用日期 ${EARLIEST}：${date}`);
  if (date > now.toISOString().slice(0, 10)) throw new Error(`日期晚于当前 UTC 日期：${date}`);
  return date;
}
