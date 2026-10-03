/**
 * 领域稳定枚举。所有取值与 contracts/domain.schema.json 保持一致，
 * 新增取值必须同时登记到契约文件，保持交换格式兼容。
 */

export const EVENT_TYPES = Object.freeze([
  "CLAIM_REGISTERED",
  "EVIDENCE_SUBMITTED",
  "EVIDENCE_LINKED",
  "CARE_CLASSIFIED",
  "RULE_SET_PUBLISHED",
  "CALCULATION_FROZEN",
  "REVIEW_OPENED",
  "DECISION_ISSUED",
  "DECISION_REVISED",
]);

export const AGGREGATE_TYPES = Object.freeze([
  "injury_claim",
  "care_evidence",
  "calculation_snapshot",
  "review_decision",
  "rule_set",
]);

/** 证据材料种类：住院阶段、医疗护理项目、生活照护需求、家属待命、事务行为、收入证明、机构意见。 */
export const EVIDENCE_KINDS = Object.freeze([
  "hospitalization_stage",
  "medical_care_item",
  "life_care_need",
  "family_standby",
  "administrative_act",
  "income_proof",
  "institutional_opinion",
  "other",
]);

/**
 * 照护事实分类。分类只描述证据事实，不含通过/拒绝结论：
 * - medical_care：医院专业护理（已计入医疗费用，不得与家属生活照护重复计算）
 * - life_care：家属生活照护（可计入护理费）
 * - standby_admin：家属待命与文书、缴费、转院等事务行为（记录事实，不计入生活照护）
 * - non_care：与照护无关
 */
export const CARE_CLASSES = Object.freeze(["medical_care", "life_care", "standby_admin", "non_care"]);

/** 最小可见范围。 */
export const VISIBILITY_SCOPES = Object.freeze(["general", "administrative", "medical_detail", "income"]);

export const ROLES = Object.freeze(["victim_side", "claims_handler", "reviewer", "opposing_insurer"]);

/** 有权作出裁决的角色。 */
export const DECIDER_ROLES = Object.freeze(["claims_handler", "reviewer"]);

export const DECISION_OUTCOMES = Object.freeze(["recognized", "partially_recognized", "rejected"]);

/** 后继更正原因：二审、新鉴定结果或一般更正。 */
export const REVISE_REASONS = Object.freeze(["second_instance", "new_appraisal", "correction"]);
