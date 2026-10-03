/**
 * 日期区间工具。区间均为闭区间，日期格式为 YYYY-MM-DD。
 */

const DAY_MS = 86_400_000;

function toUtcMs(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

/** 展开区间内的每一天。 */
export function listDays(period) {
  const start = toUtcMs(period.from);
  const end = toUtcMs(period.to);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    throw new Error(`非法期间：${period.from}~${period.to}`);
  }
  const days = [];
  for (let t = start; t <= end; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** 把若干天归并为有序区间列表。 */
export function mergeDays(days) {
  const sorted = [...new Set(days)].sort();
  const ranges = [];
  for (const day of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && toUtcMs(last.to) + DAY_MS === toUtcMs(day)) {
      last.to = day;
    } else {
      ranges.push({ from: day, to: day });
    }
  }
  return ranges;
}
