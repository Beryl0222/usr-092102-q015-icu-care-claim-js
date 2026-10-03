/**
 * 领域事件信封字段约定。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id      全局唯一、幂等标识
 * @property {string} event_type
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {string} claim_id      所属事故案件（跨聚合事件均带，便于按案重放）
 * @property {string} occurred_at
 * @property {number} version       聚合内版本号，从 1 起单调递增
 * @property {string} summary
 */

export const domainEventFields = Object.freeze([
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "claim_id",
]);

/* ------------------------------------------------------------------ */
/* 聚合类型                                                            */
/* ------------------------------------------------------------------ */

export const AGGREGATE_TYPES = Object.freeze({
  INJURY_CLAIM: "injury_claim", // 事故案件
  HOSPITALIZATION_PHASE: "hospitalization_phase", // 住院阶段（ICU/普通病房）
  CARE_ITEM: "care_item", // 医院专业护理收费项目
  CARE_EVIDENCE: "care_evidence", // 证据材料包
  LIVING_CARE_NEED: "living_care_need", // 生活照护需求（家属/护工陪护）
  FAMILY_ACTIVITY: "family_activity", // 家属待命与事务行为
  EXPERT_OPINION: "expert_opinion", // 医疗或鉴定机构意见
  CARE_CLASSIFICATION: "care_classification", // 护理性质判断（有权人员作出）
  CALCULATION_SNAPSHOT: "calculation_snapshot", // 计算快照（冻结）
  REVIEW_DECISION: "review_decision", // 裁决/复核
});

/* ------------------------------------------------------------------ */
/* 事件类型 → 所属聚合                                                 */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = Object.freeze({
  CLAIM_OPENED: "CLAIM_OPENED",
  RULE_VERSION_PINNED: "RULE_VERSION_PINNED",

  EVIDENCE_SUBMITTED: "EVIDENCE_SUBMITTED",
  /** 重复材料归并：保留一份正本，其余只作引用，不删除、不覆盖 */
  EVIDENCE_MERGED: "EVIDENCE_MERGED",

  HOSPITALIZATION_RECORDED: "HOSPITALIZATION_RECORDED",
  MEDICAL_CARE_ITEM_RECORDED: "MEDICAL_CARE_ITEM_RECORDED",
  LIVING_CARE_NEED_RECORDED: "LIVING_CARE_NEED_RECORDED",
  FAMILY_ACTIVITY_RECORDED: "FAMILY_ACTIVITY_RECORDED",
  EXPERT_OPINION_RECORDED: "EXPERT_OPINION_RECORDED",

  /** 有权人员对护理性质的判断（区别于证据事实与规则匹配） */
  CARE_CLASSIFIED: "CARE_CLASSIFIED",

  CALCULATION_FROZEN: "CALCULATION_FROZEN",
  DECISION_ISSUED: "DECISION_ISSUED",

  REVIEW_OPENED: "REVIEW_OPENED",
  /** 后继更正：二审裁判或新鉴定结果 */
  FOLLOWUP_RESULT_RECORDED: "FOLLOWUP_RESULT_RECORDED",
  DECISION_REVISED: "DECISION_REVISED",
});

export const EVENT_AGGREGATE = Object.freeze({
  CLAIM_OPENED: AGGREGATE_TYPES.INJURY_CLAIM,
  RULE_VERSION_PINNED: AGGREGATE_TYPES.INJURY_CLAIM,

  EVIDENCE_SUBMITTED: AGGREGATE_TYPES.CARE_EVIDENCE,
  EVIDENCE_MERGED: AGGREGATE_TYPES.CARE_EVIDENCE,

  HOSPITALIZATION_RECORDED: AGGREGATE_TYPES.HOSPITALIZATION_PHASE,
  MEDICAL_CARE_ITEM_RECORDED: AGGREGATE_TYPES.CARE_ITEM,
  LIVING_CARE_NEED_RECORDED: AGGREGATE_TYPES.LIVING_CARE_NEED,
  FAMILY_ACTIVITY_RECORDED: AGGREGATE_TYPES.FAMILY_ACTIVITY,
  EXPERT_OPINION_RECORDED: AGGREGATE_TYPES.EXPERT_OPINION,

  CARE_CLASSIFIED: AGGREGATE_TYPES.CARE_CLASSIFICATION,

  CALCULATION_FROZEN: AGGREGATE_TYPES.CALCULATION_SNAPSHOT,
  DECISION_ISSUED: AGGREGATE_TYPES.REVIEW_DECISION,
  REVIEW_OPENED: AGGREGATE_TYPES.REVIEW_DECISION,
  FOLLOWUP_RESULT_RECORDED: AGGREGATE_TYPES.REVIEW_DECISION,
  DECISION_REVISED: AGGREGATE_TYPES.REVIEW_DECISION,
});

/* ------------------------------------------------------------------ */
/* 证据：种类、提交主体、密级                                          */
/* ------------------------------------------------------------------ */

