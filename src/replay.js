/**
 * 事件重放：从事件流重建案件状态。
 * 状态只增不改——补证生成新证据聚合，更正生成新快照与新裁决，
 * 因此复核者可以重放任意时点之后的全过程。
 */

export function emptyState() {
  return {
    claims: new Map(),
    evidence: new Map(),
    ruleSets: new Map(),
    snapshots: new Map(),
    reviews: new Map(),
    decisions: new Map(),
  };
}

export function replay(events) {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export function applyEvent(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "CLAIM_REGISTERED":
      state.claims.set(event.aggregate_id, { claim_id: event.aggregate_id, ...p });
      break;
    case "EVIDENCE_SUBMITTED": {
      if (state.evidence.has(event.aggregate_id)) {
        throw new Error(`补证必须新建证据聚合，不得覆盖原提交：${event.aggregate_id}`);
      }
      state.evidence.set(event.aggregate_id, {
        evidence_id: event.aggregate_id,
        claim_id: p.claim_id,
        kind: p.evidence_kind,
        facts: p.facts,
        supplements: p.supplements ?? [],
        visibility_scope: p.visibility_scope ?? null,
        duplicate_of: null,
        classification: null,
        classification_history: [],
        submitted_by: p.submitted_by,
      });
      break;
    }
    case "EVIDENCE_LINKED": {
      const item = mustGet(state.evidence, event.aggregate_id, "归并引用的证据不存在");
      item.duplicate_of = p.duplicate_of;
      break;
    }
    case "CARE_CLASSIFIED": {
      const item = mustGet(state.evidence, event.aggregate_id, "被分类的证据不存在");
      item.classification = p.classification;
      item.classified_by = p.classified_by;
      item.classification_history.push({
        classification: p.classification,
        classified_by: p.classified_by,
        at: event.occurred_at,
      });
      break;
    }
    case "RULE_SET_PUBLISHED":
      state.ruleSets.set(event.aggregate_id, { rule_set_id: event.aggregate_id, ...p });
      break;
    case "CALCULATION_FROZEN":
      if (state.snapshots.has(event.aggregate_id)) {
        throw new Error(`计算快照冻结后不可变，不得重复写入：${event.aggregate_id}`);
      }
      state.snapshots.set(event.aggregate_id, { snapshot_id: event.aggregate_id, ...p });
      break;
    case "REVIEW_OPENED":
      if (!state.snapshots.has(p.frozen_snapshot_id)) {
        throw new Error(`复核必须引用已冻结的计算快照：${p.frozen_snapshot_id}`);
      }
      state.reviews.set(event.aggregate_id, { review_id: event.aggregate_id, ...p });
      break;
    case "DECISION_ISSUED":
      state.decisions.set(event.aggregate_id, { decision_id: event.aggregate_id, revises: null, ...p });
      break;
    case "DECISION_REVISED":
      if (!state.decisions.has(p.revises)) {
        throw new Error(`后继更正必须引用原裁决：${p.revises}`);
      }
      state.decisions.set(event.aggregate_id, { decision_id: event.aggregate_id, ...p });
      break;
    default:
      throw new Error(`未知事件类型：${event.event_type}`);
  }
  return state;
}

function mustGet(map, id, message) {
  const value = map.get(id);
  if (!value) throw new Error(`${message}：${id}`);
  return value;
}
