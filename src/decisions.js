/**
 * 裁决、复核与后继更正。
 *
 * 争议进入复核时冻结“当时”的计算快照；快照一经追加不可修改。
 * 二审裁判或新鉴定结果只能以 FOLLOWUP_RESULT_RECORDED 追加，
 * 再经 DECISION_REVISED 形成新裁决，原裁决与原快照永久保留、可重放比对。
 */

import {
  AUTHORIZED_CLASSIFIERS,
  AUTHORIZED_REVIEWERS,
  DECISION_OUTCOMES,
  EVENT_AGGREGATE,
  EVENT_TYPES,
  FOLLOWUP_KINDS,
  makeEvent,
} from "./domain.js";
import { loadClaim } from "./model.js";
import { calculate, calculateWithHash } from "./calculation.js";
import { snapshotHash } from "./canonical.js";

class FlowError extends Error {}

function append(store, claimId, type, aggregateId, body, occurredAt) {
  const event = makeEvent(type, aggregateId, store.nextVersion(EVENT_AGGREGATE[type], aggregateId), {
    claim_id: claimId,
    ...body,
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  });
  store.append(event);
  return event;
}

/**
 * 冻结当前时点的计算快照。纯计算、无人工裁量；快照内容含完整明细与
 * 缺口清单，哈希绑定 input_seq + 规则版本 + 计算结果。
 */
export function freezeCalculation(store, claimId, { snapshot_id }, occurredAt) {
  const state = loadClaim(store, claimId);
  const { calculation, missing_requirements, input_seq, hash } = calculateWithHash(state);
  if (state.snapshots.some((s) => s.snapshot_id === snapshot_id)) throw new FlowError(`快照编号已存在：${snapshot_id}`);
  return append(
    store,
    claimId,
    EVENT_TYPES.CALCULATION_FROZEN,
    snapshot_id,
    {
      input_seq,
      rule_version: calculation.rule_version,
      calculation,
      missing_requirements,
      hash,
      summary: `冻结计算快照 ${snapshot_id}（截至 seq ${input_seq}，规则 ${calculation.rule_version}）`,
    },
    occurredAt,
  );
}

/** 重放至快照记录的 input_seq 并重新计算，校验哈希一致 */
export function verifyFrozenSnapshot(store, claimId, snapshotId) {
  const stateNow = loadClaim(store, claimId);
  const frozen = stateNow.snapshots.find((s) => s.snapshot_id === snapshotId);
  if (!frozen) throw new FlowError(`快照不存在：${snapshotId}`);
  const replayed = loadClaim(store, claimId, { upToSeq: frozen.input_seq });
  const { calculation, missing_requirements } = calculate(replayed);
  const rebuiltHash = snapshotHash({
    input_seq: frozen.input_seq,
    rule_version: frozen.rule_version,
    calculation,
  });
  return {
    snapshot_id: snapshotId,
    consistent: rebuiltHash === frozen.hash,
    frozen_hash: frozen.hash,
    rebuilt_hash: rebuiltHash,
    missing_requirements,
  };
}

export function issueDecision(store, claimId, actor, { decision_id, snapshot_id, outcome, rationale = [] }, occurredAt) {
  if (!AUTHORIZED_CLASSIFIERS.includes(actor?.role)) throw new FlowError("仅 ADJUDICATOR 可作出裁决");
  if (!Object.values(DECISION_OUTCOMES).includes(outcome)) throw new FlowError("未知裁决结果");
  const state = loadClaim(store, claimId);
  const snapshot = state.snapshots.find((s) => s.snapshot_id === snapshot_id);
  if (!snapshot) throw new FlowError(`裁决必须引用已冻结快照：${snapshot_id}`);
  if (state.decision) throw new FlowError("案件已有裁决；更正请走复核与 DECISION_REVISED");

  return append(
    store,
    claimId,
    EVENT_TYPES.DECISION_ISSUED,
    decision_id,
    {
      snapshot_id,
      outcome,
      rationale,
      adjudicator_id: actor.actor_id,
      total_amount: snapshot.calculation.total,
      summary: `裁决 ${decision_id}：${outcome}，金额 ${snapshot.calculation.total}`,
    },
    occurredAt,
  );
}

