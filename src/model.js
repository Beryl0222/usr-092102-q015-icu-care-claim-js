/**
 * 按案件重放的读模型。
 *
 * foldClaim 是纯函数：输入事件序列，输出案件在某一时点（upToSeq）的
 * 全部事实状态。复核者用它重放“冻结时点”的历史，得到与当时完全一致
 * 的计算输入。
 */

import { AGGREGATE_TYPES, EVENT_TYPES } from "./domain.js";
import { pinRuleBook } from "./rules.js";

function initState() {
  return {
    claim: null,
    pinnedRuleVersion: null,
    pinnedRule: null,
    phases: [],
    medicalItems: [],
    evidence: new Map(),
    livingNeeds: new Map(),
    familyActivities: new Map(),
    opinions: new Map(),
    /** target_key -> 分类判断时间线（最新在末尾，历史全部保留） */
    classificationsByTarget: new Map(),
    classifications: [],
    snapshots: [],
    decision: null,
    decisions: [],
    review: null,
    followups: [],
    lastSeq: 0,
  };
}

function targetKey(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

export function foldClaim(events) {
  const state = initState();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    apply(state, e);
    state.lastSeq = e.seq;
  }
  return state;
}

function apply(state, e) {
  switch (e.event_type) {
    case EVENT_TYPES.CLAIM_OPENED: {
      if (state.claim) throw new Error(`案件 ${e.aggregate_id} 已开启，不可重复开启`);
      state.claim = {
        claim_id: e.aggregate_id,
        accident_date: e.accident_date,
        accident_region: e.accident_region ?? null,
        opened_seq: e.seq,
      };
      break;
    }

    case EVENT_TYPES.RULE_VERSION_PINNED: {
      if (!state.claim) throw new Error("必须先开启案件才能钉选规则版本");
      const expected = pinRuleBook(state.claim.accident_date).version;
      if (e.rule_version !== expected) {
        throw new Error(
          `规则版本必须按事故发生时钉选：事故日 ${state.claim.accident_date} 应使用 ${expected}，收到 ${e.rule_version}`,
        );
      }
      state.pinnedRuleVersion = e.rule_version;
      state.pinnedRule = pinRuleBook(state.claim.accident_date);
      break;
    }

    case EVENT_TYPES.EVIDENCE_SUBMITTED: {
      state.evidence.set(e.aggregate_id, {
        evidence_id: e.aggregate_id,
        kind: e.kind,
        submitted_by: e.submitted_by,
        submitted_by_role: e.submitted_by_role,
        submitted_at: e.occurred_at,
        labels: e.labels ?? [],
        content_ref: e.content_ref,
        fingerprints: e.fingerprints ?? [],
        covers_requirement: e.covers_requirement ?? null,
        status: "ACTIVE",
        canonical_id: e.aggregate_id,
        submit_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.EVIDENCE_MERGED: {
      for (const duplicateId of e.duplicate_ids) {
        const dup = state.evidence.get(duplicateId);
        const canonical = state.evidence.get(e.canonical_id);
        if (!dup) throw new Error(`归并失败：重复材料不存在 ${duplicateId}`);
        if (!canonical) throw new Error(`归并失败：正本不存在 ${e.canonical_id}`);
        if (dup.kind !== canonical.kind) {
          throw new Error(`归并失败：材料种类不一致（${dup.kind} ≠ ${canonical.kind}）`);
        }
        // 只标记归并引用，不删除、不覆盖原提交内容
        dup.status = "MERGED_DUPLICATE";
        dup.canonical_id = e.canonical_id;
        dup.merged_seq = e.seq;
        dup.merge_reason = e.reason ?? "内容重复";
      }
      break;
    }

    case EVENT_TYPES.HOSPITALIZATION_RECORDED: {
      state.phases.push({
        phase_id: e.aggregate_id,
        ward: e.ward, // "ICU" | "WARD"
        period: e.period,
        evidence_refs: e.evidence_refs ?? [],
        recorded_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.MEDICAL_CARE_ITEM_RECORDED: {
      state.medicalItems.push({
        item_id: e.aggregate_id,
        name: e.name,
        period: e.period,
        amount: e.amount,
        fee_evidence_refs: e.fee_evidence_refs ?? [],
        recorded_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.LIVING_CARE_NEED_RECORDED: {
      state.livingNeeds.set(e.aggregate_id, {
        need_id: e.aggregate_id,
        caregiver_id: e.caregiver_id,
        caregiver_name: e.caregiver_name ?? null,
        period: e.period,
        income_basis: e.income_basis, // "ACTUAL_INCOME" | "LOCAL_LABOR_STANDARD"
        daily_income: e.daily_income ?? null,
        evidence_refs: e.evidence_refs ?? [],
        supersedes: e.supersedes ?? null,
        superseded_by: null,
        recorded_seq: e.seq,
      });
      if (e.supersedes && state.livingNeeds.has(e.supersedes)) {
        state.livingNeeds.get(e.supersedes).superseded_by = e.aggregate_id;
      }
      break;
    }

    case EVENT_TYPES.FAMILY_ACTIVITY_RECORDED: {
      state.familyActivities.set(e.aggregate_id, {
        activity_id: e.aggregate_id,
        family_member_id: e.family_member_id,
        type: e.activity_type,
        errand_kind: e.errand_kind ?? null,
        period: e.period,
        evidence_refs: e.evidence_refs ?? [],
        recorded_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.EXPERT_OPINION_RECORDED: {
      state.opinions.set(e.aggregate_id, {
        opinion_id: e.aggregate_id,
        kind: e.opinion_kind,
        issuer: e.issuer,
        issued_on: e.issued_on,
        period: e.period ?? null,
        exceptions: e.exceptions ?? [],
        region_override: e.region_override ?? null,
        approved_caregiver_count: e.approved_caregiver_count ?? null,
        approved_cap_days: e.approved_cap_days ?? null,
        overlap_allow_periods: e.overlap_allow_periods ?? [],
        evidence_refs: e.evidence_refs ?? [],
        recorded_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.CARE_CLASSIFIED: {
      const record = {
        classification_id: e.aggregate_id,
        target_type: e.target_type,
        target_id: e.target_id,
        care_class: e.care_class,
        reason_codes: e.reason_codes ?? [],
        opinion_refs: e.opinion_refs ?? [],
        evidence_refs: e.evidence_refs ?? [],
        adjudicator_id: e.adjudicator_id,
        decided_at: e.occurred_at,
        seq: e.seq,
      };
      const key = targetKey(e.target_type, e.target_id);
      if (!state.classificationsByTarget.has(key)) state.classificationsByTarget.set(key, []);
      state.classificationsByTarget.get(key).push(record);
      state.classifications.push(record);
      break;
    }

    case EVENT_TYPES.CALCULATION_FROZEN: {
      state.snapshots.push({
        snapshot_id: e.aggregate_id,
        frozen_at: e.occurred_at,
        input_seq: e.input_seq,
        rule_version: e.rule_version,
        hash: e.hash,
        calculation: e.calculation,
        missing_requirements: e.missing_requirements ?? [],
        frozen_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.DECISION_ISSUED: {
      const issued = {
        decision_id: e.aggregate_id,
        snapshot_id: e.snapshot_id,
        outcome: e.outcome,
        rationale: e.rationale ?? [],
        adjudicator_id: e.adjudicator_id,
        issued_at: e.occurred_at,
        issued_seq: e.seq,
        revision_of: null,
        followup_result_ids: [],
      };
      state.decision = issued;
      state.decisions.push(issued);
      break;
    }

    case EVENT_TYPES.REVIEW_OPENED: {
      state.review = {
        review_id: e.aggregate_id,
        decision_id: e.decision_id,
        snapshot_id: e.snapshot_id,
        opened_by: e.opened_by,
        opened_at: e.occurred_at,
        opened_seq: e.seq,
      };
      break;
    }

    case EVENT_TYPES.FOLLOWUP_RESULT_RECORDED: {
      state.followups.push({
        result_id: e.aggregate_id,
        review_id: e.review_id,
        followup_kind: e.followup_kind,
        issuer: e.issuer,
        issued_on: e.issued_on,
        changes: e.changes ?? [],
        evidence_refs: e.evidence_refs ?? [],
        recorded_seq: e.seq,
      });
      break;
    }

    case EVENT_TYPES.DECISION_REVISED: {
      const revised = {
        decision_id: e.aggregate_id,
        snapshot_id: e.snapshot_id,
        outcome: e.outcome,
        rationale: e.rationale ?? [],
        adjudicator_id: e.adjudicator_id,
        issued_at: e.occurred_at,
        issued_seq: e.seq,
        revision_of: e.revision_of,
        followup_result_ids: e.followup_result_ids ?? [],
      };
      state.decision = revised;
      state.decisions.push(revised);
      state.review = null;
      break;
    }

    default:
      throw new Error(`重放遇到未处理事件：${e.event_type}`);
  }
}

/** 读取案件在当前（或指定 seq）时点的状态 */
export function loadClaim(store, claimId, { upToSeq } = {}) {
  const events = store.read({ claimId, upToSeq });
  return foldClaim(events);
}

export { targetKey, AGGREGATE_TYPES };
