/**
 * 读侧投影：不同角色只能看到其最小必要范围。
 *
 * 密级矩阵（labels 见 domain.EVIDENCE_KINDS）：
 *  MEDICAL_DETAIL  原始病历/费用/护理记录内容 —— ADJUDICATOR、REVIEWER
 *  FAMILY_INCOME   家属收入与误工材料原文     —— ADJUDICATOR、REVIEWER
 *  INSURER_INTERNAL 对方保险内部通知材料      —— ADJUDICATOR、REVIEWER、INSURER_STAFF
 * 材料提交者本人始终可见自己提交的材料。
 * 受害方看到的是“认定了哪些时段、金额如何形成、还缺什么”，
 * 不展示医疗原文与家属收入原文；对方保险人员看不到医疗与收入明细。
 */

import { CLASSIFICATION_REASONS, SENSITIVITY_LABELS } from "./domain.js";
import { loadClaim } from "./model.js";
import { calculate, missingRequirements } from "./calculation.js";
import { verifyFrozenSnapshot } from "./decisions.js";
import { coveredDays, merge } from "./periods.js";

export const VIEWER_ROLES = Object.freeze({
  VICTIM: "VICTIM",
  FAMILY_MEMBER: "FAMILY_MEMBER",
  ADJUDICATOR: "ADJUDICATOR",
  REVIEWER: "REVIEWER",
  INSURER_STAFF: "INSURER_STAFF",
});

const LABEL_GRANTS = Object.freeze({
  [SENSITIVITY_LABELS.MEDICAL_DETAIL]: new Set(["ADJUDICATOR", "REVIEWER"]),
  [SENSITIVITY_LABELS.FAMILY_INCOME]: new Set(["ADJUDICATOR", "REVIEWER"]),
  [SENSITIVITY_LABELS.INSURER_INTERNAL]: new Set(["ADJUDICATOR", "REVIEWER", "INSURER_STAFF"]),
});
const DEDUCTION_TEXT = Object.freeze({
  OUTSIDE_HOSPITALIZATION: "超出住院区间的专业护理计费日",
  MEDICAL_OVERLAP: "与医院专业护理同日，不重复给付生活照护",
  CAREGIVER_LIMIT: "超过原则护理人数（一名），无多人护理意见",
  PERIOD_CAP: "超过事故时版本护理期限上限，无延期意见",
  SUPERSEDED: "已被补正记录取代",
  NOT_CLASSIFIED: "尚未经有权人员审查认定",
  CLASSIFIED_EXCLUDED: "经审查不属于护理费用",
  MISSING_INCOME_PROOF: "主张按实际收入计算，但收入证明/误工材料尚未补齐",
  MISSING_REGIONAL_STANDARD: "规则版本未收录该地区劳务标准",
});

function canSee(labels, viewer) {
  return labels.every((label) => {
    const grant = LABEL_GRANTS[label];
    return !grant || grant.has(viewer.role);
  });
}

/** 证据行投影：无密级权限时遮蔽原文引用，仅保留举证状态 */
function projectEvidence(ev, viewer) {
  const owner = viewer.party_id && ev.submitted_by === viewer.party_id;
  const visible = owner || canSee(ev.labels, viewer);
  return {
    evidence_id: ev.evidence_id,
    kind: visible ? ev.kind : "REDACTED",
    status: ev.status,
    canonical_id: ev.canonical_id,
    submitted_by_role: ev.submitted_by_role,
    covers_requirement: ev.covers_requirement,
    content_ref: visible ? ev.content_ref : "[按最小可见范围遮蔽]",
  };
}

/* ------------------------------------------------------------------ */
/* 举证清单（缺什么）                                                  */
/* ------------------------------------------------------------------ */

export function evidenceChecklist(state) {
  const missing = missingRequirements(state);
  const satisfied = new Map();
  for (const ev of state.evidence.values()) {
    if (!ev.covers_requirement || ev.status !== "ACTIVE") continue;
    if (!satisfied.has(ev.covers_requirement)) satisfied.set(ev.covers_requirement, []);
    satisfied.get(ev.covers_requirement).push(ev.evidence_id);
  }
  const fpGroups = new Map();
  for (const ev of state.evidence.values()) {
    if (ev.status !== "ACTIVE") continue;
    for (const fp of ev.fingerprints ?? []) {
      if (!fpGroups.has(fp)) fpGroups.set(fp, []);
      fpGroups.get(fp).push(ev.evidence_id);
    }
  }
  const duplicates_pending_merge = [...fpGroups.values()].filter((ids) => ids.length > 1);
  return {
    missing: missing.map((m) => ({ ...m, status: "MISSING" })),
    satisfied: [...satisfied.entries()].map(([code, evidence_ids]) => ({ code, evidence_ids, status: "SATISFIED" })),
    duplicates_pending_merge,
  };
}

