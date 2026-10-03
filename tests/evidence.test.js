import assert from "node:assert/strict";
import test from "node:test";

import { findDuplicate } from "../src/evidence.js";
import { replay } from "../src/replay.js";
import { EventStore } from "../src/store.js";

let seq = 0;
function submitted(id, facts, extra = {}) {
  seq += 1;
  return {
    event_id: `evt-${seq}`,
    event_type: "EVIDENCE_SUBMITTED",
    aggregate_type: "care_evidence",
    aggregate_id: id,
    occurred_at: "2026-04-01T10:00:00+08:00",
    version: 1,
    summary: "提交材料",
    payload: { claim_id: "claim-1", evidence_kind: "hospitalization_stage", submitted_by: "victim-1", facts, ...extra },
  };
}

const facts = { facility: "市一院", stage: "ICU", period: { from: "2026-03-01", to: "2026-03-10" } };

test("同一事件标识重复接收幂等，内容冲突被拒绝", () => {
  const store = new EventStore();
  const event = submitted("ev-1", facts);
  assert.equal(store.append(event).appended, true);
  assert.equal(store.append(event).appended, false);
  assert.throws(() => store.append({ ...event, summary: "内容不同" }), /事件标识冲突/);
});

test("补证不覆盖原提交", () => {
  const original = submitted("ev-1", facts);
  const supplement = submitted("ev-2", { acts: ["转院配合"] }, { supplements: ["ev-1"] });
  const state = replay([original, supplement]);
  assert.deepEqual(state.evidence.get("ev-1").facts, facts);
  assert.deepEqual(state.evidence.get("ev-2").supplements, ["ev-1"]);
  // 同一证据聚合不得再次提交（覆盖原提交）
  const overwrite = { ...submitted("ev-1", { stage: "普通病房" }), event_id: "evt-x" };
  assert.throws(() => replay([original, overwrite]), /不得覆盖原提交/);
});

test("重复材料按内容归并引用", () => {
  const first = submitted("ev-1", facts);
  const second = submitted("ev-2", { ...facts });
  let state = replay([first]);
  const duplicateOf = findDuplicate(state, "claim-1", "hospitalization_stage", second.payload.facts);
  assert.equal(duplicateOf, "ev-1");
  const link = {
    event_id: "evt-link",
    event_type: "EVIDENCE_LINKED",
    aggregate_type: "care_evidence",
    aggregate_id: "ev-2",
    occurred_at: "2026-04-02T10:00:00+08:00",
    version: 2,
    summary: "归并引用",
    payload: { claim_id: "claim-1", duplicate_of: duplicateOf },
  };
  state = replay([first, second, link]);
  assert.equal(state.evidence.get("ev-2").duplicate_of, "ev-1");
});
