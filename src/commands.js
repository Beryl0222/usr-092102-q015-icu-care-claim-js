/**
 * 写侧应用服务：录入事实证据、归并重复材料、作出护理性质判断。
 *
 * 三分原则在本文件强制执行：
 *   证据事实（谁、何时、交了什么）——任何人按角色补交，只追加；
 *   规则匹配     ——由规则版本簿自动给出，不产生人工结论；
 *   有权判断     ——仅 ADJUDICATOR 可作 CARE_CLASSIFIED，且不得只凭
 *                   “ICU / 门外守候”这类关键词通过或拒绝。
 */

import {
  AGGREGATE_TYPES,
  AUTHORIZED_CLASSIFIERS,
  CARE_CLASSES,
  CLASSIFICATION_REASONS,
  CLASSIFICATION_TARGET_TYPES,
  EVIDENCE_KINDS,
  EVENT_AGGREGATE,
  EVENT_TYPES,
  makeEvent,
  PARTY_ROLES,
} from "./domain.js";
import { containedIn, days, overlaps } from "./periods.js";
import { pinRuleBook } from "./rules.js";
import { loadClaim } from "./model.js";

class CommandError extends Error {}

function stateOf(store, claimId) {
  return loadClaim(store, claimId);
}

function append(store, claimId, type, aggregateId, body, occurredAt) {
  const event = makeEvent(type, aggregateId, store.nextVersion(EVENT_AGGREGATE[type], aggregateId), {
    claim_id: claimId,
    ...body,
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  });
  store.append(event);
  return event;
}

/* ------------------------------------------------------------------ */
/* 案件与规则                                                          */
/* ------------------------------------------------------------------ */

export function openClaim(store, { claim_id, accident_date, accident_region }, occurredAt) {
  return append(
    store,
    claim_id,
    EVENT_TYPES.CLAIM_OPENED,
    claim_id,
    { accident_date, accident_region: accident_region ?? null, summary: `立案：${claim_id}` },
    occurredAt,
  );
}

/** 规则版本只能按事故发生时钉选，版本号由系统推导，禁止人工指定 */
export function pinRules(store, claimId, occurredAt) {
  const state = stateOf(store, claimId);
  if (!state.claim) throw new CommandError("案件不存在，无法钉选规则");
  const book = pinRuleBook(state.claim.accident_date);
  return append(
    store,
    claimId,
    EVENT_TYPES.RULE_VERSION_PINNED,
    claimId,
    {
      rule_version: book.version,
      accident_date: state.claim.accident_date,
      summary: `按事故发生日 ${state.claim.accident_date} 钉选规则 ${book.version}`,
    },
    occurredAt,
  );
}

/* ------------------------------------------------------------------ */
/* 证据：多主体补交、补证不覆盖、重复归并                              */
/* ------------------------------------------------------------------ */

/**
 * 提交证据。不同主体可分别补交；每次提交都是独立事件，
 * 后提交绝不修改先提交的内容。重复归并需另行显式调用 mergeEvidence。
 */
export function submitEvidence(
  store,
  claimId,
  {
    evidence_id,
    kind,
    submitted_by,
    submitted_by_role,
    content_ref,
    fingerprints = [],
    covers_requirement = null,
    labels = null,
  },
  occurredAt,
) {
  if (!EVIDENCE_KINDS[kind]) throw new CommandError(`未知证据种类：${kind}`);
  if (!Object.values(PARTY_ROLES).includes(submitted_by_role)) {
    throw new CommandError(`未知提交主体角色：${submitted_by_role}`);
  }
  const state = stateOf(store, claimId);
  if (state.evidence.has(evidence_id)) throw new CommandError(`证据编号已存在（补证请使用新编号）：${evidence_id}`);

  const kindDef = EVIDENCE_KINDS[kind];
  return append(
    store,
    claimId,
    EVENT_TYPES.EVIDENCE_SUBMITTED,
    evidence_id,
    {
      kind,
      submitted_by,
      submitted_by_role,
      content_ref,
      fingerprints,
      covers_requirement: covers_requirement ?? kindDef.requirement,
      labels: labels ?? kindDef.labels,
      summary: `${kindDef.label}（${submitted_by_role} 提交）`,
    },
    occurredAt,
  );
}

