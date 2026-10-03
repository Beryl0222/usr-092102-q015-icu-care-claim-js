import { ROLES } from "./constants.js";

/**
 * 最小可见范围：医疗详情、家属收入等敏感事实按角色投影。
 * 对方保险人员仅见 general 范围（如裁决结果与金额形成），
 * 受害方另见事务行为类材料，医疗详情与收入仅理赔与复核人员可见。
 */
const SCOPE_ROLES = {
  general: ROLES,
  administrative: ["claims_handler", "reviewer", "victim_side"],
  medical_detail: ["claims_handler", "reviewer"],
  income: ["claims_handler", "reviewer"],
};

/** 证据种类的默认可见范围（提交时可显式指定更严格的范围）。 */
const KIND_SCOPES = {
  hospitalization_stage: "medical_detail",
  medical_care_item: "medical_detail",
  institutional_opinion: "medical_detail",
  income_proof: "income",
  family_standby: "administrative",
  administrative_act: "administrative",
};

export function scopeOf(payload) {
  return payload.visibility_scope ?? KIND_SCOPES[payload.evidence_kind] ?? "general";
}

export function canSee(scope, role) {
  return (SCOPE_ROLES[scope] ?? []).includes(role);
}

/** 按角色投影单个事件：无权查看的事实用 null 遮蔽并标记 redacted。 */
export function projectEvent(event, role) {
  if (event.event_type !== "EVIDENCE_SUBMITTED") return event;
  const scope = scopeOf(event.payload);
  if (canSee(scope, role)) return event;
  return {
    ...event,
    payload: { ...event.payload, facts: null, redacted: true, visibility_scope: scope },
  };
}

export function projectEvents(events, role) {
  return events.map((event) => projectEvent(event, role));
}
