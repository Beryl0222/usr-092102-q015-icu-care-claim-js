/**
 * 复核与裁决。争议进入复核时引用并冻结当时的计算快照；
 * 二审或新鉴定结果通过 DECISION_REVISED 后继更正，原裁决保留不覆盖。
 */

/** 复核立案：锁定案件当前最新的冻结快照。 */
export function openReview(state, { eventId, reviewId, claimId, grounds, openedBy, occurredAt, version = 1 }) {
  const snapshots = [...state.snapshots.values()].filter((snapshot) => snapshot.claim_id === claimId);
  if (snapshots.length === 0) {
    throw new Error("争议进入复核前必须存在已冻结的计算快照");
  }
  const frozen = snapshots[snapshots.length - 1];
  return {
    event_id: eventId,
    event_type: "REVIEW_OPENED",
    aggregate_type: "review_decision",
    aggregate_id: reviewId,
    occurred_at: occurredAt,
    version,
    summary: `复核立案：冻结快照 ${frozen.snapshot_id}`,
    payload: { claim_id: claimId, frozen_snapshot_id: frozen.snapshot_id, grounds, opened_by: openedBy },
  };
}

/** 作出裁决（仅构造事件；有权角色由校验器约束）。 */
export function issueDecision({ eventId, decisionId, claimId, snapshotId, outcome, decidedBy, deciderRole, occurredAt, version = 1 }) {
  return {
    event_id: eventId,
    event_type: "DECISION_ISSUED",
    aggregate_type: "review_decision",
    aggregate_id: decisionId,
    occurred_at: occurredAt,
    version,
    summary: `裁决：${outcome}（快照 ${snapshotId}）`,
    payload: { claim_id: claimId, snapshot_id: snapshotId, outcome, decided_by: decidedBy, decider_role: deciderRole },
  };
}

/** 后继更正：引用原裁决与新快照，原裁决保留。 */
export function reviseDecision(state, { eventId, decisionId, revises, reason, claimId, snapshotId, decidedBy, deciderRole, occurredAt, version = 1 }) {
  if (!state.decisions.has(revises)) {
    throw new Error(`后继更正必须引用原裁决：${revises}`);
  }
  if (!state.snapshots.has(snapshotId)) {
    throw new Error(`后继更正必须引用新的冻结快照：${snapshotId}`);
  }
  return {
    event_id: eventId,
    event_type: "DECISION_REVISED",
    aggregate_type: "review_decision",
    aggregate_id: decisionId,
    occurred_at: occurredAt,
    version,
    summary: `后继更正（${reason}）：更正 ${revises}，原裁决保留`,
    payload: { claim_id: claimId, revises, reason, snapshot_id: snapshotId, decided_by: decidedBy, decider_role: deciderRole },
  };
}