/** 发现指纹相同的 ACTIVE 材料（供人工确认后归并；系统不自动归并） */
export function findDuplicateEvidence(store, claimId) {
  const state = stateOf(store, claimId);
  const byFp = new Map();
  for (const ev of state.evidence.values()) {
    if (ev.status !== "ACTIVE") continue;
    for (const fp of ev.fingerprints) {
      if (!byFp.has(fp)) byFp.set(fp, []);
      byFp.get(fp).push(ev.evidence_id);
    }
  }
  return [...byFp.entries()].filter(([, ids]) => ids.length > 1).map(([fingerprint, ids]) => ({ fingerprint, ids }));
}

/**
 * 归并重复材料：保留 canonical 正本，duplicates 只转为引用。
 * 不删除任何提交，归并后原提交仍可被引用与审计。
 */
export function mergeEvidence(store, claimId, actor, { canonical_id, duplicate_ids, reason }, occurredAt) {
  const state = stateOf(store, claimId);
  const canonical = state.evidence.get(canonical_id);
  if (!canonical) throw new CommandError(`正本不存在：${canonical_id}`);
  if (canonical.status === "MERGED_DUPLICATE") throw new CommandError("正本自身已被归并");
  for (const id of duplicate_ids) {
    if (id === canonical_id) throw new CommandError("正本不能同时作为重复件");
    const dup = state.evidence.get(id);
    if (!dup) throw new CommandError(`重复件不存在：${id}`);
    if (dup.status === "MERGED_DUPLICATE") throw new CommandError(`${id} 已归并过`);
    if (dup.kind !== canonical.kind) throw new CommandError(`不同种类材料不得归并：${dup.kind} ≠ ${canonical.kind}`);
  }
  const mergeId = `merge-${canonical_id}-${[...duplicate_ids].sort().join("-")}`;
  return append(
    store,
    claimId,
    EVENT_TYPES.EVIDENCE_MERGED,
    mergeId,
    {
      canonical_id,
      duplicate_ids,
      reason: reason ?? "指纹一致，内容重复",
      merged_by: actor.actor_id,
      summary: `重复材料归并至 ${canonical_id}`,
    },
    occurredAt,
  );
}

/* ------------------------------------------------------------------ */
/* 事实录入：住院阶段、专业护理项目、生活照护、家属行为、机构意见      */
/* ------------------------------------------------------------------ */

function requirePeriod(period) {
  if (!period || !period.start || !period.end) throw new CommandError("缺少起止期间");
  days(period.start, period.end); // 校验格式与方向
}

function requireEvidenceRefs(state, refs) {
  for (const ref of refs ?? []) {
    if (!state.evidence.has(ref)) throw new CommandError(`引用的证据不存在：${ref}`);
  }
}

export function recordHospitalization(
  store,
  claimId,
  { phase_id, ward, period, evidence_refs = [] },
  occurredAt,
) {
  if (!["ICU", "WARD"].includes(ward)) throw new CommandError(`未知病房类型：${ward}`);
  requirePeriod(period);
  const state = stateOf(store, claimId);
  requireEvidenceRefs(state, evidence_refs);
  for (const ph of state.phases) {
    if (overlaps(ph.period, period)) throw new CommandError(`住院阶段期间与 ${ph.phase_id} 重叠`);
  }
  return append(
    store,
    claimId,
    EVENT_TYPES.HOSPITALIZATION_RECORDED,
    phase_id,
    { ward, period, evidence_refs, summary: `${ward} 住院阶段 ${period.start}~${period.end}` },
    occurredAt,
  );
}

export function recordMedicalCareItem(
  store,
  claimId,
  { item_id, name, period, amount, fee_evidence_refs = [] },
  occurredAt,
) {
  requirePeriod(period);
  if (typeof amount !== "number" || amount < 0) throw new CommandError("金额必须是非负数");
  const state = stateOf(store, claimId);
  requireEvidenceRefs(state, fee_evidence_refs);
  return append(
    store,
    claimId,
    EVENT_TYPES.MEDICAL_CARE_ITEM_RECORDED,
    item_id,
    { name, period, amount, fee_evidence_refs, summary: `医院专业护理项目：${name}` },
    occurredAt,
  );
}

