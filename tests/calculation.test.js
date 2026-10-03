import assert from "node:assert/strict";
import test from "node:test";

import { freezeSnapshot, resolveRuleSet, verifySnapshot } from "../src/calculation.js";
import { replay } from "../src/replay.js";

let seq = 0;
function event(type, aggregateType, aggregateId, payload, summary = "测试事件") {
  seq += 1;
  return {
    event_id: `calc-evt-${seq}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: "2026-04-01T10:00:00+08:00",
    version: 1,
    summary,
    payload,
  };
}

function ruleSet(id, effectiveFrom, overrides = {}) {
  return event("RULE_SET_PUBLISHED", "rule_set", id, {
    effective_from: effectiveFrom,
    region: "华东某市",
    max_caregivers: 1,
    period_cap_days: 90,
    daily_labor_standard: 180,
    ...overrides,
  });
}

function claim() {
  return event("CLAIM_REGISTERED", "injury_claim", "claim-1", {
    accident_date: "2026-03-01",
    region: "华东某市",
    claimant_id: "victim-1",
  });
}

function evidence(id, kind, facts) {
  return event("EVIDENCE_SUBMITTED", "care_evidence", id, {
    claim_id: "claim-1",
    evidence_kind: kind,
    submitted_by: "victim-1",
    facts,
  });
}

function classified(id, classification) {
  return event("CARE_CLASSIFIED", "care_evidence", id, {
    claim_id: "claim-1",
    classification,
    classified_by: "handler-1",
    rationale: "测试分类理由",
  });
}

function baseEvents() {
  return [
    ruleSet("rules-2025", "2025-01-01"),
    ruleSet("rules-2026", "2026-06-01", { period_cap_days: 120, daily_labor_standard: 200 }),
    claim(),
    evidence("ev-med", "medical_care_item", { period: { from: "2026-03-01", to: "2026-03-10" } }),
    evidence("ev-life", "life_care_need", { periods: [{ from: "2026-03-01", to: "2026-03-25" }] }),
    classified("ev-med", "medical_care"),
    classified("ev-life", "life_care"),
  ];
}

function freeze(state, overrides = {}) {
  return freezeSnapshot(state, {
    eventId: `freeze-${seq}`,
    snapshotId: "snapshot-1",
    claimId: "claim-1",
    occurredAt: "2026-04-10T15:00:00+08:00",
    ...overrides,
  });
}

test("医疗护理与生活照护不重复计算", () => {
  const state = replay(baseEvents());
  const snapshot = freeze(state);
  assert.deepEqual(snapshot.payload.recognized_periods, [{ from: "2026-03-11", to: "2026-03-25" }]);
  assert.deepEqual(snapshot.payload.excluded_periods, [
    { from: "2026-03-01", to: "2026-03-10", reason: "medical_care_covered", evidence_refs: ["ev-med"] },
  ]);
  assert.equal(snapshot.payload.day_count, 15);
  assert.equal(snapshot.payload.amount, 15 * 180);
});

test("按事故发生时的规则版本计算", () => {
  const state = replay(baseEvents());
  const rule = resolveRuleSet(state.ruleSets, "华东某市", "2026-03-01");
  assert.equal(rule.rule_set_id, "rules-2025");
  assert.equal(freeze(state).payload.daily_standard, 180);
});

test("护理人数例外必须引用医疗或鉴定意见", () => {
  const state = replay(baseEvents());
  assert.throws(() => freeze(state, { caregiverCount: 2 }), /例外必须引用医疗或鉴定意见/);
  const withOpinion = replay([
    ...baseEvents(),
    evidence("ev-op", "institutional_opinion", { opinion_type: "appraisal", conclusion: "需二人护理" }),
  ]);
  const snapshot = freeze(withOpinion, { caregiverCount: 2, exceptionOpinionIds: ["ev-op"] });
  assert.equal(snapshot.payload.amount, 15 * 180 * 2);
  assert.deepEqual(snapshot.payload.exceptions, [{ type: "caregiver_count", value: 2, opinion_refs: ["ev-op"] }]);
  // 引用非本案或非意见类材料被拒绝
  assert.throws(() => freeze(state, { caregiverCount: 2, exceptionOpinionIds: ["ev-med"] }), /医疗或鉴定意见/);
});

test("期限上限未引用意见时截断并登记排除时段", () => {
  const events = [
    ruleSet("rules-cap", "2025-01-01", { period_cap_days: 5 }),
    claim(),
    evidence("ev-life", "life_care_need", { periods: [{ from: "2026-03-01", to: "2026-03-10" }] }),
    classified("ev-life", "life_care"),
  ];
  const snapshot = freeze(replay(events));
  assert.equal(snapshot.payload.day_count, 5);
  assert.deepEqual(snapshot.payload.excluded_periods, [
    { from: "2026-03-06", to: "2026-03-10", reason: "period_cap_exceeded", evidence_refs: ["ev-life"] },
  ]);
});

test("冻结快照可重放校验，事后新增证据会导致校验失败", () => {
  const events = baseEvents();
  const frozen = freeze(replay(events));
  const okState = replay([...events, frozen]);
  assert.deepEqual(verifySnapshot(okState, "snapshot-1").differences, []);
  // 冻结后补交的新证据会改变计算结果，重放校验必须发现差异
  const tampered = replay([
    ...events,
    frozen,
    evidence("ev-life-2", "life_care_need", { periods: [{ from: "2026-04-01", to: "2026-04-05" }] }),
    classified("ev-life-2", "life_care"),
  ]);
  const result = verifySnapshot(tampered, "snapshot-1");
  assert.equal(result.ok, false);
  assert.ok(result.differences.includes("amount"));
});
