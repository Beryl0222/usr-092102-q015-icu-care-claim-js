/**
 * 规范化 JSON 与快照哈希。
 * 对象键递归排序、数组保序，保证同一事实状态在任何机器上
 * 重放得到同一哈希。
 */

import { createHash } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function snapshotHash({ input_seq, rule_version, calculation }) {
  return createHash("sha256").update(stableStringify({ input_seq, rule_version, calculation })).digest("hex");
}