/* ------------------------------------------------------------------ */
/* 受害方视图：缺什么、认定时段、金额形成                              */
/* ------------------------------------------------------------------ */

function issueTextOf(line) {
  if (line.status === "PENDING") return "等待审查认定";
  if (line.status === "WITHHELD") return DEDUCTION_TEXT[line.reason] ?? line.reason;
  if (line.status === "EXCLUDED") return DEDUCTION_TEXT.CLASSIFIED_EXCLUDED;
  return null;
}

export function victimView(store, claimId) {
  const state = loadClaim(store, claimId);
  if (!state.claim) throw new Error("案件不存在");
  const { calculation } = calculate(state);
  const checklist = evidenceChecklist(state);

  const medical_lines = calculation.medical_care.lines.map((l) => ({
    target_id: l.target_id,
    // 医疗原文名称不对受害方展开，只展示认定的期间与金额
    item: "医院专业护理收费项目",
    status: l.status,
    recognized_periods: l.payable_periods ?? [],
    recognized_days: l.payable_days ?? 0,
    amount: l.payable_amount ?? 0,
    excluded_periods: l.excluded_periods ?? [],
    issue: issueTextOf(l),
  }));

  const living_lines = calculation.living_care.lines.map((l) => ({
    target_id: l.target_id,
    caregiver: `护理人（${l.caregiver_id}）`,
    status: l.status,
    rate_basis: l.income_basis === "ACTUAL_INCOME" ? "护理人实际收入（须收入证明）" : "事故发生时版本地区劳务标准",
    rule_version: calculation.rule_version,
    daily_rate: l.daily_rate,
    recognized_days: l.payable_days ?? 0,
    recognized_dates: l.payable_dates ?? [],
    amount: l.payable_amount ?? 0,
    deductions: (l.deductions ?? []).map((d) => ({
      reason: d.reason,
      explanation: DEDUCTION_TEXT[d.reason] ?? d.reason,
      day_count: d.day_count,
      dates: d.dates ?? [],
      amount: d.amount,
    })),
    issue: issueTextOf(l),
  }));

  return {
    claim_id: claimId,
    accident_date: state.claim.accident_date,
    rule_version: calculation.rule_version,
    evidence_status: {
      missing: checklist.missing,
      satisfied_codes: checklist.satisfied.map((s) => s.code),
    },
    hospitalization_periods: calculation.hospitalization_union,
    recognized: {
      medical_care: medical_lines,
      living_care: living_lines,
    },
    amount_formation: {
      medical_total: calculation.medical_care.total,
      living_total: calculation.living_care.total,
      total: calculation.total,
      currency: calculation.currency,
      cap_trace: calculation.living_care.cap_trace,
    },
    decision: state.decision
      ? {
          decision_id: state.decision.decision_id,
          outcome: state.decision.outcome,
          issued_at: state.decision.issued_at,
          revision_of: state.decision.revision_of,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* 对方保险人员视图：最小可见                                          */
/* ------------------------------------------------------------------ */

export function insurerView(store, claimId, viewer = { role: VIEWER_ROLES.INSURER_STAFF, party_id: null }) {
  const state = loadClaim(store, claimId);
  if (!state.claim) throw new Error("案件不存在");
  const { calculation } = calculate(state);
  return {
    claim_id: claimId,
    rule_version: calculation.rule_version,
    evidence: [...state.evidence.values()].map((ev) => projectEvidence(ev, viewer)),
    totals: {
      medical_total: calculation.medical_care.total,
      living_total: calculation.living_care.total,
      total: calculation.total,
      currency: calculation.currency,
    },
    decision: state.decision
      ? { decision_id: state.decision.decision_id, outcome: state.decision.outcome, issued_at: state.decision.issued_at }
      : null,
    notice: "医疗详情与家属收入材料不在对方保险人员可见范围内",
  };
}

/* ------------------------------------------------------------------ */
/* 复核者视图：重放全过程                                               */
/* ------------------------------------------------------------------ */

const FACT_REASON_CATEGORY_TEXT = { fact: "证据事实", opinion: "机构意见", keyword: "关键词（不得单独成立）" };

/**
 * 复核者审计轨迹：事实时间线、判断三分、归并/补正链、
 * 每个快照重放校验、医疗与生活照护去重的逐日依据。
 */
export function reviewerAuditTrail(store, claimId) {
  const state = loadClaim(store, claimId);
  if (!state.claim) throw new Error("案件不存在");
  const events = store.read({ claimId });

  const timeline = events.map((e) => ({
    seq: e.seq,
    occurred_at: e.occurred_at,
    event_type: e.event_type,
    aggregate_type: e.aggregate_type,
    aggregate_id: e.aggregate_id,
    version: e.version,
    summary: e.summary,
  }));

  const classifications = state.classifications.map((c) => ({
    classification_id: c.classification_id,
    target: `${c.target_type}/${c.target_id}`,
    care_class: c.care_class,
    adjudicator_id: c.adjudicator_id,
    decided_at: c.decided_at,
    basis_separation: c.reason_codes.map((code) => {
      // 理由码元数据从 domain 取，避免在事件里冗余存储
      const meta = reasonMeta(code);
      return {
        reason_code: code,
        layer: meta?.category ? FACT_REASON_CATEGORY_TEXT[meta.category] : "规则匹配",
        keyword_only: meta?.keywordOnly ?? false,
        exception: meta?.exception ?? null,
      };
    }),
    opinion_refs: c.opinion_refs,
    evidence_refs: c.evidence_refs,
  }));

  const evidence_chain = [...state.evidence.values()].map((e) => ({
    evidence_id: e.evidence_id,
    kind: e.kind,
    submitted_by: e.submitted_by,
    submitted_by_role: e.submitted_by_role,
    submitted_at: e.submitted_at,
    status: e.status,
    canonical_id: e.canonical_id,
    merge_reason: e.merge_reason ?? null,
  }));

  const supersession_chain = [...state.livingNeeds.values()]
    .filter((n) => n.supersedes || n.superseded_by)
    .map((n) => ({ need_id: n.need_id, supersedes: n.supersedes, superseded_by: n.superseded_by }));

  const snapshots = state.snapshots.map((s) => ({
    snapshot_id: s.snapshot_id,
    frozen_at: s.frozen_at,
    input_seq: s.input_seq,
    rule_version: s.rule_version,
    hash: s.hash,
    verification: verifyFrozenSnapshot(store, claimId, s.snapshot_id),
    totals: {
      medical_total: s.calculation.medical_care.total,
      living_total: s.calculation.living_care.total,
      total: s.calculation.total,
    },
  }));

  // 重放最新计算，展示医疗/生活照护没有重复计算的逐日证据
  const { calculation } = calculate(state);
  const overlap_deductions = calculation.living_care.lines
    .flatMap((l) =>
      (l.deductions ?? [])
        .filter((d) => d.reason === "MEDICAL_OVERLAP")
        .map((d) => ({ target_id: l.target_id, ...d })),
    );
  const paid_medical_periods = merge(
    calculation.medical_care.lines.filter((l) => l.status === "PAYABLE").flatMap((l) => l.payable_periods),
  );

  const decision_chain = state.decisions.map((d) => ({
    decision_id: d.decision_id,
    outcome: d.outcome,
    snapshot_id: d.snapshot_id,
    revision_of: d.revision_of,
    followup_result_ids: d.followup_result_ids,
    issued_at: d.issued_at,
    adjudicator_id: d.adjudicator_id,
  }));

  return {
    claim_id: claimId,
    pinned_rule_version: state.pinnedRuleVersion,
    timeline,
    evidence_chain,
    supersession_chain,
    classifications,
    paid_medical_periods,
    overlap_deductions,
    medical_paid_days: coveredDays(paid_medical_periods),
    snapshots,
    followups: state.followups,
    decision_chain,
    review_open: state.review
      ? { review_id: state.review.review_id, opened_at: state.review.opened_at, reason: state.review.reason }
      : null,
  };
}

function reasonMeta(code) {
  return CLASSIFICATION_REASONS[code] ?? null;
}

/** 角色入口 */
export function projectionFor(store, claimId, viewer) {
  switch (viewer.role) {
    case VIEWER_ROLES.VICTIM:
      return victimView(store, claimId);
    case VIEWER_ROLES.INSURER_STAFF:
      return insurerView(store, claimId, viewer);
    case VIEWER_ROLES.REVIEWER:
    case VIEWER_ROLES.ADJUDICATOR:
      return reviewerAuditTrail(store, claimId);
    default:
      throw new Error(`未知视角角色：${viewer.role}`);
  }
}
