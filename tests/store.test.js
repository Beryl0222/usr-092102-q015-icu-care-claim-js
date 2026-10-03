import assert from "node:assert/strict";
import test from "node:test";

import { makeEvent, EVENT_TYPES } from "../src/domain.js";
import { EventStore } from "../src/store.js";

function ev(id, type, aggregateType, aggregateId, version, extra = {}) {
  return makeEvent(type, aggregateId, version, {
    event_id: id,
    claim_id: "c1",
    ...extra,
  });
}

test("事件按序追加并获得全局 seq", () => {
  const store = new EventStore();
  const e1 = ev("e1", EVENT_TYPES.CLAIM_OPENED, "injury_claim", "c1", 1);
  const e2 = ev("e2", EVENT_TYPES.EVIDENCE_SUBMITTED, "care_evidence", "v1", 1);
  const { appended } = store.append([e1, e2]);
  assert.deepEqual(appended.map((e) => e.seq), [1, 2]);
});

test("同一 event_id 重复提交幂等跳过，不产生新 seq", () => {
  const store = new EventStore();
  const e = ev("e1", EVENT_TYPES.CLAIM_OPENED, "injury_claim", "c1", 1);
  store.append(e);
  const { appended, skipped } = store.append({ ...e });
  assert.equal(appended.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(store.size, 1);
});

test("聚合 version 必须连续，补证不能覆盖历史版本", () => {
  const store = new EventStore();
  store.append(ev("e1", EVENT_TYPES.EVIDENCE_SUBMITTED, "care_evidence", "v1", 1));
  assert.throws(
    () => store.append(ev("e2", EVENT_TYPES.EVIDENCE_SUBMITTED, "care_evidence", "v1", 1)),
    /版本冲突/,
  );
  assert.throws(
    () => store.append(ev("e3", EVENT_TYPES.EVIDENCE_SUBMITTED, "care_evidence", "v1", 3)),
    /版本冲突/,
  );
  // 只能追加 v2
  store.append(ev("e4", EVENT_TYPES.EVIDENCE_MERGED, "care_evidence", "v1", 2, { canonical_id: "v1", duplicate_ids: [] }));
  assert.equal(store.size, 2);
});

test("事件类型与聚合必须匹配", () => {
  assert.throws(
    () =>
      new EventStore().append({
        ...ev("x", EVENT_TYPES.CLAIM_OPENED, "injury_claim", "c1", 1),
        aggregate_type: "care_evidence",
      }),
    /必须属于聚合/,
  );
});

test("read 支持按案件与 upToSeq 重放", () => {
  const store = new EventStore();
  store.append(ev("e1", EVENT_TYPES.CLAIM_OPENED, "injury_claim", "c1", 1));
  store.append(ev("e2", EVENT_TYPES.EVIDENCE_SUBMITTED, "care_evidence", "v1", 1));
  store.append(ev("e3", EVENT_TYPES.CLAIM_OPENED, "injury_claim", "c2", 1, { event_id: "o1", claim_id: "c2" }));
  assert.deepEqual(store.read({ claimId: "c1" }).map((e) => e.event_id), ["e1", "e2"]);
  assert.deepEqual(store.read({ claimId: "c1", upToSeq: 1 }).map((e) => e.event_id), ["e1"]);
});
