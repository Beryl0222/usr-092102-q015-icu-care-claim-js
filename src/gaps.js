/**
 * 受害方视图：缺什么证据、哪些时段获认定、金额如何形成。
 */

const CARE_KINDS = ["medical_care_item", "life_care_need", "family_standby", "administrative_act"];

/** 评估案件当前缺少的证据。 */
export function assessGaps(state, claimId) {
  const items = [...state.evidence.values()].filter((item) => item.claim_id === claimId && !item.duplicate_of);
  const kinds = new Set(items.map((item) => item.kind));
  const gaps = [];
  if (!kinds.has("hospitalization_stage")) {
    gaps.push({ code: "missing_hospitalization_stage", message: "缺少住院阶段记录" });
  }
  if (!kinds.has("life_care_need")) {
    gaps.push({ code: "missing_life_care_need", message: "缺少生活照护需求材料" });
  }
  if (!kinds.has("income_proof")) {
    gaps.push({ code: "missing_income_proof", severity: "info", message: "未提交收入证明，将按地区劳务标准计算" });
  }
  const unclassified = items.filter((item) => CARE_KINDS.includes(item.kind) && !item.classification);
  if (unclassified.length > 0) {
    gaps.push({
      code: "unclassified_evidence",
      message: `有 ${unclassified.length} 份照护材料尚未分类`,
      evidence_ids: unclassified.map((item) => item.evidence_id),
    });
  }
  return gaps;
}

/** 受害方可见的认定结果与金额形成过程（基于最新冻结快照）。 */
export function victimView(state, claimId) {
  const snapshots = [...state.snapshots.values()].filter((snapshot) => snapshot.claim_id === claimId);
  const latest = snapshots[snapshots.length - 1] ?? null;
  return {
    claim_id: claimId,
    missing_evidence: assessGaps(state, claimId),
    recognized_periods: latest?.recognized_periods ?? [],
    excluded_periods: latest?.excluded_periods ?? [],
    amount_formation: latest
      ? {
          rule_set_id: latest.rule_set_id,
          daily_standard: latest.daily_standard,
          caregiver_count: latest.caregiver_count,
          day_count: latest.day_count,
          amount: latest.amount,
          exceptions: latest.exceptions,
        }
      : null,
  };
}
