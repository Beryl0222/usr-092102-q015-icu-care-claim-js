import assert from "node:assert/strict";
import test from "node:test";

import { assessGaps, victimView } from "../src/gaps.js";
import { replay } from "../src/replay.js";
import { issueDecision, openReview, reviseDecision } from "../src/review.js";
import { projectEvents } from "../src/visibility.js";

let seq = 0;
function event(type, aggregateType, aggregateId, payload) {
  seq += 1;
  return {
    event_id: `rev-evt-${seq}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: "2026-04-01T10:00:00+08:00",
    version: 1,
    summary: "测试事件",
    payload,
  };
}

const claim = event("CLAIM_REGISTERED", "injury_claim", "claim-1", {
  accident_date: "2026-03-01",
  region: "华东某市",
  claimant_id: "victim-1",
});

const snapshot = event("CALCULATION_FROZEN", "calculation_snapshot", "snapshot-1", {
  claim_id: "claim-1",
  rule_set_id: "rules-2025",
  recognized_periods: [{ from: "2026-03-11", to: "2026-03-25" }],
  excluded_periods: [],
  caregiver_count: 1,
  daily_standard: 180,
  day_count: 15,
  amount: 2700,
  exceptions: [],
  evidence_refs: [],
});

test("复核必须引用已冻结的计算快照", () => {
  assert.throws(
    () => openReview(replay([claim]), { eventId: "e1", reviewId: "r1", claimId: "claim-1", grounds: "异议", openedBy: "victim-1", occurredAt: "2026-04-02T10:00:00+08:00" }),
    /已冻结的计算快照/,
  );
  const state = replay([claim, snapshot]);
  const review = openReview(state, { eventId: "e2", reviewId: "r1", claimId: "claim-1", grounds: "异议", openedBy: "victim-1", occurredAt: "2026-04-02T10:00:00+08:00" });
  assert.equal(review.payload.frozen_snapshot_id, "snapshot-1");
});

test("后继更正保留原裁决", () => {
  const decision = issueDecision({
    eventId: "e3",
    decisionId: "decision-1",
    claimId: "claim-1",
    snapshotId: "snapshot-1",
    outcome: "partially_recognized",
    decidedBy: "reviewer-1",
    deciderRole: "reviewer",
    occurredAt: "2026-04-03T10:00:00+08:00",
  });
  let state = replay([claim, snapshot, decision]);
  const snapshot2 = { ...snapshot, event_id: "rev-evt-s2", aggregate_id: "snapshot-2", payload: { ...snapshot.payload, amount: 5400, caregiver_count: 2 } };
  state = replay([claim, snapshot, decision, snapshot2]);
  const revised = reviseDecision(state, {
    eventId: "e4",
    decisionId: "decision-2",
    revises: "decision-1",
    reason: "new_appraisal",
    claimId: "claim-1",
    snapshotId: "snapshot-2",
    decidedBy: "reviewer-1",
    deciderRole: "reviewer",
    occurredAt: "2026-04-04T10:00:00+08:00",
  });
  state = replay([claim, snapshot, decision, snapshot2, revised]);
  assert.equal(state.decisions.get("decision-1").outcome, "partially_recognized");
  assert.equal(state.decisions.get("decision-2").revises, "decision-1");
  assert.throws(() => reviseDecision(state, { eventId: "e5", decisionId: "d3", revises: "decision-x", reason: "correction", claimId: "claim-1", snapshotId: "snapshot-2", decidedBy: "r", deciderRole: "reviewer", occurredAt: "2026-04-05T10:00:00+08:00" }), /原裁决/);
});

test("最小可见范围按角色投影", () => {
  const income = event("EVIDENCE_SUBMITTED", "care_evidence", "ev-income", {
    claim_id: "claim-1",
    evidence_kind: "income_proof",
    submitted_by: "victim-1",
    facts: { monthly_income: 6500 },
  });
  const medical = event("EVIDENCE_SUBMITTED", "care_evidence", "ev-med", {
    claim_id: "claim-1",
    evidence_kind: "medical_care_item",
    submitted_by: "hospital-1",
    facts: { item: "特级护理" },
  });
  const admin = event("EVIDENCE_SUBMITTED", "care_evidence", "ev-admin", {
    claim_id: "claim-1",
    evidence_kind: "administrative_act",
    submitted_by: "victim-1",
    facts: { acts: ["缴费"] },
  });
  const events = [income, medical, admin];
  const insurer = projectEvents(events, "opposing_insurer");
  assert.equal(insurer[0].payload.facts, null);
  assert.equal(insurer[1].payload.facts, null);
  assert.equal(insurer[2].payload.facts, null);
  const victim = projectEvents(events, "victim_side");
  assert.equal(victim[0].payload.facts, null);
  assert.equal(victim[1].payload.facts, null);
  assert.deepEqual(victim[2].payload.facts, { acts: ["缴费"] });
  const handler = projectEvents(events, "claims_handler");
  assert.deepEqual(handler[0].payload.facts, { monthly_income: 6500 });
  assert.deepEqual(handler[1].payload.facts, { item: "特级护理" });
});

test("受害方视图：缺证、认定时段与金额形成", () => {
  const empty = replay([claim]);
  assert.ok(assessGaps(empty, "claim-1").some((gap) => gap.code === "missing_hospitalization_stage"));
  const state = replay([claim, snapshot]);
  const view = victimView(state, "claim-1");
  assert.deepEqual(view.recognized_periods, [{ from: "2026-03-11", to: "2026-03-25" }]);
  assert.equal(view.amount_formation.amount, 2700);
  assert.equal(view.amount_formation.daily_standard, 180);
});