/** 同一事故的材料可由不同主体补交 */
export const PARTY_ROLES = Object.freeze({
  VICTIM: "VICTIM", // 受害方
  FAMILY_MEMBER: "FAMILY_MEMBER", // 家属
  HOSPITAL: "HOSPITAL", // 医疗机构
  INSURER_STAFF: "INSURER_STAFF", // 对方保险人员
  APPRAISAL_AGENCY: "APPRAISAL_AGENCY", // 鉴定机构
  COURT: "COURT", // 法院
});

/**
 * 证据种类。labels 为最小可见范围标签，投影层据此遮蔽。
 * requirement 为该类材料默认满足的举证清单项。
 */
export const EVIDENCE_KINDS = Object.freeze({
  MEDICAL_RECORD: {
    code: "MEDICAL_RECORD",
    label: "病历材料",
    labels: ["MEDICAL_DETAIL"],
    requirement: "REQ_HOSPITALIZATION",
  },
  FEE_DETAIL: {
    code: "FEE_DETAIL",
    label: "费用清单/票据",
    labels: ["MEDICAL_DETAIL"],
    requirement: "REQ_MEDICAL_FEE",
  },
  NURSING_RECORD: {
    code: "NURSING_RECORD",
    label: "护理记录/医嘱护理依赖",
    labels: ["MEDICAL_DETAIL"],
    requirement: "REQ_CARE_DEPENDENCY",
  },
  REQUEST_NOTICE: {
    code: "REQUEST_NOTICE",
    label: "通知/送达记录",
    labels: ["INSURER_INTERNAL"],
    requirement: "REQ_NOTICE",
  },
  LOST_INCOME_MATERIAL: {
    code: "LOST_INCOME_MATERIAL",
    label: "误工材料",
    labels: ["FAMILY_INCOME"],
    requirement: "REQ_LOST_INCOME",
  },
  INCOME_PROOF: {
    code: "INCOME_PROOF",
    label: "护理人收入证明",
    labels: ["FAMILY_INCOME"],
    requirement: "REQ_CAREGIVER_INCOME",
  },
  IDENTITY_RELATION: {
    code: "IDENTITY_RELATION",
    label: "身份与亲属关系证明",
    labels: [],
    requirement: "REQ_RELATION",
  },
  OTHER: { code: "OTHER", label: "其他材料", labels: [], requirement: null },
});

/** 密级标签：医疗详情、家属收入、对方保险内部材料 */
export const SENSITIVITY_LABELS = Object.freeze({
  MEDICAL_DETAIL: "MEDICAL_DETAIL",
  FAMILY_INCOME: "FAMILY_INCOME",
  INSURER_INTERNAL: "INSURER_INTERNAL",
});

/* ------------------------------------------------------------------ */
/* 护理性质判断                                                        */
/* ------------------------------------------------------------------ */

export const CARE_CLASSES = Object.freeze({
  MEDICAL_CARE: "MEDICAL_CARE", // 医疗护理（医院专业护理项目）
  LIVING_CARE: "LIVING_CARE", // 生活照护（家属/护工陪护）
  EXCLUDED: "EXCLUDED", // 不予认定为护理费用
});

export const CLASSIFICATION_TARGET_TYPES = Object.freeze({
  MEDICAL_CARE_ITEM: "MEDICAL_CARE_ITEM",
  LIVING_CARE_NEED: "LIVING_CARE_NEED",
  FAMILY_ACTIVITY: "FAMILY_ACTIVITY",
});

/**
 * 判断理由码。
 * category:
 *  - fact    证据事实（材料可证）
 *  - opinion 医疗/鉴定意见（例外的唯一来源）
 *  - rule    法律规则匹配（自动匹配，不构成人工判断本身）
 * keyword_only 标记的理由不能单独支撑通过或拒绝。
 */
