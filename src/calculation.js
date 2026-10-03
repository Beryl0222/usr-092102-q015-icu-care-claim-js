import { canonicalStringify } from "./evidence.js";
import { listDays, mergeDays } from "./periods.js";

/**
 * 选取事故发生时有效的计算规则版本：
 * 同一地区内取 effective_from 不晚于事故日期的最新版本。
 */
export function resolveRuleSet(ruleSets, region, accidentDate) {
  const candidates = [...ruleSets.values()]
    .filter((rule) => rule.region === region && rule.effective_from <= accidentDate)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  if (candidates.length === 0) {
    throw new Error(`没有适用于 ${region} 在 ${accidentDate} 的计算规则版本`);
  }
  return candidates[0];
}

function collectDays(items, classification) {
  const days = new Map(); // day → Set<evidence_id>
  for (const item of items) {
    if (item.duplicate_of || item.classification !== classification) continue;
    const periods = item.facts?.periods ?? (item.facts?.period ? [item.facts.period] : []);
    for (const period of periods) {
      for (const day of listDays(period)) {
        if (!days.has(day)) days.set(day, new Set());
        days.get(day).add(item.evidence_id);
      }
    }
  }
  return days;
}

function mergeExcluded(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const refs = [...entry.refs].sort();
    const key = `${entry.reason}|${refs.join(",")}`;
    if (!groups.has(key)) groups.set(key, { reason: entry.reason, evidence_refs: refs, days: [] });
    groups.get(key).days.push(entry.day);
  }
  return [...groups.values()].flatMap((group) =>
    mergeDays(group.days).map((range) => ({ ...range, reason: group.reason, evidence_refs: group.evidence_refs })),
  );
}

/**
 * 计算护理费快照内容（纯函数，便于重放校验）：
 * - 医疗护理（medical_care）已计入医疗费用，与生活照护（life_care）不重复计算；
 * - 原则上一名护理人，人数例外必须引用医疗或鉴定意见；
 * - 期限上限按规则版本执行，未引用意见时超出部分截断并登记为排除时段；
 * - 重复材料（已归并引用）不参与计算。
 */
export function computeCareCalculation({ claim, evidenceItems, ruleSet, caregiverCount = 1, exceptionOpinionIds = [] }) {
  const lifeDays = collectDays(evidenceItems, "life_care");
  const medicalDays = collectDays(evidenceItems, "medical_care");

  const excluded = [];
  const recognized = [];
  for (const [day, refs] of [...lifeDays.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (medicalDays.has(day)) {
      excluded.push({ day, reason: "medical_care_covered", refs: [...medicalDays.get(day)] });
    } else {
      recognized.push({ day, refs: [...refs] });
    }
  }

  const exceptions = [];
  let capped = recognized;
  if (recognized.length > ruleSet.period_cap_days) {
    if (exceptionOpinionIds.length === 0) {
      const overflow = recognized.slice(ruleSet.period_cap_days);
      for (const item of overflow) excluded.push({ day: item.day, reason: "period_cap_exceeded", refs: item.refs });
      capped = recognized.slice(0, ruleSet.period_cap_days);
    } else {
      exceptions.push({ type: "period_cap", value: recognized.length, opinion_refs: [...exceptionOpinionIds].sort() });
    }
  }
  if (caregiverCount !== 1) {
    if (exceptionOpinionIds.length === 0) {
      throw new Error("护理人数例外必须引用医疗或鉴定意见");
    }
    exceptions.push({ type: "caregiver_count", value: caregiverCount, opinion_refs: [...exceptionOpinionIds].sort() });
  }

  const dayCount = capped.length;
  return {
    claim_id: claim.claim_id,
    rule_set_id: ruleSet.rule_set_id,
    recognized_periods: mergeDays(capped.map((item) => item.day)),
    excluded_periods: mergeExcluded(excluded),
    caregiver_count: caregiverCount,
    daily_standard: ruleSet.daily_labor_standard,
    day_count: dayCount,
    amount: dayCount * ruleSet.daily_labor_standard * caregiverCount,
    exceptions,
    evidence_refs: [...new Set([...capped.flatMap((item) => item.refs), ...excluded.flatMap((item) => item.refs)])].sort(),
  };
}

/**
 * 冻结计算快照：按事故发生时的规则版本计算并生成 CALCULATION_FROZEN 事件。
 * 例外引用的意见必须是本案已提交的机构意见（医疗或鉴定）。
 */
export function freezeSnapshot(state, { eventId, snapshotId, claimId, caregiverCount = 1, exceptionOpinionIds = [], occurredAt, version = 1, summary }) {
  const claim = state.claims.get(claimId);
  if (!claim) throw new Error(`案件不存在：${claimId}`);
  for (const id of exceptionOpinionIds) {
    const opinion = state.evidence.get(id);
    if (!opinion || opinion.claim_id !== claimId || opinion.kind !== "institutional_opinion") {
      throw new Error(`例外必须引用本案医疗或鉴定意见：${id}`);
    }
  }
  const ruleSet = resolveRuleSet(state.ruleSets, claim.region, claim.accident_date);
  const evidenceItems = [...state.evidence.values()].filter((item) => item.claim_id === claimId);
  const payload = computeCareCalculation({ claim, evidenceItems, ruleSet, caregiverCount, exceptionOpinionIds });
  return {
    event_id: eventId,
    event_type: "CALCULATION_FROZEN",
    aggregate_type: "calculation_snapshot",
    aggregate_id: snapshotId,
    occurred_at: occurredAt,
    version,
    summary: summary ?? `冻结计算快照：认定 ${payload.day_count} 天，金额 ${payload.amount}`,
    payload,
  };
}

/**
 * 重放校验：从当前证据与规则重新计算，与冻结快照比对。
 * 复核者据此确认医疗护理与生活照护没有重复计算、金额形成过程未被篡改。
 */
export function verifySnapshot(state, snapshotId) {
  const snapshot = state.snapshots.get(snapshotId);
  if (!snapshot) throw new Error(`快照不存在：${snapshotId}`);
  const claim = state.claims.get(snapshot.claim_id);
  const ruleSet = state.ruleSets.get(snapshot.rule_set_id);
  const opinionIds = [...new Set((snapshot.exceptions ?? []).flatMap((item) => item.opinion_refs))];
  const recomputed = computeCareCalculation({
    claim,
    evidenceItems: [...state.evidence.values()].filter((item) => item.claim_id === snapshot.claim_id),
    ruleSet,
    caregiverCount: snapshot.caregiver_count,
    exceptionOpinionIds: opinionIds,
  });
  const fields = ["recognized_periods", "excluded_periods", "caregiver_count", "day_count", "amount", "exceptions"];
  const differences = fields.filter((field) => canonicalStringify(recomputed[field]) !== canonicalStringify(snapshot[field]));
  return { ok: differences.length === 0, differences, recomputed };
}