export function recordLivingCareNeed(
  store,
  claimId,
  { need_id, caregiver_id, caregiver_name, period, income_basis, daily_income = null, evidence_refs = [], supersedes = null },
  occurredAt,
) {
  requirePeriod(period);
  if (!["ACTUAL_INCOME", "LOCAL_LABOR_STANDARD"].includes(income_basis)) {
    throw new CommandError("收入基准必须是 ACTUAL_INCOME 或 LOCAL_LABOR_STANDARD");
  }
  if (income_basis === "ACTUAL_INCOME" && daily_income !== null && (typeof daily_income !== "number" || daily_income < 0)) {
    throw new CommandError("主张日收入必须是非负数");
  }
  const state = stateOf(store, claimId);
  requireEvidenceRefs(state, evidence_refs);
  if (supersedes) {
    const old = state.livingNeeds.get(supersedes);
    if (!old) throw new CommandError(`被补正的材料不存在：${supersedes}`);
    if (old.superseded_by) throw new CommandError(`${supersedes} 已有补正记录`);
    if (old.caregiver_id !== caregiver_id) throw new CommandError("补正不得更换护理人；请另立护理需求");
  }
  return append(
    store,
    claimId,
    EVENT_TYPES.LIVING_CARE_NEED_RECORDED,
    need_id,
    {
      caregiver_id,
      caregiver_name: caregiver_name ?? null,
      period,
      income_basis,
      daily_income,
      evidence_refs,
      supersedes,
      summary: `生活照护需求：护理人 ${caregiver_id} ${period.start}~${period.end}`,
    },
    occurredAt,
  );
}

export function recordFamilyActivity(
  store,
  claimId,
  { activity_id, family_member_id, activity_type, errand_kind = null, period, evidence_refs = [] },
  occurredAt,
) {
  if (!["STANDBY", "ERRAND"].includes(activity_type)) throw new CommandError("家属行为必须是 STANDBY 或 ERRAND");
  requirePeriod(period);
  const state = stateOf(store, claimId);
  requireEvidenceRefs(state, evidence_refs);
  return append(
    store,
    claimId,
    EVENT_TYPES.FAMILY_ACTIVITY_RECORDED,
    activity_id,
    {
      family_member_id,
      activity_type,
      errand_kind,
      period,
      evidence_refs,
      summary: `家属${activity_type === "STANDBY" ? "待命/守候" : "事务行为"} ${period.start}~${period.end}`,
    },
    occurredAt,
  );
}

export function recordExpertOpinion(
  store,
  claimId,
  {
    opinion_id,
    opinion_kind,
    issuer,
    issued_on,
    period = null,
    exceptions = [],
    region_override = null,
    approved_caregiver_count = null,
    approved_cap_days = null,
    overlap_allow_periods = [],
    evidence_refs = [],
  },
  occurredAt,
) {
  if (!["MEDICAL_OPINION", "APPRAISAL"].includes(opinion_kind)) throw new CommandError("未知意见类型");
  const state = stateOf(store, claimId);
  requireEvidenceRefs(state, evidence_refs);
  if (period) requirePeriod(period);
  return append(
    store,
    claimId,
    EVENT_TYPES.EXPERT_OPINION_RECORDED,
    opinion_id,
    {
      opinion_kind,
      issuer,
      issued_on,
      period,
      exceptions,
      region_override,
      approved_caregiver_count,
      approved_cap_days,
      overlap_allow_periods,
      evidence_refs,
      summary: `${opinion_kind === "APPRAISAL" ? "鉴定意见" : "医疗意见"}：${issuer}`,
    },
    occurredAt,
  );
}

/* ------------------------------------------------------------------ */
/* 护理性质判断：仅授权人员；禁止仅凭关键词                             */
/* ------------------------------------------------------------------ */