export const CLASSIFICATION_REASONS = Object.freeze({
  FACT_HOSPITAL_PROFESSIONAL_NURSING: {
    code: "FACT_HOSPITAL_PROFESSIONAL_NURSING",
    category: "fact",
    keywordOnly: false,
    label: "费用清单载有医院专业护理收费项目",
  },
  FACT_FEE_ITEM_PAID: {
    code: "FACT_FEE_ITEM_PAID",
    category: "fact",
    keywordOnly: false,
    label: "专业护理费用已实际结算",
  },
  FACT_DOCTOR_ORDER_CARE: {
    code: "FACT_DOCTOR_ORDER_CARE",
    category: "fact",
    keywordOnly: false,
    label: "医嘱/护理记录载明需生活陪护",
  },
  FACT_FAMILY_CARE_ATTESTED: {
    code: "FACT_FAMILY_CARE_ATTESTED",
    category: "fact",
    keywordOnly: false,
    label: "证据可证家属实际从事生活照护",
  },
  FACT_ACTIVITY_IS_ERRAND: {
    code: "FACT_ACTIVITY_IS_ERRAND",
    category: "fact",
    keywordOnly: false,
    label: "行为记录显示为签署文书/缴费/转院配合等事务行为",
  },
  FACT_NO_PATIENT_CONTACT_CARE: {
    code: "FACT_NO_PATIENT_CONTACT_CARE",
    category: "fact",
    keywordOnly: false,
    label: "记录可证该时段未对伤者实施生活照护",
  },

  OPINION_MULTI_CAREGIVER: {
    code: "OPINION_MULTI_CAREGIVER",
    category: "opinion",
    exception: "MULTI_CAREGIVER",
    label: "医疗/鉴定意见支持多人护理",
  },
  OPINION_PERIOD_EXTENSION: {
    code: "OPINION_PERIOD_EXTENSION",
    category: "opinion",
    exception: "PERIOD_CAP",
    label: "医疗/鉴定意见支持超期护理",
  },
  OPINION_NONLOCAL_STANDARD: {
    code: "OPINION_NONLOCAL_STANDARD",
    category: "opinion",
    exception: "REGIONAL_STANDARD",
    label: "医疗/鉴定意见支持适用外地劳务标准",
  },
  OPINION_OVERLAP_RESOLUTION: {
    code: "OPINION_OVERLAP_RESOLUTION",
    category: "opinion",
    exception: "OVERLAP",
    label: "医疗/鉴定意见对医疗护理与生活照护重叠作出区分",
  },

  KEYWORD_ICU_ONLY: {
    code: "KEYWORD_ICU_ONLY",
    category: "keyword",
    keywordOnly: true,
    label: "仅凭“ICU”字样",
  },
  KEYWORD_WAIT_OUTSIDE_ONLY: {
    code: "KEYWORD_WAIT_OUTSIDE_ONLY",
    category: "keyword",
    keywordOnly: true,
    label: "仅凭“门外守候”",
  },
});

export const AUTHORIZED_CLASSIFIERS = Object.freeze(["ADJUDICATOR"]);
export const AUTHORIZED_REVIEWERS = Object.freeze(["REVIEWER"]);

/* ------------------------------------------------------------------ */
/* 家属行为 / 机构意见                                                 */
/* ------------------------------------------------------------------ */

export const ACTIVITY_TYPES = Object.freeze({
  STANDBY: "STANDBY", // 待命/守候
  ERRAND: "ERRAND", // 事务行为
});

export const ERRAND_KINDS = Object.freeze({
  SIGN_DOCUMENTS: "SIGN_DOCUMENTS", // 签署文书
  PAY_FEES: "PAY_FEES", // 缴费
  TRANSFER_COOPERATION: "TRANSFER_COOPERATION", // 转院配合
  OTHER: "OTHER",
});

export const OPINION_KINDS = Object.freeze({
  MEDICAL_OPINION: "MEDICAL_OPINION", // 医疗机构意见
  APPRAISAL: "APPRAISAL", // 鉴定意见
});

export const FOLLOWUP_KINDS = Object.freeze({
  SECOND_INSTANCE: "SECOND_INSTANCE", // 二审裁判
  NEW_APPRAISAL: "NEW_APPRAISAL", // 新鉴定结果
});

export const DECISION_OUTCOMES = Object.freeze({
  APPROVED: "APPROVED", // 全部认定
  PARTIALLY_APPROVED: "PARTIALLY_APPROVED", // 部分认定
  REJECTED: "REJECTED", // 不予认定
});

/* ------------------------------------------------------------------ */
/* 举证清单（规则要求的证据要件；规则版本可增减）                       */
/* ------------------------------------------------------------------ */

export const REQUIREMENT_CODES = Object.freeze({
  REQ_HOSPITALIZATION: { code: "REQ_HOSPITALIZATION", label: "住院事实与阶段（病历/住院证明）" },
  REQ_MEDICAL_FEE: { code: "REQ_MEDICAL_FEE", label: "医疗/专业护理费用清单" },
  REQ_CARE_DEPENDENCY: { code: "REQ_CARE_DEPENDENCY", label: "护理依赖依据（医嘱/护理记录/意见）" },
  REQ_RELATION: { code: "REQ_RELATION", label: "护理人身份及与伤者关系证明" },
  REQ_CAREGIVER_INCOME: { code: "REQ_CAREGIVER_INCOME", label: "护理人收入证明（主张按实际收入时）" },
  REQ_LOST_INCOME: { code: "REQ_LOST_INCOME", label: "误工减损材料（主张按实际收入时）" },
  REQ_NOTICE: { code: "REQ_NOTICE", label: "通知与送达记录" },
});

/* ------------------------------------------------------------------ */
/* 事件工厂                                                            */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

/**
 * 构造领域事件信封。
 * event_id 默认按 聚合+版本 确定生成（同聚合同版本即同一事件，幂等）。
 * @returns {DomainEvent}
 */
export function makeEvent(eventType, aggregateId, version, body = {}) {
  const aggregateType = EVENT_AGGREGATE[eventType];
  if (!aggregateType) throw new Error(`未知事件类型：${eventType}`);
  if (!Number.isInteger(version) || version < 1) throw new Error("version 必须是正整数");
  const { event_id, occurred_at, summary, ...payload } = body;
  return {
    event_id: event_id ?? `${aggregateType}:${aggregateId}:v${version}`,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurred_at ?? nowIso(),
    version,
    summary: summary ?? `${eventType}/${aggregateId}`,
    ...payload,
  };
}
