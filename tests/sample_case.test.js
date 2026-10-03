import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifySnapshot } from "../src/calculation.js";
import { victimView } from "../src/gaps.js";
import { replay } from "../src/replay.js";
import { EventStore } from "../src/store.js";
import { validateEvent } from "../src/validator.js";
import { projectEvents } from "../src/visibility.js";

const sampleCase = JSON.parse(await readFile(new URL("../data/sample_case.json", import.meta.url), "utf8"));
const events = sampleCase.events;

test("样例案件全部事件符合领域约定", () => {
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 校验失败`);
  }
});

test("样例案件按事件标识接收并可重放", () => {
  const store = new EventStore();
  store.appendAll(events);
  // 重复接收同一事件幂等
  assert.equal(store.append(events[0]).appended, false);

  const state = replay(store.all());

  // 重复病历只归并引用
  assert.equal(state.evidence.get("ev-dup-001").duplicate_of, "ev-ward-001");
  // 补证不覆盖原提交
  assert.equal(state.evidence.get("ev-admin-001").facts.acts.includes("缴纳住院费"), true);
  assert.deepEqual(state.evidence.get("ev-admin-002").supplements, ["ev-admin-001"]);

  // 复核者重放校验：两份快照的医疗护理与生活照护均未重复计算
  assert.deepEqual(verifySnapshot(state, "snapshot-001").differences, []);
  assert.deepEqual(verifySnapshot(state, "snapshot-002").differences, []);
  const first = state.snapshots.get("snapshot-001");
  assert.equal(first.rule_set_id, "rules-hd-2025", "按事故发生时规则版本计算");
  assert.deepEqual(first.recognized_periods, [{ from: "2026-03-11", to: "2026-03-25" }]);
  assert.equal(first.excluded_periods[0].reason, "medical_care_covered");

  // 后继更正：原裁决保留，新裁决引用新快照
  assert.equal(state.decisions.get("decision-001").outcome, "partially_recognized");
  assert.equal(state.decisions.get("decision-002").revises, "decision-001");
  assert.equal(state.decisions.get("decision-002").snapshot_id, "snapshot-002");

  // 受害方视图：认定时段与金额形成（含二人护理例外及其意见引用）
  const view = victimView(state, "claim-2026-001");
  assert.equal(view.amount_formation.amount, 5400);
  assert.equal(view.amount_formation.caregiver_count, 2);
  assert.deepEqual(view.amount_formation.exceptions[0].opinion_refs, ["ev-op-002"]);
});

test("样例案件的最小可见范围", () => {
  const insurer = projectEvents(events, "opposing_insurer");
  const income = insurer.find((event) => event.aggregate_id === "ev-income-001");
  assert.equal(income.payload.facts, null, "对方保险人员不得见家属收入");
  const medical = insurer.find((event) => event.aggregate_id === "ev-med-001");
  assert.equal(medical.payload.facts, null, "对方保险人员不得见医疗详情");

  const victim = projectEvents(events, "victim_side");
  assert.equal(victim.find((event) => event.aggregate_id === "ev-med-001").payload.facts, null);
  assert.notEqual(victim.find((event) => event.aggregate_id === "ev-admin-001").payload.facts, null);

  const handler = projectEvents(events, "claims_handler");
  assert.notEqual(handler.find((event) => event.aggregate_id === "ev-income-001").payload.facts, null);
});