const SUPPORTING_FACTS = Object.freeze({
  MEDICAL_CARE: new Set(["FACT_HOSPITAL_PROFESSIONAL_NURSING", "FACT_FEE_ITEM_PAID"]),
  LIVING_CARE: new Set(["FACT_DOCTOR_ORDER_CARE", "FACT_FAMILY_CARE_ATTESTED"]),
  EXCLUDED: new Set(["FACT_ACTIVITY_IS_ERRAND", "FACT_NO_PATIENT_CONTACT_CARE"]),
});

/**
 * 有权人员对单个对象作出护理性质判断。
 * 返回 CARE_CLASSIFIED 事件；不满足守卫时抛错，系统不会替人作结论。
 */
export function classifyCare(
  store,
  claimId,
  actor,
  { classification_id, target_type, target_id, care_class, reason_codes = [], opinion_refs = [], evidence_refs = [] },
  occurredAt,
) {
  if (!AUTHORIZED_CLASSIFIERS.includes(actor?.role)) {
    throw new CommandError("仅理赔裁决人员（ADJUDICATOR）可作出护理性质判断");
  }
  if (!Object.values(CARE_CLASSES).includes(care_class)) throw new CommandError("未知护理类别");
  if (!Object.values(CLASSIFICATION_TARGET_TYPES).includes(target_type)) throw new CommandError("未知判断对象类型");
  if (reason_codes.length === 0) throw new CommandError("判断必须载明理由码");

  const reasons = reason_codes.map((code) => {
    const def = CLASSIFICATION_REASONS[code];
    if (!def) throw new CommandError(`未知理由码：${code}`);
    return def;
  });

  // 守卫一：不得仅凭关键词（ICU / 门外守候）自动通过或拒绝
  if (reasons.every((r) => r.keywordOnly)) {
    throw new CommandError("不得仅凭“ICU”或“门外守候”字样作出通过或拒绝，须引用证据事实或机构意见");
  }

  const state = stateOf(store, claimId);

  // 守卫二：对象必须真实存在
  const target =
    (target_type === "MEDICAL_CARE_ITEM" && state.medicalItems.find((m) => m.item_id === target_id)) ||
    (target_type === "LIVING_CARE_NEED" && state.livingNeeds.get(target_id)) ||
    (target_type === "FAMILY_ACTIVITY" && state.familyActivities.get(target_id)) ||
    null;
  if (!target) throw new CommandError(`判断对象不存在：${target_type}/${target_id}`);

  // 守卫三：例外类理由必须引用对应、且载明该例外的机构意见
  for (const r of reasons.filter((x) => x.category === "opinion")) {
    const ref = opinion_refs.find((o) => o.reason_code === r.code);
    if (!ref) throw new CommandError(`理由 ${r.code} 必须在 opinion_refs 中引用机构意见`);
    const opinion = state.opinions.get(ref.opinion_id);
    if (!opinion) throw new CommandError(`引用的机构意见不存在：${ref.opinion_id}`);
    if (!opinion.exceptions.includes(r.exception)) {
      throw new CommandError(`机构意见 ${ref.opinion_id} 未载明例外 ${r.exception}`);
    }
    if (opinion.period && target.period && !containedIn(target.period, opinion.period)) {
      throw new CommandError(`机构意见 ${ref.opinion_id} 的覆盖期间不包含对象期间`);
    }
  }

  // 守卫四：结论必须有支撑性事实或机构意见，关键词只能作备注
  const hasSupportingFact = reasons.some((r) => r.category === "fact" && SUPPORTING_FACTS[care_class]?.has(r.code));
  const hasOpinion = reasons.some((r) => r.category === "opinion");
  if (!hasSupportingFact && !hasOpinion) {
    throw new CommandError(`${care_class} 结论缺少支撑性证据事实或机构意见`);
  }

  requireEvidenceRefs(state, evidence_refs);

  return append(
    store,
    claimId,
    EVENT_TYPES.CARE_CLASSIFIED,
    classification_id,
    {
      target_type,
      target_id,
      care_class,
      reason_codes,
      opinion_refs,
      evidence_refs,
      adjudicator_id: actor.actor_id,
      summary: `${target_id} 判定为 ${care_class}`,
    },
    occurredAt,
  );
}

export { CommandError, AGGREGATE_TYPES };