/**
 * 开启复核：自动冻结“当前时点”快照作为复核基准，
 * 原裁决引用的争议快照保持不变。
 */
export function openReview(store, claimId, actor, { review_id, reason }, occurredAt) {
  if (!AUTHORIZED_REVIEWERS.includes(actor?.role)) throw new FlowError("仅 REVIEWER 可开启复核");
  const state = loadClaim(store, claimId);
  if (!state.decision) throw new FlowError("没有可复核的裁决");
  if (state.review) throw new FlowError(`复核已开启：${state.review.review_id}`);

  const reviewSnapshotId = `snapshot-review-${review_id}`;
  freezeCalculation(store, claimId, { snapshot_id: reviewSnapshotId }, occurredAt);

  return append(
    store,
    claimId,
    EVENT_TYPES.REVIEW_OPENED,
    review_id,
    {
      decision_id: state.decision.decision_id,
      snapshot_id: reviewSnapshotId,
      disputed_snapshot_id: state.decision.snapshot_id,
      reason,
      opened_by: actor.actor_id,
      summary: `复核 ${review_id} 开启：${reason}`,
    },
    occurredAt,
  );
}

/** 记录二审裁判或新鉴定结果（只追加；不直接改判） */
export function recordFollowupResult(
  store,
  claimId,
  actor,
  { result_id, review_id, followup_kind, issuer, issued_on, changes = [], evidence_refs = [] },
  occurredAt,
) {
  if (!Object.values(FOLLOWUP_KINDS).includes(followup_kind)) throw new FlowError("未知后继结果类型");
  const state = loadClaim(store, claimId);
  const review = state.review;
  if (!review || review.review_id !== review_id) throw new FlowError(`复核不存在或未开启：${review_id}`);
  for (const ref of evidence_refs) {
    if (!state.evidence.has(ref)) throw new FlowError(`引用的证据不存在：${ref}`);
  }
  return append(
    store,
    claimId,
    EVENT_TYPES.FOLLOWUP_RESULT_RECORDED,
    result_id,
    {
      review_id,
      followup_kind,
      issuer,
      issued_on,
      changes,
      evidence_refs,
      recorded_by: actor.actor_id,
      summary: `${followup_kind === "SECOND_INSTANCE" ? "二审裁判" : "新鉴定结果"}：${issuer}`,
    },
    occurredAt,
  );
}

/**
 * 依据后继结果更正裁决：重算并冻结新快照，原裁决链保留。
 * 必须引用至少一条本复核下的后继结果。
 */
export function reviseDecision(
  store,
  claimId,
  actor,
  { decision_id, review_id, followup_result_ids = [], outcome, rationale = [] },
  occurredAt,
) {
  if (!AUTHORIZED_CLASSIFIERS.includes(actor?.role)) throw new FlowError("仅 ADJUDICATOR 可作出更正裁决");
  if (!Object.values(DECISION_OUTCOMES).includes(outcome)) throw new FlowError("未知裁决结果");
  if (!followup_result_ids.length) throw new FlowError("更正裁决必须引用二审裁判或新鉴定结果");

  const state = loadClaim(store, claimId);
  if (!state.review || state.review.review_id !== review_id) throw new FlowError(`复核不存在或未开启：${review_id}`);
  const results = state.followups.filter((f) => f.review_id === review_id);
  for (const id of followup_result_ids) {
    if (!results.some((r) => r.result_id === id)) throw new FlowError(`后继结果不属于本复核或不存在：${id}`);
  }

  const newSnapshotId = `snapshot-revised-${decision_id}`;
  freezeCalculation(store, claimId, { snapshot_id: newSnapshotId }, occurredAt);

  return append(
    store,
    claimId,
    EVENT_TYPES.DECISION_REVISED,
    decision_id,
    {
      snapshot_id: newSnapshotId,
      revision_of: state.decision.decision_id,
      followup_result_ids,
      outcome,
      rationale,
      adjudicator_id: actor.actor_id,
      summary: `更正裁决 ${decision_id}（基于 ${followup_result_ids.join("、")}）`,
    },
    occurredAt,
  );
}

export { FlowError };
