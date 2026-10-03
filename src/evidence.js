import { createHash } from "node:crypto";

/** 键序稳定的序列化，用于内容哈希与快照比对。 */
export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 证据事实内容哈希：同一事故案件下内容相同的材料只归并引用，不重复计入。 */
export function factsHash(facts) {
  return createHash("sha256").update(canonicalStringify(facts)).digest("hex").slice(0, 16);
}

/** 在案件已有证据中查找内容相同的原始提交（归并引用目标）。 */
export function findDuplicate(state, claimId, kind, facts) {
  const hash = factsHash(facts);
  for (const item of state.evidence.values()) {
    if (item.claim_id !== claimId || item.kind !== kind || item.duplicate_of) continue;
    if (factsHash(item.facts) === hash) return item.evidence_id;
  }
  return null;
}
