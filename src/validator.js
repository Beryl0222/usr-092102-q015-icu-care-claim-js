import {
  AGGREGATE_TYPES,
  CARE_CLASSES,
  DECIDER_ROLES,
  DECISION_OUTCOMES,
  EVENT_TYPES,
  EVIDENCE_KINDS,
  REVISE_REASONS,
  VISIBILITY_SCOPES,
} from "./constants.js";

const ENVELOPE_REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 各事件类型的 payload 必备字段。 */
const PAYLOAD_REQUIRED = {
  CLAIM_REGISTERED: ["accident_date", "region", "claimant_id"],
  EVIDENCE_SUBMITTED: ["claim_id", "evidence_kind", "submitted_by", "facts"],
  EVIDENCE_LINKED: ["claim_id", "duplicate_of"],
  CARE_CLASSIFIED: ["claim_id", "classification", "classified_by", "rationale"],
  RULE_SET_PUBLISHED: ["effective_from", "region", "max_caregivers", "period_cap_days", "daily_labor_standard"],
  CALCULATION_FROZEN: ["claim_id", "rule_set_id", "recognized_periods", "excluded_periods", "caregiver_count", "amount"],
  REVIEW_OPENED: ["claim_id", "frozen_snapshot_id", "grounds", "opened_by"],
  DECISION_ISSUED: ["claim_id", "snapshot_id", "outcome", "decided_by", "decider_role"],
  DECISION_REVISED: ["claim_id", "revises", "reason", "snapshot_id", "decided_by", "decider_role"],
};

/**
 * 分类事件不得携带的字段。事实分类与裁决必须分离：
 * 系统不得依据“ICU”或“门外守候”等关键词自动通过或拒绝，
 * 分类只登记证据事实，裁决只能由有权人员通过 DECISION_* 事件作出。
 */
const FORBIDDEN_CLASSIFICATION_FIELDS = ["auto_decision", "decision", "outcome", "approved", "rejected", "keyword_match"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkPayload(event) {
  const errors = [];
  const p = event.payload;
  switch (event.event_type) {
    case "EVIDENCE_SUBMITTED":
      if ("evidence_kind" in p && !EVIDENCE_KINDS.includes(p.evidence_kind)) errors.push(`未知证据种类：${p.evidence_kind}`);
      if ("visibility_scope" in p && !VISIBILITY_SCOPES.includes(p.visibility_scope)) errors.push(`未知可见范围：${p.visibility_scope}`);
      if ("supplements" in p && !Array.isArray(p.supplements)) errors.push("supplements 必须是数组（被补充的证据标识）");
      break;
    case "CARE_CLASSIFIED":
      if ("classification" in p && !CARE_CLASSES.includes(p.classification)) errors.push(`未知照护分类：${p.classification}`);
      if ("rationale" in p && (typeof p.rationale !== "string" || p.rationale.trim() === "")) errors.push("分类必须说明理由（rationale）");
      for (const field of FORBIDDEN_CLASSIFICATION_FIELDS) {
        if (field in p) errors.push(`分类事件不得包含自动裁决字段：${field}`);
      }
      break;
    case "CALCULATION_FROZEN":
      if ("caregiver_count" in p && (!Number.isInteger(p.caregiver_count) || p.caregiver_count < 1)) {
        errors.push("caregiver_count 必须是正整数");
      }
      break;
    case "DECISION_ISSUED":
      if ("outcome" in p && !DECISION_OUTCOMES.includes(p.outcome)) errors.push(`未知裁决结果：${p.outcome}`);
      if ("decider_role" in p && !DECIDER_ROLES.includes(p.decider_role)) {
        errors.push("裁决必须由有权人员作出（claims_handler 或 reviewer）");
      }
      break;
    case "DECISION_REVISED":
      if ("reason" in p && !REVISE_REASONS.includes(p.reason)) errors.push(`未知更正原因：${p.reason}`);
      if ("decider_role" in p && !DECIDER_ROLES.includes(p.decider_role)) {
        errors.push("裁决必须由有权人员作出（claims_handler 或 reviewer）");
      }
      break;
    default:
      break;
  }
  return errors;
}

/** 校验领域事件信封与 payload，返回错误信息列表（空数组表示通过）。 */
export function validateEvent(record) {
  if (!isPlainObject(record)) return ["事件必须是对象"];
  const errors = ENVELOPE_REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);

  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) errors.push("event_id 必须是非空字符串");
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)) errors.push("aggregate_id 必须是非空字符串");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是可解析的时间");
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) errors.push("summary 必须是非空字符串");

  const required = PAYLOAD_REQUIRED[record.event_type];
  if (required) {
    if (!isPlainObject(record.payload)) {
      errors.push("payload 必须是对象");
    } else {
      for (const field of required) {
        if (!(field in record.payload)) errors.push(`payload 缺少字段：${field}`);
      }
      errors.push(...checkPayload(record));
    }
  }
  return errors;
}
