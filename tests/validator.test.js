import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

const base = {
  event_id: "t-1",
  event_type: "CLAIM_REGISTERED",
  aggregate_type: "injury_claim",
  aggregate_id: "claim-1",
  occurred_at: "2026-03-05T09:00:00+08:00",
  version: 1,
  summary: "登记",
  payload: { accident_date: "2026-03-01", region: "华东某市", claimant_id: "victim-1" },
};

test("合法事件通过校验", () => {
  assert.deepEqual(validateEvent(base), []);
});

test("未知事件类型被拒绝", () => {
  const errors = validateEvent({ ...base, event_type: "AUTO_APPROVED" });
  assert.ok(errors.some((message) => message.includes("未知事件类型")));
});

test("缺少信封字段被拒绝", () => {
  const { summary, ...rest } = base;
  assert.ok(validateEvent(rest).some((message) => message.includes("summary")));
});

test("分类事件不得携带自动裁决字段", () => {
  const event = {
    ...base,
    event_type: "CARE_CLASSIFIED",
    aggregate_type: "care_evidence",
    payload: {
      claim_id: "claim-1",
      classification: "life_care",
      classified_by: "handler-1",
      rationale: "家属提供生活照护",
      auto_decision: "reject",
    },
  };
  assert.ok(validateEvent(event).some((message) => message.includes("自动裁决")));
});

test("分类必须说明理由", () => {
  const event = {
    ...base,
    event_type: "CARE_CLASSIFIED",
    aggregate_type: "care_evidence",
    payload: { claim_id: "claim-1", classification: "life_care", classified_by: "handler-1", rationale: " " },
  };
  assert.ok(validateEvent(event).some((message) => message.includes("rationale")));
});

test("裁决必须由有权人员作出", () => {
  const event = {
    ...base,
    event_type: "DECISION_ISSUED",
    aggregate_type: "review_decision",
    payload: {
      claim_id: "claim-1",
      snapshot_id: "snapshot-1",
      outcome: "recognized",
      decided_by: "adjuster-x",
      decider_role: "opposing_insurer",
    },
  };
  assert.ok(validateEvent(event).some((message) => message.includes("有权人员")));
});

test("证据材料必须指明种类", () => {
  const event = {
    ...base,
    event_type: "EVIDENCE_SUBMITTED",
    aggregate_type: "care_evidence",
    payload: { claim_id: "claim-1", submitted_by: "victim-1", facts: {} },
  };
  assert.ok(validateEvent(event).some((message) => message.includes("evidence_kind")));
});
