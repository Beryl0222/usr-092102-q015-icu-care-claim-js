/**
 * 日历日区间工具。区间一律为闭区间 [start, end]，参数为 YYYY-MM-DD。
 * 全部为纯函数，便于计算引擎与重放审计复用。
 */

/** @param {string} date YYYY-MM-DD */
export function toDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法日期：${date}`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`非法日期：${date}`);
  return Math.floor(ms / 86_400_000);
}

export function fromDay(day) {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** 闭区间天数（首尾各计一天） */
export function days(start, end) {
  const a = toDay(start);
  const b = toDay(end);
  if (b < a) throw new Error(`区间反转：${start} > ${end}`);
  return b - a + 1;
}

export function isBeforeOrEqual(a, b) {
  return toDay(a) <= toDay(b);
}

/** 两闭区间是否相交 */
export function overlaps(p, q) {
  return toDay(p.start) <= toDay(q.end) && toDay(q.start) <= toDay(p.end);
}

/** 区间交集，无交集返回 null */
export function intersection(p, q) {
  if (!overlaps(p, q)) return null;
  const start = fromDay(Math.max(toDay(p.start), toDay(q.start)));
  const end = fromDay(Math.min(toDay(p.end), toDay(q.end)));
  return { start, end };
}

/** 把 period 限制在 bounds 内，无交集返回 null */
export function clamp(period, bounds) {
  return intersection(period, bounds);
}

/** 区间是否落在 bounds 内 */
export function containedIn(period, bounds) {
  return toDay(period.start) >= toDay(bounds.start) && toDay(period.end) <= toDay(bounds.end);
}

/**
 * 拆分 periods：返回每段区间及其“重叠层级”。
 * 用于检测同一伤者同日是否出现两条以上生活照护主张。
 */
export function overlapGroups(periods) {
  return periods.filter((p) => periods.some((q) => q !== p && overlaps(p, q)));
}

/** 合并相交或首尾相接的区间 */
export function merge(periods) {
  const sorted = [...periods].sort((a, b) => toDay(a.start) - toDay(b.start));
  const out = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && toDay(p.start) <= toDay(last.end) + 1) {
      last.end = fromDay(Math.max(toDay(last.end), toDay(p.end)));
    } else {
      out.push({ start: p.start, end: p.end });
    }
  }
  return out;
}

/** 计算若干区间的并集天数（重叠日只计一次） */
export function coveredDays(periods) {
  return merge(periods).reduce((sum, p) => sum + days(p.start, p.end), 0);
}

/** 从 covered 中挖去 holes，返回剩余不相交区间（按 UTC 日历日） */
export function subtract(covered, holes) {
  const mergedHoles = merge(holes.filter(Boolean));
  let fragments = [covered];
  for (const hole of mergedHoles) {
    const next = [];
    for (const frag of fragments) {
      if (!overlaps(frag, hole)) {
        next.push(frag);
        continue;
      }
      if (toDay(hole.start) > toDay(frag.start)) {
        next.push({ start: frag.start, end: fromDay(Math.min(toDay(frag.end), toDay(hole.start) - 1)) });
      }
      if (toDay(hole.end) < toDay(frag.end)) {
        next.push({ start: fromDay(Math.max(toDay(frag.start), toDay(hole.end) + 1)), end: frag.end });
      }
    }
    fragments = next;
  }
  return fragments;
}
